/**
 * The Strategy Lab conversation (design 3.1, M1c 1): plain words in, one of
 *   { questions }        at most 3 in the whole conversation, 2-4 tappable answers and a default each;
 *   { spec }             a StrategySpec v2 that passed zod and the FSL type checker;
 *   { not_a_strategy }   tips, predictions and advice requests.
 *
 * - claude-sonnet-5-5, structured output (betaZodOutputFormat), adaptive
 *   thinking at effort medium, server-side refusal fallback.
 * - The FSL reference is the system prompt, cached for 1 hour.
 * - One automatic repair: when the spec fails zod, the type checker or the
 *   ticker rule, the errors go back to the model once.
 * - Tickers are never chosen by the model: every ticker in the spec must
 *   appear in text the person typed (or be SPY, the market reference, or come
 *   from a Falcon universe or the spec being edited). Otherwise the turn
 *   becomes a question asking which tickers.
 * - Every model sentence passes neutralize(); the rules shown come from
 *   describe(spec), never from the model.
 */

import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod/v4";
import { neutralize, neutralizeList } from "../neutralize";
import { DEFAULT_SPEC_FIELDS, describeSpec, universeTickers, validateSpec, type SpecDescription, type SpecIssue, type StrategySpecV2 } from "../spec";
import { parse, walk } from "../fsl/parse";
import { UNIVERSES } from "../universes";
import { CONVERSE_SYSTEM, PROMPT_VERSION } from "./prompts";
import { costUsd, type Usage } from "./usage";

export const CONVERSE_MODEL = "claude-sonnet-5-5";
export const MAX_TEXT_CHARS = 4_000;
export const MAX_QUESTIONS = 3;

/**
 * The structured envelope. The spec itself travels as JSON text in the
 * StrategySpec v2 shape (spec_json): a strict schema for the whole spec
 * compiles to a grammar larger than the API accepts, and the spec is checked
 * by zod, the FSL type checker and one repair round anyway.
 */
export const TurnOutput = z.object({
  outcome: z.enum(["questions", "spec", "not_a_strategy"]),
  questions: z.array(
    z.object({
      id: z.string(),
      text: z.string(),
      options: z.array(z.object({ label: z.string() })),
      default_index: z.number().int(),
    }),
  ),
  assumptions: z.array(z.string()),
  not_expressible: z.array(z.string()),
  message: z.string().describe('For not_a_strategy: one neutral sentence. Otherwise ""'),
  spec_json: z.string().describe('For outcome "spec": the StrategySpec as a JSON object in text. Otherwise ""'),
});
type TurnOutputT = z.infer<typeof TurnOutput>;

export type Question = { id: string; text: string; options: string[]; defaultIndex: number };
export type Answer = { q: string; a: string; /** True when the person typed it (not a tapped option). */ typed: boolean };

export type ConverseInput = {
  /** The person's description, verbatim. */
  intent: string;
  /** Questions answered so far (each asked question counts toward the limit of 3). */
  answers: Answer[];
  /** Questions asked so far in this conversation. */
  questionsAsked?: number;
  /** A follow-up edit by chat: the current spec and the request. */
  edit?: { request: string; current: StrategySpecV2 } | null;
};

export type ConverseResult =
  | { kind: "questions"; questions: Question[]; assumptions: string[]; usage: Usage }
  | {
      kind: "spec";
      spec: StrategySpecV2;
      describe: SpecDescription;
      assumptions: string[];
      notExpressible: string[];
      repaired: boolean;
      usage: Usage;
    }
  | { kind: "not_a_strategy"; message: string; notExpressible: string[]; usage: Usage }
  | { kind: "error"; reason: "empty" | "too_long" | "unavailable" | "timeout" | "invalid" | "refusal"; message: string; issues?: SpecIssue[]; usage?: Usage };

type MessagesClient = { beta: { messages: { create: (params: never, options?: never) => Promise<unknown> } } };

export type ConverseOptions = {
  apiKey?: string | null;
  client?: MessagesClient;
  /** Whole turn budget including a repair. */
  timeoutMs?: number;
  now?: Date;
};

type BetaMessage = {
  model?: string;
  stop_reason?: string | null;
  content?: Array<{ type: string; text?: string }>;
  usage?: { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number; cache_creation_input_tokens?: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number } };
};

/**
 * The model's spec JSON as a StrategySpec v2: fields Falcon owns are set here
 * (spec_version, intent, clarifications; no legacy), missing optional fields
 * get their defaults, tickers are upper-cased. zod and the type checker run
 * afterwards. Returns null when the text is not a JSON object.
 */
