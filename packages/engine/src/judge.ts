/**
 * Impact: for one event and the companies the graph links it to, a judge
 * says whether the event reaches each company, which way, how sure, over
 * what window, and why in one or two sentences. Grounded only in the event
 * summary (and the lines quoted from its source) and the filing quotes that
 * prove each link.
 *
 * Judges:
 *   - "claude": the Claude API (model claude-sonnet-5-5, structured JSON
 *     output). Sonnet 5.5 rejects a non-default temperature with a 400, so
 *     the request leaves sampling at its default; the schema, the closed
 *     answer sets and the validation below keep the output stable.
 *   - "file": answers read from a JSON file in the same schema (a review
 *     pass, a fixture, or a run without an API key). They go through the
 *     same validation as the API's.
 *
 * Every answer is validated; an answer that fails is dropped, never fixed.
 * Each event is asked several times and the answers are put to a vote per
 * candidate (src/vote.ts, README "Judge votes").
 */

import fs from "node:fs";
import Anthropic from "@anthropic-ai/sdk";
import type { Confidence, Direction, RippleEvent } from "@falcon/ripple";
import type { GraphEdge, Path } from "./graph.ts";
import { framingProblems, inventedNumbers } from "./validate.ts";

export const JUDGE_MODEL = "claude-sonnet-5-5";

export const WINDOWS = ["1 to 5 trading days", "1 to 4 weeks", "1 to 3 months"] as const;
export type Window = (typeof WINDOWS)[number];

export type Candidate = {
  key: string;
  ticker: string;
  companyName: string;
  degree: 1 | 2;
  via?: string;
  viaName?: string;
  /** What the candidate is to the event company (degree 1) or to `via` (degree 2). */
  relation: string;
  /** Degree 2: what `via` is to the event company. */
  viaRelation?: string;
  links: Array<{ filer: string; named: string; says: string; quote: string; form: string; filedAt: string }>;
};

export type JudgeRequest = {
  eventId: string;
  event: Pick<RippleEvent, "ticker" | "companyName" | "kind" | "headline" | "occurredAt" | "summary" | "facts">;
  candidates: Candidate[];
};

export type JudgeAnswer = {
  key: string;
  include: boolean;
  direction: Direction;
  confidence: Confidence;
  window: Window;
  mechanism: string;
};

export type JudgeResponse = { hits: JudgeAnswer[] };

export const JUDGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["hits"],
  properties: {
    hits: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "include", "direction", "confidence", "window", "mechanism"],
        properties: {
          key: { type: "string" },
          include: { type: "boolean" },
          direction: { type: "string", enum: ["up", "down", "unclear"] },
          confidence: { type: "string", enum: ["low", "medium", "high"] },
          window: { type: "string", enum: [...WINDOWS] },
          mechanism: { type: "string" },
        },
      },
    },
  },
} as const;

export const SYSTEM_PROMPT = `You assess how one company's news reaches the companies linked to it in SEC filings. Your answers appear on Falcon, an information product for retail investors. Falcon reports what happened and what the record shows. It never tells anyone to act.

You get one event (a headline, a summary, and lines quoted from its source) and a list of candidate companies. Each candidate comes with the filing quotes that link it to the event company, directly (degree 1) or through one company in between (degree 2).

For each candidate, decide:
- include: true only if the event says something about this company's business through the quoted link. False when the quote names the company in a long list without a shared product or market that the event speaks to, or when the link cannot carry the event's information.
- direction: the likely first-order effect of this event on how the market reads this company. "up" or "down" only when the mechanism follows from the event summary and the quote. "unclear" when the event could cut either way for this company (for example, a competitor's strong quarter can mean healthy demand for both, or share taken from this company).
- confidence: "high" only for a direct customer or supplier link whose quote states a share of revenue or a sole or exclusive source, with an event that clearly moves that business. "medium" for a direct supply-chain link without a stated share, or a named principal competitor in the same product market. "low" for competitors named in a list, all degree 2 links, and anything indirect.
- window: when the information is likely to be priced: "1 to 5 trading days" for direct read-throughs of reported numbers, "1 to 4 weeks" for links that need the next data point (the company's own report, the next monthly figure), "1 to 3 months" for slow supply-chain effects.
- mechanism: one or two plain sentences, at most 300 characters, that name the link and say how the event reaches this company.

Rules for the mechanism:
- Use only facts in the event summary, the quoted lines and the filing quotes. Do not add numbers, dates, products, customers or market shares that are not there. Every number you write must appear in that material.
- Do not forecast prices or returns and do not say how much a stock may move.
- Information framing only. Never use the words buy, sell, hold, should, opportunity, recommend, target, undervalued, overvalued, outperform, or any call to act.
- No hype words (soar, massive, huge, blockbuster, game-changing). No em dashes. No emojis. Plain English.
- Say what the record shows, for example: "Arrow is Microchip's largest distributor at 12% of net sales, so Microchip's 42.2% year-over-year sales growth passed through Arrow's distribution business."

Return one entry per candidate, using the candidate's key.`;

