import type {
  AgentChannel,
  AgentDraft,
  AgentEnds,
  AgentMetric,
  AgentPatch,
  AgentTrigger,
} from "../../shared/agent-types";

/**
 * Input rules for agents, shared by every door into the engine: the renderer's
 * create and update calls, the model's draft, and the file on disk when it is
 * read back. Pure, so the rules are pinned by tests without Electron.
 *
 * Every function here either returns a clean value or throws an Error whose
 * message is fit to show next to the form ("Ticker ABCDEFGHIJK is not a
 * ticker"). Nothing is silently invented: a bad trigger is refused, not
 * replaced by a guess.
 */

export const LIMITS = {
  agentsPerUser: 50,
  briefChars: 2000,
  nameChars: 80,
  instructionsChars: 1000,
  triggers: 6,
  metrics: 12,
  metricLabelChars: 80,
  expectationChars: 200,
  keywords: 10,
  keywordChars: 40,
  forms: 10,
  messageChars: 2000,
  reportsPerAgent: 100,
  activityPerAgent: 300,
  messagesPerAgent: 200,
  notes: 8,
} as const;

export const AGENT_CHANNELS: readonly AgentChannel[] = ["desktop", "mobile_push", "digest"];

/** Delivery for a new agent when nothing else is said: the app itself, plus the daily digest. */
export const DEFAULT_CHANNELS: readonly AgentChannel[] = ["digest"];

/** Plain US listing symbols, with a class suffix: NVDA, BRK.B, BF-B. */
const TICKER_SHAPE = /^[A-Z][A-Z0-9]{0,5}(?:[.-][A-Z0-9]{1,2})?$/;

/** Upper-cases and strips a leading "$". Null when it cannot be a ticker. */
export function normalizeTicker(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().replace(/^\$/, "").toUpperCase();
  return TICKER_SHAPE.test(t) ? t : null;
}

function requireTicker(raw: unknown, fallback: string | undefined, where: string): string {
  const t = normalizeTicker(raw) ?? (raw == null || raw === "" ? fallback ?? null : null);
  if (!t) {
    throw new Error(
      raw == null || raw === "" ? `${where} needs a ticker` : `${where}: "${String(raw).slice(0, 20)}" is not a ticker`,
    );
  }
  return t;
}