export function modelToSpec(json: string, intent: string, clarifications: { q: string; a: string }[]): StrategySpecV2 | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const d = structuredClone(DEFAULT_SPEC_FIELDS);
  const obj = (v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null);
  const spec = {
    ...d,
    ...m,
    spec_version: 2,
    name: neutralize(typeof m.name === "string" ? m.name : "").text.slice(0, 80) || "Untitled strategy",
    intent: intent.slice(0, 4_000),
    clarifications: clarifications.slice(0, 6).map((c) => ({ q: c.q.slice(0, 400), a: c.a.slice(0, 400) })),
    params: obj(m.params) ?? {},
    defs: obj(m.defs) ?? {},
    risk: { ...d.risk, ...(obj(m.risk) ?? {}) },
    execution: { ...d.execution, ...(obj(m.execution) ?? {}) },
    period: { ...d.period, ...(obj(m.period) ?? {}) },
    side: "long",
    holdout: "off",
  } as Record<string, unknown>;
  delete spec.legacy;
  const u = obj(spec.universe);
  if (u && Array.isArray(u.tickers)) u.tickers = u.tickers.map((t) => (typeof t === "string" ? t.trim().toUpperCase() : t));
  if (u && u.kind === "rule" && u.filter === undefined) u.filter = null;
  const p = obj(spec.portfolio);
  if (p?.mode === "weights" && obj(p.weights)) {
    const w: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj(p.weights)!)) w[k.trim().toUpperCase()] = v;
    p.weights = w;
    if (!u || u.kind !== "static") spec.universe = { kind: "static", tickers: Object.keys(w) };
    else u.tickers = Object.keys(w);
  }
  if (p?.mode === "rules") {
    p.exit ??= null;
    p.clock ??= "close";
    p.reentry ??= "edge";
    p.tiebreak ??= "seeded";
    p.sizing ??= "equal";
  }
  if (p?.mode === "rank") {
    p.filter ??= null;
    p.weighting ??= "equal";
  }
  for (const k of ["start", "end"] as const) {
    const per = spec.period as Record<string, unknown>;
    if (per[k] === "") per[k] = null;
  }
  return spec as unknown as StrategySpecV2;
}

/** Every ticker a spec names: universe, weights keys, at/of/w strings in any formula. */
export function specTickers(spec: StrategySpecV2): string[] {
  const out = new Set<string>();
  if (spec.universe.kind === "static") spec.universe.tickers.forEach((t) => out.add(t.toUpperCase()));
  if (spec.portfolio.mode === "weights") Object.keys(spec.portfolio.weights).forEach((t) => out.add(t.toUpperCase()));
  const formulas: string[] = [...Object.values(spec.defs)];
  const p = spec.portfolio;
  if (p.mode === "rules") formulas.push(p.entry, p.exit ?? "", p.tiebreak !== "seeded" ? p.tiebreak.by : "");
  if (p.mode === "rank") formulas.push(p.score, p.filter ?? "");
  if (p.mode === "weights") formulas.push(...Object.values(p.weights));
  if (p.mode === "event_study") formulas.push(p.event, p.targets);
  if (spec.universe.kind === "rule" && spec.universe.filter) formulas.push(spec.universe.filter);
  for (const f of formulas) {
    if (!f.trim()) continue;
    try {
      walk(parse(f), (n) => {
        if (n.k === "call" && (n.fn === "at" || n.fn === "of" || n.fn === "w") && n.args[0]?.k === "str") out.add(n.args[0].v.toUpperCase());
      });
    } catch {
      // The type checker reports it.
    }
  }
  return Array.from(out);
}

function mentions(text: string, ticker: string): boolean {
  const up = text.toUpperCase();
  const variants = new Set([ticker, ticker.replace(/-/g, "."), ticker.replace(/\./g, "-")]);
  for (const v of Array.from(variants)) {
    const esc = v.replace(/[.^$*+?()[\]{}|\\-]/g, "\\$&");
    if (new RegExp(`(^|[^A-Z0-9])\\$?${esc}($|[^A-Z0-9])`).test(up)) return true;
  }
  return false;
}

/** Tickers in the spec the person never typed (SPY, Falcon universes and the spec being edited are allowed). */
export function untypedTickers(spec: StrategySpecV2, input: ConverseInput): string[] {
  const typed = [input.intent, input.edit?.request ?? "", ...input.answers.filter((a) => a.typed).map((a) => a.a)].join("\n");
  const allowed = new Set<string>(["SPY"]);
  if (input.edit) specTickers(input.edit.current).forEach((t) => allowed.add(t));
  if (spec.universe.kind === "rule") UNIVERSES[spec.universe.base].tickers.forEach((t) => allowed.add(t));
  return specTickers(spec).filter((t) => !allowed.has(t) && !mentions(typed, t));
}

