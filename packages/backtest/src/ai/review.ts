/**
 * "Explain" (design 6.4): Claude describes the QualityReport in slot
 * templates and never writes a result number.
 *
 *   - Each sentence is { template, slots[] }: "{}" marks a slot, and each slot
 *     names a path in report.values ("delay.drop_pct").
 *   - Numbers in templates: only those that define the strategy (they appear
 *     in describe(spec).rules, a parameter, a risk setting or the person's own
 *     description, like "10% trailing stop" or "top 3"), digits inside a ticker
 *     symbol, and the fixed numbers in a check's own definition when that
 *     check is in the report (CHECK_CONSTANTS: "the 5 best trades", "a 90%
 *     range"; value names like top5_trades_share_pct; check names like "Null
 *     comparison (200 seeds)"). Any other number is a result and must be a
 *     slot; written as text it is rejected (allowedNumbers, inventedNumbers).
 *   - Post-checks: such a number, a slot count that does not match the "{}"
 *     count, or a ref that does not resolve. A reply with problems is first
 *     repaired by dropping the sentences that carry them (repairReply); it is
 *     retried once, with the problems listed, only when that loses the
 *     headline or every flag, and fails only when nothing valid is left.
 *   - The server fills the slots, each value formatted by its declared unit
 *     (VALUE_UNITS in audit/report.ts: "45.7%", "24.49 points", "$6.27"), then
 *     every sentence passes neutralize().
 *   - Input: the spec, describe(spec) and the report's checks and values. No
 *     prices, no news.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { neutralize } from "../neutralize";
import { fillSlots, resolveRef, type QualityReport } from "../audit/report";
import { CHECK_CONSTANTS } from "../audit/tiers";
import { universeTickers, type SpecDescription, type StrategySpecV2 } from "../spec";
import { PROMPT_VERSION, REVIEW_SYSTEM } from "./prompts";
import { costUsd, type Usage } from "./usage";

export const REVIEW_MODEL = "claude-sonnet-5-5";
/** A call (first or retry) is not started with less time than this left. */
const MIN_CALL_MS = 4_000;
export const REVIEW_TIMEOUT_MESSAGE = "Explain took longer than usual. Try again.";

const Sentence = z.object({ template: z.string(), slots: z.array(z.object({ ref: z.string() })) });
export const ReviewOutput = z.object({
  headline: Sentence,
  flags: z.array(z.object({ check_id: z.number().int(), severity: z.enum(["high", "medium", "low"]), meaning: Sentence, try_next: Sentence.nullable() })),
  interpretation_risks: z.array(Sentence),
  next_experiments: z.array(z.object({ change: Sentence, why: Sentence })),
});
type ReviewOutputT = z.infer<typeof ReviewOutput>;
type SentenceT = z.infer<typeof Sentence>;

export type Review = {
  headline: string;
  flags: { check_id: number; severity: "high" | "medium" | "low"; meaning: string; tryNext: string | null }[];
  interpretationRisks: string[];
  nextExperiments: { change: string; why: string }[];
  model: string;
  usage: Usage;
  /** Sentences dropped by the deterministic repair (0 when the reply was valid as written). */
  repaired: number;
};

export type ReviewResult = { ok: true; review: Review } | { ok: false; reason: "unavailable" | "timeout" | "invalid" | "refusal"; message: string; usage?: Usage };

type MessagesClient = { beta: { messages: { create: (params: never, options?: never) => Promise<unknown> } } };

// ---------------------------------------------------------------------------
// Numbers a template may contain.

/** Numbers a template may contain, and ticker symbols (which may hold digits). */
export type NumberAllowance = { numbers: Set<string>; tickers: Set<string> };

const NUMBER = /\d+(?:,\d{3})*(?:\.\d+)?/g;
/** Names with digits in them that are not quantities. */
const NAMES = /S&P\s*500\b/gi;

const canon = (tok: string) => String(Number(tok.replace(/,/g, "")));

function addNumbers(set: Set<string>, text: string) {
  for (const tok of text.replace(NAMES, " ").match(NUMBER) ?? []) set.add(canon(tok));
}

/**
 * The numbers a template may write although Falcon did not compute them: the
 * strategy's own definition (rules text without its "1." numbering,
 * parameters, risk settings), the person's description and answers, and the
 * fixed numbers of the checks in the report (CHECK_CONSTANTS, value names like
 * top5_trades_share_pct and above_200d_pct, check names like "Null comparison
 * (200 seeds)"). Results always go through slots.
 */
