import type {
  Agent,
  AgentDraft,
  AgentMessage,
  AgentMetric,
  AgentMetricReading,
  AgentReport,
  AgentTrigger,
} from "../../shared/agent-types";
import { cleanModelText, copyIssues, enforceCopy, enforceLine } from "./copy";
import { REPORT_SYSTEM, draftSystem, replySystem } from "./prompts";
import { corpusNumbers, ungroundedNumbers } from "./grounding";
import type { ReportMaterial } from "./gather";
import type { AgentDataSources } from "./sources";
import type { TriggerEvent } from "./triggers";
import { clarifyFor, endsFromWords } from "./ends";
import { DEFAULT_CHANNELS, LIMITS, cleanBlock, cleanLine, defaultName, normalizeTicker, validateEnds, validateMetrics, validateTrigger } from "./validate";

/**
 * The agent engine's three model tasks: turn a reader's words into a draft,
 * write the update when an event fires, and answer the reader's questions.
 *
 * All three go through `AgentModelCaller`, one structured-JSON call (the live
 * one is the Claude API, see `anthropic.ts`; tests pass a fake). Each task:
 *   1. asks with the house rules in the system prompt,
 *   2. parses and validates the JSON, asking once more with the error when it
 *      does not parse or does not fit,
 *   3. checks the prose against the copy rules and every figure against the
 *      material, asking once more with the list of problems,
 *   4. enforces the rules itself on what comes back: dashes and tics fixed,
 *      banned words swapped or the sentence dropped, unsourced figures out.
 */

export type AgentModelCall = {
  purpose: "draft" | "report" | "reply";
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens: number;
  timeoutMs: number;
};

/** One call; resolves to the reply text (expected to be JSON). */
export type AgentModelCaller = (call: AgentModelCall) => Promise<string>;

/** The reply did not parse or did not fit its schema; carries the reason. */
class ModelShapeError extends Error {}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    // A preamble or fence around the object: take the outermost braces.
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        // fall through
      }
    }
    throw new ModelShapeError("the reply was not valid JSON");
  }
}

/** Calls, parses, validates; one retry with the reason when the reply does not fit. */
export async function callJson<T>(
  caller: AgentModelCaller,
  call: AgentModelCall,
  parse: (value: unknown) => T,
): Promise<T> {
  let reason = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const user =
      attempt === 0
        ? call.user
        : `${call.user}\n\nYOUR PREVIOUS REPLY WAS REJECTED: ${reason}. Reply again with one JSON object that fits the schema exactly.`;
    const text = await caller({ ...call, user });
    try {
      return parse(parseJsonText(text));
    } catch (err) {
      if (!(err instanceof ModelShapeError)) throw err;
      reason = err.message;
    }
  }
  throw new Error(`The model's answer could not be read (${reason})`);
}

function obj(value: unknown, what: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ModelShapeError(`${what} must be an object`);
  return value as Record<string, unknown>;
}

function str(value: unknown, what: string): string {
  if (typeof value !== "string") throw new ModelShapeError(`${what} must be a string`);
  return value;
}

function optStr(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/* ------------------------------------------------------------------ */
/* Draft                                                                */
/* ------------------------------------------------------------------ */

const nullable = (type: string) => ({ type: [type, "null"] });
/**
 * A string from a fixed list, or null. Written as `anyOf` because structured
 * outputs reject an `enum` holding null under a `["string", "null"]` type
 * array ("Enum value ... does not match declared type"), a 400 on every draft.
 */
const nullableEnum = (values: readonly string[]) => ({ anyOf: [{ type: "string", enum: values }, { type: "null" }] });

export const DRAFT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["name", "ticker", "companyName", "triggers", "metrics", "instructions", "oneShot", "ends", "clarify", "notes"],
  properties: {
    name: { type: "string" },
    ticker: nullable("string"),
    companyName: nullable("string"),
    triggers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "ticker", "moment", "forms", "insiderBuysOnly", "thresholdPct", "window", "keywords", "event", "cadence", "time", "weekday"],
        properties: {
          kind: { type: "string", enum: ["earnings", "filing", "price_move", "news", "macro", "schedule"] },
          ticker: nullable("string"),
          moment: nullableEnum(["release", "call"]),
          forms: { type: ["array", "null"], items: { type: "string" } },
          insiderBuysOnly: nullable("boolean"),
          thresholdPct: nullable("number"),
          window: nullableEnum(["intraday", "1d", "5d"]),
          keywords: { type: ["array", "null"], items: { type: "string" } },
          event: nullable("string"),
          cadence: nullableEnum(["daily", "weekdays", "weekly"]),
          time: nullable("string"),
          weekday: nullable("integer"),
        },
      },
    },
    metrics: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "expectation"],
        properties: { label: { type: "string" }, expectation: nullable("string") },
      },
    },
    instructions: nullable("string"),
    oneShot: { type: "boolean" },
    // Plain strings, not nullable ones: structured outputs cap a schema at 16
    // union-typed parameters, and the triggers already use most of them.
    // ends: "" | "earnings" | "date YYYY-MM-DD" | "filing <form>".
    ends: { type: "string" },
    clarify: { type: "string", enum: ["none", "subject", "trigger"] },
    notes: { type: "array", items: { type: "string" } },
  },
} as const;