const TICKERS_QUESTION: Question = {
  id: "tickers",
  text: "Which tickers does the strategy trade? Falcon uses only tickers you list, so the test does not pick today's winners.",
  options: ["I will type the tickers", "Falcon semiconductors list (58 names, today's membership)", "The 11 sector SPDR ETFs"],
  defaultIndex: 0,
};

function cleanQuestions(qs: TurnOutputT["questions"], input: ConverseInput): Question[] {
  const typed = [input.intent, ...input.answers.filter((a) => a.typed).map((a) => a.a)].join("\n");
  return qs.slice(0, MAX_QUESTIONS).flatMap((q) => {
    const text = neutralize(q.text).text;
    // Options must not slip in tickers the person never typed.
    let options = q.options
      .map((o) => neutralize(o.label).text.slice(0, 120))
      .filter((o) => {
        const caps = (o.match(/\b[A-Z]{2,5}\b/g) ?? []).filter((w) => !["ETF", "ETFS", "SPDR", "RSI", "SPY", "EPS", "ATR", "MACD", "USD", "NYSE"].includes(w));
        return o && caps.filter((c) => !mentions(typed, c)).length < 2;
      });
    options = Array.from(new Set(options)).slice(0, 4);
    if (!text || options.length < 2) return [];
    const defaultIndex = Math.min(options.length - 1, Math.max(0, q.default_index));
    return [{ id: q.id.replace(/[^a-z0-9_]/gi, "_").slice(0, 40) || "q", text, options, defaultIndex }];
  });
}

/** ANTHROPIC_API_KEY from the environment (the routes pass it explicitly). */
function clientFor(opts: ConverseOptions, timeoutMs: number): MessagesClient | null {
  if (opts.client) return opts.client;
  const apiKey = opts.apiKey ?? process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return null;
  return new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 }) as unknown as MessagesClient;
}

function userMessage(input: ConverseInput, now: Date): string {
  const asked = input.questionsAsked ?? input.answers.length;
  const parts = [
    `Today's date: ${now.toISOString().slice(0, 10)}`,
    `Questions asked so far: ${asked} of ${MAX_QUESTIONS}.${asked >= MAX_QUESTIONS ? " No questions are left: compile with defaults stated as assumptions." : ""}`,
    `<strategy_description>\n${input.intent}\n</strategy_description>`,
  ];
  if (input.answers.length) {
    parts.push(
      `<answers>\n${input.answers.map((a) => `Q: ${a.q}\nA (${a.typed ? "typed by the person" : "tapped option"}): ${a.a}`).join("\n")}\n</answers>`,
    );
  }
  if (input.edit) {
    parts.push(`<current_spec>\n${JSON.stringify(input.edit.current)}\n</current_spec>`);
    parts.push(`<edit_request>\n${input.edit.request}\n</edit_request>`);
  }
  return parts.join("\n\n");
}

async function call(client: MessagesClient, messages: unknown[], timeoutMs: number): Promise<BetaMessage> {
  const params = {
    model: CONVERSE_MODEL,
    max_tokens: 8_000,
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    output_config: { effort: "medium", format: betaZodOutputFormat(TurnOutput) },
    system: [{ type: "text", text: CONVERSE_SYSTEM, cache_control: { type: "ephemeral", ttl: "1h" } }],
    messages,
  };
  return (await client.beta.messages.create(params as never, { timeout: timeoutMs } as never)) as BetaMessage;
}

function addUsage(u: Usage, m: BetaMessage) {
  u.calls++;
  u.inputTokens += m.usage?.input_tokens ?? 0;
  u.outputTokens += m.usage?.output_tokens ?? 0;
  u.cacheReadTokens += m.usage?.cache_read_input_tokens ?? 0;
  u.cacheWriteTokens += m.usage?.cache_creation_input_tokens ?? 0;
  u.usd = costUsd(u, CONVERSE_MODEL);
  if (m.model) u.model = m.model;
}

