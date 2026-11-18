/**
 * `falcon_options(ticker, detail?, expiration?, live?)`: Falcon AI's options
 * overview of a US stock, with its implied volatility, as "/options AAPL" in
 * the chat ("/options AAPL surface" with a detail).
 *
 * Fast path (free): Falcon's daily snapshot in Supabase options_daily
 * (packages/engine/src/options/daily.ts, about 1,100 liquid names priced at
 * 15:45 New York each session): ATM IV 30 days, implied moves, skew, the term
 * structure kept with the row, and the ticker's stored ATM IV history (IV
 * percentile and rank once 20 sessions are stored).
 *
 * On-demand path (paid, capped): any other optionable US ticker, a stored row
 * older than the latest session Databento has, `live: true`, or a smile or a
 * surface (strike-level IVs are not stored) prices one OPRA.PILLAR cbbo-1m
 * snapshot of just that chain ([minute - 5, minute + 1), parent symbology),
 * computed with the engine's own math (surface.ts, cards.ts) exactly as the
 * daily job does. A single chain is a fraction of a cent to a few cents
 * (2026-11-13: SOUN $0.0004, AAPL $0.005, SPY $0.019). Every pull is priced
 * first with get_cost; one over DESK_IV_MAX_PULL_USD (default $0.25) is
 * refused, and so is one that would pass this caller's month cap
 * (DESK_IV_MONTH_CAP_USD, default $10) or the Databento month cap over every
 * caller in public.options_spend (OPTIONS_DAILY_MONTH_CAP_USD, default $110).
 * Each charge is written to options_spend as caller "desk-iv" before the
 * download (a refund line if Databento refuses it). A computed chain is kept
 * in memory for 6 hours per snapshot, so it is bought once; the download has
 * its own 25 s timeout and keeps going past the tool's deadline.
 *
 * The summary adds put/call volume and open interest (putcall.ts): OPRA
 * statistics (open interest, pre-open) and ohlcv-1d (volume of one session),
 * priced and capped with the chain as one pull (the per-pull limit covers the
 * pieces together; chain first, then open interest, then volume), charged in
 * the same ledger and cached per ticker and day. A stored row needs only
 * these pieces.
 *
 * Shown only when OPTIONS_DISPLAY allows this viewer (lib/sightings-options).
 * Server-only. Pure helpers are exported for the tests (iv.test.ts).
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { RippleOptions } from "@falcon/ripple";
import { betaFromCloses, chainProblem, optionsBlock, tickerOptionsFrom, type TickerOptions } from "../../../../../packages/engine/src/options/cards.ts";
import type { OptionDefinition, Quote as EngineQuote } from "../../../../../packages/engine/src/options/client.ts";
import { earningsStraddle, releaseSessions, type EarningsRelease, type EarningsStraddle } from "../../../../../packages/engine/src/options/earnings-straddle.ts";
import { definitionsFromRecords, osiRoot } from "../../../../../packages/engine/src/options/study-options.ts";
import { constantMaturityIv, surfaceFeatures, type SurfaceFeatures } from "../../../../../packages/engine/src/options/surface.ts";
import { addDays, isNyseEarlyClose, nyInstantMs, nyseSessions } from "../../../../../packages/engine/src/study/abnormal.ts";
import { DatabentoError, databentoConfigured, datasetEndOf, getCost, getDatasetEnds, getRange, quotesAt, requestKey, type DatasetEnds, type RangeBody, type RangeRequest } from "../../databento/client";
import { appendSpend, monthBounds, monthSpend, type SpendLine } from "../../databento/ledger";
import { canSeeOptions, optionsDisplayMode } from "../../sightings-options";
import { getSupabaseAdmin } from "../../supabase-admin";
import { barsFromChart } from "./history";
import {
  EARNINGS_WINDOW_DAYS,
  YAHOO_OPTIONS_DATASET,
  currentSession,
  earningsFromEpoch,
  isStale,
  loadEarningsSoon,
  loadYahooChain,
  yahooIvCheck,
  yahooOptionsUrl,
  type EarningsSoon,
  type SessionClock,
  type YahooIvCheck,
} from "./iv-fresh";
import { OI_SCHEMA, VOLUME_SCHEMA, oiFigures, oiFromStatistics, putCallPlan, putCallTotals, shapePutCall, volumeFromOhlcv, type PcPlan, type PcRow, type PutCall } from "./putcall";
import { ToolError, TtlCache, cached, normalizeTicker, nyParts, round, type ToolProgress } from "./util";
import { yahooChart, type ChartResult } from "./yahoo";

export const IV_TOOL_NAME = "falcon_options";
export const IV_DETAILS = ["summary", "term", "smile", "surface", "history"] as const;
export type IvDetail = (typeof IV_DETAILS)[number];
/** history: the period of the ATM IV series (iv-history.ts); max = since OPRA's history starts (2013). */
export const IV_HISTORY_RANGES = ["1m", "3m", "6m", "1y", "2y", "5y", "max"] as const;
export type IvHistoryRange = (typeof IV_HISTORY_RANGES)[number];
export const IV_CALLER = "desk-iv";
export const IV_DATASET = "OPRA.PILLAR";
export const IV_SCHEMA = "cbbo-1m";
/** Minutes of cbbo-1m before the snapshot (engine chains.ts LOOKBACK_MIN: thin chains need it). */
export const LOOKBACK_MIN = 5;
/** Stored sessions before a percentile or rank is given (engine store.ts MIN_IV_DAYS). */
export const MIN_IV_DAYS = 20;
/** Download timeout of one chain (its own, not the tool's). */
const PULL_TIMEOUT_MS = 25_000;
/** Pricing timeout of a put/call piece. */
const PC_PRICE_TIMEOUT_MS = 10_000;
const MAX_TERM_POINTS = 20;
const MAX_SMILE_POINTS = 40;
const MAX_SURFACE_EXPIRIES = 10;
const SURFACE_MONEYNESS = [80, 85, 90, 95, 100, 105, 110, 115, 120];
/** Widest strike gap (moneyness points) a surface cell is interpolated across: a $3 stock lists $0.50 strikes, about 15 points apart. */
const MAX_GAP_PTS = 20;
/** Surface cells further from spot than this many ATM standard deviations (ln K/S) are left empty. */
const WING_SDS = 4;
const SURFACE_DAY_TARGETS = [7, 14, 21, 30, 45, 60, 90, 120, 180, 270, 365];
const HOUR = 3_600_000;

export const IV_MEANING =
  "Implied volatility is the options market's expected size of moves, annualised (one standard deviation, in %); it says nothing about direction and is not a forecast.";

const ticker = { type: "string", description: "US stock ticker, e.g. AAPL, BRK.B.", minLength: 1, maxLength: 10 } as const;

export const IV_TOOL = {
  name: IV_TOOL_NAME,
  description:
    "Options overview of a US stock (OPRA via Databento, computed by Falcon) with its as-of time: implied volatility (ATM IV at 30 days, also 60 and 90), where it sits in the stock's stored IV history (percentile and rank once 20 sessions are stored), implied move over a week (5 sessions) and a month (20 sessions), raw and beyond the market, the term structure by expiry, put-minus-call skew, call-put spread, beta and VIX context. " +
    "The summary also gives the put/call ratio: by volume (calls, puts, puts / calls for the latest whole session) and by open interest (positions after the previous close, with the 3 contracts holding the most), each with its date; volume is left out with a note when it would cost too much (the busiest names such as SPY or AAPL). " +
    "Always the freshest data there is, with `as_of` (exchange time), `source`, per-group `sources` and a `stale` flag: during and after today's session Falcon reads Yahoo's options chain (delayed ~15 min, free) and computes every figure itself from the bid/ask mids, since Databento publishes a session's OPRA quotes only after it ends; otherwise Falcon's daily 15:45 New York snapshot (about 1,100 liquid names) for free, and any other optionable US ticker is priced on demand from one snapshot of just that chain; the put/call figures are bought on demand (cents, capped, bought once per day). With earnings within 7 days the summary adds `earnings` (date, time and the pre-earnings ATM straddle: the market's expected move through the report). When `stale` is true or `freshness.warning` is present, say so plainly and never present the numbers as current. " +
    "detail: summary (default, compact); term = ATM IV per expiry, every expiry (chartable); smile = IV by strike for one expiry (`expiration`, default the one nearest 30 days); surface = an IV grid over moneyness (strike / spot, %) and days to expiry, ready for show_chart surface3d; history = ATM IV 30 days per session over `range` (daily up to 3m, weekly for 6m and 1y, about 130 points for longer; with skew and the 20-session implied move), the IV percentile and rank within it, and a line chart for show_chart (bought on demand, cents). " +
    "live: true only when the member asks for the latest or intraday numbers (the freshest data is used anyway). Use for any options question: implied vol, IV rank or percentile, expected move, skew, term structure, smile or vol surface, put/call ratio, open interest or option volume (summary). Explain a put/call ratio briefly: a high one often means hedging or income strategies, not necessarily a bearish bet.",
  input_schema: {
    type: "object",
    properties: {
      ticker,
      detail: { type: "string", enum: [...IV_DETAILS], description: "summary (default), term, smile, surface or history." },
      range: { type: "string", enum: [...IV_HISTORY_RANGES], description: "history only: the period ending at the latest session (default 1y; max = since 2013)." },
      expiration: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "smile only: the expiry (YYYY-MM-DD); the nearest listed one is used." },
      live: { type: "boolean", description: "Price the latest snapshot Databento has, even when the stored one is current." },
    },
    required: ["ticker"],
    additionalProperties: false,
  },
} satisfies Anthropic.Beta.BetaTool;