export function allowedNumbers(input: { spec?: StrategySpecV2; describe?: SpecDescription; report: QualityReport }): NumberAllowance {
  const numbers = new Set<string>();
  const tickers = new Set<string>(["SPY"]);
  const { spec, describe, report } = input;
  for (const line of describe?.rules ?? []) addNumbers(numbers, line.replace(/^\s*\d+\.\s+/, ""));
  if (spec) {
    addNumbers(numbers, spec.intent ?? "");
    for (const c of spec.clarifications ?? []) addNumbers(numbers, c.a);
    for (const p of Object.values(spec.params ?? {})) numbers.add(canon(String(p.value)));
    for (const v of Object.values(spec.risk ?? {})) if (typeof v === "number") numbers.add(canon(String(v)));
    try {
      for (const t of universeTickers(spec)) tickers.add(t);
    } catch {
      // No universe to read: tickers stay as listed in the values.
    }
  }
  for (const [group, vals] of Object.entries(report.values)) {
    for (const d of group.match(/\d+/g) ?? []) numbers.add(canon(d));
    for (const [key, v] of Object.entries(vals ?? {})) {
      for (const d of key.match(/\d+/g) ?? []) numbers.add(canon(d));
      if (typeof v === "string" && /ticker|examples|missing/.test(key)) for (const t of v.split(/,\s*/)) if (t.trim()) tickers.add(t.trim().toUpperCase());
    }
  }
  for (const c of report.checks) {
    addNumbers(numbers, c.name);
    for (const k of CHECK_CONSTANTS[c.id] ?? []) numbers.add(canon(String(k)));
  }
  return { numbers, tickers };
}

/** Numbers in a template that Falcon did not compute and the strategy does not define. */
export function inventedNumbers(template: string, allow: NumberAllowance): string[] {
  const text = template
    .replace(/\{\}/g, " ")
    .replace(NAMES, " ")
    // Ticker symbols with digits in them ("BRK-B", "0700.HK") are names, not numbers.
    .replace(/[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]/g, (tok) => (/[A-Za-z]/.test(tok) && allow.tickers.has(tok.toUpperCase()) ? " " : tok));
  return (text.match(NUMBER) ?? []).filter((tok) => !allow.numbers.has(canon(tok)));
}

function sentenceProblems(s: SentenceT, where: string, report: QualityReport, allow: NumberAllowance): string[] {
  const problems: string[] = [];
  const bad = inventedNumbers(s.template, allow);
  if (bad.length) problems.push(`${where}: the template contains ${bad.map((b) => `"${b}"`).join(", ")}, not a number from the rules or the person's description ("${s.template}"). Use "{}" and a slot instead.`);
  const holes = (s.template.match(/\{\}/g) ?? []).length;
  if (holes !== s.slots.length) problems.push(`${where}: ${holes} "{}" but ${s.slots.length} slots.`);
  for (const slot of s.slots) if (resolveRef(report.values, slot.ref) === null) problems.push(`${where}: slot "${slot.ref}" is not a path in the report values.`);
  return problems;
}

/** Problems with a reply's templates; empty when it can be rendered as written. */
export function templateProblems(out: ReviewOutputT, report: QualityReport, allow: NumberAllowance = allowedNumbers({ report })): string[] {
  const problems: string[] = [];
  const checkIds = new Set(report.checks.map((c) => c.id));
  const visit = (s: SentenceT, where: string) => problems.push(...sentenceProblems(s, where, report, allow));
  visit(out.headline, "headline");
  out.flags.forEach((f, i) => {
    if (!checkIds.has(f.check_id)) problems.push(`flags[${i}]: check ${f.check_id} is not in the report.`);
    visit(f.meaning, `flags[${i}].meaning`);
    if (f.try_next) visit(f.try_next, `flags[${i}].try_next`);
  });
  out.interpretation_risks.forEach((s, i) => visit(s, `interpretation_risks[${i}]`));
  out.next_experiments.forEach((e, i) => {
    visit(e.change, `next_experiments[${i}].change`);
    visit(e.why, `next_experiments[${i}].why`);
  });
  return problems;
}

// ---------------------------------------------------------------------------
// Deterministic repair.

/**
 * Keeps the sentences of a template that are valid on their own (no invented
 * number, every slot resolves), with their slots; null when none is. A slot
 * count that does not match the "{}" count cannot be split safely: null.
 */