export type DraftDeps = { caller: AgentModelCaller | null; sources: Pick<AgentDataSources, "lookupTicker" | "searchCompany">; today: string };

type RawTrigger = Record<string, unknown>;

function withoutNulls(raw: RawTrigger): RawTrigger {
  const out: RawTrigger = {};
  for (const [k, v] of Object.entries(raw)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

function parseDraftReply(value: unknown): {
  name: string;
  ticker: string | null;
  companyName: string | null;
  triggers: RawTrigger[];
  metrics: Array<{ label: string; expectation: string | null }>;
  instructions: string | null;
  oneShot: boolean;
  ends: RawTrigger | null;
  clarify: "subject" | "trigger" | null;
  notes: string[];
} {
  const o = obj(value, "the reply");
  if (!Array.isArray(o.triggers)) throw new ModelShapeError("triggers must be an array");
  if (!Array.isArray(o.metrics)) throw new ModelShapeError("metrics must be an array");
  return {
    name: str(o.name, "name"),
    ticker: optStr(o.ticker),
    companyName: optStr(o.companyName),
    triggers: o.triggers.map((t, i) => obj(t, `triggers[${i}]`)),
    metrics: o.metrics.map((m, i) => {
      const mo = obj(m, `metrics[${i}]`);
      return { label: str(mo.label, `metrics[${i}].label`), expectation: optStr(mo.expectation) };
    }),
    instructions: optStr(o.instructions),
    oneShot: typeof o.oneShot === "boolean" ? o.oneShot : false,
    // Both optional on the way in: a gateway that ignores the schema, or an
    // older reply shape, still reads.
    ends: parseEndsField(o.ends),
    clarify: o.clarify === "subject" || o.clarify === "trigger" ? o.clarify : null,
    notes: Array.isArray(o.notes) ? o.notes.filter((n): n is string => typeof n === "string") : [],
  };
}

/**
 * The draft's `ends` as the model writes it ("date 2026-12-31", "earnings",
 * "filing 10-K", or "" for none), or as an object from a gateway that
 * ignored the schema. Null when there is nothing usable.
 */
export function parseEndsField(value: unknown): RawTrigger | null {
  if (value && typeof value === "object" && !Array.isArray(value)) return (value as RawTrigger).kind ? (value as RawTrigger) : null;
  if (typeof value !== "string") return null;
  const v = value.trim();
  const date = /^date\s+(\d{4}-\d{2}-\d{2})$/i.exec(v);
  if (date) return { kind: "date", date: date[1] };
  if (/^earnings$/i.test(v)) return { kind: "earnings" };
  const form = /^filing\s+(.+)$/i.exec(v);
  if (form) return { kind: "filing", form: form[1]!.trim() };
  return null;
}

/**
 * Checks the draft's tickers against the US stock catalog: a listed ticker
 * gets its catalog name; an unknown one is looked up by the company name the
 * model gave; failing that it is dropped with a note, along with the triggers
 * that needed it. An unreachable catalog keeps the ticker and says so.
 */
export async function resolveDraftTickers(
  draft: { ticker?: string; companyName?: string; triggers: AgentTrigger[] },
  sources: Pick<AgentDataSources, "lookupTicker" | "searchCompany">,
  notes: string[],
): Promise<{ ticker?: string; companyName?: string; triggers: AgentTrigger[] }> {
  const verdicts = new Map<string, string | null>();
  let catalogDown = false;
  const check = async (ticker: string, companyHint?: string): Promise<string | null> => {
    if (verdicts.has(ticker)) return verdicts.get(ticker)!;
    let resolved: string | null = null;
    try {
      const hit = await sources.lookupTicker(ticker);
      if (hit) {
        resolved = hit.symbol;
        if (ticker === draft.ticker) draft.companyName = hit.companyName;
      } else if (companyHint) {
        const matches = await sources.searchCompany(companyHint);
        const first = matches.find((m) => m !== null) ?? null;
        if (first) {
          resolved = first.symbol;
          if (ticker === draft.ticker) draft.companyName = first.companyName;
          notes.push(`${ticker} is not a listed ticker; used ${first.symbol} (${first.companyName}).`);
        }
      }
      if (!resolved) notes.push(`${ticker} is not in the US stock list, so it was left out.`);
    } catch {
      catalogDown = true;
      resolved = ticker;
    }
    verdicts.set(ticker, resolved);
    return resolved;
  };

  let ticker = draft.ticker;
  if (ticker) ticker = (await check(ticker, draft.companyName)) ?? undefined;
  const triggers: AgentTrigger[] = [];
  for (const t of draft.triggers) {
    if (!("ticker" in t) || !t.ticker) {
      triggers.push(t);
      continue;
    }
    const resolved = await check(t.ticker, t.ticker === draft.ticker ? draft.companyName : undefined);
    if (resolved) triggers.push({ ...t, ticker: resolved } as AgentTrigger);
  }
  if (catalogDown) notes.push("The stock list could not be reached, so tickers were not checked.");
  return { ticker, companyName: ticker ? draft.companyName : undefined, triggers };
}

/** The reader's words as an editable draft. Never throws for content: problems become notes. */
export async function draftFromBriefWithModel(briefRaw: string, deps: DraftDeps): Promise<AgentDraft> {
  const brief = cleanBlock(briefRaw, LIMITS.briefChars);
  if (!brief) throw new Error("Describe what the agent watches for.");
  if (!deps.caller) return heuristicDraft(brief, deps);

  const reply = await callJson(
    deps.caller,
    {
      purpose: "draft",
      system: draftSystem(deps.today),
      user: `THE READER'S REQUEST, VERBATIM:\n${brief}`,
      schema: DRAFT_SCHEMA as unknown as Record<string, unknown>,
      maxTokens: 2000,
      timeoutMs: 45_000,
    },
    parseDraftReply,
  );

  const notes = reply.notes.map((n) => enforceLine(n, "")).filter(Boolean);
  const primary = normalizeTicker(reply.ticker) ?? undefined;
  if (reply.ticker && !primary) notes.push(`"${cleanLine(reply.ticker, 20)}" is not a ticker, so it was left out.`);
  const triggers: AgentTrigger[] = [];
  for (const raw of reply.triggers.slice(0, LIMITS.triggers)) {
    try {
      triggers.push(validateTrigger(withoutNulls(raw), primary));
    } catch (err) {
      notes.push(`One trigger was left out: ${err instanceof Error ? err.message : String(err)}.`);
    }
  }
  let metrics: AgentMetric[] = [];
  try {
    metrics = validateMetrics(
      reply.metrics.slice(0, LIMITS.metrics).map((m) => ({ label: enforceLine(m.label, m.label), expectation: m.expectation ?? undefined })),
    );
  } catch (err) {
    notes.push(err instanceof Error ? err.message : String(err));
  }

  const resolved = await resolveDraftTickers(
    { ticker: primary, companyName: reply.companyName ? cleanLine(reply.companyName, 120) : undefined, triggers },
    deps.sources,
    notes,
  );
  if (resolved.triggers.length === 0) notes.push("No trigger could be set from the request. Pick one before saving.");

  const draft: AgentDraft = {
    name: enforceLine(cleanLine(reply.name, LIMITS.nameChars), defaultName(resolved.ticker, resolved.triggers)),
    brief,
    triggers: resolved.triggers,
    metrics,
    channels: [...DEFAULT_CHANNELS],
    oneShot: reply.oneShot,
  };
  if (resolved.ticker) draft.ticker = resolved.ticker;
  if (resolved.companyName) draft.companyName = resolved.companyName;
  if (reply.ends) {
    try {
      const ends = validateEnds(withoutNulls(reply.ends), resolved.ticker);
      if (ends) draft.ends = ends;
    } catch {
      // An end that does not fit is proposed afresh by the engine.
    }
  }
  // The model's own wish to ask is not enough: the question comes only when
  // nothing could be set up from the words (see `clarifyFor`).
  const clarify = clarifyFor(draft);
  if (clarify) draft.clarify = clarify;
  const instructions = reply.instructions ? enforceCopy(cleanBlock(reply.instructions, LIMITS.instructionsChars)) : "";
  if (instructions) draft.instructions = instructions;
  if (notes.length > 0) draft.notes = [...new Set(notes)].slice(0, LIMITS.notes);
  return draft;
}

/** Words that carry no topic: verbs of asking, time words, filler. */
const NOT_TOPIC = new Set(
  ("a an the and or of for to in on at about with from by me my i you it its their them us our any all every each " +
    "tell let know keep posted watch track follow monitor alert notify send give show write report reports reporting " +
    "news headline headlines material important big major new latest overnight today tonight yesterday tomorrow " +
    "morning evening night day days daily week weekly weekday weekdays month monthly time times when whenever which " +
    "what who that this these those there had has have is are was were be been being do does did please summary " +
    "update updates digest brief note notes stock stocks share shares name names company companies market markets").split(" "),
);

/**
 * The topic of a request about no one company, as headline keywords:
 * "which semiconductor suppliers had material news" gives semiconductor and
 * suppliers; "watch tech" gives tech. Empty when there is none.
 */
export function topicKeywords(brief: string): string[] {
  const lower = brief.toLowerCase();
  const phrase =
    /\bwhich ([a-z][a-z0-9 &-]{2,60}?) (?:had|have|has|filed|reported|moved|announced)\b/.exec(lower)?.[1] ??
    /\b(?:news|headlines) (?:about|on|from|mentioning|around) ([a-z][a-z0-9 &-]{2,60})/.exec(lower)?.[1] ??
    /\b(?:watch|track|follow|monitor|keep an eye on|tell me about|anything about|about) ([a-z][a-z0-9 &-]{2,60})/.exec(lower)?.[1] ??
    "";
  return [...new Set(phrase.split(/[\s,&]+/).map((w) => w.replace(/[^a-z0-9-]/g, "")).filter((w) => w.length >= 3 && !NOT_TOPIC.has(w)))].slice(0, 4);
}

/**
 * A draft without the model, for when the model is not reachable: tickers the
 * reader typed (checked against the catalog), and the trigger kind their words
 * name. Plainly marked as such in the notes.
 */
export async function heuristicDraft(brief: string, deps: Pick<DraftDeps, "sources">): Promise<AgentDraft> {
  const notes = ["Drafted without the model, which was not reachable. Check every field."];
  const lower = brief.toLowerCase();
  const candidates = [...new Set((brief.match(/\$?\b[A-Z]{1,5}(?:\.[A-Z])?\b/g) ?? []).map((t) => t.replace(/^\$/, "")))].filter(
    (t) => !["I", "A", "CEO", "CFO", "EPS", "CPI", "PPI", "FOMC", "GDP", "PCE", "NFP", "US", "USA", "SEC", "ET", "AI", "Q1", "Q2", "Q3", "Q4"].includes(t),
  );
  let ticker: string | undefined;
  let companyName: string | undefined;
  for (const c of candidates) {
    try {
      const hit = await deps.sources.lookupTicker(c);
      if (hit) {
        ticker = hit.symbol;
        companyName = hit.companyName;
        break;
      }
    } catch {
      ticker = normalizeTicker(c) ?? undefined;
      notes.push("The stock list could not be reached, so the ticker was not checked.");
      break;
    }
  }
  const triggers: AgentTrigger[] = [];
  const pct = lower.match(/(\d+(?:\.\d+)?)\s?%/);
  if (/\bcpi\b|inflation/.test(lower)) triggers.push({ kind: "macro", event: "CPI" });
  else if (/\bfomc\b|\bfed\b|rate decision/.test(lower)) triggers.push({ kind: "macro", event: "FOMC" });
  else if (/payroll|jobs report/.test(lower)) triggers.push({ kind: "macro", event: "NFP" });
  if (ticker) {
    if (/earnings|results|report(s|ing)?\b|quarter/.test(lower)) triggers.push({ kind: "earnings", ticker, moment: /\bcall\b/.test(lower) ? "call" : "release" });
    if (/insider|form 4/.test(lower)) triggers.push({ kind: "filing", ticker, forms: ["4"], insiderBuysOnly: /buy|purchas/.test(lower) });
    else if (/8-k|10-q|10-k|filing|files/.test(lower)) {
      const forms = ["8-K", "10-Q", "10-K"].filter((f) => lower.includes(f.toLowerCase()));
      triggers.push({ kind: "filing", ticker, forms: forms.length > 0 ? forms : ["8-K"] });
    }
    if (pct && /move|drop|fall|jump|rise|moves|swing/.test(lower)) {
      triggers.push({ kind: "price_move", ticker, thresholdPct: Math.min(50, Math.max(0.5, Number(pct[1]))), window: /week|5.?day/.test(lower) ? "5d" : "1d" });
    }
    if (/\bnews\b|headline/.test(lower)) triggers.push({ kind: "news", ticker, keywords: [] });
  }
  // No company: a topic in the words becomes keywords on the market's headlines.
  const topic = ticker || triggers.some((t) => t.kind === "macro") ? [] : topicKeywords(brief);
  const scheduled = /every (day|morning|weekday|week)|each (day|morning|weekday)|daily|weekly/.test(lower);
  if (scheduled) {
    const weekly = /every week(?!day)|weekly/.test(lower);
    const daily = /every day|each day|daily/.test(lower);
    const time = /\b([01]?\d|2[0-3]):([0-5]\d)\b/.exec(brief);
    const at = time ? `${time[1]!.padStart(2, "0")}:${time[2]}` : "08:00";
    const keywords = topic.length > 0 ? { keywords: topic } : {};
    triggers.push(
      weekly
        ? { kind: "schedule", cadence: "weekly", time: at, weekday: 1, ...keywords }
        : { kind: "schedule", cadence: daily ? "daily" : "weekdays", time: at, ...keywords },
    );
    if (!time) notes.push("The digest time was set to 08:00. Change it if you meant another time.");
  } else if (!ticker && topic.length > 0) {
    triggers.push({ kind: "news", keywords: topic });
  } else if (!ticker && triggers.length === 0 && /\bmarket\b/.test(lower) && /\bnews\b|headline/.test(lower)) {
    triggers.push({ kind: "news", keywords: [] });
  }
  if (triggers.length === 0) notes.push("No trigger could be read from the request. Pick one before saving.");
  // "I care about X, Y and Z" (or "interested in", "focus on") names the metrics.
  const named = brief.match(/\b(?:care about|interested in|focus on)\s+([^.;\n]+)/i)?.[1] ?? "";
  const labels = named
    .split(/,\s*(?:and\s+)?|\s+and\s+/i)
    .map((l) => cleanLine(l.replace(/^(the|their|its)\s+/i, ""), LIMITS.metricLabelChars))
    .filter((l) => l.length >= 3 && l.split(" ").length <= 6)
    .slice(0, LIMITS.metrics);
  const draft: AgentDraft = {
    name: defaultName(ticker, triggers),
    brief,
    triggers: triggers.slice(0, LIMITS.triggers),
    metrics: labels.map((label, i) => ({ id: `m${i + 1}`, label: label.charAt(0).toUpperCase() + label.slice(1) })),
    channels: [...DEFAULT_CHANNELS],
    oneShot: triggers.length > 0 && triggers.every((t) => t.kind === "earnings") && !/every|each|always/.test(lower),
    notes,
  };
  if (ticker) draft.ticker = ticker;
  if (companyName) draft.companyName = companyName;
  const ends = endsFromWords(brief, ticker);
  if (ends) draft.ends = ends;
  const clarify = clarifyFor(draft);
  if (clarify) draft.clarify = clarify;
  return draft;
}

/* ------------------------------------------------------------------ */
/* Report                                                               */
/* ------------------------------------------------------------------ */

export const REPORT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "summary", "readings", "sources"],
  properties: {
    headline: { type: "string" },
    summary: { type: "string" },
    readings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["metricId", "value", "verdict", "comparison"],
        properties: {
          metricId: { type: "string" },
          value: { type: "string" },
          verdict: { type: "string", enum: ["above", "below", "inline", "unclear"] },
          comparison: nullable("string"),
        },
      },
    },
    sources: { type: "array", items: { type: "integer" } },
  },
} as const;