/* ------------------------------------------------------------------ input */

export type IvQuery = { ticker: string; detail: IvDetail; expiration: string | null; live: boolean; range: IvHistoryRange };

/** The tool's input, checked. Throws ToolError with a message the model can act on. Pure. */
export function parseIvInput(input: unknown): IvQuery {
  const i = (input && typeof input === "object" && !Array.isArray(input) ? input : {}) as Record<string, unknown>;
  const t = normalizeTicker(i.ticker);
  const detail = i.detail === undefined || i.detail === null || i.detail === "" ? "summary" : String(i.detail).toLowerCase();
  if (!(IV_DETAILS as readonly string[]).includes(detail)) throw new ToolError(`detail must be one of ${IV_DETAILS.join(", ")}.`);
  let expiration: string | null = null;
  if (i.expiration !== undefined && i.expiration !== null && i.expiration !== "") {
    const e = String(i.expiration).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(e) || !Number.isFinite(Date.parse(`${e}T12:00:00Z`))) throw new ToolError("expiration must be a date, YYYY-MM-DD.");
    expiration = e;
  }
  if (i.live !== undefined && typeof i.live !== "boolean") throw new ToolError("live must be true or false.");
  const range = i.range === undefined || i.range === null || i.range === "" ? "1y" : String(i.range).toLowerCase();
  if (!(IV_HISTORY_RANGES as readonly string[]).includes(range)) throw new ToolError(`range must be one of ${IV_HISTORY_RANGES.join(", ")}.`);
  return { ticker: t, detail: detail as IvDetail, expiration, live: i.live === true, range: range as IvHistoryRange };
}

/* ------------------------------------------------------------------ caps */

