/**
 * `/options <TICKER> history <range>`: a stock's daily ATM IV (30 days) over a
 * past range, bought on demand from OPRA.PILLAR when Falcon AI runs the
 * command (never in bulk, never written to options_daily).
 *
 * Method (the cheapest correct one measured on 2026-11-16): per sampled
 * session, one cbbo-1m snapshot at the daily job's minute (15:45 New York,
 * 12:45 on early closes; window [minute - 5, minute + 1)) of just the
 * near-the-money contracts, asked for by OSI symbol (stype_in raw_symbol).
 * Databento bills a cbbo-1m request per contract that exists (about $0.0000015
 * a contract a snapshot); symbols that were never listed cost nothing. The
 * symbols are built, not looked up: strikes on a grid from 93% to 105% of the
 * session's close (Yahoo, splits undone), for the Fridays either side of 30
 * days out and the monthly expiries either side (Thursday when the Friday is a
 * holiday). That is enough for the engine's ATM IV 30 days (surface.ts,
 * variance-interpolated between the expiries bracketing 30 days), the XZZ skew
 * and the 20-session implied move (cards.ts), with the spot refined by
 * put-call parity as the daily job does. A full chain costs 20 to 150 times
 * more (2026-11-13: AAPL $0.0048 a day, SPY $0.019).
 *
 * Sampling: every session up to 3 months; weekly (every 5th session, counted
 * back from the latest) for 6 months and a year; longer ranges at most about
 * 130 points. One request per point. Nothing is priced point by point:
 * Databento's get_cost is free but as slow as a download (seconds each, tails
 * of 20-50 s), and a cbbo-1m snapshot costs exactly USD_PER_RECORD a record,
 * one record a minute per listed contract (measured on all 51 points of AAPL
 * 1y, 2026-11-16). So a point costs at most its symbols x window minutes x
 * that rate: the pull is capped on that bound (DESK_IV_MAX_HISTORY_USD,
 * default $0.50; the oldest points are dropped to fit), checked against the
 * desk-iv month cap and the Databento month cap like any other on-demand
 * pull, and charged to public.options_spend as one "desk-iv" line before the
 * downloads. When they are done one settling line brings the charge to what
 * was served (the records x the rate, checked once against get_cost for the
 * newest point), refused downloads included. The downloads run
 * DOWNLOAD_CONCURRENCY at a time and a slow one is asked again once after
 * HEDGE_AFTER_MS (whichever answers first is kept; the copy is charged too).
 * A computed point is kept in memory for a day (per ticker and session), so
 * ranges share points and a repeat ask is free; the pull keeps going past the
 * tool's deadline, and the route waits on it in the next request
 * (ToolPending), with the points loaded so far shown in the member's row.
 *
 * IV percentile and rank come from the series itself (ivStanding, iv.ts).
 * Server-only. Pure helpers are exported for the tests (iv-history.test.ts).
 */

import { optionsBlock, tickerOptionsFrom } from "../../../../../packages/engine/src/options/cards.ts";
import { definitionsFromRecords, osiRoot } from "../../../../../packages/engine/src/options/study-options.ts";
import { surfaceFeatures, type SurfaceFeatures } from "../../../../../packages/engine/src/options/surface.ts";
import { addDays, nyInstantMs, nyseSessions } from "../../../../../packages/engine/src/study/abnormal.ts";
import { DatabentoError, getCost, getRange, quotesAt, requestKey, type RangeBody, type RangeRequest } from "../../databento/client";
import { appendSpend, monthSpend, type SpendLine } from "../../databento/ledger";
import {
  IV_CALLER,
  IV_DATASET,
  IV_MEANING,
  IV_SCHEMA,
  LOOKBACK_MIN,
  capRefusal,
  discountToContinuous,
  dividendYield,
  ivCaps,
  ivStanding,
  snapshotMinute,
  type IvHistoryRange,
  type IvSnapshot,
} from "./iv";
import { ToolError, ToolPending, TtlCache, cached, round, type ToolProgress } from "./util";
import { yahooChart, type ChartResult } from "./yahoo";