export type ReportDeps = { caller: AgentModelCaller | null; newId: () => string; now: Date };

function reportUser(agent: Agent, event: TriggerEvent, material: ReportMaterial): string {
  const lines: string[] = [
    "THE AGENT",
    `Name: ${agent.name}`,
    `The reader's request: ${agent.brief}`,
  ];
  if (agent.instructions) lines.push(`The reader's instructions for the write-up: ${agent.instructions}`);
  if (agent.ticker) lines.push(`Company: ${agent.ticker}${agent.companyName ? ` (${agent.companyName})` : ""}`);
  lines.push("", "METRICS");
  if (agent.metrics.length === 0) lines.push("(none: readings is an empty array)");
  for (const m of agent.metrics) lines.push(`- ${m.id}: ${m.label}${m.expectation ? `; the reader's bar: ${m.expectation}` : ""}`);
  lines.push("", "WHAT HAPPENED", event.title, "", "FACTS", ...material.facts.map((f) => `- ${f}`));
  for (const d of material.documents) lines.push("", `DOCUMENT: ${d.title}${d.url ? ` (${d.url})` : ""}`, d.text);
  lines.push("", "SOURCES");
  material.sources.forEach((s, i) => lines.push(`${i + 1}. ${s.title}${s.publishedAt ? ` (${s.publishedAt.slice(0, 10)})` : ""}`));
  return lines.join("\n");
}

type ReportReply = {
  headline: string;
  summary: string;
  readings: Array<{ metricId: string; value: string; verdict: AgentMetricReading["verdict"]; comparison: string | null }>;
  sources: number[];
};

function parseReportReply(metrics: AgentMetric[]) {
  return (value: unknown): ReportReply => {
    const o = obj(value, "the reply");
    const readingsRaw = Array.isArray(o.readings) ? o.readings : null;
    if (!readingsRaw) throw new ModelShapeError("readings must be an array");
    const ids = new Set(metrics.map((m) => m.id));
    const readings = readingsRaw.map((r, i) => {
      const ro = obj(r, `readings[${i}]`);
      const verdict = ro.verdict as AgentMetricReading["verdict"];
      if (verdict !== "above" && verdict !== "below" && verdict !== "inline" && verdict !== "unclear") {
        throw new ModelShapeError(`readings[${i}].verdict must be above, below, inline or unclear`);
      }
      return { metricId: str(ro.metricId, `readings[${i}].metricId`), value: str(ro.value, `readings[${i}].value`), verdict, comparison: optStr(ro.comparison) };
    });
    const unknown = readings.find((r) => !ids.has(r.metricId));
    if (unknown) throw new ModelShapeError(`readings has metricId "${unknown.metricId}", which is not one of the metrics`);
    return {
      headline: str(o.headline, "headline"),
      summary: str(o.summary, "summary"),
      readings,
      sources: Array.isArray(o.sources) ? o.sources.filter((n): n is number => Number.isInteger(n)) : [],
    };
  };
}

/** Everything wrong with a reply, as lines the model can act on. */
function reportProblems(reply: ReportReply, corpus: number[]): string[] {
  const problems: string[] = [];
  const fields: Array<[string, string]> = [
    ["headline", reply.headline],
    ["summary", reply.summary],
    ...reply.readings.flatMap((r): Array<[string, string]> => [
      [`value of ${r.metricId}`, r.value],
      ...(r.comparison ? ([[`comparison of ${r.metricId}`, r.comparison]] as Array<[string, string]>) : []),
    ]),
  ];
  for (const [name, text] of fields) {
    const cleaned = cleanModelText(text);
    for (const issue of copyIssues(cleaned)) problems.push(`${name}: ${issue}`);
    const missing = ungroundedNumbers(cleaned, corpus);
    if (missing.length > 0) problems.push(`${name}: figures not in the material: ${missing.join(", ")}`);
  }
  return problems;
}

const NOT_FOUND = "Not in the material";

/** The deterministic pass over a reply: copy rules enforced, unsourced figures removed. */
export function finalizeReport(
  reply: ReportReply,
  agent: Agent,
  event: TriggerEvent,
  material: ReportMaterial,
  deps: Pick<ReportDeps, "newId" | "now">,
): AgentReport {
  const corpus = corpusNumbers(material.corpus);
  const unsourced = (s: string) => ungroundedNumbers(s, corpus).length > 0;
  const headline = enforceLine(
    unsourced(cleanModelText(reply.headline)) ? event.title : reply.headline,
    enforceLine(event.title, `${agent.name} update`),
  ).slice(0, 140);
  const summary =
    enforceCopy(reply.summary, unsourced) ||
    "The material for this event did not support a written summary. The sources are listed below.";
  const byId = new Map(reply.readings.map((r) => [r.metricId, r]));
  const readings: AgentMetricReading[] = agent.metrics.map((m) => {
    const r = byId.get(m.id);
    const base = { metricId: m.id, label: m.label, ...(m.expectation ? { expectation: m.expectation } : {}) };
    if (!r) return { ...base, value: NOT_FOUND, verdict: "unclear" };
    const value = cleanModelText(r.value);
    if (!value || unsourced(value)) {
      return { ...base, value: NOT_FOUND, verdict: "unclear", comparison: value ? "The figure could not be matched to the sources." : undefined };
    }
    const reading: AgentMetricReading = { ...base, value: enforceLine(value, NOT_FOUND), verdict: r.verdict };
    if (reading.value === NOT_FOUND) reading.verdict = "unclear";
    if (r.comparison) {
      const comparison = enforceCopy(r.comparison, unsourced);
      if (comparison) reading.comparison = comparison;
    }
    return reading;
  });
  const cited = reply.sources.map((n) => material.sources[n - 1]).filter((s) => s !== undefined);
  return {
    id: deps.newId(),
    agentId: agent.id,
    at: deps.now.toISOString(),
    trigger: event.kind,
    headline,
    summary,
    readings,
    sources: cited.length > 0 ? cited : material.sources.slice(0, 8),
    read: false,
  };
}

/** A report from the facts alone, for when the model cannot be reached after retries. */
export function factsOnlyReport(agent: Agent, event: TriggerEvent, material: ReportMaterial, deps: Pick<ReportDeps, "newId" | "now">): AgentReport {
  const facts = material.facts.filter((f) => !f.startsWith("Checked at") && !f.startsWith("Event:")).slice(0, 6);
  const summary = [
    enforceCopy(facts.join(" ")) || enforceLine(event.title, "The event this agent watches happened."),
    "The write-up could not be generated because the model was not reachable. The facts above are as read from the sources.",
  ].join("\n\n");
  return {
    id: deps.newId(),
    agentId: agent.id,
    at: deps.now.toISOString(),
    trigger: event.kind,
    headline: enforceLine(event.title, `${agent.name} update`).slice(0, 140),
    summary,
    readings: agent.metrics.map((m) => ({
      metricId: m.id,
      label: m.label,
      ...(m.expectation ? { expectation: m.expectation } : {}),
      value: "Not assessed",
      verdict: "unclear" as const,
    })),
    sources: material.sources.slice(0, 8),
    read: false,
  };
}

export async function writeReport(agent: Agent, event: TriggerEvent, material: ReportMaterial, deps: ReportDeps): Promise<AgentReport> {
  if (!deps.caller) throw new Error("The model is not configured.");
  const call: AgentModelCall = {
    purpose: "report",
    system: REPORT_SYSTEM,
    user: reportUser(agent, event, material),
    schema: REPORT_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 4000,
    timeoutMs: 90_000,
  };
  const parse = parseReportReply(agent.metrics);
  let reply = await callJson(deps.caller, call, parse);
  const corpus = corpusNumbers(material.corpus);
  const problems = reportProblems(reply, corpus);
  if (problems.length > 0) {
    try {
      reply = await callJson(
        deps.caller,
        { ...call, user: `${call.user}\n\nYOUR PREVIOUS DRAFT BROKE THESE RULES. Write it again without them:\n- ${problems.slice(0, 12).join("\n- ")}` },
        parse,
      );
    } catch {
      // Keep the first reply; the deterministic pass below enforces the rules.
    }
  }
  return finalizeReport(reply, agent, event, material, deps);
}

/* ------------------------------------------------------------------ */
/* Chat                                                                 */
/* ------------------------------------------------------------------ */

const REPLY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["reply", "reportIds"],
  properties: { reply: { type: "string" }, reportIds: { type: "array", items: { type: "string" } } },
} as const;