function envUsd(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

export type IvCaps = { maxPullUsd: number; callerMonthUsd: number; totalMonthUsd: number };

export function ivCaps(): IvCaps {
  return {
    maxPullUsd: envUsd("DESK_IV_MAX_PULL_USD", 0.25),
    callerMonthUsd: envUsd("DESK_IV_MONTH_CAP_USD", 10),
    totalMonthUsd: envUsd("OPTIONS_DAILY_MONTH_CAP_USD", 110),
  };
}

export type MonthTally = { callerUsd: number; totalUsd: number };

/** Why a pull priced at `costUsd` may not be bought, or null when it fits every cap. Pure. */
export function capRefusal(costUsd: number, month: MonthTally | null, caps: IvCaps): string | null {
  if (!Number.isFinite(costUsd) || costUsd < 0) return "Databento could not price this chain";
  if (costUsd > caps.maxPullUsd + 1e-9) return `this chain alone is priced at $${costUsd.toFixed(2)}, over the $${caps.maxPullUsd.toFixed(2)} limit for one on-demand snapshot`;
  if (!month) return "the spend ledger could not be read, so nothing was bought";
  if (month.callerUsd + costUsd > caps.callerMonthUsd + 1e-9) return `Falcon AI's monthly budget for on-demand options data ($${caps.callerMonthUsd.toFixed(2)}) is used up`;
  if (month.totalUsd + costUsd > caps.totalMonthUsd + 1e-9) return `the monthly Databento budget ($${caps.totalMonthUsd.toFixed(2)}) is used up`;
  return null;
}

let month: { month: string; at: number; tally: MonthTally } | null = null;
const MONTH_TTL_MS = 5 * 60_000;
let datasetEnd: { at: number; ends: DatasetEnds } | null = null;
const chainCache = new TtlCache<Promise<LiveChain>>(6 * HOUR, 200);
/** Put/call pieces (open interest of a pre-open, volume of a session) per ticker, bought once like the chain. */
const pieceCache = new TtlCache<Promise<PcRow[]>>(6 * HOUR, 400);

/** For tests: forget the month tally, the dataset range, every cached chain and every remembered price. */
export function resetIv(): void {
  month = null;
  datasetEnd = null;
  chainCache.clear();
  pieceCache.clear();
  priceMemo.clear();
}

async function loadMonth(nowMs: number, signal: AbortSignal): Promise<MonthTally | null> {
  const m = monthBounds(nowMs).month;
  if (month && month.month === m && nowMs - month.at < MONTH_TTL_MS) return month.tally;
  try {
    const s = await monthSpend(IV_CALLER, nowMs, signal);
    month = { month: m, at: nowMs, tally: { callerUsd: s.callerUsd, totalUsd: s.totalUsd } };
    return month.tally;
  } catch {
    return null;
  }
}

/** OPRA's available end per schema (one free call, kept 10 minutes). */
async function loadDatasetEnds(nowMs: number, signal: AbortSignal): Promise<DatasetEnds | null> {
  if (datasetEnd && nowMs - datasetEnd.at < 10 * 60_000) return datasetEnd.ends;
  const ends = await getDatasetEnds(IV_DATASET, signal).catch(() => null);
  if (ends) datasetEnd = { at: nowMs, ends };
  return ends;
}

/* ------------------------------------------------------------------ snapshots */

export type IvSnapshot = { date: string; minute: number; asOfMs: number; label: string; intraday: boolean };

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/** The daily job's snapshot minute: 15:45 New York, 12:45 on early-close days (engine chains.ts snapshotMinute). Pure. */
export function snapshotMinute(date: string): number {
  return isNyseEarlyClose(date) ? 12 * 60 + 45 : 15 * 60 + 45;
}

const snap = (date: string, minute: number, intraday: boolean): IvSnapshot => ({ date, minute, asOfMs: nyInstantMs(date, minute), label: `${date} ${hhmm(minute)} ET`, intraday });

/**
 * The snapshots Databento can serve at `nowMs`: `eod`, the latest session's
 * 15:45 (the daily job's minute), and `latest`, the newest minute there is
 * (intraday when Databento already has today's session past 09:45). A
 * snapshot must be 15 minutes old and, when the range is known, end inside
 * it. Pure.
 */
export function pickIvSnapshots(nowMs: number, availableEndMs: number | null): { eod: IvSnapshot | null; latest: IvSnapshot | null } {
  const capMs = Math.min(nowMs - 15 * 60_000, availableEndMs ?? Number.POSITIVE_INFINITY);
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const sessions = nyseSessions(addDays(today, -12), today);
  let eod: IvSnapshot | null = null;
  let latest: IvSnapshot | null = null;
  for (let i = sessions.length - 1; i >= 0 && !eod; i--) {
    const date = sessions[i]!;
    const full = snapshotMinute(date);
    if (nyInstantMs(date, full + 1) <= capMs) {
      eod = snap(date, full, false);
      latest ??= eod;
    } else if (!latest && nyInstantMs(date, 9 * 60 + 46) <= capMs) {
      const capMinute = Math.floor((capMs - nyInstantMs(date, 0)) / 60_000) - 1;
      latest = snap(date, Math.min(full, capMinute), true);
    }
  }
  return { eod, latest };
}

/** The quote request for one chain at a snapshot. Pure. */
export function chainRequest(t: string, s: Pick<IvSnapshot, "date" | "minute">): RangeRequest {
  const iso = (m: number) => new Date(nyInstantMs(s.date, m)).toISOString();
  return { dataset: IV_DATASET, schema: IV_SCHEMA, symbols: [`${osiRoot(t)}.OPT`], stype_in: "parent", start: iso(s.minute - LOOKBACK_MIN), end: iso(s.minute + 1) };
}

/* ------------------------------------------------------------------ the store */

type TermRow = [string, number, number];
export type StoreRow = { as_of: string; skip: string | null; block: RippleOptions | null; ivPct: number | null; term: TermRow[] | null; straddle?: EarningsStraddle | null };

export type Stored = {
  session: string;
  block: RippleOptions;
  /** ATM IV per expiry (fractions), nearest first. */
  term: Array<{ expiration: string; days: number; iv: number }>;
  /** ATM IV per stored session (percent), oldest first. */
  history: Array<{ date: string; atmIv: number }>;
  /** The latest stored pre-earnings straddle (metrics.earnings_straddle), with its session. */
  straddle?: { session: string; value: EarningsStraddle } | null;
};

/** The latest stored record and the ticker's ATM IV history; the latest skip (a chain too thin to read) when newer. Pure. */
export function storedView(rows: readonly StoreRow[]): { stored: Stored | null; skip: { session: string; reason: string } | null } {
  const sorted = [...rows].sort((a, b) => (a.as_of < b.as_of ? 1 : -1));
  const good = sorted.filter((r) => !r.skip && r.block && typeof r.block.atmIv === "number" && Number.isFinite(r.block.atmIv));
  const top = good[0];
  const skipRow = sorted.find((r) => r.skip);
  const skip = skipRow && (!top || skipRow.as_of > top.as_of) ? { session: skipRow.as_of, reason: skipRow.skip! } : null;
  if (!top) return { stored: null, skip };
  const term = (Array.isArray(top.term) ? top.term : [])
    .filter((p) => Array.isArray(p) && typeof p[0] === "string" && Number.isFinite(p[1]) && Number.isFinite(p[2]) && p[2] > 0)
    .map(([expiration, days, iv]) => ({ expiration, days, iv }));
  const block: RippleOptions = { ...top.block! };
  if (typeof top.ivPct === "number") block.ivPct = top.ivPct;
  const st = good.find((r) => r.straddle && typeof r.straddle.implied_move === "number");
  return {
    stored: { session: top.as_of, block, term, history: good.map((r) => ({ date: r.as_of, atmIv: r.block!.atmIv })).reverse(), straddle: st ? { session: st.as_of, value: st.straddle! } : null },
    skip,
  };
}

async function readStore(t: string): Promise<StoreRow[]> {
  const res = await getSupabaseAdmin()
    .from("options_daily")
    .select("as_of, skip, block:metrics->block, ivPct:metrics->ivPct, term:metrics->raw->term, straddle:metrics->earnings_straddle")
    .eq("ticker", t)
    .order("as_of", { ascending: false })
    .limit(120);
  if (res.error) throw new Error(res.error.message);
  return (res.data ?? []) as unknown as StoreRow[];
}

/* ------------------------------------------------------------------ IV standing */

export type IvStanding = { sessions: number; from: string | null; percentile: number | null; rank: number | null; low: number | null; high: number | null; note?: string };

/**
 * Where `current` (percent) sits among the stored ATM IVs: percentile (share
 * of stored days below it, ties half, as the engine's store.ts) and rank
 * ((current - low) / (high - low)), both 0-100, from 20 stored sessions on. Pure.
 */
export function ivStanding(current: number, history: ReadonlyArray<{ date: string; atmIv: number }>): IvStanding {
  const h = history.filter((p) => Number.isFinite(p.atmIv) && p.atmIv > 0);
  const from = h.length ? h[0]!.date : null;
  if (h.length < MIN_IV_DAYS || !Number.isFinite(current)) {
    return { sessions: h.length, from, percentile: null, rank: null, low: null, high: null, note: `IV percentile and rank need ${MIN_IV_DAYS} earlier stored sessions; Falcon has ${h.length}${from ? ` (since ${from})` : ""}.` };
  }
  let below = 0;
  let equal = 0;
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (const p of h) {
    if (p.atmIv < current) below++;
    else if (p.atmIv === current) equal++;
    low = Math.min(low, p.atmIv);
    high = Math.max(high, p.atmIv);
  }
  const rank = high > low ? Math.round(Math.min(100, Math.max(0, ((current - low) / (high - low)) * 100))) : 50;
  return { sessions: h.length, from, percentile: Math.round((100 * (below + equal / 2)) / h.length), rank, low: round(low, 1), high: round(high, 1) };
}

/* ------------------------------------------------------------------ one live chain */

/** A contract with an IV, compact. */
export type IvContract = { strike: number; right: "C" | "P"; expiration: string; days: number; iv: number };

export type LiveChain = {
  ticker: string;
  snapshot: IvSnapshot;
  block: RippleOptions;
  atmIv60: number | null;
  atmIv90: number | null;
  spot: number;
  spotSource: string;
  /** ATM IV per expiry (fractions), nearest first. */
  term: Array<{ expiration: string; days: number; iv: number }>;
  contracts: IvContract[];
  quality: { contracts: number; quoted: number; withIv: number };
  costUsd: number;
  /** Where the quotes came from: Databento OPRA (bought) or Yahoo's delayed chain (free, iv-fresh.ts). */
  provider?: "databento" | "yahoo";
  /** Before an earnings reaction: the ATM straddle of the first expiry covering it (engine earnings-straddle.ts). */
  earningsStraddle?: EarningsStraddle | null;
  /** Yahoo only: Yahoo's own ATM IV next to Falcon's. */
  yahooIvCheck?: YahooIvCheck | null;
  /** Yahoo only: when the chain was read (ms). */
  fetchedAtMs?: number;
};

export type Market = {
  daily: ReturnType<typeof barsFromChart>;
  /** Close of the 1-minute bar ending at the snapshot, when Yahoo has it. */
  minuteSpot: number | null;
  spy: ReturnType<typeof barsFromChart>;
  vix: number | null;
  rate: number;
  dividends: Array<{ date: string; amount: number }>;
};

/** Bank discount yield (percent) of a 91-day bill to a continuous rate (engine rates.ts discountToContinuous). Pure. */
export function discountToContinuous(pct: number, days = 91): number {
  const price = 1 - ((pct / 100) * days) / 360;
  return -Math.log(price) / (days / 365);
}

/** Continuous dividend yield ln(1 + D / S), D the dividends with ex-date in (date - 365 d, date] (engine rates.ts dividendYieldOn). Pure. */
export function dividendYield(dividends: ReadonlyArray<{ date: string; amount: number }>, date: string, spot: number): number {
  const from = addDays(date, -365);
  let d = 0;
  for (const x of dividends) if (x.date > from && x.date <= date) d += x.amount;
  return spot > 0 ? Math.log(1 + d / spot) : 0;
}

/** Close of the 1-minute bar that ends at (or just before) `asOfMs`, within 10 minutes. Pure. */
export function minuteClose(c: ChartResult | null | undefined, asOfMs: number): number | null {
  const ts = c?.timestamp ?? [];
  const close = c?.indicators?.quote?.[0]?.close ?? [];
  let best: number | null = null;
  for (let i = 0; i < ts.length; i++) {
    const startMs = ts[i]! * 1000;
    const v = close[i];
    if (startMs + 60_000 > asOfMs || startMs + 60_000 < asOfMs - 10 * 60_000 || typeof v !== "number" || !(v > 0)) continue;
    best = v;
  }
  return best;
}

function dividendsOf(c: ChartResult | null): Array<{ date: string; amount: number }> {
  const raw = ((c as { events?: { dividends?: Record<string, { amount?: number; date?: number }> } } | null)?.events?.dividends ?? {}) as Record<string, { amount?: number; date?: number }>;
  return Object.values(raw)
    .filter((d) => typeof d.amount === "number" && d.amount > 0 && typeof d.date === "number")
    .map((d) => ({ date: new Date(d.date! * 1000 - 5 * HOUR).toISOString().slice(0, 10), amount: d.amount! }));
}

const lastOnOrBefore = (bars: ReturnType<typeof barsFromChart>, date: string) => {
  let v: number | null = null;
  for (const b of bars) if (b.date <= date) v = b.close;
  return v;
};

/** Yahoo's inputs for one chain (free): closes, the minute spot, SPY (beta), VIX, the bill rate, dividends. Null for an unknown ticker. */
async function loadMarket(t: string, s: IvSnapshot, nowMs: number): Promise<Market | null> {
  const sig = () => AbortSignal.timeout(8_000);
  const soft = <T>(p: Promise<T>) => p.catch(() => undefined);
  const recent = nowMs - s.asOfMs < 6 * 86_400_000;
  const [daily, minute, spy, vix, irx] = await Promise.all([
    soft(yahooChart(t, "1y", "1d", sig())),
    recent ? soft(yahooChart(t, "5d", "1m", sig())) : Promise.resolve(undefined),
    soft(yahooChart("SPY", "1y", "1d", sig())),
    soft(yahooChart("^VIX", "1mo", "1d", sig())),
    soft(yahooChart("^IRX", "1mo", "1d", sig())),
  ]);
  if (daily === null) return null;
  const vixClose = vix ? lastOnOrBefore(barsFromChart(vix), s.date) : null;
  const irxClose = irx ? lastOnOrBefore(barsFromChart(irx), s.date) : null;
  return {
    daily: daily ? barsFromChart(daily).filter((b) => b.date <= s.date) : [],
    minuteSpot: minuteClose(minute ?? null, s.asOfMs),
    spy: spy ? barsFromChart(spy) : [],
    vix: vixClose !== null ? vixClose / 100 : null,
    rate: irxClose !== null && irxClose > 0 && irxClose < 25 ? discountToContinuous(irxClose) : 0.04,
    dividends: dividendsOf(daily ?? null),
  };
}

/**
 * One chain's record from its quote records, with the engine's spot rule
 * (chains.ts computeOne): the minute bar when within 15% of the session's
 * close, else the close refined by the put-call parity spot when within 3%.
 * Throws ToolError when the chain is too thin to read. Pure.
 */
export function computeChain(t: string, s: IvSnapshot, records: ReadonlyArray<Record<string, unknown>>, m: Market, costUsd: number, release: EarningsRelease | null = null): LiveChain {
  const defsAll = definitionsFromRecords(records, t);
  if (!defsAll.length) throw new ToolError(`${t} had no option quotes at ${s.label}.`);
  return computeFromQuotes(t, s, defsAll, quotesAt(records, s.asOfMs), m, costUsd, { release, straddleSource: "OPRA.PILLAR cbbo-1m via Databento (on demand)" });
}

/**
 * computeChain's core from definitions and quotes at the snapshot, whatever
 * their source (Databento records, or Yahoo's chain in iv-fresh.ts). `spotLabel`
 * names the minute spot (m.minuteSpot); with `release` (an earnings release
 * the snapshot comes before) the pre-earnings ATM straddle is added, the same
 * computation as the daily job's metrics.earnings_straddle. Throws ToolError
 * when the chain is too thin to read. Pure.
 */
export function computeFromQuotes(
  t: string,
  s: IvSnapshot,
  defsAll: readonly OptionDefinition[],
  quotes: ReadonlyMap<number, EngineQuote>,
  m: Market,
  costUsd: number,
  opts: { spotLabel?: string; release?: EarningsRelease | null; straddleSource?: string; provider?: LiveChain["provider"] } = {},
): LiveChain {
  if (!defsAll.length) throw new ToolError(`${t} had no option quotes at ${s.label}.`);
  const last = m.daily.length ? m.daily[m.daily.length - 1]! : null;
  const close = last && last.date === s.date && !s.intraday ? last.close : null;
  const fallback = close ?? (last ? last.close : null);
  const run = (spot: number, divYield: number): SurfaceFeatures => {
    const defs = defsAll.filter((d) => d.strike / spot >= 0.7 && d.strike / spot <= 1.3 && (Date.parse(d.expiration) - Date.parse(s.date)) / 86_400_000 <= 400);
    return surfaceFeatures({ underlying: t, date: s.date, asOfMs: s.asOfMs, spot, rate: m.rate, divYield, definitions: defs, quotes, moveDates: [] });
  };
  const at = (spot: number) => run(spot, dividendYield(m.dividends, s.date, spot));
  let spot = m.minuteSpot;
  let spotSource: TickerOptions["spotSource"] = "itch";
  let f: SurfaceFeatures | null = null;
  if (spot !== null && (fallback === null || Math.abs(spot / fallback - 1) < 0.15)) f = at(spot);
  else if (fallback !== null) {
    spot = fallback;
    spotSource = "close";
    f = at(spot);
  }
  // Refine with the parity spot (the engine does for the close; here also when the minute bar is a little off).
  const p = f?.parityImpliedSpot ?? null;
  if (f && spot !== null && p !== null && Math.abs(p / spot - 1) > 0.002 && Math.abs(p / spot - 1) < 0.03 && (spotSource === "close" || chainProblem(f))) {
    spot = p;
    spotSource = "parity";
    f = at(spot);
  }
  if (!f || spot === null) throw new ToolError(`No price for ${t} at ${s.label}, so its options could not be read.`);
  const problem = chainProblem(f);
  if (problem) throw new ToolError(`${t}'s option chain is too thin to read at ${s.label} (${problem}).`);
  const closes = m.daily.map((b) => ({ date: b.date, close: b.adj }));
  const spy = m.spy.map((b) => ({ date: b.date, close: b.adj }));
  const beta = closes.length && spy.length ? betaFromCloses(closes, spy, s.date) : null;
  const rec = tickerOptionsFrom(f, { ticker: t, spotSource, beta, vix: m.vix });
  const contracts: IvContract[] = f.contracts
    .filter((r) => r.iv !== null && r.days >= 2)
    .map((r) => ({ strike: r.strike, right: r.right, expiration: r.expiration, days: Math.round(r.days * 100) / 100, iv: Math.round(r.iv! * 1e5) / 1e5 }));
  return {
    ticker: t,
    snapshot: s,
    block: optionsBlock(rec),
    atmIv60: f.atmIv60,
    atmIv90: f.atmIv90,
    spot,
    spotSource: spotSource === "itch" ? (opts.spotLabel ?? "1-minute bar at the snapshot") : spotSource === "parity" ? "put-call parity" : "session close",
    term: rec.term,
    contracts,
    quality: { contracts: f.quality.contracts, quoted: f.quality.quoted, withIv: f.quality.withIv },
    costUsd,
    provider: opts.provider ?? "databento",
    ...(opts.release && s.date <= releaseSessions(opts.release).snapshotSession
      ? { earningsStraddle: earningsStraddle(f.contracts, spot, opts.release, { asOfMs: s.asOfMs, sourceMinute: s.label, source: opts.straddleSource ?? "OPRA.PILLAR cbbo-1m via Databento" }) }
      : {}),
  };
}

function spendLine(req: RangeRequest, kind: "charge" | "refund", costUsd: number, note: string): SpendLine {
  return { at: new Date().toISOString(), caller: IV_CALLER, kind, dataset: req.dataset, schema: req.schema, symbols: req.symbols.length, start_at: req.start, end_at: req.end, cost_usd: kind === "refund" ? -costUsd : costUsd, key: requestKey(req), note };
}

/** One paid request of an on-demand pull: the chain's quotes, open interest or volume. */
export type PieceName = "chain" | "oi" | "volume";
type Piece = { what: PieceName; req: RangeRequest; costUsd: number; note: string };

/**
 * The pieces of one on-demand pull that may be bought, in priority order
 * (chain, then open interest, then volume): together they stay within the
 * per-pull limit, and each fits the caller's and the Databento month caps
 * with the ones before it. `refused` says why the others are not. Pure.
 */
export function choosePieces(pieces: ReadonlyArray<{ what: PieceName; costUsd: number }>, month: MonthTally | null, caps: IvCaps): { buy: PieceName[]; refused: Partial<Record<PieceName, string>> } {
  const buy: PieceName[] = [];
  const refused: Partial<Record<PieceName, string>> = {};
  let total = 0;
  for (const p of pieces) {
    const tally = month ? { callerUsd: month.callerUsd + total, totalUsd: month.totalUsd + total } : null;
    let why: string | null;
    if (p.what === "chain") why = capRefusal(p.costUsd, tally, caps);
    else if (!Number.isFinite(p.costUsd) || p.costUsd < 0) why = "Databento could not price it";
    else if (total + p.costUsd > caps.maxPullUsd + 1e-9)
      why = `it would cost $${p.costUsd.toFixed(2)} of OPRA data${total > 0 ? ` ($${(total + p.costUsd).toFixed(2)} with the rest of this pull)` : ""}, over the $${caps.maxPullUsd.toFixed(2)} limit for one on-demand pull`;
    else why = capRefusal(p.costUsd, tally, { ...caps, maxPullUsd: Number.POSITIVE_INFINITY });
    if (why) refused[p.what] = why;
    else {
      buy.push(p.what);
      total += p.costUsd;
    }
  }
  return { buy, refused };
}

/** Downloads one bought piece with its own timeout (not the tool's); refunds it when Databento refuses it. */
async function download(p: Piece): Promise<RangeBody<Record<string, unknown>>> {
  try {
    return await getRange(p.req, AbortSignal.timeout(PULL_TIMEOUT_MS));
  } catch (err) {
    // Databento refused (nothing served): refund. A dropped or slow download keeps its charge (the safe side).
    if (err instanceof DatabentoError && err.status >= 400) {
      release(p.costUsd);
      await appendSpend([spendLine(p.req, "refund", p.costUsd, `refused: HTTP ${err.status}`)]).catch(() => undefined);
    }
    throw err;
  }
}

function release(costUsd: number): void {
  if (!month) return;
  month.tally.callerUsd -= costUsd;
  month.tally.totalUsd -= costUsd;
}

function waitOrAbort<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

const errText = (err: unknown) => (err instanceof ToolError ? err.message : err instanceof DatabentoError ? `Databento answered HTTP ${err.status || "error"}` : "the download failed");

/** Open interest's price: the 06:30 window, or the whole pre-open when that one is empty (null when it could not be priced). */
async function priceOi(oi: NonNullable<PcPlan["oi"]>, price: (r: RangeRequest, label: string) => Promise<number | null>): Promise<{ req: RangeRequest; costUsd: number } | null> {
  const narrow = await price(oi.req, "Open interest");
  if (narrow === null || narrow > 0 || !oi.wide) return narrow === null ? null : { req: oi.req, costUsd: narrow };
  const wide = await price(oi.wide, "Open interest");
  return wide === null ? null : { req: oi.wide, costUsd: wide };
}

/** A put/call piece: its rows (bought now or earlier) and what this answer paid for it. */
type PcPiece = { rows: Promise<PcRow[]>; costUsd: number };

type OnDemand = {
  chain: Promise<LiveChain> | null;
  chainFromCache: boolean;
  chainError: unknown;
  oi: PcPiece | null;
  volume: PcPiece | null;
  pcNotes: string[];
};

/**
 * Databento's price for a request already priced on this instance (metadata.get_cost often takes 10-30 s; the price of
 * a range that has ended does not change). A repeat ask, or a reply resumed in a new request, skips the wait.
 */
const priceMemo = new Map<string, number>();
async function priceOf(req: RangeRequest, signal: AbortSignal): Promise<number> {
  const key = requestKey(req);
  const hit = priceMemo.get(key);
  if (hit !== undefined) return hit;
  const v = await getCost(req, signal);
  const end = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(req.end) ? `${req.end}T00:00:00Z` : req.end);
  if (Number.isFinite(end) && end < Date.now()) {
    if (priceMemo.size >= 500) priceMemo.clear();
    priceMemo.set(key, v);
  }
  return v;
}