/** First session of OPRA.PILLAR cbbo-1m at Databento (metadata.get_dataset_range, 2026-11-16). */
export const OPRA_HISTORY_START = "2013-04-01";
/** Sessions sampled at most for the long ranges (2y, 5y, max). */
export const MAX_HISTORY_POINTS = 130;
/** Strike band around the close (K / S): ATM both sides, and the 0.95 put the XZZ skew reads. */
export const BAND_LOW = 0.93;
export const BAND_HIGH = 1.05;
/** Strike candidates per expiry at most (the grid widens for high-priced stocks). */
const MAX_STRIKES = 100;
const STRIKE_STEPS = [0.5, 1, 2.5, 5, 10, 25, 50, 100];
/** Downloads in flight at once (more draws 429s from Databento). */
const DOWNLOAD_CONCURRENCY = 16;
/** A download still running after this is asked again once (Databento's latency has long random tails). */
export const HEDGE_AFTER_MS = 7_000;
/** One attempt at a snapshot's download (the pull goes on past the tool's deadline). */
const DOWNLOAD_TIMEOUT_MS = 45_000;
/** The get_cost check of the rate (free; the settling line waits for it at most this long). */
const RATE_CHECK_TIMEOUT_MS = 20_000;
/**
 * Databento's price of one OPRA.PILLAR cbbo-1m record in USD: get_cost / records was exactly this for each of the
 * 51 points of AAPL 1y on 2026-11-16 (with 6 records per listed contract, one a minute of the window).
 * DESK_IV_USD_PER_RECORD overrides it; every pull checks it once against get_cost and logs a change.
 */
export const USD_PER_RECORD = 2.4835e-7;
/** Records one listed contract gives in a snapshot window: one a minute. */
export const RECORDS_PER_CONTRACT = LOOKBACK_MIN + 1;

export function usdPerRecord(): number {
  const raw = process.env.DESK_IV_USD_PER_RECORD?.trim();
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v > 0 ? v : USD_PER_RECORD;
}

/** The most a snapshot request can cost: every symbol listed, a record each minute. Pure. */
export function maxCostUsd(req: RangeRequest, rate = usdPerRecord()): number {
  return req.symbols.length * RECORDS_PER_CONTRACT * rate;
}

export function maxHistoryUsd(): number {
  const raw = process.env.DESK_IV_MAX_HISTORY_USD?.trim();
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : 0.5;
}

/* ------------------------------------------------------------------ sampling (pure) */

const RANGE_DAYS: Record<Exclude<IvHistoryRange, "max">, number> = { "1m": 31, "3m": 92, "6m": 183, "1y": 366, "2y": 731, "5y": 1827 };

/**
 * The sessions to sample for `range` ending at `eod` (the latest session with
 * a full snapshot), oldest first, and how: every session up to 3 months,
 * every 5th (weekly) for 6 months and a year, at most MAX_HISTORY_POINTS for
 * longer. Counted back from `eod`, so the latest session is always there. Pure.
 */
export function historyDates(range: IvHistoryRange, eod: string): { dates: string[]; step: number; from: string } {
  const start = range === "max" ? OPRA_HISTORY_START : addDays(eod, -RANGE_DAYS[range]);
  const from = start < OPRA_HISTORY_START ? OPRA_HISTORY_START : start;
  const sessions = nyseSessions(from, eod);
  const step = range === "1m" || range === "3m" ? 1 : Math.max(5, Math.ceil(sessions.length / MAX_HISTORY_POINTS));
  const dates: string[] = [];
  for (let i = sessions.length - 1; i >= 0; i -= step) dates.push(sessions[i]!);
  return { dates: dates.reverse(), step, from: dates.length ? dates[dates.length - 1]! : from };
}

/** "daily" / "weekly" / "every 27 sessions". Pure. */
export function samplingLabel(step: number): string {
  return step === 1 ? "daily" : step === 5 ? "weekly (every 5th session)" : `every ${step} sessions`;
}

const isSession = (d: string) => nyseSessions(d, d).length === 1;
/** The expiry of a Friday: that Friday, or the Thursday before when the Friday is a market holiday. Pure. */
function expiryOf(friday: string): string {
  return isSession(friday) ? friday : addDays(friday, -1);
}
const weekday = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();