function parseOut(m: BetaMessage): TurnOutputT | null {
  const text = (m.content ?? []).find((b) => b.type === "text" && typeof b.text === "string")?.text ?? "";
  try {
    const r = TurnOutput.safeParse(JSON.parse(text));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/** One conversation turn. Never throws for API problems; the result says what happened. */
export async function converse(input: ConverseInput, opts: ConverseOptions = {}): Promise<ConverseResult> {
  const intent = (input.intent ?? "").trim();
  if (!intent) return { kind: "error", reason: "empty", message: "Describe a strategy to test." };
  const total = [intent, input.edit?.request ?? "", ...input.answers.map((a) => a.a)].join("").length;
  if (total > MAX_TEXT_CHARS) return { kind: "error", reason: "too_long", message: `Keep the description under ${MAX_TEXT_CHARS} characters.` };
  const budget = opts.timeoutMs ?? 22_000;
  const started = Date.now();
  const client = clientFor(opts, budget);
  if (!client) return { kind: "error", reason: "unavailable", message: "The strategy assistant is not configured on this server." };
  const now = opts.now ?? new Date();
  const usage: Usage = { model: CONVERSE_MODEL, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, usd: 0, promptVersion: PROMPT_VERSION };
  const messages: unknown[] = [{ role: "user", content: userMessage({ ...input, intent }, now) }];
  const clarifications = input.answers.map((a) => ({ q: a.q, a: a.a }));
  const asked = input.questionsAsked ?? input.answers.length;

  let repaired = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    const left = budget - (Date.now() - started);
    if (left < 4_000) return { kind: "error", reason: "timeout", message: "Reading the strategy took too long. Try again.", usage };
    let msg: BetaMessage;
    try {
      msg = await call(client, messages, left);
    } catch (e) {
      if (e instanceof Anthropic.APIConnectionTimeoutError) return { kind: "error", reason: "timeout", message: "Reading the strategy took too long. Try again.", usage };
      if (e instanceof Anthropic.RateLimitError) return { kind: "error", reason: "unavailable", message: "Too many strategies are being read right now. Try again in a minute.", usage };
      if (e instanceof Anthropic.APIError) {
        console.error("[backtest/ai] Claude API error", e.status, e.message);
        return { kind: "error", reason: "unavailable", message: "The strategy assistant is unavailable right now.", usage };
      }
      throw e;
    }
    addUsage(usage, msg);
    if (msg.stop_reason === "refusal") return { kind: "error", reason: "refusal", message: "This description could not be turned into rules. Try describing the rules differently.", usage };
    const out = msg.stop_reason === "max_tokens" ? null : parseOut(msg);
    const notExpressible = out ? neutralizeList(out.not_expressible).items : [];
    const assumptions = out ? neutralizeList(out.assumptions).items : [];
    let problems: string[] = [];
    let issues: SpecIssue[] | undefined;

    if (!out) problems = ["The reply did not match the output schema."];
    else if (out.outcome === "not_a_strategy") {
      const m = out.message ? neutralize(out.message).text : "";
      return {
        kind: "not_a_strategy",
        message: m || 'Falcon tests rules you write, for example "Hold SPY while it closes above its 200-day average."',
        notExpressible,
        usage,
      };
    } else if (out.outcome === "questions") {
      const qs = cleanQuestions(out.questions, input);
      if (asked < MAX_QUESTIONS && qs.length) return { kind: "questions", questions: qs.slice(0, MAX_QUESTIONS - asked), assumptions, usage };
      problems = [asked >= MAX_QUESTIONS ? "No questions are left; return a spec with defaults stated as assumptions." : "The questions need 2 to 4 answer options each."];
    } else {
      const spec = modelToSpec(out.spec_json, intent, clarifications);
      if (!spec) problems = ['outcome is "spec" but spec_json is not a JSON object.'];
      else {
      const check = validateSpec(spec, now);
      if (!check.ok) {
        issues = check.issues;
        problems = check.issues.map((i) => `${i.path}: ${i.message}${i.hint ? ` (${i.hint})` : ""}`);
      } else {
        const untyped = untypedTickers(check.spec, { ...input, intent });
        if (untyped.length) {
          problems = [`The tickers ${untyped.join(", ")} were not typed by the person. Do not choose tickers; ask which tickers they mean (outcome "questions"), or use a Falcon universe.`];
          if (attempt === 1 || asked >= MAX_QUESTIONS) {
            if (asked < MAX_QUESTIONS) return { kind: "questions", questions: [TICKERS_QUESTION], assumptions, usage };
          }
        } else {
          return {
            kind: "spec",
            spec: check.spec,
            describe: describeSpec(check.spec, check.uses),
            assumptions,
            notExpressible,
            repaired,
            usage,
          };
        }
      }
      }
    }
    if (attempt === 1) {
      return { kind: "error", reason: "invalid", message: "The strategy could not be compiled into rules Falcon can run. Try rephrasing it, or edit the formula directly.", issues, usage };
    }
    repaired = true;
    messages.push({ role: "assistant", content: msg.content });
    messages.push({
      role: "user",
      content: `Falcon's checks rejected that reply:\n${problems.slice(0, 8).map((p) => `- ${p}`).join("\n")}\nReturn the full corrected reply.`,
    });
  }
  return { kind: "error", reason: "invalid", message: "The strategy could not be compiled.", usage };
}

export { universeTickers };