/**
 * One on-demand pull: the chain at snapshot `s` (when given) and the put/call
 * pieces of `plan` (when given), each from the cache or priced (in parallel),
 * checked against the caps together, charged in the ledger in one write and
 * downloaded in parallel. With `chainFirst`, nothing else is bought when the
 * chain is not (there would be no answer to put it in).
 */
async function onDemand(t: string, s: IvSnapshot | null, plan: PcPlan | null, nowMs: number, signal: AbortSignal, chainFirst: boolean, earningsRelease: EarningsRelease | null = null): Promise<OnDemand> {
  const out: OnDemand = { chain: null, chainFromCache: false, chainError: null, oi: null, volume: null, pcNotes: [] };
  const chainKey = s ? `${t}|${s.label}|${earningsRelease ? `${earningsRelease.date} ${earningsRelease.time}` : ""}` : "";
  const hit = s ? chainCache.get(chainKey) : undefined;
  if (hit) {
    out.chain = hit;
    out.chainFromCache = true;
  }
  const oiKey = plan?.oi ? `${t}|oi|${plan.oi.date}` : null;
  const volKey = plan?.volume ? `${t}|vol|${plan.volume.session}` : null;
  const oiHit = oiKey ? pieceCache.get(oiKey) : undefined;
  const volHit = volKey ? pieceCache.get(volKey) : undefined;
  if (oiHit) out.oi = { rows: oiHit, costUsd: 0 };
  if (volHit) out.volume = { rows: volHit, costUsd: 0 };
  const wantChain = s !== null && !hit;
  const wantOi = !!plan?.oi && !oiHit;
  const wantVol = !!plan?.volume && !volHit;
  if (!wantChain && !wantOi && !wantVol) return out;

  const req = s ? chainRequest(t, s) : null;
  // Each put/call price has its own short timeout: Databento's pricing sometimes stalls, and the IV answer must not wait on it.
  const pcPrice = (r: RangeRequest, label: string) =>
    priceOf(r, AbortSignal.any([signal, AbortSignal.timeout(PC_PRICE_TIMEOUT_MS)])).catch((err: unknown) => {
      if (signal.aborted) throw err;
      const why = err instanceof DatabentoError ? (err.status === 422 ? "Databento has no listed options for it" : errText(err)) : "Databento did not answer in time; ask again";
      out.pcNotes.push(`${label} could not be priced (${why})`);
      return null;
    });
  const [cost, market, tally, oiCost, volCost] = await Promise.all([
    wantChain
      ? priceOf(req!, signal).catch((err: unknown) => {
          if (signal.aborted) throw err;
          if (err instanceof DatabentoError && err.status === 422) return new ToolError(`Databento has no listed options for ${t}.`);
          return new ToolError(`Databento could not price ${t}'s options (${errText(err)}).`);
        })
      : Promise.resolve(0),
    wantChain ? loadMarket(t, s!, nowMs) : Promise.resolve(null),
    loadMonth(nowMs, signal),
    wantOi ? priceOi(plan!.oi!, pcPrice) : Promise.resolve(null),
    wantVol ? pcPrice(plan!.volume!.req, "Put/call volume") : Promise.resolve(null),
  ]);

  const pieces: Piece[] = [];
  if (wantChain) {
    const again = chainCache.get(chainKey);
    if (cost instanceof Error) out.chainError = cost;
    else if (market === null) out.chainError = new ToolError(`No such US ticker: ${t}.`);
    else if (!(cost > 0)) out.chainError = new ToolError(`${t} had no option quotes at ${s!.label} (no listed options, or none quoted).`);
    else if (again) {
      out.chain = again;
      out.chainFromCache = true;
    } else pieces.push({ what: "chain", req: req!, costUsd: cost, note: `${t} ${s!.label}` });
  }
  if (wantOi && oiCost !== null) {
    if (oiCost.costUsd > 0) pieces.push({ what: "oi", req: oiCost.req, costUsd: oiCost.costUsd, note: `${t} open interest, ${plan!.oi!.date} pre-open` });
    else out.pcNotes.push(`No open interest was published for ${t}'s options before the ${plan!.oi!.date} open`);
  }
  if (wantVol && volCost !== null) {
    if (volCost > 0) pieces.push({ what: "volume", req: plan!.volume!.req, costUsd: volCost, note: `${t} option volume, ${plan!.volume!.session}` });
    else out.pcNotes.push(`No option volume for ${t} on ${plan!.volume!.session}`);
  }
  const { buy, refused } = choosePieces(pieces, tally, ivCaps());
  if (refused.chain) out.chainError = new ToolError(`No fresh options snapshot was bought: ${refused.chain}.`);
  if (chainFirst && wantChain && !buy.includes("chain") && !out.chain) return out;
  if (refused.oi) out.pcNotes.push(`Open interest not bought: ${refused.oi}`);
  if (refused.volume) out.pcNotes.push(`Put/call volume not bought: ${refused.volume}`);
  let bought = pieces.filter((p) => buy.includes(p.what));
  if (!bought.length) return out;
  for (const p of bought) {
    month!.tally.callerUsd += p.costUsd;
    month!.tally.totalUsd += p.costUsd;
  }
  try {
    await appendSpend(
      bought.map((p) => spendLine(p.req, "charge", p.costUsd, p.note)),
      AbortSignal.timeout(8_000),
    );
  } catch {
    for (const p of bought) release(p.costUsd);
    if (buy.includes("chain")) out.chainError = new ToolError("The spend ledger could not be written, so no options data was bought. Try again later.");
    if (bought.some((p) => p.what !== "chain")) out.pcNotes.push("The spend ledger could not be written, so no put/call data was bought");
    bought = [];
  }
  for (const p of bought) {
    if (p.what === "chain") out.chain = cached(chainCache, chainKey, () => download(p).then((body) => ({ ...computeChain(t, s!, body.records, market!, p.costUsd, earningsRelease), fetchedAtMs: Date.now() })));
    else if (p.what === "oi") out.oi = { rows: cached(pieceCache, oiKey!, () => download(p).then((body) => oiFromStatistics(body.records, t))), costUsd: p.costUsd };
    else out.volume = { rows: cached(pieceCache, volKey!, () => download(p).then((body) => volumeFromOhlcv(body.records, t))), costUsd: p.costUsd };
  }
  return out;
}