/** Third Friday of the month of `ymd`. Pure. */
export function thirdFriday(ymd: string): string {
  const first = `${ymd.slice(0, 7)}-01`;
  const lead = (5 - weekday(first) + 7) % 7;
  return addDays(first, lead + 14);
}

/**
 * The expiries one sample needs: the Fridays either side of 30 calendar days
 * out (weekly listings) and the monthly expiries either side (names with no
 * weeklies), at least a week out; Thursday when the Friday is a holiday. Pure.
 */
export function historyExpiries(date: string): string[] {
  const target = addDays(date, 30);
  const back = (weekday(target) - 5 + 7) % 7;
  const friBelow = addDays(target, -back);
  const friAbove = addDays(friBelow, 7);
  const monthlies: string[] = [];
  for (let m = 0; m < 4; m++) {
    const d = new Date(`${date.slice(0, 7)}-01T12:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + m);
    monthlies.push(thirdFriday(d.toISOString().slice(0, 10)));
  }
  const minExp = addDays(date, 7);
  const mBelow = [...monthlies].reverse().find((f) => f <= target && f >= minExp);
  const mAbove = monthlies.find((f) => f > target);
  const out = new Set<string>();
  for (const f of [friBelow, friAbove, mBelow, mAbove]) if (f && f >= minExp) out.add(expiryOf(f));
  return [...out].sort();
}

/** The strike grid for a spot: the finest standard step with at most MAX_STRIKES strikes in the band. Pure. */
export function strikeStep(spot: number): number {
  for (const s of STRIKE_STEPS) if (((BAND_HIGH - BAND_LOW) * spot) / s <= MAX_STRIKES) return s;
  return STRIKE_STEPS[STRIKE_STEPS.length - 1]!;
}

/** Candidate strikes in [BAND_LOW, BAND_HIGH] x spot on the grid. Pure. */
export function historyStrikes(spot: number): number[] {
  const step = strikeStep(spot);
  const out: number[] = [];
  for (let k = Math.ceil((BAND_LOW * spot) / step) * step; k <= BAND_HIGH * spot + 1e-9; k += step) out.push(Math.round(k * 1000) / 1000);
  return out;
}

/** OSI symbol: root padded to 6, yymmdd, C/P, strike x 1000 in 8 digits. Pure. */
export function osiSymbol(root: string, expiration: string, right: "C" | "P", strike: number): string {
  return `${root.padEnd(6, " ")}${expiration.slice(2, 4)}${expiration.slice(5, 7)}${expiration.slice(8, 10)}${right}${String(Math.round(strike * 1000)).padStart(8, "0")}`;
}

/** The snapshot request of one sample: the near-the-money contracts by OSI symbol. Pure. */
export function historyRequest(t: string, date: string, spot: number): RangeRequest {
  const root = osiRoot(t);
  const symbols: string[] = [];
  for (const e of historyExpiries(date)) for (const k of historyStrikes(spot)) for (const r of ["C", "P"] as const) symbols.push(osiSymbol(root, e, r, k));
  const m = snapshotMinute(date);
  const iso = (min: number) => new Date(nyInstantMs(date, min)).toISOString();
  return { dataset: IV_DATASET, schema: IV_SCHEMA, symbols, stype_in: "raw_symbol", start: iso(m - LOOKBACK_MIN), end: iso(m + 1) };
}

/* ------------------------------------------------------------------ market inputs (pure) */

export type DayInputs = { close: number; adjClose: number; rate: number; dividends: Array<{ date: string; amount: number }> };

type Splits = Array<{ date: string; ratio: number }>;
type ChartEvents = { events?: { splits?: Record<string, { date?: number; numerator?: number; denominator?: number }>; dividends?: Record<string, { amount?: number; date?: number }> } };
const nyDate = (sec: number) => new Date(sec * 1000 - 5 * 3_600_000).toISOString().slice(0, 10);

/**
 * Per session: the close as it traded (Yahoo's closes are split-adjusted, so
 * every later split is undone: option strikes are in the prices of the day),
 * the split-adjusted close (dividends are split-adjusted too), the bill rate
 * from ^IRX and the dividends. Pure.
 */
export function dayInputs(c: ChartResult, irx: ChartResult | null): Map<string, DayInputs> {
  const ev = (c as ChartResult & ChartEvents).events ?? {};
  const splits: Splits = Object.values(ev.splits ?? {})
    .filter((s) => typeof s.date === "number" && (s.numerator ?? 0) > 0 && (s.denominator ?? 0) > 0)
    .map((s) => ({ date: nyDate(s.date!), ratio: s.numerator! / s.denominator! }));
  const dividends = Object.values(ev.dividends ?? {})
    .filter((d) => typeof d.amount === "number" && d.amount > 0 && typeof d.date === "number")
    .map((d) => ({ date: nyDate(d.date!), amount: d.amount! }));
  const rates = new Map<string, number>();
  for (const [d, v] of closesOf(irx)) if (v > 0 && v < 25) rates.set(d, discountToContinuous(v));
  const out = new Map<string, DayInputs>();
  let lastRate = 0.04;
  const rateDays = [...rates.keys()].sort();
  let ri = 0;
  for (const [date, close] of closesOf(c)) {
    while (ri < rateDays.length && rateDays[ri]! <= date) lastRate = rates.get(rateDays[ri++]!)!;
    let factor = 1;
    for (const s of splits) if (s.date > date) factor *= s.ratio;
    out.set(date, { close: close * factor, adjClose: close, rate: lastRate, dividends });
  }
  return out;
}

function closesOf(c: ChartResult | null): Array<[string, number]> {
  const ts = c?.timestamp ?? [];
  const close = c?.indicators?.quote?.[0]?.close ?? [];
  const off = (c?.meta?.gmtoffset as number | undefined) ?? -5 * 3600;
  const out: Array<[string, number]> = [];
  for (let i = 0; i < ts.length; i++) {
    const v = close[i];
    if (typeof v === "number" && v > 0) out.push([new Date((ts[i]! + off) * 1000).toISOString().slice(0, 10), v]);
  }
  return out;
}

/* ------------------------------------------------------------------ one point (pure) */

export type HistoryPoint = { date: string; atmIv: number; skew: number | null; move20: number | null; spot: number };

/**
 * One sample from its quote records with the engine's math: the close, then
 * the put-call parity spot when within 3% (chains.ts computeOne); null when
 * the snapshot gives no ATM IV at 30 days or the spot does not agree with the
 * quotes. IV, skew and move in percent. Pure.
 */
export function computePoint(t: string, date: string, records: ReadonlyArray<Record<string, unknown>>, d: DayInputs): HistoryPoint | null {
  const defs = definitionsFromRecords(records, t);
  if (!defs.length) return null;
  const asOfMs = nyInstantMs(date, snapshotMinute(date));
  const quotes = quotesAt(records, asOfMs);
  const q = dividendYield(d.dividends, date, d.adjClose);
  const run = (spot: number): SurfaceFeatures => surfaceFeatures({ underlying: t, date, asOfMs, spot, rate: d.rate, divYield: q, definitions: defs, quotes, moveDates: [] });
  let spot = d.close;
  let f = run(spot);
  const p = f.parityImpliedSpot;
  if (p !== null && Math.abs(p / spot - 1) < 0.03 && Math.abs(p / spot - 1) > 0.002) {
    spot = p;
    f = run(spot);
  }
  if (f.atmIv30 === null || !(f.atmIv30 > 0) || f.quality.warnings.some((w) => w.startsWith("parity"))) return null;
  const block = optionsBlock(tickerOptionsFrom(f, { ticker: t, spotSource: "close", beta: null, vix: null }));
  return { date, atmIv: block.atmIv, skew: block.skew ?? null, move20: block.impliedMove20?.rawPct ?? null, spot: round(spot, 2)! };
}

/* ------------------------------------------------------------------ shaping (pure) */

export type HistoryRun = {
  ticker: string;
  range: IvHistoryRange;
  step: number;
  asked: number;
  points: HistoryPoint[];
  costUsd: number;
  fromCache: number;
  /** Sessions whose snapshot did not download (asked again next time). */
  missed?: number;
  notes: string[];
};

/** The tool's result: a chart-ready line of ATM IV, skew and 20-session move per point, and the IV percentile and rank. Pure. */
export function shapeHistory(r: HistoryRun) {
  const pts = [...r.points].sort((a, b) => (a.date < b.date ? -1 : 1));
  if (!pts.length) throw new ToolError(`No usable ATM IV for ${r.ticker} over ${r.range}${r.notes.length ? ` (${r.notes.join("; ")})` : ""}.`);
  const last = pts[pts.length - 1]!;
  const standing = ivStanding(last.atmIv, pts.slice(0, -1).map((p) => ({ date: p.date, atmIv: p.atmIv })));
  const ivs = pts.map((p) => p.atmIv);
  const mean = ivs.reduce((a, b) => a + b, 0) / ivs.length;
  const t = r.ticker.replace("-", ".");
  const notes = [...r.notes];
  if (standing.note) notes.push(standing.note.replace("stored sessions", "points in this range").replace("Falcon has", "this range has"));
  const unread = r.asked - pts.length - (r.missed ?? 0);
  if (unread > 0) notes.push(`${unread} of ${r.asked} sampled sessions had no readable ATM IV (thin quotes, no listing or no close) and are left out.`);
  return {
    ticker: t,
    range: r.range,
    sampling: samplingLabel(r.step),
    from: pts[0]!.date,
    to: last.date,
    points: pts.length,
    current: { date: last.date, atmIv30Pct: last.atmIv, spot: last.spot },
    ivStanding: {
      basis: `this series (${pts.length - 1} earlier points, ${samplingLabel(r.step)})`,
      percentile: standing.percentile,
      rank: standing.rank,
      ...(standing.low !== null ? { low: standing.low, high: standing.high } : {}),
      mean: round(mean, 1),
    },
    chart: {
      kind: "line",
      title: `${t} ATM implied volatility (30 days), ${r.range}`,
      source: `OPRA via Databento, Falcon's snapshot at 15:45 New York per session, to ${last.date}`,
      axes: { y: { label: "ATM IV 30d", unit: "%" } },
      series: [{ name: `${t} ATM IV 30d`, points: pts.map((p) => [p.date, p.atmIv]) }],
    },
    skewAndMove: { columns: ["date", "skew pts", "implied move 20 sessions %"], rows: pts.map((p) => [p.date, p.skew, p.move20]) },
    source: "OPRA via Databento: one end-of-day snapshot of the near-the-money contracts per sampled session, priced on demand by Falcon",
    data: r.costUsd > 0 ? `on demand, $${r.costUsd.toFixed(4)}${r.fromCache ? ` (${r.fromCache} points already bought)` : ""}` : "already bought (free)",
    meaning: IV_MEANING,
    units: "IV and implied move in percent (21.9 = 21.9% annualised); skew in vol points (OTM put IV minus ATM call IV, about 30 days). Percentile = share of the earlier points below the latest; rank = (latest - low) / (high - low).",
    note: "For a chart pass `chart` to show_chart unchanged (kind line).",
    ...(notes.length ? { notes } : {}),
  };
}