export type ReplyContext = {
  agent: Agent;
  reports: AgentReport[];
  history: AgentMessage[];
  /** Fresh lines read for this question: quote, headlines, next date. */
  freshFacts: string[];
  question: string;
};

function replyUser(ctx: ReplyContext): string {
  const { agent } = ctx;
  const lines = ["YOUR SETUP", `The reader's request: ${agent.brief}`];
  if (agent.ticker) lines.push(`Company: ${agent.ticker}${agent.companyName ? ` (${agent.companyName})` : ""}`);
  if (agent.metrics.length > 0) lines.push(`Metrics: ${agent.metrics.map((m) => `${m.label}${m.expectation ? ` (bar: ${m.expectation})` : ""}`).join("; ")}`);
  if (agent.instructions) lines.push(`Instructions: ${agent.instructions}`);
  lines.push(`Status: ${agent.status}${agent.nextAction ? `. ${agent.nextAction}` : ""}`);
  if (agent.nextExpectedAt) lines.push(`Next event due: ${agent.nextExpectedAt}`);
  if (agent.lastFiredAt) lines.push(`Last fired: ${agent.lastFiredAt}`);
  lines.push("", "YOUR REPORTS (newest first)");
  if (ctx.reports.length === 0) lines.push("(none yet)");
  for (const r of ctx.reports) {
    lines.push(`[${r.id}] ${r.at.slice(0, 10)}: ${r.headline}`, r.summary);
    for (const x of r.readings) lines.push(`  ${x.label}: ${x.value} (${x.verdict})${x.comparison ? `, ${x.comparison}` : ""}`);
  }
  lines.push("", "DATA READ JUST NOW", ...(ctx.freshFacts.length > 0 ? ctx.freshFacts.map((f) => `- ${f}`) : ["(nothing could be read)"]));
  lines.push("", "THE CONVERSATION SO FAR");
  if (ctx.history.length === 0) lines.push("(nothing yet)");
  for (const m of ctx.history) lines.push(`${m.role === "user" ? "Reader" : "You"}: ${m.text}`);
  lines.push("", "THE QUESTION TO ANSWER NOW", ctx.question);
  return lines.join("\n");
}