/** The put/call figures from the pieces, waiting for their downloads until the tool's deadline. */
async function putCallOf(t: string, plan: PcPlan, d: OnDemand, signal: AbortSignal, outer: AbortSignal | undefined): Promise<PutCall> {
  const notes = [...d.pcNotes];
  const settle = async (piece: PcPiece | null, label: string): Promise<PcRow[] | null> => {
    if (!piece) return null;
    try {
      return await waitOrAbort(piece.rows, signal);
    } catch (err) {
      if (outer?.aborted) throw err;
      notes.push(signal.aborted ? `${label} is still downloading; ask again for it (it is not bought twice)` : `${label} could not be read (${errText(err)})`);
      if (!signal.aborted && !(err instanceof ToolError)) console.error("[desk/iv] put/call", JSON.stringify({ ticker: t, piece: label, error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : String(err) }));
      return null;
    }
  };
  const [oiRows, volRows] = await Promise.all([settle(d.oi, "Open interest"), settle(d.volume, "Put/call volume")]);
  if (!plan.oi) notes.push("No pre-open open interest is available from Databento yet");
  return {
    oi: oiRows && oiRows.length ? oiFigures(oiRows, plan.oi!.date, plan.oi!.after) : null,
    volume: volRows && volRows.length ? { ...putCallTotals(volRows), session: plan.volume!.session } : null,
    costUsd: (oiRows ? d.oi?.costUsd ?? 0 : 0) + (volRows ? d.volume?.costUsd ?? 0 : 0),
    notes,
  };
}

/* ------------------------------------------------------------------ shaping (pure) */

const pct1 = (frac: number | null | undefined) => (typeof frac === "number" && Number.isFinite(frac) ? Math.round(frac * 1000) / 10 : null);

/** ATM IV per expiry as [expiration, days, IV %], at most `max` points spread over the curve. Pure. */
export function termPoints(term: ReadonlyArray<{ expiration: string; days: number; iv: number }>, max = MAX_TERM_POINTS): Array<[string, number, number]> {
  const pts = term.filter((p) => p.days >= 2 && p.iv > 0).sort((a, b) => a.days - b.days);
  return spread(pts, max).map((p) => [p.expiration, round(p.days, 1)!, pct1(p.iv)!]);
}

/** At most `max` items, evenly spaced, first and last kept. Pure. */
export function spread<T>(items: readonly T[], max: number): T[] {
  if (items.length <= max) return [...items];
  const out: T[] = [];
  for (let i = 0; i < max; i++) out.push(items[Math.round((i * (items.length - 1)) / (max - 1))]!);
  return out;
}

/** IV by strike for one expiry: the out-of-the-money side (puts below spot, calls at and above), the other side where it has none. Pure. */
export function smileOf(contracts: readonly IvContract[], expiration: string, spot: number): Array<{ strike: number; iv: number }> {
  const byStrike = new Map<number, { C?: number; P?: number }>();
  for (const c of contracts) {
    if (c.expiration !== expiration) continue;
    const e = byStrike.get(c.strike) ?? {};
    e[c.right] = c.iv;
    byStrike.set(c.strike, e);
  }
  return Array.from(byStrike.entries())
    .map(([strike, e]) => ({ strike, iv: (strike < spot ? e.P ?? e.C : e.C ?? e.P)! }))
    .filter((p) => Number.isFinite(p.iv))
    .sort((a, b) => a.strike - b.strike);
}

/** Expiries with a usable smile (at least 3 strikes with an IV: a $3 stock lists few), nearest first. Pure. */
function smileExpiries(contracts: readonly IvContract[]): Array<{ expiration: string; days: number; strikes: number }> {
  const m = new Map<string, { days: number; strikes: Set<number> }>();
  for (const c of contracts) {
    const e = m.get(c.expiration) ?? { days: c.days, strikes: new Set<number>() };
    e.strikes.add(c.strike);
    m.set(c.expiration, e);
  }
  return Array.from(m.entries())
    .map(([expiration, e]) => ({ expiration, days: e.days, strikes: e.strikes.size }))
    .filter((e) => e.strikes >= 3)
    .sort((a, b) => a.days - b.days);
}

