/**
 * `earnings_events` (/events): Falcon's history of earnings reactions, read
 * from the Supabase table `historical_events` (one row per SEC 8-K Item 2.02
 * filing, 2016 on, for the link-graph companies). The measures are abnormal
 * returns against the company's sector ETF: the event day alone (d0 = the
 * filing day, or the next trading day for a filing after 4 pm ET), the next
 * day alone (d1), and the two days compounded:
 * (1 + r_stock_d0)(1 + r_stock_d1) - (1 + r_etf_d0)(1 + r_etf_d1).
 *
 * Each row has an event_kind: 'earnings' (the results release), 'preliminary',
 * 'operational_update' (e.g. Tesla's production and deliveries) or 'other'.
 * Only earnings releases are read unless `kinds` asks for more.
 *
 * Two forms:
 * - /events NVDA: one company's events (newest first) with a summary (mean and
 *   median move, typical absolute move, share of positive reactions, biggest
 *   up and down, how the latest compares) and a chart spec for show_chart.
 * - /events --min-return 10% --since 2024-01-01: a cross-sectional screen of
 *   events with |abnormal| at least x (or signed: up only, down only), largest
 *   first, with totals.
 *
 * Read-only through the service client (server-side, like the other Falcon
 * tools; loaded lazily so command.ts can use the pure parsers on the client).
 * runEventsTool never throws. The parsers and the summary math are pure.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { FieldSource } from "../citations";
import type { DeskToolOutcome } from "./index";
import { DEFAULT_TOOL_TIMEOUT_MS, TtlCache, ToolError, deadline, fitResult, normalizeTicker, nyParts, round, type DeskToolContext } from "./util";

export const EVENTS_TOOL_NAME = "earnings_events";
export const EVENTS_TABLE = "historical_events";

export const EVENTS_LIMITS = { tickerDefault: 12, screenDefault: 25, max: 60, tickers: 25, fetch: 1000, maxAbs: 5 } as const;

/** GICS sector -> its SPDR sector ETF (the Graph's sector names). A sector ETF symbol is also accepted as is. */
export const SECTOR_ETFS: Record<string, string> = {
  "Communication Services": "XLC",
  "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP",
  Energy: "XLE",
  Financials: "XLF",
  "Health Care": "XLV",
  Industrials: "XLI",
  "Information Technology": "XLK",
  Materials: "XLB",
  "Real Estate": "XLRE",
  Utilities: "XLU",
};

export const EVENT_KINDS = ["earnings", "preliminary", "operational_update", "other"] as const;
export type EventKind = (typeof EVENT_KINDS)[number];
const DEFAULT_KINDS: EventKind[] = ["earnings"];

/** Rows whose match or price is in doubt: left out of summaries and screens, listed apart. */
export const CAVEAT_FLAGS = ["cik_mismatch", "price_source_disagree"] as const;
const SUSPICIOUS = "suspicious_move";
const FOREIGN =
  "Foreign private issuers (20-F / 6-K filers such as TSM, ASML, SAP; about 230 companies in Falcon's graph) file no 8-K, so they have no events here; use `earnings` for their reported quarters.";

const LOADING = "Falcon's historical earnings events are still loading. Answer without them and say so; they will be available soon.";