/* ------------------------------------------------------------------ the pull */

/** Computed points per ticker and session (null: bought, but no ATM IV), kept a day. */
const pointCache = new TtlCache<Promise<HistoryPoint | null>>(24 * 3_600_000, 6_000);
/** Running pulls per ticker, range and latest session (a repeat ask waits on the same one). */
const pullCache = new TtlCache<Promise<HistoryRun>>(10 * 60_000, 50);
/** How far each pull has come (same keys as pullCache). */
const pullProgress = new TtlCache<ToolProgress>(10 * 60_000, 50);
/** Ledger lines still being settled (tests wait for them). */
const settling = new Set<Promise<void>>();

/** For tests: forget every cached point and pull. */
export function resetHistory(): void {
  pointCache.clear();
  pullCache.clear();
  pullProgress.clear();
}

/** For tests: wait until every settling ledger line is written. */
export async function historySettled(): Promise<void> {
  await Promise.all([...settling]);
}

async function pool<T, R>(items: readonly T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

/** Databento refused the request (nothing served, nothing billed): no point asking again. */
const refusedBy = (err: unknown) => err instanceof DatabentoError && err.status >= 400 && err.status < 500 && err.status !== 429;

/**
 * Runs `attempt`, and once more alongside it when it has not answered after `hedgeMs` (a request stuck in a
 * latency tail); the first answer wins and the other is aborted. A refusal ends it at once; otherwise it fails when
 * every attempt has. `onHedge` is called when the second attempt starts.
 */
export function hedged<T>(attempt: (signal: AbortSignal) => Promise<T>, hedgeMs: number, onHedge: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const ctls: AbortController[] = [];
    let live = 0;
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      done = true;
      if (timer !== undefined) clearTimeout(timer);
      for (const c of ctls) c.abort();
    };
    const start = () => {
      const c = new AbortController();
      ctls.push(c);
      live++;
      attempt(c.signal).then(
        (v) => {
          if (done) return;
          finish();
          resolve(v);
        },
        (err: unknown) => {
          live--;
          if (done) return;
          // Waiting for the hedge timer to try again, unless Databento refused.
          if (refusedBy(err) || (live === 0 && timer === undefined)) {
            finish();
            reject(err);
          }
        },
      );
    };
    start();
    timer = setTimeout(() => {
      timer = undefined;
      if (done) return;
      onHedge();
      start();
    }, hedgeMs);
  });
}