/** Control characters out, runs of whitespace folded, trimmed and capped. */
export function cleanLine(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

/** Like cleanLine but keeps paragraph breaks: briefs and messages are prose. */
export function cleanBlock(raw: unknown, max: number): string {
  if (typeof raw !== "string") return "";
  return raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/** How a reader (or the model) may write a form, mapped to EDGAR's spelling. */
const FORM_ALIASES: Record<string, string> = {
  "8K": "8-K",
  "10K": "10-K",
  "10Q": "10-Q",
  "6K": "6-K",
  "20F": "20-F",
  "40F": "40-F",
  S1: "S-1",
  S3: "S-3",
  "FORM 4": "4",
  FORM4: "4",
  "13D": "SC 13D",
  "13G": "SC 13G",
  "SCHEDULE 13D": "SC 13D",
  "SCHEDULE 13G": "SC 13G",
  "13F": "13F-HR",
  DEF14A: "DEF 14A",
  PROXY: "DEF 14A",
};

const FORM_SHAPE = /^[A-Z0-9][A-Z0-9 \-/]{0,15}$/;

export function normalizeForm(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const f = raw.trim().toUpperCase().replace(/\s+/g, " ");
  const mapped = FORM_ALIASES[f] ?? FORM_ALIASES[f.replace(/[\s-]/g, "")] ?? f;
  return FORM_SHAPE.test(mapped) ? mapped : null;
}

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** Keywords as stored: lower case, trimmed, at least two characters, each once, capped. */
function cleanKeywords(raw: unknown): string[] {
  const words = Array.isArray(raw) ? raw : [];
  return [...new Set(words.map((k) => cleanLine(k, LIMITS.keywordChars).toLowerCase()).filter((k) => k.length >= 2))].slice(0, LIMITS.keywords);
}

/**
 * One trigger, checked and normalized. `fallbackTicker` fills a missing
 * ticker from the agent's primary company, which is how the model and the
 * form both write "the earnings of the company this agent is about".
 */
export function validateTrigger(raw: unknown, fallbackTicker?: string): AgentTrigger {
  if (!raw || typeof raw !== "object") throw new Error("A trigger is missing its details");
  const t = raw as Record<string, unknown>;
  switch (t.kind) {
    case "earnings": {
      const moment = t.moment === "call" ? "call" : "release";
      return { kind: "earnings", ticker: requireTicker(t.ticker, fallbackTicker, "Earnings trigger"), moment };
    }
    case "filing": {
      const forms = Array.isArray(t.forms) ? t.forms : [];
      const clean = [...new Set(forms.map(normalizeForm).filter((f): f is string => f !== null))].slice(0, LIMITS.forms);
      if (clean.length === 0) throw new Error("Filing trigger needs at least one form, such as 8-K");
      const out: AgentTrigger = {
        kind: "filing",
        ticker: requireTicker(t.ticker, fallbackTicker, "Filing trigger"),
        forms: clean,
      };
      if (t.insiderBuysOnly === true && clean.includes("4")) out.insiderBuysOnly = true;
      return out;
    }
    case "price_move": {
      const pct = typeof t.thresholdPct === "number" ? t.thresholdPct : Number(t.thresholdPct);
      if (!Number.isFinite(pct) || Math.abs(pct) < 0.5 || Math.abs(pct) > 50) {
        throw new Error("Price move threshold must be between 0.5% and 50%");
      }
      const window = t.window === "intraday" || t.window === "5d" ? t.window : "1d";
      return {
        kind: "price_move",
        ticker: requireTicker(t.ticker, fallbackTicker, "Price move trigger"),
        thresholdPct: Math.round(Math.abs(pct) * 10) / 10,
        window,
      };
    }
    case "news": {
      const keywords = cleanKeywords(t.keywords);
      const ticker = t.ticker == null || t.ticker === "" ? fallbackTicker : requireTicker(t.ticker, undefined, "News trigger");
      // Neither a ticker nor keywords: the market's headlines as a whole.
      return ticker ? { kind: "news", ticker, keywords } : { kind: "news", keywords };
    }
    case "macro": {
      const event = cleanLine(t.event, 40);
      if (event.length < 2) throw new Error("Macro trigger needs an event, such as CPI or FOMC");
      return { kind: "macro", event };
    }
    case "schedule": {
      const cadence = t.cadence === "daily" || t.cadence === "weekly" ? t.cadence : "weekdays";
      const time = typeof t.time === "string" && CLOCK.test(t.time.trim()) ? t.time.trim() : null;
      if (!time) throw new Error("Schedule trigger needs a time as HH:mm");
      const keywords = cleanKeywords(t.keywords);
      const topic = keywords.length > 0 ? { keywords } : {};
      if (cadence === "weekly") {
        const weekday = typeof t.weekday === "number" ? t.weekday : Number(t.weekday);
        if (!Number.isInteger(weekday) || weekday < 0 || weekday > 6) {
          throw new Error("Weekly schedule needs a weekday from 0 (Sunday) to 6");
        }
        return { kind: "schedule", cadence, time, weekday, ...topic };
      }
      return { kind: "schedule", cadence, time, ...topic };
    }
    default:
      throw new Error(`Unknown trigger kind "${String(t.kind).slice(0, 20)}"`);
  }
}

export function validateTriggers(raw: unknown, fallbackTicker?: string): AgentTrigger[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("An agent needs at least one trigger");
  if (raw.length > LIMITS.triggers) throw new Error(`An agent can have at most ${LIMITS.triggers} triggers`);
  return raw.map((t) => validateTrigger(t, fallbackTicker));
}

/** Metrics with stable, unique ids; labels required, expectations optional. */
export function validateMetrics(raw: unknown): AgentMetric[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new Error("Metrics must be a list");
  if (raw.length > LIMITS.metrics) throw new Error(`An agent can track at most ${LIMITS.metrics} metrics`);
  const used = new Set<string>();
  const out: AgentMetric[] = [];
  raw.forEach((m, i) => {
    const src = m && typeof m === "object" ? (m as Record<string, unknown>) : {};
    const label = cleanLine(src.label, LIMITS.metricLabelChars);
    if (!label) throw new Error(`Metric ${i + 1} needs a label`);
    let id = typeof src.id === "string" && /^[A-Za-z0-9_-]{1,40}$/.test(src.id) ? src.id : `m${i + 1}`;
    if (used.has(id)) id = `m${i + 1}`;
    for (let n = 2; used.has(id); n++) id = `m${i + 1}-${n}`;
    used.add(id);
    const expectation = cleanLine(src.expectation, LIMITS.expectationChars);
    out.push(expectation ? { id, label, expectation } : { id, label });
  });
  return out;
}

/**
 * Known channels, each once. An empty list is allowed: every report is in the
 * app anyway, so no channel means in-app only. No list at all gets the default.
 */
export function validateChannels(raw: unknown): AgentChannel[] {
  if (!Array.isArray(raw)) return [...DEFAULT_CHANNELS];
  return [...new Set(raw.filter((c): c is AgentChannel => AGENT_CHANNELS.includes(c as AgentChannel)))];
}

const YMD = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar date, YYYY-MM-DD. */
export function isYmd(raw: unknown): raw is string {
  if (typeof raw !== "string") return false;
  const m = YMD.exec(raw);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * When the agent stops. Null or absent is no end (the engine proposes one on
 * create); anything else must be complete. A missing ticker falls back to the
 * agent's own, as triggers do.
 */
export function validateEnds(raw: unknown, fallbackTicker?: string): AgentEnds | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "object") throw new Error("The end must be a date, a results release or a filing");
  const e = raw as Record<string, unknown>;
  switch (e.kind) {
    case "date":
      if (!isYmd(e.date)) throw new Error("The end date must be a date (YYYY-MM-DD)");
      return { kind: "date", date: e.date };
    case "earnings":
      return { kind: "earnings", ticker: requireTicker(e.ticker, fallbackTicker, "The end") };
    case "filing": {
      const form = normalizeForm(e.form);
      if (!form) throw new Error("The end needs the form to wait for (8-K, 10-K, ...)");
      return { kind: "filing", ticker: requireTicker(e.ticker, fallbackTicker, "The end"), form };
    }
    default:
      throw new Error("The end must be a date, a results release or a filing");
  }
}

/**
 * A draft about to become an agent. The primary ticker, when given, must be a
 * ticker; triggers without one inherit it.
 */
export function validateDraft(raw: unknown): AgentDraft {
  if (!raw || typeof raw !== "object") throw new Error("Nothing to save");
  const d = raw as Record<string, unknown>;
  const brief = cleanBlock(d.brief, LIMITS.briefChars);
  if (!brief) throw new Error("The agent needs a brief: what to watch, in your words");
  let ticker: string | undefined;
  if (d.ticker != null && d.ticker !== "") {
    const t = normalizeTicker(d.ticker);
    if (!t) throw new Error(`"${String(d.ticker).slice(0, 20)}" is not a ticker`);
    ticker = t;
  }
  const triggers = validateTriggers(d.triggers, ticker);
  const metrics = validateMetrics(d.metrics);
  const name = cleanLine(d.name, LIMITS.nameChars) || defaultName(ticker, triggers);
  const companyName = cleanLine(d.companyName, 120) || undefined;
  const instructions = cleanBlock(d.instructions, LIMITS.instructionsChars) || undefined;
  const notes = Array.isArray(d.notes)
    ? d.notes.map((n) => cleanLine(n, 200)).filter(Boolean).slice(0, LIMITS.notes)
    : undefined;
  const ends = validateEnds(d.ends, ticker);
  const draft: AgentDraft = {
    name,
    brief,
    triggers,
    metrics,
    channels: validateChannels(d.channels),
    oneShot: bool(d.oneShot, false),
  };
  if (ticker) draft.ticker = ticker;
  if (ticker && companyName) draft.companyName = companyName;
  if (instructions) draft.instructions = instructions;
  if (notes && notes.length > 0) draft.notes = notes;
  if (ends) draft.ends = ends;
  return draft;
}

/**
 * A partial edit. Only the fields present are checked; triggers are checked
 * against the ticker the agent will have after the edit.
 */
export function validatePatch(raw: unknown, currentTicker: string | undefined): AgentPatch {
  if (!raw || typeof raw !== "object") throw new Error("Nothing to change");
  const p = raw as Record<string, unknown>;
  const out: AgentPatch = {};
  let ticker = currentTicker;
  if ("ticker" in p) {
    if (p.ticker == null || p.ticker === "") {
      ticker = undefined;
      out.ticker = undefined;
      out.companyName = undefined;
    } else {
      const t = normalizeTicker(p.ticker);
      if (!t) throw new Error(`"${String(p.ticker).slice(0, 20)}" is not a ticker`);
      ticker = t;
      out.ticker = t;
    }
  }
  if ("companyName" in p && ticker) out.companyName = cleanLine(p.companyName, 120) || undefined;
  if ("name" in p) {
    const name = cleanLine(p.name, LIMITS.nameChars);
    if (!name) throw new Error("The agent needs a name");
    out.name = name;
  }
  if ("brief" in p) {
    const brief = cleanBlock(p.brief, LIMITS.briefChars);
    if (!brief) throw new Error("The agent needs a brief");
    out.brief = brief;
  }
  if ("triggers" in p) out.triggers = validateTriggers(p.triggers, ticker);
  if ("metrics" in p) out.metrics = validateMetrics(p.metrics);
  if ("instructions" in p) out.instructions = cleanBlock(p.instructions, LIMITS.instructionsChars) || undefined;
  if ("channels" in p) out.channels = validateChannels(p.channels);
  if ("oneShot" in p) {
    if (typeof p.oneShot !== "boolean") throw new Error("oneShot must be true or false");
    out.oneShot = p.oneShot;
  }
  if ("ends" in p) out.ends = validateEnds(p.ends, ticker);
  return out;
}

const KIND_NAME: Record<AgentTrigger["kind"], string> = {
  earnings: "earnings",
  filing: "filings",
  price_move: "price moves",
  news: "news",
  macro: "macro",
  schedule: "digest",
};

export function defaultName(ticker: string | undefined, triggers: AgentTrigger[]): string {
  const first = triggers[0];
  const what = first ? KIND_NAME[first.kind] : "watch";
  if (first?.kind === "macro") return `${first.event} release`;
  return ticker ? `${ticker} ${what}` : `Market ${what}`;
}

/** Agent and report ids: short, url-safe, never a path. */
export const ID_SHAPE = /^[a-z0-9-]{6,64}$/;

export function requireId(raw: unknown): string {
  if (typeof raw !== "string" || !ID_SHAPE.test(raw)) throw new Error("Not an agent id");
  return raw;
}