/** The user message for one event. Pure. */
export function judgePrompt(req: JudgeRequest): string {
  const e = req.event;
  const lines: string[] = [];
  lines.push(`EVENT (${e.kind}, ${e.occurredAt})`);
  lines.push(`Company: ${e.companyName} (${e.ticker})`);
  lines.push(`Headline: ${e.headline}`);
  lines.push(`Summary: ${e.summary}`);
  for (const f of e.facts ?? []) lines.push(`Quoted from the source: ${f}`);
  lines.push("");
  lines.push("CANDIDATES");
  for (const c of req.candidates) {
    const how =
      c.degree === 1
        ? `degree 1: ${c.companyName} is ${e.companyName}'s ${c.relation}`
        : `degree 2 via ${c.viaName} (${c.via}): ${c.viaName} is ${e.companyName}'s ${c.viaRelation}, and ${c.companyName} is ${c.viaName}'s ${c.relation}`;
    lines.push(`[${c.key}] ${c.companyName} (${c.ticker}), ${how}`);
    for (const l of c.links) lines.push(`  - ${l.filer} ${l.form} filed ${l.filedAt} (${l.says}): "${l.quote}"`);
  }
  return lines.join("\n");
}

export type ValidatedAnswer = JudgeAnswer & { problems: string[] };

/** SEC form names ("10-K", "6-K", "20-F") are document names, not figures. */
export const FORM_NAME = /\b(?:10-K|10-Q|8-K|6-K|20-F|40-F|S-1|S-4)(?:\/A)?\b/gi;

/**
 * Where an answer's numbers may come from: what the prompt shows the judge
 * about the event (headline, summary, quoted source lines, the event's year)
 * and about this candidate (each link's filer, quote and filing year). Full
 * dates are left out on purpose: their day and month would let any small
 * number through. Pure.
 */
export function answerMaterial(req: JudgeRequest, cand: Candidate): string[] {
  const e = req.event;
  const year = (d: string) => d.slice(0, 4);
  return [year(e.occurredAt), e.headline, e.summary, ...(e.facts ?? []), ...cand.links.map((l) => `${l.filer} ${year(l.filedAt)}: ${l.quote}`)];
}

/** Numbers in a mechanism that the material does not hold, form names aside. Pure. */
export function inventedInAnswer(mechanism: string, req: JudgeRequest, cand: Candidate): string[] {
  return inventedNumbers(mechanism.replace(FORM_NAME, " "), answerMaterial(req, cand));
}

/**
 * Checks one answer against the request: a known key, closed answer sets,
 * length, framing, and no number that the event or the quotes do not hold.
 * Pure.
 */
export function checkAnswer(req: JudgeRequest, a: unknown): ValidatedAnswer | null {
  if (!a || typeof a !== "object") return null;
  const x = a as Record<string, unknown>;
  const problems: string[] = [];
  const cand = req.candidates.find((c) => c.key === x.key);
  if (!cand) return null;
  if (typeof x.include !== "boolean") problems.push("include not boolean");
  if (!["up", "down", "unclear"].includes(x.direction as string)) problems.push("bad direction");
  if (!["low", "medium", "high"].includes(x.confidence as string)) problems.push("bad confidence");
  if (!(WINDOWS as readonly string[]).includes(x.window as string)) problems.push("bad window");
  const mechanism = typeof x.mechanism === "string" ? x.mechanism.trim() : "";
  if (mechanism.length < 30) problems.push("mechanism too short");
  if (mechanism.length > 420) problems.push("mechanism too long");
  if (mechanism.split(/(?<=[.!?])\s+(?=[A-Z])/).length > 2) problems.push("more than two sentences");
  problems.push(...framingProblems(mechanism, "mechanism"));
  const invented = inventedInAnswer(mechanism, req, cand);
  if (invented.length) problems.push(`numbers not in the event or the quotes: ${invented.join(", ")}`);
  // Degree 2 and list competitors cannot be high confidence.
  if (x.confidence === "high" && (cand.degree === 2 || cand.relation === "competitor" || cand.relation === "peer")) {
    problems.push("high confidence on an indirect or competitor link");
  }
  return {
    key: String(x.key),
    include: x.include === true,
    direction: x.direction as Direction,
    confidence: x.confidence as Confidence,
    window: x.window as Window,
    mechanism,
    problems,
  };
}