/** The smile output for an expiry (the one asked for, else the one nearest 30 days). Pure. */
export function smileOutput(chain: Pick<LiveChain, "contracts" | "spot">, expiration: string | null) {
  const exps = smileExpiries(chain.contracts);
  if (!exps.length) return null;
  const pick = expiration
    ? exps.reduce((a, b) => (Math.abs(Date.parse(b.expiration) - Date.parse(expiration)) < Math.abs(Date.parse(a.expiration) - Date.parse(expiration)) ? b : a))
    : exps.reduce((a, b) => (Math.abs(b.days - 30) < Math.abs(a.days - 30) ? b : a));
  const pts = spread(smileOf(chain.contracts, pick.expiration, chain.spot), MAX_SMILE_POINTS);
  return {
    expiration: pick.expiration,
    days: round(pick.days, 1),
    spot: round(chain.spot, 2),
    points: pts.map((p) => [round(p.strike, 2), pct1(p.iv)]),
    columns: ["strike $", "IV %"],
    ...(expiration && pick.expiration !== expiration ? { note: `No ${expiration} expiry; the nearest listed one is shown.` } : {}),
    otherExpiries: exps.filter((e) => e.expiration !== pick.expiration).slice(0, 12).map((e) => e.expiration),
  };
}

/** IV (fraction) at moneyness `x` (K/S, %) on a smile, linear between neighbours at most MAX_GAP_PTS apart; null outside (never extrapolated). Pure. */
export function ivAtMoneyness(smile: ReadonlyArray<{ strike: number; iv: number }>, spot: number, x: number): number | null {
  const pts = smile.map((p) => ({ m: (p.strike / spot) * 100, iv: p.iv }));
  let lo: { m: number; iv: number } | null = null;
  let hi: { m: number; iv: number } | null = null;
  for (const p of pts) {
    if (p.m <= x && (!lo || p.m > lo.m)) lo = p;
    if (p.m >= x && (!hi || p.m < hi.m)) hi = p;
  }
  if (!lo || !hi) return null;
  if (hi.m === lo.m) return lo.iv;
  if (hi.m - lo.m > MAX_GAP_PTS) return null;
  return lo.iv + ((hi.iv - lo.iv) * (x - lo.m)) / (hi.m - lo.m);
}

/**
 * The IV surface for show_chart surface3d: x = moneyness (strike / spot, %),
 * y = days to expiry (ascending, at most 10 expiries spread from a week to a
 * year), z[i][j] = IV % at y[i], x[j] (null where no quote brackets it). Pure.
 */
export function surfaceOutput(chain: Pick<LiveChain, "contracts" | "spot">) {
  const exps = smileExpiries(chain.contracts).filter((e) => e.days >= 2);
  const chosen: typeof exps = [];
  for (const target of SURFACE_DAY_TARGETS) {
    const best = exps.reduce<(typeof exps)[number] | null>((a, b) => (!a || Math.abs(b.days - target) < Math.abs(a.days - target) ? b : a), null);
    if (best && !chosen.some((c) => c.expiration === best.expiration || Math.round(c.days) === Math.round(best.days))) chosen.push(best);
  }
  chosen.sort((a, b) => a.days - b.days);
  const y: number[] = [];
  const z: Array<Array<number | null>> = [];
  const expirations: string[] = [];
  for (const e of chosen.slice(0, MAX_SURFACE_EXPIRIES)) {
    const smile = smileOf(chain.contracts, e.expiration, chain.spot);
    // Wings past 4 ATM standard deviations (a week out, 80% of spot is ~6) are a cent bid and noise: left empty.
    const atm = ivAtMoneyness(smile, chain.spot, 100);
    const reach = atm !== null ? WING_SDS * atm * Math.sqrt(e.days / 365) : Number.POSITIVE_INFINITY;
    const row = SURFACE_MONEYNESS.map((x) => (Math.abs(Math.log(x / 100)) <= reach ? pct1(ivAtMoneyness(smile, chain.spot, x)) : null));
    if (row.filter((v) => v !== null).length < 3) continue;
    y.push(Math.round(e.days));
    z.push(row);
    expirations.push(e.expiration);
  }
  if (y.length < 2) return null;
  return {
    grid: { x: [...SURFACE_MONEYNESS], y, z },
    axes: { x: { label: "Strike / spot", unit: "%" }, y: { label: "Days to expiry", unit: "days" }, z: { label: "Implied vol", unit: "%" } },
    expirations,
    spot: round(chain.spot, 2),
    note: "Pass grid and axes to show_chart (kind surface3d) unchanged. Out-of-the-money side per strike (puts below spot, calls above); null = no quotes around that strike, or more than 4 standard deviations from spot for that expiry (thin far wings).",
  };
}

type Shape = {
  q: IvQuery;
  stored: Stored | null;
  live: { chain: LiveChain; fromCache: boolean } | null;
  liveNote: string | null;
  /** Put/call volume and open interest (summary only). */
  putCall?: PutCall | null;
  /** The clock and session the answer's freshness is judged against (ivTool always passes it). */
  freshness?: AnswerFreshness;
};

/** What decides an answer's `stale` flag and its warning. */
export type AnswerFreshness = {
  nowMs: number;
  session: SessionClock | null;
  /** Earnings within EARNINGS_WINDOW_DAYS, when known. */
  earnings: EarningsSoon | null;
  /** Why no same-day chain could be read (Databento and Yahoo), when one was tried and failed. */
  freshFailure: string | null;
};

/** A machine-readable source of one group of numbers (for citations). */
export type SourceRef = { group: string; covers: string[]; dataset: string; as_of: string | null; fetched_at: string; url?: string };

const DATABENTO_OPRA_URL = "https://databento.com/datasets/OPRA.PILLAR";
const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString() : null);

/** The sources of an answer's number groups. Pure. */
export function ivSources(o: { ticker: string; chain: LiveChain | null; block: RippleOptions; stored: Stored | null; putCall: PutCall | null | undefined; nowMs: number }): SourceRef[] {
  const fetched = new Date(o.nowMs).toISOString();
  const main = ["spot", "atmIv30Pct", "atmIv60Pct", "atmIv90Pct", "impliedMove5", "impliedMove20", "skewPts", "callPutSpreadPts", "term", "smile", "surface", "earnings"];
  const out: SourceRef[] = [];
  if (o.chain?.provider === "yahoo")
    out.push({ group: "options", covers: main, dataset: `${YAHOO_OPTIONS_DATASET}; figures computed by Falcon from bid/ask mids`, as_of: o.block.asOf, fetched_at: iso(o.chain.fetchedAtMs ?? o.nowMs)!, url: yahooOptionsUrl(o.ticker) });
  else if (o.chain)
    out.push({ group: "options", covers: main, dataset: "OPRA.PILLAR cbbo-1m via Databento (one snapshot of this chain, priced on demand by Falcon)", as_of: o.block.asOf, fetched_at: iso(o.chain.fetchedAtMs ?? o.nowMs)!, url: DATABENTO_OPRA_URL });
  else out.push({ group: "options", covers: main, dataset: "Falcon options_daily: OPRA.PILLAR cbbo-1m via Databento, end-of-day snapshot", as_of: o.block.asOf, fetched_at: fetched, url: DATABENTO_OPRA_URL });
  out.push({ group: "market", covers: ["beta", "vixPct", "ivToVix"], dataset: "Yahoo Finance daily chart (stock, SPY, ^VIX)", as_of: o.block.asOf, fetched_at: out[0]!.fetched_at });
  const hist = o.stored?.history ?? [];
  if (hist.length) out.push({ group: "ivStanding", covers: ["ivStanding", "atmIvHistory"], dataset: "Falcon options_daily (stored ATM IV per session, OPRA via Databento)", as_of: iso(nyInstantMs(hist[hist.length - 1]!.date, snapshotMinute(hist[hist.length - 1]!.date))), fetched_at: fetched });
  const pc = o.putCall;
  if (pc?.volume) out.push({ group: "putCallVolume", covers: ["putCall.volume"], dataset: "OPRA.PILLAR ohlcv-1d via Databento (one session)", as_of: iso(nyInstantMs(pc.volume.session, isNyseEarlyClose(pc.volume.session) ? 13 * 60 : 16 * 60)), fetched_at: fetched, url: DATABENTO_OPRA_URL });
  if (pc?.oi) out.push({ group: "putCallOpenInterest", covers: ["putCall.openInterest"], dataset: "OPRA.PILLAR statistics (open interest, pre-open broadcast) via Databento", as_of: iso(nyInstantMs(pc.oi.date, 6 * 60 + 30)), fetched_at: fetched, url: DATABENTO_OPRA_URL });
  return out;
}

/**
 * The pre-earnings straddle to show: the chain's (computed now) or the stored
 * one of the same release (the daily job's 15:45 snapshot), the newer first. Pure.
 */