export function repairSentence(s: SentenceT, report: QualityReport, allow: NumberAllowance): SentenceT | null {
  if (!sentenceProblems(s, "", report, allow).length) return s;
  if ((s.template.match(/\{\}/g) ?? []).length !== s.slots.length) return null;
  const kept: SentenceT[] = [];
  let next = 0;
  for (const part of s.template.split(/(?<=[.!?])\s+/)) {
    const n = (part.match(/\{\}/g) ?? []).length;
    const piece = { template: part, slots: s.slots.slice(next, next + n) };
    next += n;
    if (part.trim() && !sentenceProblems(piece, "", report, allow).length) kept.push(piece);
  }
  if (!kept.length) return null;
  return { template: kept.map((k) => k.template).join(" "), slots: kept.flatMap((k) => k.slots) };
}

export type Repaired = { headline: SentenceT | null; reply: ReviewOutputT; dropped: number; kept: number };

/**
 * Drops what cannot be rendered safely: sentences with a problem, flags for a
 * check not in the report, flags whose meaning is lost (a lost try_next
 * becomes null), experiments missing a half. headline is null when lost.
 */
export function repairReply(out: ReviewOutputT, report: QualityReport, allow: NumberAllowance): Repaired {
  const checkIds = new Set(report.checks.map((c) => c.id));
  let dropped = 0;
  const fix = (s: SentenceT) => {
    const r = repairSentence(s, report, allow);
    if (r !== s) dropped++;
    return r;
  };
  const headline = fix(out.headline);
  const flags: ReviewOutputT["flags"] = [];
  for (const f of out.flags) {
    if (!checkIds.has(f.check_id)) {
      dropped++;
      continue;
    }
    const meaning = fix(f.meaning);
    if (meaning) flags.push({ ...f, meaning, try_next: f.try_next ? fix(f.try_next) : null });
  }
  const risks = out.interpretation_risks.map(fix).filter((s): s is SentenceT => s !== null);
  const experiments: ReviewOutputT["next_experiments"] = [];
  for (const e of out.next_experiments) {
    const change = fix(e.change);
    const why = fix(e.why);
    if (change && why) experiments.push({ change, why });
  }
  const reply = { headline: headline ?? { template: "", slots: [] }, flags, interpretation_risks: risks, next_experiments: experiments };
  return { headline, reply, dropped, kept: (headline ? 1 : 0) + flags.length + risks.length + experiments.length };
}

/** Fills slots with the report's values (formatted by unit) and neutralizes the sentence. */
export function render(s: SentenceT, report: QualityReport): string {
  return neutralize(fillSlots(s.template, s.slots.map((x) => x.ref), report.values)).text;
}

function renderReview(reply: ReviewOutputT, report: QualityReport, model: string, usage: Usage, repaired: number, headline?: string): Review {
  return {
    headline: headline ?? render(reply.headline, report),
    flags: reply.flags.slice(0, 5).map((f) => ({ check_id: f.check_id, severity: f.severity, meaning: render(f.meaning, report), tryNext: f.try_next ? render(f.try_next, report) || null : null })),
    interpretationRisks: reply.interpretation_risks.slice(0, 4).map((s) => render(s, report)).filter(Boolean),
    nextExperiments: reply.next_experiments.slice(0, 3).map((e) => ({ change: render(e.change, report), why: render(e.why, report) })),
    model,
    usage,
    repaired,
  };
}

/** Falcon's own label sentence, for a reply whose headline could not be kept. */
function labelHeadline(report: QualityReport): string {
  return neutralize([`${report.label.title}.`, report.label.reasons[0] ?? ""].join(" ")).text;
}

function reviewInput(spec: StrategySpecV2, describe: SpecDescription, report: QualityReport, trials: number): string {
  const checks = report.checks.map((c) => ({ id: c.id, name: c.name, tier: c.tier, level: c.level, status: c.status, detail: c.detail }));
  return [
    `<intent>\n${spec.intent || spec.name}\n</intent>`,
    `<rules>\n${describe.rules.join("\n")}\n</rules>`,
    `<evidence_label>${report.label.title}: ${report.label.reasons.join(" ")}</evidence_label>`,
    `<checks>\n${JSON.stringify(checks)}\n</checks>`,
    `<values>\n${JSON.stringify(report.values)}\n</values>`,
    `<ledger>This is trial ${trials} of this strategy.</ledger>`,
  ].join("\n\n");
}