export type JudgeUsage = { calls: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number };

export type Judge = {
  name: string;
  judge: (req: JudgeRequest) => Promise<unknown>;
  /** Same answers every call (a file): asked once, no vote (src/vote.ts). */
  deterministic?: boolean;
  /** Tokens used so far (the Claude judge), for the run's cost line. */
  usage?: JudgeUsage;
};

/** claude-sonnet-5-5 list prices, US dollars per million tokens (input, output, cache read, cache write). */
export const JUDGE_PRICE = { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 } as const;

/** What the tokens cost at JUDGE_PRICE, US dollars. Pure. */
export function judgeCostUsd(u: JudgeUsage): number {
  return (u.inputTokens * JUDGE_PRICE.input + u.outputTokens * JUDGE_PRICE.output + u.cacheReadTokens * JUDGE_PRICE.cacheRead + u.cacheWriteTokens * JUDGE_PRICE.cacheWrite) / 1e6;
}

export function claudeJudge(apiKey: string): Judge {
  const client = new Anthropic({ apiKey, maxRetries: 3 });
  const usage: JudgeUsage = { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  return {
    name: JUDGE_MODEL,
    usage,
    async judge(req) {
      usage.calls++;
      const res = await client.beta.messages.create({
        model: JUDGE_MODEL,
        max_tokens: 8000,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        // The votes on one event send the same prompt: later calls read it from the cache.
        cache_control: { type: "ephemeral" },
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: judgePrompt(req) }],
        output_config: { effort: "medium", format: { type: "json_schema", schema: JUDGE_SCHEMA as unknown as Record<string, unknown> } },
      });
      const u = res.usage;
      usage.inputTokens += u.input_tokens ?? 0;
      usage.outputTokens += u.output_tokens ?? 0;
      usage.cacheReadTokens += u.cache_read_input_tokens ?? 0;
      usage.cacheWriteTokens += u.cache_creation_input_tokens ?? 0;
      if (res.stop_reason === "refusal") throw new Error(`judge declined event ${req.eventId}`);
      if (res.stop_reason === "max_tokens") throw new Error(`judge ran out of tokens on event ${req.eventId}`);
      const text = res.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("");
      return JSON.parse(text) as unknown;
    },
  };
}

/**
 * Answers from a file: `{ "judge": "<who>", "events": { "<eventId>": { "hits": [...] } } }`.
 * An answer may name its candidate by `ticker` instead of `key` (keys depend
 * on candidate order; tickers do not). A candidate the file does not answer
 * gets no hit.
 */
export function fileJudge(file: string, fallbackName: string): Judge {
  const body = JSON.parse(fs.readFileSync(file, "utf8")) as { judge?: string; events?: Record<string, { hits?: unknown[] }> };
  const events = body.events ?? {};
  return {
    name: body.judge ?? fallbackName,
    deterministic: true,
    async judge(req) {
      const answer = events[req.eventId];
      if (!answer || !Array.isArray(answer.hits)) throw new Error(`no answers for ${req.eventId} in ${file}`);
      const hits = answer.hits.map((h) => {
        const x = h as Record<string, unknown>;
        if (typeof x.key === "string" || typeof x.ticker !== "string") return h;
        const c = req.candidates.find((c) => c.ticker === x.ticker && (x.degree === undefined || c.degree === x.degree));
        const { ticker: _t, degree: _d, ...rest } = x;
        return c ? { key: c.key, ...rest } : h;
      });
      return { hits };
    },
  };
}

export function linkLine(edge: GraphEdge, names: (t: string) => string): Candidate["links"][number] {
  const says =
    edge.category === "competitor"
      ? `names ${edge.toName} as a competitor`
      : edge.category === "partner"
        ? `names ${edge.toName} as a partner`
        : `names ${edge.toName} as a ${edge.category}${edge.disclosedSharePct !== null ? ` at ${edge.disclosedSharePct}%` : ""}`;
  return { filer: names(edge.from), named: edge.toName, says, quote: edge.quote, form: edge.form, filedAt: edge.filedAt };
}

export function candidateFrom(path: Path, key: string, names: (t: string) => string): Candidate {
  return {
    key,
    ticker: path.ticker,
    companyName: names(path.ticker),
    degree: path.degree,
    ...(path.via ? { via: path.via, viaName: names(path.via) } : {}),
    relation: path.relation,
    ...(path.viaRelation ? { viaRelation: path.viaRelation } : {}),
    links: path.edges.map((e) => linkLine(e, names)),
  };
}