export function straddleFor(chain: LiveChain | null, stored: Stored | null, e: EarningsSoon | null): { value: EarningsStraddle; from: string } | null {
  const own = chain?.earningsStraddle ?? null;
  const kept = stored?.straddle?.value ?? null;
  const keptOk = kept && (!e || kept.earnings_date === e.date) ? kept : null;
  if (own && (!keptOk || own.as_of >= keptOk.as_of)) return { value: own, from: chain?.provider === "yahoo" ? "Yahoo (free, delayed ~15 min)" : "on demand" };
  return keptOk ? { value: keptOk, from: "stored" } : null;
}

/** The tool's result. Pure. */
export function shapeIv({ q, stored, live, liveNote, putCall, freshness }: Shape) {
  const chain = live?.chain ?? null;
  const block = chain?.block ?? stored!.block;
  const session = chain?.snapshot.date ?? stored!.session;
  const term = chain?.term ?? stored?.term ?? [];
  const curve = term.filter((p) => p.days >= 2).map((p) => ({ T: p.days / 365, iv: p.iv }));
  const atm60 = chain ? chain.atmIv60 : curve.length ? constantMaturityIv(curve, 60 / 365) : null;
  const atm90 = chain ? chain.atmIv90 : curve.length ? constantMaturityIv(curve, 90 / 365) : null;
  // Against the earlier stored sessions (as the engine's store.ts percentile).
  const history = (stored?.history ?? []).filter((h) => h.date < session);
  const standing = ivStanding(block.atmIv, history);
  const notes: string[] = [];
  if (chain && stored && stored.session < chain.snapshot.date) notes.push(`Falcon's stored snapshot is from ${stored.session}; this one is newer.`);
  if (!chain && liveNote && q.detail !== "smile" && q.detail !== "surface") notes.push(`Not refreshed on demand: ${liveNote}.`);
  if (chain?.snapshot.intraday) notes.push("Intraday snapshot: quotes move during the session.");
  if (standing.note) notes.push(standing.note);
  const out: Record<string, unknown> = {
    ticker: q.ticker.replace("-", "."),
    asOf: block.asOf,
    snapshot: chain?.snapshot.label ?? `${session} ${block.asOf ? new Date(block.asOf).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }) : "15:45"} ET`,
    source:
      chain?.provider === "yahoo"
        ? `${YAHOO_OPTIONS_DATASET}: Falcon computed every figure from the bid/ask mids (Yahoo's own IV is not used)`
        : chain
          ? "OPRA via Databento: one snapshot of this chain priced on demand by Falcon"
          : "OPRA via Databento: Falcon's daily snapshot (end of day)",
    data: chain?.provider === "yahoo" ? "Yahoo Finance (free, delayed ~15 min)" : chain ? (live!.fromCache ? "on demand (already bought, free)" : `on demand, $${chain.costUsd.toFixed(4)}`) : "stored (free)",
    spot: block.spot,
    ...(chain ? { spotSource: chain.spotSource } : {}),
    atmIv30Pct: block.atmIv,
    atmIv60Pct: pct1(atm60),
    atmIv90Pct: pct1(atm90),
    ivStanding: { sessions: standing.sessions, percentile: standing.percentile, rank: standing.rank, ...(standing.low !== null ? { low: standing.low, high: standing.high, since: standing.from } : {}) },
    impliedMove5: block.impliedMove5,
    impliedMove20: block.impliedMove20,
    skewPts: block.skew ?? null,
    callPutSpreadPts: block.cpSpread ?? null,
    beta: block.beta ?? null,
    vixPct: block.vix ?? null,
    ivToVix: typeof block.vix === "number" && block.vix > 0 ? round(block.atmIv / block.vix, 2) : null,
  };
  if (freshness) {
    const asOfMs = Date.parse(block.asOf);
    const stale = isStale(asOfMs, freshness.session);
    const e = freshness.earnings;
    const ses = freshness.session;
    const label = out.snapshot as string;
    let warning: string | null = null;
    if (stale && ses) {
      const why = freshness.freshFailure ?? "no same-day options chain could be read";
      warning = e
        ? `${q.ticker.replace("-", ".")} reports earnings on ${e.date} (${e.daysAway === 0 ? "today" : `in ${e.daysAway} day${e.daysAway === 1 ? "" : "s"}`}) and these options figures are from ${label}, before the ${ses.date} open, so they miss what the market has priced since. A same-day chain could not be read: ${why}. Say this plainly; do not present these numbers as current.`
        : `These options figures are from ${label}, older than the current session (${ses.date}, opened 09:30 ET). A same-day chain could not be read: ${why}.`;
      notes.unshift(warning);
    }
    out.as_of = block.asOf;
    out.stale = stale;
    out.freshness = {
      currentSession: ses?.date ?? null,
      sessionOpen: ses ? new Date(ses.openMs).toISOString() : null,
      marketOpen: ses?.inSession ?? false,
      ageMinutes: Number.isFinite(asOfMs) ? Math.max(0, Math.round((freshness.nowMs - asOfMs) / 60_000)) : null,
      rule: `Current = at or after the latest session's 09:30 ET open; stale otherwise. Before earnings (within ${EARNINGS_WINDOW_DAYS} days) stale data is never shown as current.`,
      ...(warning ? { warning } : {}),
    };
    const st = straddleFor(chain, stored, e);
    if (e || st) {
      out.earnings = {
        ...(e ? { date: e.date, time: e.time, daysAway: e.daysAway, dateSource: e.source } : { date: st!.value.earnings_date, time: st!.value.earnings_time }),
        ...(st
          ? {
              straddle: {
                implied_move: st.value.implied_move,
                impliedMovePct: round(st.value.implied_move * 100, 2),
                strike: st.value.strike,
                expiry: st.value.expiry,
                call_mid: st.value.call_mid,
                put_mid: st.value.put_mid,
                spot: st.value.spot,
                dte: st.value.dte,
                as_of: st.value.as_of,
                source_minute: st.value.source_minute,
                reaction_day: st.value.reaction_day,
                data: st.from,
                meaning: "Pre-earnings ATM straddle: (call mid + put mid) / spot at the strike nearest spot, first expiry covering the reaction session: the options market's expected absolute move through the report (no direction).",
              },
            }
          : {}),
      };
    }
    out.sources = ivSources({ ticker: q.ticker.replace("-", "."), chain, block, stored, putCall, nowMs: freshness.nowMs });
    if (st)
      (out.sources as SourceRef[]).push({
        group: "earningsStraddle",
        covers: ["earnings.straddle"],
        dataset: st.from === "stored" ? "Falcon options_daily metrics.earnings_straddle (OPRA.PILLAR cbbo-1m via Databento, 15:45 ET)" : st.value.source,
        as_of: st.value.as_of,
        fetched_at: (out.sources as SourceRef[])[0]!.fetched_at,
        ...(st.value.source.startsWith("Yahoo") ? { url: yahooOptionsUrl(q.ticker.replace("-", ".")) } : { url: DATABENTO_OPRA_URL }),
      });
  }
  if (chain?.yahooIvCheck) out.yahooIvCheck = { ...chain.yahooIvCheck, note: "Yahoo's own IV for the same expiry, for comparison only; Falcon's figures come from the bid/ask mids with its own model." };
  if (stored && stored.history.length >= 2 && q.detail === "summary") out.atmIvHistory = spread(stored.history, 20).map((h) => [h.date, h.atmIv]);
  {
    const pts = termPoints(term, q.detail === "summary" ? 8 : MAX_TERM_POINTS);
    if (pts.length) {
      out.term = pts;
      out.termColumns = ["expiration", "days", "ATM IV %"];
    }
  }
  if (q.detail === "smile") {
    const s = chain ? smileOutput(chain, q.expiration) : null;
    if (s) out.smile = s;
    else notes.push(`No smile: ${chain ? "too few strikes with an IV" : liveNote ?? "strike-level IVs are not stored"}.`);
  }
  if (q.detail === "surface") {
    const s = chain ? surfaceOutput(chain) : null;
    if (s) out.surface = s;
    else notes.push(`No surface: ${chain ? "too few expiries with enough strikes" : liveNote ?? "strike-level IVs are not stored"}.`);
  }
  if (chain) out.chain = chain.quality;
  if (putCall && q.detail === "summary") out.putCall = shapePutCall(putCall);
  out.meaning = IV_MEANING;
  out.units = "IV, moves and VIX in percent (21.9 = 21.9% annualised); ivToVix = ATM IV / VIX; skew and call-put spread in vol points; implied moves are expected absolute moves over the sessions (raw, and beyond the market with beta x VIX taken out).";
  if (notes.length) out.notes = notes;
  return out;
}

/* ------------------------------------------------------------------ the tool */

export type IvRunOptions = { admin: boolean; signal?: AbortSignal; timeoutMs?: number; now?: () => number; /** history: points loaded so far, as they come */ onProgress?: (p: ToolProgress) => void };