/**
 * Which points fit the per-pull limit: newest first, older ones dropped once
 * the total would pass it (a longer history is cut, not refused). Pure.
 */
export function fitToCap<T extends { date: string; costUsd: number }>(priced: readonly T[], capUsd: number): { buy: T[]; dropped: number; totalUsd: number } {
  const newest = [...priced].sort((a, b) => (a.date < b.date ? 1 : -1));
  const buy: T[] = [];
  let total = 0;
  for (const p of newest) {
    if (total + p.costUsd > capUsd + 1e-9) break;
    buy.push(p);
    total += p.costUsd;
  }
  return { buy: buy.reverse(), dropped: priced.length - buy.length, totalUsd: total };
}

/**
 * What a pull cost: a served snapshot its records at the rate (twice when it was hedged: the copy may be billed
 * too), a refused one nothing, one that never answered its most (the safe side). Pure.
 */
export function servedCostUsd(points: ReadonlyArray<{ records: number | null; refused: boolean; hedged: boolean; maxUsd: number }>, rate: number): number {
  let usd = 0;
  for (const p of points) {
    if (p.refused) continue;
    if (p.records === null) usd += p.maxUsd * (p.hedged ? 2 : 1);
    else usd += p.records * rate * (p.hedged ? 2 : 1);
  }
  return usd;
}