export async function review(
  input: { spec: StrategySpecV2; describe: SpecDescription; report: QualityReport; trials?: number },
  opts: {
    apiKey?: string | null;
    client?: MessagesClient;
    /**
     * Whole budget including the retry (default 50 s). The route passes what
     * is left of a 50 s deadline after the sign-in check (Netlify's limit is 60 s).
     */
    timeoutMs?: number;
    model?: string;
    effort?: "medium" | "high";
  } = {},
): Promise<ReviewResult> {
  const model = opts.model ?? REVIEW_MODEL;
  const budget = opts.timeoutMs ?? 50_000;
  const started = Date.now();
  let client = opts.client;
  if (!client) {
    const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) return { ok: false, reason: "unavailable", message: "Explain is not configured on this server." };
    client = new Anthropic({ apiKey, timeout: budget, maxRetries: 0 }) as unknown as MessagesClient;
  }
  const usage: Usage = { model, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, promptVersion: PROMPT_VERSION };
  const allow = allowedNumbers(input);
  const messages: unknown[] = [{ role: "user", content: reviewInput(input.spec, input.describe, input.report, input.trials ?? 1) }];
  // The best repaired reply so far, used when the retry cannot do better.
  let best: (Repaired & { model: string }) | null = null;
  const fromBest = (): ReviewResult | null =>
    best && best.kept > 0
      ? { ok: true, review: renderReview(best.reply, input.report, best.model, usage, best.dropped, best.headline ? undefined : labelHeadline(input.report)) }
      : null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = budget - (Date.now() - started);
    if (left < MIN_CALL_MS) return fromBest() ?? { ok: false, reason: "timeout", message: REVIEW_TIMEOUT_MESSAGE, usage };
    let msg: { model?: string; stop_reason?: string | null; content?: Array<{ type: string; text?: string }>; usage?: Record<string, number> };
    try {
      msg = (await client.beta.messages.create(
        {
          model,
          max_tokens: 6_000,
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
          output_config: { effort: opts.effort ?? "medium", format: betaZodOutputFormat(ReviewOutput) },
          system: [{ type: "text", text: REVIEW_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
          messages,
        } as never,
        { timeout: left } as never,
      )) as typeof msg;
    } catch (e) {
      if (e instanceof Anthropic.APIConnectionTimeoutError) return fromBest() ?? { ok: false, reason: "timeout", message: REVIEW_TIMEOUT_MESSAGE, usage };
      if (e instanceof Anthropic.APIError) {
        console.error("[backtest/ai] review API error", e.status, e.message);
        return fromBest() ?? { ok: false, reason: "unavailable", message: "Explain is unavailable right now.", usage };
      }
      throw e;
    }
    usage.calls++;
    usage.inputTokens += msg.usage?.input_tokens ?? 0;
    usage.outputTokens += msg.usage?.output_tokens ?? 0;
    usage.cacheReadTokens += msg.usage?.cache_read_input_tokens ?? 0;
    usage.cacheWriteTokens += msg.usage?.cache_creation_input_tokens ?? 0;
    usage.usd = costUsd(usage, model);
    if (msg.stop_reason === "refusal") return fromBest() ?? { ok: false, reason: "refusal", message: "Explain could not describe this report.", usage };
    let out: ReviewOutputT | null = null;
    try {
      const r = ReviewOutput.safeParse(JSON.parse((msg.content ?? []).find((b) => b.type === "text")?.text ?? ""));
      out = r.success ? r.data : null;
    } catch {
      out = null;
    }
    const problems = out ? templateProblems(out, input.report, allow) : ["The reply did not match the output schema."];
    if (out && !problems.length) return { ok: true, review: renderReview(out, input.report, msg.model ?? model, usage, 0) };
    if (out) {
      const fixed = repairReply(out, input.report, allow);
      // Good enough without a retry: the headline survived, and so did a flag when the reply had any.
      if (fixed.headline && (fixed.reply.flags.length > 0 || out.flags.length === 0)) {
        return { ok: true, review: renderReview(fixed.reply, input.report, msg.model ?? model, usage, fixed.dropped) };
      }
      const score = (r: Repaired) => (r.headline ? 100 : 0) + r.kept;
      if (!best || score(fixed) > score(best)) best = { ...fixed, model: msg.model ?? model };
    }
    messages.push({ role: "assistant", content: msg.content });
    messages.push({ role: "user", content: `The reply was rejected:\n${problems.slice(0, 10).map((p) => `- ${p}`).join("\n")}\nReturn the full corrected reply.` });
  }
  return fromBest() ?? { ok: false, reason: "invalid", message: "Explain could not produce a valid description. Try again.", usage };
}