export async function ivTool(input: unknown, opts: IvRunOptions) {
  const q = parseIvInput(input);
  if (!canSeeOptions(optionsDisplayMode(), opts.admin)) throw new ToolError("Options data is not shown in this version of Falcon.");
  const signal = AbortSignal.any([...(opts.signal ? [opts.signal] : []), AbortSignal.timeout(opts.timeoutMs ?? 25_000)]);
  const nowMs = opts.now?.() ?? Date.now();
  const configured = databentoConfigured();
  const [rows, ends, rowsEarnings] = await Promise.all([
    readStore(q.ticker).catch((err: unknown) => {
      console.error("[desk/iv] store read failed", err instanceof Error ? err.message : String(err));
      return [] as StoreRow[];
    }),
    configured ? loadDatasetEnds(nowMs, AbortSignal.any([signal, AbortSignal.timeout(2_500)])) : Promise.resolve(null),
    // Earnings within the window (Yahoo's calendar, as /earnings): the freshness warning and the pre-earnings straddle.
    q.detail === "history" ? Promise.resolve(null) : loadEarningsSoon(q.ticker, nowMs, AbortSignal.any([signal, AbortSignal.timeout(6_000)])).catch(() => null),
  ]);
  const calEarnings = rowsEarnings;
  const { stored, skip } = storedView(rows);
  const snaps = pickIvSnapshots(nowMs, datasetEndOf(ends, IV_SCHEMA));
  if (q.detail === "history") {
    if (!configured) throw new ToolError("On-demand options history is not configured on this server.");
    const { historyTool } = await import("./iv-history");
    return historyTool(q.ticker, q.range, { eod: snaps.eod, signal, nowMs, onProgress: opts.onProgress });
  }
  // Freshness: what Databento (stored or on demand) can give against the current session.
  const session = currentSession(nowMs);
  const storedMs = stored ? Date.parse(stored.block.asOf) || nyInstantMs(stored.session, snapshotMinute(stored.session)) : Number.NEGATIVE_INFINITY;
  const eodStale = isStale(Math.max(storedMs, snaps.eod?.asOfMs ?? Number.NEGATIVE_INFINITY), session);
  // Only a known range proves Databento has the current session (without a live licence it ends at the day's open).
  const latestFresh = datasetEndOf(ends, IV_SCHEMA) !== null && snaps.latest !== null && !isStale(snaps.latest.asOfMs, session);
  let yahoo: { chain: LiveChain | null; note: string | null; earnings: EarningsSoon | null } | null = null;
  if (eodStale && !latestFresh) yahoo = await yahooFresh(q, nowMs, signal, calEarnings);
  const earnings = yahoo?.earnings ?? calEarnings;
  const release: EarningsRelease | null = earnings ? { date: earnings.date, time: earnings.time } : null;
  const target = q.live || (eodStale && latestFresh) ? snaps.latest : snaps.eod;
  const wantChain = q.detail === "smile" || q.detail === "surface";
  const current = stored !== null && target !== null && stored.session >= target.date && !target.intraday;
  // Before an earnings reaction the summary carries the straddle: stored by the daily job for that session, else computed on demand.
  const needStraddle =
    q.detail === "summary" &&
    release !== null &&
    target !== null &&
    target.date <= releaseSessions(release).snapshotSession &&
    !(stored?.straddle && stored.straddle.session >= target.date && stored.straddle.value.earnings_date === release.date);
  let chainTarget: IvSnapshot | null = null;
  let liveNote: string | null = null;
  if (yahoo?.chain) {
    // A same-day chain: nothing older is bought.
  } else if (q.live || wantChain || !current || needStraddle) {
    if (!configured) liveNote = "on-demand options pricing is not configured on this server";
    else if (!target) liveNote = "Databento has no recent options snapshot";
    else if (skip && skip.session >= target.date && !target.intraday) liveNote = `${q.ticker}'s option chain was too thin to read on ${skip.session} (${skip.reason})`;
    else chainTarget = target;
  }
  // Put/call volume and open interest go with the summary only, bought with the chain (one pull, one limit) or alone.
  const plan = configured && q.detail === "summary" && (stored || chainTarget || yahoo?.chain) ? putCallPlan(q.ticker, nowMs, datasetEndOf(ends, OI_SCHEMA), datasetEndOf(ends, VOLUME_SCHEMA)) : null;
  let live: Shape["live"] = yahoo?.chain ? { chain: yahoo.chain, fromCache: false } : null;
  let putCall: PutCall | null = null;
  if (chainTarget || plan) {
    let d: OnDemand | null = null;
    try {
      d = await onDemand(q.ticker, chainTarget, plan, nowMs, signal, !stored, release);
    } catch (err) {
      if (opts.signal?.aborted) throw err;
      if (chainTarget) liveNote = errText(err).replace(/\.$/, "");
      if (plan) putCall = { oi: null, volume: null, costUsd: 0, notes: ["Put/call data could not be priced in time (Databento was slow); ask again"] };
    }
    if (d && chainTarget) {
      try {
        if (d.chainError) throw d.chainError;
        if (!d.chain) throw new ToolError("the download failed");
        try {
          live = { chain: await waitOrAbort(d.chain, signal), fromCache: d.chainFromCache };
        } catch (err) {
          if (err instanceof ToolError || !signal.aborted) throw err;
          throw new ToolError(`Still downloading ${q.ticker}'s option quotes. Call falcon_options again with the same arguments for the result: the download continues and is not bought twice.`);
        }
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        liveNote = errText(err).replace(/\.$/, "");
        if (!(err instanceof ToolError)) console.error("[desk/iv]", JSON.stringify({ ticker: q.ticker, error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : String(err) }));
      }
    }
    if (d && plan && (live || stored)) putCall = await putCallOf(q.ticker, plan, d, signal, opts.signal);
  }
  if (!live && !stored) throw new ToolError(`No implied volatility for ${q.ticker}: ${liveNote ?? "Falcon has no options data for it"}.`);
  const sameDayWhy =
    yahoo && !yahoo.chain
      ? `Databento publishes the session's OPRA quotes only after it ends (intraday needs a live licence) and Yahoo's delayed chain failed (${yahoo.note ?? "no answer"})`
      : liveNote ?? (eodStale ? "Databento publishes the session's OPRA quotes only after it ends (intraday needs a live licence)" : null);
  return shapeIv({ q, stored, live, liveNote, putCall, freshness: { nowMs, session, earnings, freshFailure: sameDayWhy } });
}

/**
 * The same-day chain from Yahoo (iv-fresh.ts) when Databento cannot serve the
 * current session: the engine's math on Yahoo's bid/ask mids, with the
 * straddle-implied move through an earnings report within the window. Never
 * throws for data problems: `note` says why there is no chain.
 */
async function yahooFresh(q: IvQuery, nowMs: number, signal: AbortSignal, calEarnings: EarningsSoon | null): Promise<{ chain: LiveChain | null; note: string | null; earnings: EarningsSoon | null }> {
  const full = q.detail !== "summary";
  const ySignal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
  const inputs = await loadYahooChain(q.ticker, full, q.detail === "smile" ? q.expiration : null, nowMs, ySignal).catch((err: unknown) => {
    if (signal.aborted) throw err;
    return err instanceof Error ? err : new Error(String(err));
  });
  if (inputs instanceof Error) return { chain: null, note: `Yahoo Finance did not answer (${inputs.message.slice(0, 80)})`, earnings: calEarnings };
  if (!inputs) return { chain: null, note: "Yahoo Finance has no options chain for it", earnings: calEarnings };
  const earnings = earningsFromEpoch(inputs.earningsEpoch, nowMs, "Yahoo Finance quote") ?? calEarnings;
  const p = nyParts(inputs.asOfMs);
  const closeMin = isNyseEarlyClose(p.date) ? 13 * 60 : 16 * 60;
  const minute = Math.min(p.minutes, closeMin);
  const s: IvSnapshot = { date: p.date, minute, asOfMs: inputs.asOfMs, label: `${p.date} ${hhmm(minute)} ET`, intraday: p.minutes < closeMin };
  const market = await loadMarket(q.ticker, s, nowMs).catch(() => null);
  if (!market) return { chain: null, note: "Yahoo Finance has no price history for it", earnings };
  // The stock's 1-minute bar at the chain's (delayed) time, else Yahoo's last price.
  const spotLabel = market.minuteSpot !== null ? `1-minute bar at ${hhmm(minute)} ET (Yahoo)` : "Yahoo last price";
  market.minuteSpot ??= inputs.spot;
  try {
    const chain = computeFromQuotes(q.ticker, s, inputs.definitions, inputs.quotes, market, 0, {
      spotLabel,
      release: earnings ? { date: earnings.date, time: earnings.time } : null,
      straddleSource: YAHOO_OPTIONS_DATASET,
      provider: "yahoo",
    });
    chain.yahooIvCheck = yahooIvCheck(inputs, chain.spot, chain.term);
    chain.fetchedAtMs = Date.now();
    return { chain, note: null, earnings };
  } catch (err) {
    return { chain: null, note: err instanceof ToolError ? err.message.replace(/\.$/, "") : "its chain could not be computed", earnings };
  }
}

/** "Reading AAPL options overview" / "Built AAPL IV surface". */
export function ivToolLabel(input: unknown, phase: "running" | "done" = "done"): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  let t = "?";
  try {
    t = normalizeTicker(i.ticker).replace("-", ".");
  } catch {
    if (typeof i.ticker === "string") t = i.ticker.slice(0, 10).toUpperCase();
  }
  const run = phase === "running";
  switch (i.detail) {
    case "term":
      return `${run ? "Reading" : "Read"} ${t} IV term structure`;
    case "smile":
      return `${run ? "Building" : "Built"} ${t} volatility smile`;
    case "surface":
      return `${run ? "Building" : "Built"} ${t} IV surface`;
    case "history":
      return `${run ? "Reading" : "Read"} ${t} IV history`;
    default:
      return `${run ? "Reading" : "Read"} ${t} options overview`;
  }
}