function parseReply(value: unknown): { reply: string; reportIds: string[] } {
  const o = obj(value, "the reply");
  const reply = str(o.reply, "reply").trim();
  if (!reply) throw new ModelShapeError("reply is empty");
  return { reply, reportIds: Array.isArray(o.reportIds) ? o.reportIds.filter((s): s is string => typeof s === "string") : [] };
}

export async function writeReply(ctx: ReplyContext, caller: AgentModelCaller | null): Promise<{ text: string; reportIds: string[] }> {
  if (!caller) throw new Error("The model is not configured, so the agent cannot answer right now.");
  const user = replyUser(ctx);
  const call: AgentModelCall = {
    purpose: "reply",
    system: replySystem(ctx.agent),
    user,
    schema: REPLY_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: 1500,
    timeoutMs: 60_000,
  };
  const corpus = corpusNumbers(user);
  let out = await callJson(caller, call, parseReply);
  const problems = [
    ...copyIssues(cleanModelText(out.reply)),
    ...ungroundedNumbers(cleanModelText(out.reply), corpus).map((n) => `figure not in the material: ${n}`),
  ];
  if (problems.length > 0) {
    try {
      out = await callJson(caller, { ...call, user: `${user}\n\nYOUR PREVIOUS ANSWER BROKE THESE RULES. Answer again without them:\n- ${problems.join("\n- ")}` }, parseReply);
    } catch {
      // The deterministic pass below still applies.
    }
  }
  const text =
    enforceCopy(out.reply, (s) => ungroundedNumbers(s, corpus).length > 0) ||
    "That is not something the material here answers. The latest report and its sources are on this agent's page.";
  const known = new Set(ctx.reports.map((r) => r.id));
  return { text, reportIds: out.reportIds.filter((id) => known.has(id)) };
}