const YAHOO_RANGE: Record<IvHistoryRange, string> = { "1m": "6mo", "3m": "6mo", "6m": "1y", "1y": "2y", "2y": "5y", "5y": "10y", max: "max" };

function spendLine(t: string, range: IvHistoryRange, kind: "charge" | "refund", costUsd: number, reqs: readonly RangeRequest[], note: string): SpendLine {
  const keys = reqs.map(requestKey).sort().join(",");
  return {
    at: new Date().toISOString(),
    caller: IV_CALLER,
    kind,
    dataset: IV_DATASET,
    schema: IV_SCHEMA,
    symbols: reqs.reduce((a, r) => a + r.symbols.length, 0),
    start_at: reqs[0]?.start ?? "",
    end_at: reqs[reqs.length - 1]?.end ?? "",
    cost_usd: kind === "refund" ? -costUsd : costUsd,
    key: requestKey({ dataset: IV_DATASET, schema: IV_SCHEMA, symbols: [keys], start: `${t}|${range}`, end: kind }),
    note,
  };
}

type Todo = { date: string; req: RangeRequest; inputs: DayInputs; costUsd: number };

async function runPull(t: string, range: IvHistoryRange, eod: IvSnapshot, nowMs: number, progress: ToolProgress): Promise<HistoryRun> {
  const { dates, step } = historyDates(range, eod.date);
  const run: HistoryRun = { ticker: t, range, step, asked: dates.length, points: [], costUsd: 0, fromCache: 0, notes: [] };
  progress.total = dates.length;
  const sig = () => AbortSignal.timeout(10_000);
  const [chart, irx] = await Promise.all([yahooChart(t, YAHOO_RANGE[range], "1d", sig()).catch(() => undefined), yahooChart("^IRX", YAHOO_RANGE[range], "1d", sig()).catch(() => null)]);
  if (chart === null) throw new ToolError(`No such US ticker: ${t}.`);
  if (!chart) throw new ToolError(`No price history for ${t} right now (Yahoo did not answer); ask again.`);
  const inputs = dayInputs(chart, irx);
  const count = <T>(p: Promise<T>) => {
    p.then(
      () => progress.loaded++,
      () => progress.loaded++,
    );
    return p;
  };

  // Points already computed on this instance are free; the rest are bought, each at most its symbols x minutes x rate.
  const rate = usdPerRecord();
  const known: Array<Promise<HistoryPoint | null>> = [];
  const todo: Todo[] = [];
  let noClose = 0;
  for (const date of dates) {
    const hit = pointCache.get(`${t}|${date}`);
    if (hit) {
      known.push(count(hit));
      run.fromCache++;
      continue;
    }
    const d = inputs.get(date);
    if (!d) {
      noClose++;
      continue;
    }
    const req = historyRequest(t, date, d.close);
    todo.push({ date, req, inputs: d, costUsd: maxCostUsd(req, rate) });
  }
  progress.total -= noClose;
  if (noClose) run.notes.push(`${noClose} sampled sessions have no close at Yahoo (before the listing?)`);

  if (todo.length) {
    const caps = ivCaps();
    const fit = fitToCap(todo, maxHistoryUsd());
    progress.total -= fit.dropped;
    if (fit.dropped) run.notes.push(`The ${fit.dropped} oldest sessions were left out to stay within the $${maxHistoryUsd().toFixed(2)} limit for one history pull`);
    let tally: { callerUsd: number; totalUsd: number } | null = null;
    try {
      const s = await monthSpend(IV_CALLER, nowMs, AbortSignal.timeout(8_000));
      tally = { callerUsd: s.callerUsd, totalUsd: s.totalUsd };
    } catch {
      tally = null;
    }
    const why = capRefusal(fit.totalUsd, tally, { ...caps, maxPullUsd: Number.POSITIVE_INFINITY });
    if (why) {
      progress.total -= fit.buy.length;
      if (!known.length) throw new ToolError(`No options history was bought: ${why}.`);
      run.notes.push(`Only the sessions already bought are shown: ${why}`);
    } else if (fit.buy.length) {
      const reqs = fit.buy.map((p) => p.req);
      try {
        await appendSpend([spendLine(t, range, "charge", fit.totalUsd, reqs, `${t} IV history ${range}, ${reqs.length} snapshots (at most)`)], AbortSignal.timeout(8_000));
      } catch {
        throw new ToolError("The spend ledger could not be written, so no options history was bought. Try again later.");
      }
      // The rate, checked once against Databento's own price of the newest point (free; the settling line uses it).
      const newest = fit.buy[fit.buy.length - 1]!;
      const quoted = getCost(newest.req, AbortSignal.timeout(RATE_CHECK_TIMEOUT_MS)).catch(() => null);
      // Every bought point goes into the cache at once (a parallel ask of another range waits on it, never buys it
      // again); the downloads then run DOWNLOAD_CONCURRENCY at a time. A failed one leaves the cache.
      const slots = fit.buy.map((p) => {
        let settle!: { resolve: (v: HistoryPoint | null) => void; reject: (e: unknown) => void };
        const promise = new Promise<HistoryPoint | null>((resolve, reject) => (settle = { resolve, reject }));
        promise.catch(() => {
          if (pointCache.get(`${t}|${p.date}`) === promise) pointCache.delete(`${t}|${p.date}`);
        });
        pointCache.set(`${t}|${p.date}`, promise);
        count(promise);
        return { p, promise, settle, records: null as number | null, refused: false, hedged: false, failed: false };
      });
      await pool(slots, DOWNLOAD_CONCURRENCY, async (s) => {
        try {
          const body: RangeBody<Record<string, unknown>> = await hedged(
            (signal) => getRange(s.p.req, AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)])),
            HEDGE_AFTER_MS,
            () => (s.hedged = true),
          );
          s.records = body.records.length;
          s.settle.resolve(computePoint(t, s.p.date, body.records, s.p.inputs));
        } catch (err) {
          // Databento refused (nothing served): not charged. A dropped download keeps its most (the safe side).
          s.failed = true;
          if (err instanceof DatabentoError && err.status >= 400) s.refused = true;
          s.settle.reject(err);
        }
      });
      known.push(...slots.map((s) => s.promise.catch(() => null)));
      const failed = slots.filter((s) => s.failed).length;
      const dropped = slots.filter((s) => s.failed && !s.refused).length;
      if (dropped) run.notes.push(`${dropped} snapshots did not download in time; ask again for them`);
      run.missed = failed;
      const served = slots.map((s) => ({ records: s.records, refused: s.refused, hedged: s.hedged, maxUsd: s.p.costUsd }));
      run.costUsd = servedCostUsd(served, rate);
      // The settling line: the charge brought to what was served, at the rate get_cost confirms (written in the background).
      const settle = (async () => {
        let used = rate;
        const q = await quoted;
        const n = slots[slots.length - 1]!.records;
        if (q !== null && n) {
          const seen = q / n;
          if (Math.abs(seen / rate - 1) > 0.02) {
            console.warn("[desk/iv] history rate", JSON.stringify({ ticker: t, configured: rate, quoted: seen }));
            used = seen;
          }
        }
        const delta = servedCostUsd(served, used) - fit.totalUsd;
        if (Math.abs(delta) < 1e-9) return;
        const note = `${t} IV history ${range}: settled to ${slots.length - failed} snapshots served${slots.some((s) => s.hedged) ? ` (${slots.filter((s) => s.hedged).length} asked twice)` : ""}`;
        await appendSpend([spendLine(t, range, delta < 0 ? "refund" : "charge", Math.abs(delta), reqs, note)], AbortSignal.timeout(8_000));
      })()
        .catch((err: unknown) => console.error("[desk/iv] history settle", err instanceof Error ? err.message.slice(0, 200) : String(err)))
        .finally(() => settling.delete(settle));
      settling.add(settle);
    }
  }
  const pts = await Promise.all(known.map((k) => k.catch(() => null)));
  run.points = pts.filter((p): p is HistoryPoint => p !== null);
  return run;
}