export const EVENTS_TOOL = {
  name: EVENTS_TOOL_NAME,
  description:
    "Falcon's history of earnings reactions (2016 on, about 1,400 US filers): one row per SEC 8-K Item 2.02 filing with the filing time and abnormal returns versus the company's sector ETF for the event day alone (abn_d0; event day = the filing day, or the next trading day if filed after 4 pm ET), the next trading day alone (abn_d1) and both days compounded (abn). " +
    "Only quarterly earnings releases are read by default; preliminary results, operational updates (e.g. Tesla's production and deliveries reports) and other Item 2.02 filings are left out and counted under `excluded` unless kinds asks for them. " +
    "With one ticker and no min_abs_return: that company's events newest first (date, filing time ET, abn_d0, abn_d1, abn, stock_d0, stock and ETF two-day returns, flags, filing link), a summary of the two-day move (count, mean and median abnormal move, average absolute move = its typical earnings move, share of positive reactions, biggest up and down, how the latest compares) with the same for the event day alone under summary.d0, and `chart`, a show_chart spec of both over time (pass it unchanged). " +
    "With min_abs_return (and/or since, sector, a ticker list): a screen of events with |abnormal| at least that size, largest first, with totals. " +
    "Returns are in percent; events without a return are left out of the stats; d0 is there before d1's close is in. Rows flagged cik_mismatch or price_source_disagree are left out of summaries and screens and listed apart as `caveated`; `suspicious: true` marks an extreme move to check; other `flags` (missing_price, amended, multiple_same_day, etf_fallback_spy) qualify a row. Foreign filers (20-F, e.g. TSM, ASML, SAP) have no 8-K events. No EPS surprise yet. Free and fast. The member may type /events NVDA or /events --min-return 10% --since 2024-01-01 [--until DATE] [--up|--down] [--sector XLK] [--limit N] [--kinds all]; map them to these fields.",
  input_schema: {
    type: "object",
    properties: {
      ticker: { type: "string", maxLength: 200, description: "One US ticker (its own history), or up to 25 separated by commas to limit a screen." },
      min_abs_return: { type: ["number", "string"], description: "Screen: smallest |abnormal return|. 10 or \"10%\" or 0.1 all mean 10% (values of 1 or more are read as percent). A signed value (\"+10%\", \"-10%\") also sets the direction." },
      direction: { type: "string", enum: ["up", "down", "both"], description: "Screen: positive reactions only, negative only, or both (default)." },
      since: { type: "string", maxLength: 10, description: "First event date, YYYY-MM-DD (or YYYY, YYYY-MM)." },
      until: { type: "string", maxLength: 10, description: "Last event date, YYYY-MM-DD (or YYYY, YYYY-MM)." },
      sector: { type: "string", maxLength: 40, description: "Screen: a GICS sector name (e.g. Information Technology) or a sector ETF symbol (e.g. XLK)." },
      limit: { type: "integer", minimum: 1, maximum: EVENTS_LIMITS.max, description: `Events to list (default ${EVENTS_LIMITS.tickerDefault} for one ticker, ${EVENTS_LIMITS.screenDefault} for a screen).` },
      kinds: {
        type: ["array", "string"],
        items: { type: "string", enum: [...EVENT_KINDS, "all"] },
        description: "Which Item 2.02 filings to read: earnings (default), preliminary, operational_update, other, or all. A list or a comma-separated string.",
      },
    },
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

/* ------------------------------------------------------------------ input */

export type Direction = "up" | "down" | "both";

export type EventsQuery =
  | { mode: "ticker"; ticker: string; since: string | null; until: string | null; limit: number; kinds: EventKind[] }
  | { mode: "screen"; tickers: string[] | null; min: number; direction: Direction; since: string | null; until: string | null; etf: string | null; limit: number; kinds: EventKind[] };

type Input = Record<string, unknown>;

/**
 * A return threshold as a non-negative decimal and the sign it carried:
 * "10%" / 10 / 0.1 -> 0.1; "+10%" -> up; "-10%" / -0.1 -> down. Values of 1 or
 * more without % are percent (1 -> 1%). Throws ToolError.
 */
export function parseReturn(v: unknown): { value: number; sign: "up" | "down" | null } {
  let s: string;
  if (typeof v === "number") s = String(v);
  else if (typeof v === "string") s = v.trim().replace(/\s+/g, "").replace(",", ".");
  else throw new ToolError("min_abs_return must be a number like 10 (= 10%), \"10%\" or 0.1.");
  const m = /^([+-])?(\d+(?:\.\d+)?|\.\d+)(%)?$/.exec(s);
  if (!m) throw new ToolError(`min_abs_return "${String(v).slice(0, 20)}" is not a return. Use e.g. 10%, 10 or 0.1.`);
  const n = Number(m[2]);
  const value = m[3] || n >= 1 ? n / 100 : n;
  if (!(value <= EVENTS_LIMITS.maxAbs)) throw new ToolError(`min_abs_return must be at most ${EVENTS_LIMITS.maxAbs * 100}%.`);
  return { value: Math.round(value * 1e6) / 1e6, sign: m[1] === "+" ? "up" : m[1] === "-" ? "down" : null };
}

function validDate(y: number, mo: number, d: number): boolean {
  const t = new Date(Date.UTC(y, mo - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === d;
}

/** "2024" / "2024-03" / "2024-03-05" -> a YYYY-MM-DD bound (start or end of the period). Throws ToolError. */
export function parseDateBound(v: unknown, field: "since" | "until"): string | null {
  if (v === undefined || v === null || v === "") return null;
  const s = typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "";
  const m = /^(\d{4})(?:-(\d{1,2})(?:-(\d{1,2}))?)?$/.exec(s);
  const y = m ? Number(m[1]) : NaN;
  if (!m || y < 1990 || y > 2100) throw new ToolError(`${field} must be a date like 2024-01-01 (or 2024, 2024-01).`);
  const mo = m[2] ? Number(m[2]) : field === "since" ? 1 : 12;
  const d = m[3] ? Number(m[3]) : field === "since" ? 1 : new Date(Date.UTC(y, mo, 0)).getUTCDate();
  if (!validDate(y, mo, d)) throw new ToolError(`${field} "${s}" is not a calendar date.`);
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

/** A sector name (GICS, any case) or ETF symbol -> the ETF symbol. Throws ToolError. */
export function parseSector(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") throw new ToolError("sector must be a GICS sector name or a sector ETF symbol.");
  const s = v.trim();
  const byName = Object.entries(SECTOR_ETFS).find(([name]) => name.toLowerCase() === s.toLowerCase().replace(/\s+/g, " "));
  if (byName) return byName[1];
  if (/^tech(nology)?$/i.test(s)) return "XLK";
  if (/^[A-Za-z]{2,5}$/.test(s)) return s.toUpperCase();
  throw new ToolError(`sector "${s.slice(0, 40)}" is unknown. Use one of ${Object.keys(SECTOR_ETFS).join(", ")}, or an ETF symbol such as XLK.`);
}

function parseTickers(v: unknown): string[] | null {
  if (v === undefined || v === null || v === "") return null;
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/).filter(Boolean) : null;
  if (!parts) throw new ToolError("ticker must be a US stock symbol such as NVDA, or several separated by commas.");
  const out = [...new Set(parts.map((p) => normalizeTicker(p)))];
  if (!out.length) return null;
  if (out.length > EVENTS_LIMITS.tickers) throw new ToolError(`At most ${EVENTS_LIMITS.tickers} tickers.`);
  return out;
}

/** "earnings" (default) / ["earnings", "preliminary"] / "all" / "earnings,other" -> the kinds, in table order. Throws ToolError. */
export function parseKinds(v: unknown): EventKind[] {
  if (v === undefined || v === null || v === "") return [...DEFAULT_KINDS];
  const parts = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/).filter(Boolean) : null;
  if (!parts) throw new ToolError(`kinds must be one or more of ${EVENT_KINDS.join(", ")}, or all.`);
  const want = new Set<EventKind>();
  for (const p of parts) {
    const k = String(p).trim().toLowerCase().replace(/[\s-]+/g, "_");
    if (k === "all" || k === "any") return [...EVENT_KINDS];
    const hit = (EVENT_KINDS as readonly string[]).includes(k) ? (k as EventKind) : k === "operational" || k === "operational_updates" ? "operational_update" : null;
    if (!hit) throw new ToolError(`kinds "${String(p).slice(0, 30)}" is unknown. Use ${EVENT_KINDS.join(", ")} or all.`);
    want.add(hit);
  }
  return want.size ? EVENT_KINDS.filter((k) => want.has(k)) : [...DEFAULT_KINDS];
}

const isDefaultKinds = (k: readonly EventKind[]) => k.length === 1 && k[0] === "earnings";

function parseLimit(v: unknown, fallback: number): number {
  if (v === undefined || v === null || v === "") return fallback;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  if (!Number.isInteger(n) || n < 1) throw new ToolError(`limit must be a whole number from 1 to ${EVENTS_LIMITS.max}.`);
  return Math.min(n, EVENTS_LIMITS.max);
}

/** The tool's input, checked. One ticker and no threshold or direction: its history; anything else: a screen. Throws ToolError. */
export function parseEventsInput(input: unknown): EventsQuery {
  const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Input;
  const tickers = parseTickers(i.ticker);
  const since = parseDateBound(i.since, "since");
  const until = parseDateBound(i.until, "until");
  if (since && until && since > until) throw new ToolError("since must be on or before until.");
  const dirRaw = i.direction === undefined || i.direction === null || i.direction === "" ? null : String(i.direction).toLowerCase();
  if (dirRaw !== null && !["up", "down", "both"].includes(dirRaw)) throw new ToolError("direction must be up, down or both.");
  const hasMin = i.min_abs_return !== undefined && i.min_abs_return !== null && i.min_abs_return !== "";
  const min = hasMin ? parseReturn(i.min_abs_return) : null;
  if (min?.sign && dirRaw && dirRaw !== "both" && dirRaw !== min.sign) throw new ToolError(`min_abs_return says ${min.sign} but direction says ${dirRaw}.`);
  const direction = (min?.sign ?? dirRaw ?? "both") as Direction;
  const etf = parseSector(i.sector);
  const kinds = parseKinds(i.kinds);
  if (tickers?.length === 1 && !min && direction === "both" && !etf) {
    return { mode: "ticker", ticker: tickers[0]!, since, until, limit: parseLimit(i.limit, EVENTS_LIMITS.tickerDefault), kinds };
  }
  return { mode: "screen", tickers, min: min?.value ?? 0, direction, since, until, etf, limit: parseLimit(i.limit, EVENTS_LIMITS.screenDefault), kinds };
}

/** 0.1 -> "10%", 0.075 -> "7.5%". */
export function pctText(x: number): string {
  return `${Number((x * 100).toFixed(2))}%`;
}

/**
 * The slash form a member types, as tool input (checked later by parseEventsInput):
 * "/events NVDA --limit 20", "/events --min-return 10% --since 2024-01-01 --down --sector XLK".
 * Returns null when the text is not an /events command.
 */
export function parseEventsCommand(text: string): Input | null {
  const m = /^\s*\/events\b(.*)$/is.exec(text);
  if (!m) return null;
  const words = m[1]!.trim().split(/\s+/).filter(Boolean);
  const out: Input = {};
  const tickers: string[] = [];
  for (let k = 0; k < words.length; k++) {
    const w = words[k]!;
    const flag = /^--?([a-z-]+)(?:=(.*))?$/i.exec(w);
    if (!flag) {
      tickers.push(...w.split(",").filter(Boolean));
      continue;
    }
    const name = flag[1]!.toLowerCase();
    if (name === "up" || name === "down" || name === "both") {
      out.direction = name;
      continue;
    }
    if (name === "all" || name === "all-kinds") {
      out.kinds = "all";
      continue;
    }
    const value = flag[2] ?? words[++k];
    if (value === undefined) break;
    if (/^(min-return|min|min-abs-return|min-abs)$/.test(name)) out.min_abs_return = value;
    else if (name === "since" || name === "from") out.since = value;
    else if (name === "until" || name === "to") out.until = value;
    else if (name === "sector") out.sector = value.replace(/_/g, " ");
    else if (name === "limit") out.limit = /^\d+$/.test(value) ? Number(value) : value;
    else if (name === "direction") out.direction = value.toLowerCase();
    else if (name === "tickers" || name === "ticker") tickers.push(...value.split(",").filter(Boolean));
    else if (name === "kinds" || name === "kind") out.kinds = value;
  }
  if (tickers.length) out.ticker = tickers.join(",");
  return out;
}

/** The tool row's command: "/events NVDA", "/events --min-return 10% --since 2024-01-01". Pure. */
export function eventsCommand(input: unknown): string {
  let q: EventsQuery;
  try {
    q = parseEventsInput(input);
  } catch {
    const t = (input as Input | null)?.ticker;
    return typeof t === "string" && t.trim() ? `/events ${t.trim().toUpperCase().slice(0, 24)}` : "/events";
  }
  const kinds = isDefaultKinds(q.kinds) ? "" : q.kinds.length === EVENT_KINDS.length ? " --kinds all" : ` --kinds ${q.kinds.join(",")}`;
  const dates = `${q.since ? ` --since ${q.since}` : ""}${q.until ? ` --until ${q.until}` : ""}${kinds}`;
  if (q.mode === "ticker") return `/events ${q.ticker.replace("-", ".")}${dates}`;
  const sign = q.direction === "up" ? "+" : q.direction === "down" ? "-" : "";
  const list = q.tickers ? ` ${q.tickers.length <= 4 ? q.tickers.map((t) => t.replace("-", ".")).join(",") : `${q.tickers.length} tickers`}` : "";
  const min = q.min > 0 ? ` --min-return ${sign}${pctText(q.min)}` : sign ? ` --${q.direction}` : "";
  return `/events${list}${min}${dates}${q.etf ? ` --sector ${q.etf}` : ""}`;
}

export function eventsLabel(input: unknown, phase: "running" | "done" = "done"): string {
  const run = phase === "running";
  try {
    const q = parseEventsInput(input);
    if (q.mode === "ticker") return `${run ? "Reading" : "Read"} ${q.ticker.replace("-", ".")} earnings reactions`;
    const size = q.min > 0 ? ` of ${q.direction === "up" ? "+" : q.direction === "down" ? "-" : "±"}${pctText(q.min)} or more` : "";
    return `${run ? "Screening" : "Screened"} earnings reactions${size}`;
  } catch {
    return `${run ? "Reading" : "Read"} earnings reactions`;
  }
}

/* ------------------------------------------------------------------ store */

export type EventRow = {
  ticker: string;
  event_date: string;
  filed_at: string | null;
  accession: string;
  filing_url: string | null;
  form: string | null;
  sector_etf: string | null;
  abnormal_return_d0_d1: number | null;
  stock_return_d0_d1: number | null;
  etf_return_d0_d1: number | null;
  /** The event day alone and the next day alone (absent on rows read before the d0/d1 columns). */
  abnormal_return_d0?: number | null;
  stock_return_d0?: number | null;
  etf_return_d0?: number | null;
  abnormal_return_d1?: number | null;
  stock_return_d1?: number | null;
  etf_return_d1?: number | null;
  price_source: string | null;
  flags: string[] | null;
  event_kind?: string | null;
  kind_reason?: string | null;
};

/** One read of the table. `side`: up = abnormal >= min, down = abnormal <= -min (below 0 when min is 0), any = no return filter. */
export type RowQuery = {
  tickers: string[] | null;
  since: string | null;
  until: string | null;
  etf: string | null;
  side: "up" | "down" | "any";
  /** exclude (default): leave out rows with a CAVEAT_FLAGS flag; only: just those; any: both. */
  caveat: "exclude" | "only" | "any";
  /** event_kind values to read; null = every kind. */
  kinds: EventKind[] | null;
  min: number;
  order: "date_desc" | "abn_desc" | "abn_asc";
  limit: number;
};

export type EventsStore = {
  rows(q: RowQuery, signal: AbortSignal): Promise<{ rows: EventRow[]; count: number | null }>;
  /** Whether the table has any row at all. */
  hasAny(signal: AbortSignal): Promise<boolean>;
};

/** The table does not exist yet (or PostgREST has not seen it). */
export class EventsMissingError extends Error {}

const COLUMNS =
  "ticker, event_date, filed_at, accession, filing_url, form, sector_etf, abnormal_return_d0_d1, stock_return_d0_d1, etf_return_d0_d1, abnormal_return_d0, stock_return_d0, etf_return_d0, abnormal_return_d1, stock_return_d1, etf_return_d1, price_source, flags, event_kind, kind_reason";
const ABN = "abnormal_return_d0_d1";

/** 42P01 undefined_table; PGRST205 / PGRST204-ish "schema cache" misses. */
export function isMissingTable(err: { code?: string; message?: string } | null | undefined): boolean {
  if (!err) return false;
  return err.code === "42P01" || err.code === "PGRST205" || /relation .* does not exist|could not find the table|schema cache/i.test(err.message ?? "");
}

/** Both spellings of a class share, as the table may keep either ("BRK-B", "BRK.B"). */
export function tickerVariants(tickers: string[]): string[] {
  return [...new Set(tickers.flatMap((t) => (t.includes("-") ? [t, t.replace("-", ".")] : [t])))];
}

const admin = async () => (await import("../../supabase-admin")).getSupabaseAdmin();

export function supabaseEventsStore(): EventsStore {
  return {
    async rows(q, signal) {
      let b = (await admin()).from(EVENTS_TABLE).select(COLUMNS, { count: "exact" });
      if (q.tickers) b = b.in("ticker", tickerVariants(q.tickers));
      if (q.since) b = b.gte("event_date", q.since);
      if (q.until) b = b.lte("event_date", q.until);
      if (q.etf) b = b.eq("sector_etf", q.etf);
      if (q.kinds && q.kinds.length < EVENT_KINDS.length) b = b.in("event_kind", q.kinds);
      const caveats = `{${CAVEAT_FLAGS.join(",")}}`;
      if (q.caveat === "exclude") b = b.or(`flags.is.null,flags.not.ov.${caveats}`);
      else if (q.caveat === "only") b = b.overlaps("flags", [...CAVEAT_FLAGS]);
      if (q.side === "up") b = b.gte(ABN, q.min);
      else if (q.side === "down") b = q.min > 0 ? b.lte(ABN, -q.min) : b.lt(ABN, 0);
      b = q.order === "date_desc" ? b.order("event_date", { ascending: false }).order("filed_at", { ascending: false }) : b.order(ABN, { ascending: q.order === "abn_asc" });
      const res = await b.limit(q.limit).abortSignal(signal);
      if (res.error) {
        if (isMissingTable(res.error)) throw new EventsMissingError(res.error.message);
        throw new Error(res.error.message);
      }
      return { rows: (res.data ?? []) as unknown as EventRow[], count: res.count ?? null };
    },
    async hasAny(signal) {
      const res = await (await admin()).from(EVENTS_TABLE).select("id").limit(1).abortSignal(signal);
      if (res.error) {
        if (isMissingTable(res.error)) throw new EventsMissingError(res.error.message);
        throw new Error(res.error.message);
      }
      return (res.data ?? []).length > 0;
    },
  };
}

/* ------------------------------------------------------------------ math */

const p2 = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? null : round(x * 100, 2));

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** "2024-02-21 16:20 ET (after close)" from the filing instant. */
export function filedText(filedAt: string | null): string | null {
  const ms = filedAt ? Date.parse(filedAt) : NaN;
  if (!Number.isFinite(ms)) return null;
  const p = nyParts(ms);
  const when = p.minutes < 9 * 60 + 30 ? "pre-market" : p.minutes >= 16 * 60 ? "after close" : "market hours";
  return `${p.date} ${p.time} ET (${when})`;
}

export type EventsSummary = {
  events: number;
  with_returns: number;
  mean_abn: number | null;
  median_abn: number | null;
  avg_abs_abn: number | null;
  median_abs_abn: number | null;
  up_share: number | null;
  biggest_up: { date: string; abn: number } | null;
  biggest_down: { date: string; abn: number } | null;
  latest: { date: string; abn: number; vs_avg_abs: number | null; abs_rank: string; abs_percentile: number | null } | null;
};

export type ReturnKey = "abnormal_return_d0_d1" | "abnormal_return_d0" | "abnormal_return_d1";

/**
 * Summary of one company's events (rows newest first) on one measure (default
 * the two-day abnormal return; abnormal_return_d0 for the event day alone).
 * Returns in percent; up_share is the share (percent) of events with a
 * positive abnormal return; the latest's abs_rank is its |abnormal| rank among
 * all ("2 of 38", 1 = largest), abs_percentile the share of events with a
 * smaller |abnormal| (ties count half).
 */
export function summarizeEvents(rows: EventRow[], key: ReturnKey = "abnormal_return_d0_d1"): EventsSummary {
  const v = (r: EventRow) => r[key] as number;
  const valued = rows.filter((r) => typeof r[key] === "number" && Number.isFinite(r[key]));
  const abn = valued.map(v);
  const abs = abn.map(Math.abs);
  const up = valued.reduce((best, r) => (best === null || v(r) > v(best) ? r : best), null as EventRow | null);
  const down = valued.reduce((best, r) => (best === null || v(r) < v(best) ? r : best), null as EventRow | null);
  const avgAbs = mean(abs);
  let latest: EventsSummary["latest"] = null;
  const last = valued[0];
  if (last) {
    const a = Math.abs(v(last));
    const larger = abs.filter((x) => x > a).length;
    const smaller = abs.filter((x) => x < a).length;
    const ties = abs.length - larger - smaller - 1;
    latest = {
      date: last.event_date,
      abn: p2(v(last))!,
      vs_avg_abs: avgAbs ? round(a / avgAbs, 2) : null,
      abs_rank: `${larger + 1} of ${abs.length}`,
      abs_percentile: abs.length > 1 ? round(((smaller + ties / 2) / (abs.length - 1)) * 100, 0) : null,
    };
  }
  return {
    events: rows.length,
    with_returns: valued.length,
    mean_abn: p2(mean(abn)),
    median_abn: p2(median(abn)),
    avg_abs_abn: p2(avgAbs),
    median_abs_abn: p2(median(abs)),
    up_share: valued.length ? round((abn.filter((x) => x > 0).length / valued.length) * 100, 0) : null,
    biggest_up: up && v(up) > 0 ? { date: up.event_date, abn: p2(v(up))! } : null,
    biggest_down: down && v(down) < 0 ? { date: down.event_date, abn: p2(v(down))! } : null,
    latest,
  };
}

function eventOut(r: EventRow, withTicker: boolean) {
  return {
    ...(withTicker ? { ticker: r.ticker } : {}),
    date: r.event_date,
    filed: filedText(r.filed_at),
    abn_d0: p2(r.abnormal_return_d0),
    abn_d1: p2(r.abnormal_return_d1),
    abn: p2(r.abnormal_return_d0_d1),
    stock_d0: p2(r.stock_return_d0),
    stock: p2(r.stock_return_d0_d1),
    etf: p2(r.etf_return_d0_d1),
    ...(r.event_kind && r.event_kind !== "earnings" ? { kind: r.event_kind, ...(r.kind_reason ? { kind_reason: r.kind_reason.slice(0, 140) } : {}) } : {}),
    ...(withTicker && r.sector_etf ? { etf_symbol: r.sector_etf } : {}),
    ...(r.form && r.form !== "8-K" ? { form: r.form } : {}),
    ...(r.flags?.includes(SUSPICIOUS) ? { suspicious: true } : {}),
    ...(r.flags?.length ? { flags: r.flags } : {}),
    ...(r.filing_url ? { url: r.filing_url } : {}),
    // Where this row's closes came from (the `sources` list names each figure's source by it).
    ...(r.price_source ? { prices: r.price_source } : {}),
  };
}

export const isCaveated = (r: EventRow) => !!r.flags?.some((f) => (CAVEAT_FLAGS as readonly string[]).includes(f));

const CAVEAT_NOTE = `caveated: rows flagged ${CAVEAT_FLAGS.join(" or ")} (the filer or the price is in doubt), left out of the summary/totals and listed apart; mention them only with that caveat.`;
const SUSPICIOUS_NOTE = "suspicious: true marks an extreme move flagged for checking (a split, a merger, a data error or other news on the day); say so whenever you cite one.";

const MEASURE =
  "Abnormal returns in percent against the sector ETF. abn_d0 = the event day alone (stock d0 - ETF d0; d0 = the filing day, or the next trading day if filed after 4 pm ET); abn_d1 = the next trading day alone; abn = both days compounded, (1+stock d0)(1+stock d1) - (1+ETF d0)(1+ETF d1), so not exactly abn_d0 + abn_d1. stock_d0 = the stock's own event-day return; stock and etf = the two-day returns.";

const KIND_NOTE = "excluded: Item 2.02 filings that are not quarterly earnings releases (preliminary results, operational updates such as production and deliveries, amendments and other), left out of the events and the summary; pass kinds to include them.";

/** Rows of the asked kinds; a row without a kind counts as earnings. */
const ofKinds = (rows: EventRow[], kinds: readonly EventKind[]) => rows.filter((r) => (kinds as readonly string[]).includes(r.event_kind ?? "earnings"));

function excludedCounts(rows: EventRow[], kinds: readonly EventKind[]): Record<string, number> | null {
  const out: Record<string, number> = {};
  for (const r of rows) {
    const k = r.event_kind ?? "earnings";
    if (!(kinds as readonly string[]).includes(k)) out[k] = (out[k] ?? 0) + 1;
  }
  return Object.keys(out).length ? out : null;
}

/** The closes behind a row's returns, by its price_source: 'mixed' is the stock from Databento and the ETF from Yahoo. */
const CLOSES: Record<string, { stock: string; etf: string }> = {
  mixed: { stock: "Databento EQUS.SUMMARY", etf: "Yahoo Finance" },
  yahoo: { stock: "Yahoo Finance", etf: "Yahoo Finance" },
  databento: { stock: "Databento EQUS.SUMMARY", etf: "Databento EQUS.SUMMARY" },
};

/** The price sources of the rows that have one (the stored price_source values). */
const priceSources = (rows: { price_source: string | null }[]) => [...new Set(rows.map((r) => r.price_source).filter((x): x is string => !!x && x in CLOSES))];

/** The data providers behind the rows' closes ("Databento EQUS.SUMMARY and Yahoo Finance"). Pure. */
export function closesLabel(rows: { price_source: string | null }[]): string {
  const names = [...new Set(priceSources(rows).flatMap((p) => [CLOSES[p]!.stock, CLOSES[p]!.etf]))].sort();
  return names.length ? names.join(" and ") : "no prices";
}

function sourceLine(rows: EventRow[]): string {
  return `Falcon earnings events: dates and times from SEC EDGAR 8-K Item 2.02 filings; returns computed by Falcon from daily closes (${closesLabel(rows)})`;
}

/**
 * Where each figure of an events answer comes from (citations.ts FieldSource): a row's date and filing time from
 * EDGAR; its returns computed from the closes its `prices` names (the stock and the sector ETF can differ); the
 * summary, totals and chart computed from the rows' returns. Pure.
 */
export function eventSources(rows: EventRow[]): FieldSource[] {
  const at = (keys: string[]) => ["events", "caveated", "caveated.events"].flatMap((p) => keys.map((k) => `${p}.${k}`));
  const out: FieldSource[] = [{ covers: at(["date", "filed"]), label: "SEC EDGAR 8-K Item 2.02 filings (filing date and acceptance time)" }];
  for (const p of priceSources(rows)) {
    const { stock, etf } = CLOSES[p]!;
    const when = { prices: p };
    out.push({ covers: at(["stock*"]), when, label: `Computed by Falcon from ${stock} daily closes (the stock)` });
    out.push({ covers: at(["etf"]), when, label: `Computed by Falcon from ${etf} daily closes (the sector ETF)` });
    out.push({ covers: at(["abn*"]), when, label: stock === etf ? `Computed by Falcon from ${stock} daily closes (stock and sector ETF)` : `Computed by Falcon from ${stock} (stock) and ${etf} (sector ETF) daily closes` });
  }
  out.push({ covers: ["summary", "totals", "chart"], label: `Computed by Falcon from the events' returns (daily closes: ${closesLabel(rows)})` });
  return out;
}

/* ------------------------------------------------------------------ run */

const cache = new TtlCache<unknown>(15 * 60_000, 200);

export function resetEvents(): void {
  cache.clear();
}

async function tickerView(q: Extract<EventsQuery, { mode: "ticker" }>, store: EventsStore, signal: AbortSignal) {
  // A company has about 40 events since 2016; read them all for the summary.
  // Every kind is read so the excluded ones can be counted; the kinds asked for are kept here.
  const { rows: everyKind } = await store.rows({ tickers: [q.ticker], since: q.since, until: q.until, etf: null, side: "any", caveat: "any", min: 0, order: "date_desc", limit: 400, kinds: null }, signal);
  const shown = q.ticker.replace("-", ".");
  const all = ofKinds(everyKind, q.kinds);
  const excluded = excludedCounts(everyKind.filter((r) => !isCaveated(r)), q.kinds);
  const excludedOut = excluded ? { excluded, kinds: q.kinds } : {};
  const rows = all.filter((r) => !isCaveated(r));
  const caveated = all.filter(isCaveated);
  if (!rows.length) {
    if (!everyKind.length && !(await store.hasAny(signal))) return { status: "loading", note: LOADING };
    return {
      ticker: shown,
      events: [],
      ...excludedOut,
      ...(caveated.length ? { caveated: caveated.slice(0, 10).map((r) => eventOut(r, false)) } : {}),
      note: `Falcon has no ${caveated.length ? "clean " : ""}earnings events for ${shown}${q.since || q.until ? " in that period" : ""}. It covers about 1,400 US filers in Falcon's filing graph, 2016 on. ${FOREIGN}`,
    };
  }
  const listed = rows.slice(0, q.limit);
  const { events: _n, ...d0 } = summarizeEvents(rows, "abnormal_return_d0");
  const d0Stock = rows.map((r) => r.stock_return_d0).filter((x): x is number => typeof x === "number" && Number.isFinite(x));
  const summary = { ...summarizeEvents(rows), d0: { ...d0, avg_abs_stock: p2(mean(d0Stock.map(Math.abs))) } };
  const etfs = [...new Set(rows.map((r) => r.sector_etf).filter(Boolean))];
  const source = sourceLine(rows);
  const pointsOf = (key: ReturnKey) =>
    rows
      .filter((r) => typeof r[key] === "number")
      .map((r) => [r.event_date, p2(r[key])] as [string, number | null])
      .reverse();
  const points = pointsOf("abnormal_return_d0_d1");
  const pointsD0 = pointsOf("abnormal_return_d0");
  const notes = [...(excluded ? [KIND_NOTE] : []), ...(caveated.length ? [CAVEAT_NOTE] : []), ...(listed.some((r) => r.flags?.includes(SUSPICIOUS)) ? [SUSPICIOUS_NOTE] : [])];
  return {
    ticker: shown,
    sector_etf: etfs.length === 1 ? etfs[0] : etfs,
    source,
    measure: MEASURE,
    period: { first: rows[rows.length - 1]!.event_date, last: rows[0]!.event_date },
    summary,
    shown: listed.length,
    of: rows.length,
    events: listed.map((r) => eventOut(r, false)),
    ...excludedOut,
    ...(caveated.length ? { caveated: caveated.slice(0, 10).map((r) => eventOut(r, false)) } : {}),
    ...(notes.length ? { notes } : {}),
    chart: {
      kind: "bar",
      title: `${shown} earnings reactions vs ${etfs.length === 1 ? etfs[0] : "sector ETF"}`,
      axes: { y: { label: "Abnormal return", unit: "%" } },
      series: [...(pointsD0.length ? [{ name: "Event day", points: pointsD0 }] : []), { name: "Event day + next", points }],
      source: source.slice(0, 160),
    },
    eps_surprise: "not available yet",
    sources: eventSources([...rows, ...caveated]),
  };
}

async function screenView(q: Extract<EventsQuery, { mode: "screen" }>, store: EventsStore, signal: AbortSignal) {
  const base = { tickers: q.tickers, since: q.since, until: q.until, etf: q.etf, min: q.min, limit: EVENTS_LIMITS.fetch, caveat: "exclude" as const, kinds: q.kinds };
  const apart = { ...base, limit: 10, caveat: "only" as const };
  const [up, down, upApart, downApart] = await Promise.all([
    q.direction !== "down" ? store.rows({ ...base, side: "up", order: "abn_desc" }, signal) : null,
    q.direction !== "up" ? store.rows({ ...base, side: "down", order: "abn_asc" }, signal) : null,
    q.direction !== "down" ? store.rows({ ...apart, side: "up", order: "abn_desc" }, signal) : null,
    q.direction !== "up" ? store.rows({ ...apart, side: "down", order: "abn_asc" }, signal) : null,
  ]);
  const bySize = (a: EventRow, b: EventRow) => Math.abs(b.abnormal_return_d0_d1 ?? 0) - Math.abs(a.abnormal_return_d0_d1 ?? 0);
  const caveated = [...(upApart?.rows ?? []), ...(downApart?.rows ?? [])].sort(bySize).slice(0, 10);
  const caveatedCount = (upApart ? (upApart.count ?? upApart.rows.length) : 0) + (downApart ? (downApart.count ?? downApart.rows.length) : 0);
  const rows = [...(up?.rows ?? []), ...(down?.rows ?? [])].sort(bySize);
  const filters = {
    min_abs_return: q.min > 0 ? `${q.direction === "up" ? "+" : q.direction === "down" ? "-" : ""}${pctText(q.min)}` : null,
    direction: q.direction,
    since: q.since,
    until: q.until,
    sector_etf: q.etf,
    tickers: q.tickers?.map((t) => t.replace("-", ".")) ?? null,
    kinds: q.kinds,
  };
  const apartOut = caveated.length ? { caveated: { count: caveatedCount, events: caveated.map((r) => eventOut(r, true)) } } : {};
  if (!rows.length) {
    if (!caveated.length && !(await store.hasAny(signal))) return { status: "loading", note: LOADING };
    return { filters, totals: { matched: 0 }, events: [], ...apartOut, note: "No earnings events match these filters." };
  }
  const listed = rows.slice(0, q.limit);
  const notes = [...(caveated.length ? [CAVEAT_NOTE] : []), ...(listed.some((r) => r.flags?.includes(SUSPICIOUS)) ? [SUSPICIOUS_NOTE] : [])];
  const upCount = up ? (up.count ?? up.rows.length) : 0;
  const downCount = down ? (down.count ?? down.rows.length) : 0;
  const exact = (!up || up.rows.length >= (up.count ?? 0)) && (!down || down.rows.length >= (down.count ?? 0));
  const abs = rows.map((r) => Math.abs(r.abnormal_return_d0_d1 ?? 0));
  const absD0 = rows.map((r) => r.abnormal_return_d0).filter((x): x is number => typeof x === "number" && Number.isFinite(x)).map(Math.abs);
  const perTicker = new Map<string, number>();
  for (const r of rows) perTicker.set(r.ticker, (perTicker.get(r.ticker) ?? 0) + 1);
  const flagged: Record<string, number> = {};
  for (const r of rows) for (const f of r.flags ?? []) flagged[f] = (flagged[f] ?? 0) + 1;
  return {
    filters,
    source: sourceLine(rows),
    measure: MEASURE,
    totals: {
      matched: upCount + downCount,
      up: q.direction !== "down" ? upCount : undefined,
      down: q.direction !== "up" ? downCount : undefined,
      companies: perTicker.size,
      mean_abs_abn: p2(mean(abs)),
      median_abs_abn: p2(median(abs)),
      ...(absD0.length ? { median_abs_abn_d0: p2(median(absD0)) } : {}),
      ...(Object.keys(flagged).length ? { flagged } : {}),
      ...(exact ? {} : { note: `companies and averages are over the ${rows.length} largest matches` }),
    },
    most_events: [...perTicker.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 5).map(([ticker, n]) => ({ ticker, n })),
    shown: listed.length,
    events: listed.map((r) => eventOut(r, true)),
    ...apartOut,
    ...(notes.length ? { notes } : {}),
    eps_surprise: "not available yet",
    sources: eventSources([...rows, ...caveated]),
  };
}

/** The tool's result (pure apart from the store). Throws ToolError for bad input. */
export async function eventsTool(input: unknown, store: EventsStore, signal: AbortSignal): Promise<unknown> {
  const q = parseEventsInput(input);
  const key = JSON.stringify(q);
  const hit = cache.get(key);
  if (hit) return hit;
  let out: unknown;
  try {
    out = q.mode === "ticker" ? await tickerView(q, store, signal) : await screenView(q, store, signal);
  } catch (err) {
    if (err instanceof EventsMissingError) return { status: "loading", note: LOADING };
    throw err;
  }
  if (!(out && typeof out === "object" && "status" in out)) cache.set(key, out);
  return out;
}

/** Runs one earnings_events call. Never throws. */
export async function runEventsTool(input: unknown, ctx: DeskToolContext & { store?: EventsStore } = {}): Promise<DeskToolOutcome> {
  const started = Date.now();
  const label = eventsLabel(input, "done");
  const signal = deadline(ctx, ctx.timeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS);
  try {
    const result = await eventsTool(input, ctx.store ?? supabaseEventsStore(), signal);
    return { name: EVENTS_TOOL_NAME, ok: true, content: fitResult(result), label, ms: Date.now() - started };
  } catch (err) {
    const known = err instanceof ToolError;
    if (!known) console.error("[desk/events]", JSON.stringify({ error: err instanceof Error ? `${err.name}: ${err.message}` : String(err), ms: Date.now() - started }));
    const message = known
      ? (err as Error).message
      : signal.aborted
        ? "Falcon's earnings events did not answer in time. Try again, or answer without them and say so."
        : "Falcon's earnings events are unavailable right now. Answer without them and say so.";
    return { name: EVENTS_TOOL_NAME, ok: false, content: JSON.stringify({ error: message }), label, ms: Date.now() - started };
  }
}