export type HistoryOptions = { eod: IvSnapshot | null; signal: AbortSignal; nowMs: number; onProgress?: (p: ToolProgress) => void };

/**
 * The history detail: waits for the pull until the tool's deadline, reporting progress; the pull itself goes on
 * past it (ToolPending: the route waits on it in the next request).
 */
export async function historyTool(t: string, range: IvHistoryRange, o: HistoryOptions) {
  if (!o.eod) throw new ToolError("Databento has no recent options snapshot, so no history can be read.");
  const key = `${t}|${range}|${o.eod.date}`;
  // A pull that left sessions undownloaded (Databento is slow at times) is not kept: the next ask buys only those.
  const p = cached(pullCache, key, () => {
    const progress: ToolProgress = { loaded: 0, total: 0 };
    pullProgress.set(key, progress);
    return runPull(t, range, o.eod!, o.nowMs, progress).then((r) => {
      if (r.missed) pullCache.delete(key);
      return r;
    });
  });
  const progress = (): ToolProgress => ({ ...(pullProgress.get(key) ?? { loaded: 0, total: 0 }) });
  let shown = "";
  const tick = o.onProgress
    ? setInterval(() => {
        const now = progress();
        const k = `${now.loaded}/${now.total}`;
        if (!now.total || k === shown) return;
        shown = k;
        o.onProgress!(now);
      }, 400)
    : null;
  try {
    return shapeHistory(await waitFor(p, o.signal));
  } catch (err) {
    if (err instanceof ToolError || !o.signal.aborted) {
      if (!(err instanceof ToolError)) console.error("[desk/iv] history", JSON.stringify({ ticker: t, range, error: err instanceof Error ? `${err.name}: ${err.message}`.slice(0, 300) : String(err) }));
      throw err instanceof ToolError ? err : new ToolError(`${t}'s options history could not be read (the download failed); ask again.`);
    }
    const now = progress();
    throw new ToolPending(
      `Still downloading ${t}'s options history (${now.loaded} of ${now.total || "?"} sessions so far). Call falcon_options again with the same arguments for the result: the download continues and is not bought twice.`,
      now,
    );
  } finally {
    if (tick) clearInterval(tick);
  }
}

function waitFor<T>(p: Promise<T>, signal: AbortSignal): Promise<T> {
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
