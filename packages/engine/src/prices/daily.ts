/**
 * Daily stock prices for the whole universe (the graph's US listings) from
 * Databento EQUS.SUMMARY ohlcv-1d: the consolidated official daily summary
 * (open, high, low, close, volume across every US venue), unadjusted.
 * Stored in Supabase public.prices_daily (store.ts); the website serves it at
 * /api/prices and lib/prices-api.ts, so nothing on the website calls
 * Databento.
 *
 * Two modes, one code path:
 *   daily     the sessions of the last 10 days not stored yet (normally just
 *             the latest one), one request per session. Runs in the options
 *             workflow after the close and again early the next morning.
 *   backfill  every session from `from` (default: the dataset's first day,
 *             2024-07-01) not stored yet, in requests of CHUNK_SESSIONS.
 *
 * A session counts as stored when it has rows for at least DONE_SHARE of the
 * universe, so a rerun buys nothing twice (a missed day is caught up by the
 * next run). Every request is priced with get_cost first and goes through the
 * shared spend guard (options/client.ts, cost.ts): a per-run cap and a
 * per-UTC-month cap per mode, counted in public.options_spend (callers
 * prices-daily@... and prices-backfill@...). A cap, or Databento refusing for
 * billing, stops the run quietly; the summary says why.
 *
 * Adjustment: Databento bars are unadjusted and its corporate-actions data
 * needs a separate subscription, so splits are detected from the bars
 * (detectSplits: an overnight jump that matches a standard split ratio while
 * dollar volume stays ordinary) and stored in public.prices_splits; the
 * website adjusts with them. Dividends are not adjusted (price return).
 */

import { env } from "../env.ts";
import { addDays, nyseSessions } from "../study/abnormal.ts";
import { BudgetError, DatabentoClient, DatabentoError, fetchStockDaily, type PullOptions } from "../options/client.ts";
import type { RangeRequest, SpendEntry } from "../options/cost.ts";
import { accountProblem } from "../options/chains.ts";
import { capFromEnv } from "../options/sightings-options.ts";
import type { SpendLedgerStore } from "../options/store.ts";
import type { DayBar, PriceRow, PricesStore, Split } from "./store.ts";

export const PRICES_DATASET = "EQUS.SUMMARY";
export const PRICES_SOURCE = "EQUS.SUMMARY";
/** EQUS.SUMMARY's first day. */
export const PRICES_DATA_START = "2024-07-01";
export const DEFAULT_PRICES_RUN_CAP_USD = { daily: 1, backfill: 10 } as const;
export const DEFAULT_PRICES_MONTH_CAP_USD = { daily: 2, backfill: 10 } as const;
/** Sessions a backfill request covers (about a quarter: ~150k bars, ~$0.40 for the universe). */
export const CHUNK_SESSIONS = 63;
/** The daily mode looks this many calendar days back for sessions not stored yet. */
export const DAILY_LOOKBACK_DAYS = 10;
/** A session is stored when it has rows for this share of the universe. */
export const DONE_SHARE = 0.8;
/** Calendar days of stored bars read before the new ones for split detection (the dollar-volume baseline). */
export const SPLIT_CONTEXT_DAYS = 45;

export type PricesMode = "daily" | "backfill";

/** Graph ticker to Databento raw symbol (BRK-B -> BRK.B). Pure. */
export const toDatabentoSymbol = (t: string) => t.replace(/-/g, ".");

/** Sessions in runs of consecutive sessions, each at most `size` long. Pure. */
export function chunkSessions(all: readonly string[], todo: ReadonlySet<string>, size: number): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  for (const d of all) {
    if (todo.has(d) && cur.length < size) {
      cur.push(d);
      continue;
    }
    if (cur.length) out.push(cur);
    cur = todo.has(d) ? [d] : [];
  }
  if (cur.length) out.push(cur);
  return out;
}

// ---------------------------------------------------------------------------
// Split detection (pure)

/** Forward splits looked for (new shares per old share: the price divides by it). */
export const FORWARD_RATIOS: readonly number[] = [1.5, 2, 2.5, 3, 4, 5, 6, 7, 8, 10, 12, 15, 20, 25, 30, 40, 50];
/**
 * Reverse splits looked for (old shares per new share: the price multiplies
 * by it), roundest first: when the open is not within 3% of one, the first
 * one within tolerance wins (prices move on the day, and 1-for-10 is far
 * likelier than 1-for-9).
 */
export const REVERSE_DIVISORS: readonly number[] = [10, 5, 20, 2, 4, 25, 50, 100, 15, 30, 8, 3, 40, 12, 6, 75, 200, 250, 500, 60, 150, 125, 300, 80, 35, 16, 7];
/** Overnight falls smaller than this are never forward splits. */
const MIN_FALL = Math.log(1.4);
/** Overnight rises smaller than this are never reverse splits. */
const MIN_RISE = Math.log(1.8);
/** From this rise on, only a reverse split (or a once-a-decade biotech jump) explains the open: looser match, looser dollar-volume cap. */
const SURE_RISE = Math.log(4);
/** How close (log) the open must sit to the ratio: forward 3-for-2 / 5-for-2, 2-for-1, larger; reverse; sure reverse; an exact reverse match. */
const OPEN_TOL_HALF = 0.03;
const OPEN_TOL_TWO = 0.04;
const OPEN_TOL = 0.06;
const OPEN_TOL_REVERSE = 0.05;
const OPEN_TOL_SURE = 0.12;
const EXACT_TOL = 0.03;
/** How close (log) the close must sit to it. */
const CLOSE_TOL = 0.15;
const CLOSE_TOL_HALF = 0.13;
const CLOSE_TOL_SURE = 0.3;
/** Split day's dollar volume against the median of the previous sessions: a split leaves it ordinary, a crash or a jump does not. */
const DV_MIN = 0.2;
const DV_MAX = 3;
/** Reverse splits are often sold hard (seen up to ~27x); genuine 4x+ jumps trade hundreds of times their usual dollar volume. */
const DV_MAX_SURE = 30;
const DV_BASE_MIN = 5;
const DV_BASE_MAX = 20;
/** A gap longer than this between two bars (calendar days) is not judged. */
const MAX_GAP_DAYS = 10;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

const dayDiff = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

const nearest = (x: number, set: readonly number[]) => set.reduce((best, k) => (Math.abs(x - Math.log(k)) < Math.abs(x - Math.log(best)) ? k : best), set[0]!);

/** The divisor a rise of `x` (log) matches: the nearest when within 3%, else the roundest within `tol`; null when none. Pure. */
export function reverseDivisor(x: number, tol: number): number | null {
  const k = nearest(x, REVERSE_DIVISORS);
  if (Math.abs(x - Math.log(k)) <= EXACT_TOL) return k;
  return REVERSE_DIVISORS.find((d) => Math.abs(x - Math.log(d)) <= tol) ?? null;
}

/**
 * Splits in one ticker's unadjusted bars (oldest first). `ratio` is new
 * shares per old share (10 for a 10-for-1, 0.05 for a 1-for-20). Pure.
 *
 *   Forward: the open falls to within 6% (log; 4% for 2-for-1, 3% for
 *     3-for-2 and 5-for-2) of the previous close divided by a standard
 *     ratio, the close within 15% (13%), and the session's dollar volume
 *     stays between 0.2x and 3x the median of up to 20 previous sessions (at
 *     least 5 needed). A genuine 50% crash trades many times its usual
 *     dollar volume; a split does not.
 *   Reverse: the open rises to the previous close times a standard divisor.
 *     Under 4x it is judged as forward splits are (5% at the open). From 4x
 *     on the match is loose (12% at the open, 30% at the close) and the
 *     dollar-volume cap is 30x: reverse splits are often sold hard, while a
 *     genuine 4x biotech jump trades hundreds of times its usual amount.
 */
export function detectSplits(ticker: string, bars: readonly DayBar[]): Split[] {
  const out: Split[] = [];
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1]!;
    const cur = bars[i]!;
    if (!(prev.close > 0 && cur.open > 0 && cur.close > 0)) continue;
    if (dayDiff(prev.date, cur.date) > MAX_GAP_DAYS) continue;
    const jump = Math.log(prev.close / cur.open);
    const atClose = Math.log(prev.close / cur.close);
    let ratio: number;
    let dvMax = DV_MAX;
    if (jump >= MIN_FALL) {
      const k = nearest(jump, FORWARD_RATIOS);
      const half = k === 1.5 || k === 2.5;
      if (Math.abs(jump - Math.log(k)) > (half ? OPEN_TOL_HALF : k === 2 ? OPEN_TOL_TWO : OPEN_TOL)) continue;
      if (Math.abs(atClose - Math.log(k)) > (half ? CLOSE_TOL_HALF : CLOSE_TOL)) continue;
      ratio = k;
    } else if (-jump >= MIN_RISE) {
      const sure = -jump >= SURE_RISE;
      const k = reverseDivisor(-jump, sure ? OPEN_TOL_SURE : OPEN_TOL_REVERSE);
      if (k === null) continue;
      if (Math.abs(-atClose - Math.log(k)) > (sure ? CLOSE_TOL_SURE : CLOSE_TOL)) continue;
      ratio = 1 / k;
      if (sure) dvMax = DV_MAX_SURE;
    } else continue;
    const base = bars.slice(Math.max(0, i - DV_BASE_MAX), i).map((b) => b.close * b.volume).filter((x) => x > 0);
    const dv = base.length ? (cur.close * cur.volume) / median(base) : NaN;
    if (base.length < DV_BASE_MIN || !(dv >= DV_MIN && dv <= dvMax)) continue;
    out.push({
      ticker,
      date: cur.date,
      ratio: Math.round(ratio * 1e6) / 1e6,
      detail: `prev close ${prev.close} (${prev.date}), open ${cur.open}, close ${cur.close}; dollar volume ${Number.isFinite(dv) ? dv.toFixed(2) : "?"}x the ${base.length}-session median`,
    });
  }
  return out;
}

/** Bars to stored rows: Databento symbols back to graph tickers (only those asked for). Pure. */
export function barsToRows(bySymbol: ReadonlyMap<string, ReadonlyMap<string, { open: number; high: number; low: number; close: number; volume: number }>>, tickerOf: ReadonlyMap<string, string>): PriceRow[] {
  const out: PriceRow[] = [];
  for (const [sym, days] of bySymbol) {
    const ticker = tickerOf.get(sym);
    if (!ticker) continue;
    for (const [date, b] of days) {
      if (![b.open, b.high, b.low, b.close, b.volume].every(Number.isFinite) || b.close <= 0) continue;
      out.push({ ticker, date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume, source: PRICES_SOURCE });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The job

export type PricesOptions = {
  client?: DatabentoClient;
  store: PricesStore | null;
  ledger: SpendLedgerStore | null;
  tickers: readonly string[];
  mode: PricesMode;
  /** First session to fill (backfill default: the dataset's first day; daily: 10 days back). */
  from?: string;
  /** Last session to fill (default: the newest Databento has). */
  to?: string;
  priceOnly?: boolean;
  runCapUsd?: number;
  monthCapUsd?: number;
  chunkSessions?: number;
  nowMs?: number;
  log?: (line: string) => void;
};

export type PricesSummary = {
  mode: PricesMode;
  from: string | null;
  to: string | null;
  universe: number;
  sessions: number;
  /** Sessions already stored (skipped). */
  stored: number;
  /** Sessions requested this run. */
  bought: number;
  requests: number;
  rows: number;
  tickers: number;
  splits: Split[];
  spendUsd: number;
  pricedUsd: number;
  monthUsdBefore: number;
  runCapUsd: number;
  monthCapUsd: number;
  stopped: string | null;
  accountError: string | null;
  line: string;
};

const usd = (x: number) => `$${x.toFixed(x < 0.1 && x > 0 ? 4 : 2)}`;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***").slice(0, 200);

/** Fills prices_daily for the sessions not stored yet. Never throws for data, budget, store or account problems. */
export async function runPrices(opts: PricesOptions): Promise<PricesSummary> {
  const log = opts.log ?? (() => undefined);
  const nowMs = opts.nowMs ?? Date.now();
  const mode = opts.mode;
  const runCapUsd = opts.runCapUsd ?? capFromEnv(mode === "daily" ? "PRICES_DAILY_RUN_CAP_USD" : "PRICES_BACKFILL_RUN_CAP_USD", DEFAULT_PRICES_RUN_CAP_USD[mode]);
  const monthCapUsd = opts.monthCapUsd ?? capFromEnv(mode === "daily" ? "PRICES_DAILY_MONTH_CAP_USD" : "PRICES_BACKFILL_MONTH_CAP_USD", DEFAULT_PRICES_MONTH_CAP_USD[mode]);
  const s: PricesSummary = {
    mode,
    from: null,
    to: null,
    universe: opts.tickers.length,
    sessions: 0,
    stored: 0,
    bought: 0,
    requests: 0,
    rows: 0,
    tickers: 0,
    splits: [],
    spendUsd: 0,
    pricedUsd: 0,
    monthUsdBefore: 0,
    runCapUsd,
    monthCapUsd,
    stopped: null,
    accountError: null,
    line: "",
  };
  const finish = () => {
    s.line = pricesLine(s, opts.priceOnly === true);
    return s;
  };
  if (!opts.client && !env("DATABENTO_API_KEY")) {
    s.stopped = "DATABENTO_API_KEY is not set";
    return finish();
  }
  if (!opts.priceOnly && (!opts.store || !opts.ledger)) {
    s.stopped = "no price store (DATABASE_URL is not set)";
    return finish();
  }
  if (!opts.tickers.length) {
    s.stopped = "no tickers";
    return finish();
  }
  const client = opts.client ?? new DatabentoClient();
  const prefix = `prices-${mode}`;
  const caller = `${prefix}@${new Date(nowMs).toISOString().slice(0, 16)}Z`;
  const mine = (): SpendEntry[] => client.guard.entries().filter((e) => e.caller === caller);

  // The newest day Databento has (free metadata; `end` is exclusive).
  let lastAvailable: string;
  try {
    const range = await client.getDatasetRange(PRICES_DATASET);
    const end = (range.schema?.["ohlcv-1d"]?.end ?? range.end).slice(0, 10);
    lastAvailable = addDays(end, -1);
  } catch (err) {
    s.stopped = accountProblem(err) ?? `dataset range unavailable (${errText(err)})`;
    if (accountProblem(err)) s.accountError = accountProblem(err);
    return finish();
  }
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const to = [opts.to ?? lastAvailable, lastAvailable, today].sort()[0]!;
  const from = opts.from ?? (mode === "backfill" ? PRICES_DATA_START : addDays(to, -DAILY_LOOKBACK_DAYS));
  s.from = from < PRICES_DATA_START ? PRICES_DATA_START : from;
  s.to = to;
  const sessions = nyseSessions(s.from, to);
  s.sessions = sessions.length;
  if (!sessions.length) return finish();

  // Sessions already stored.
  let counts = new Map<string, number>();
  if (opts.store) {
    try {
      counts = await opts.store.countByDate(s.from, to);
    } catch (err) {
      s.stopped = `price store unreadable (${errText(err)})`;
      return finish();
    }
  }
  const need = Math.max(1, Math.floor(DONE_SHARE * opts.tickers.length));
  const todo = new Set(sessions.filter((d) => (counts.get(d) ?? 0) < need));
  s.stored = sessions.length - todo.size;
  const chunks = chunkSessions(sessions, todo, mode === "daily" ? 1 : Math.max(1, opts.chunkSessions ?? CHUNK_SESSIONS));
  log(`prices-${mode}: ${opts.tickers.length} tickers, sessions ${s.from} to ${to}: ${sessions.length}, ${s.stored} stored, ${todo.size} to fetch in ${chunks.length} request(s)`);
  if (!chunks.length) return finish();

  // Caps: this run, and this mode's UTC month in the persistent ledger plus this run.
  if (opts.ledger) {
    try {
      s.monthUsdBefore = await opts.ledger.monthSpend(prefix, nowMs);
    } catch (err) {
      s.stopped = `spend ledger unreadable (${errText(err)}); nothing bought`;
      return finish();
    }
  }
  if (!opts.priceOnly && s.monthUsdBefore >= monthCapUsd) {
    s.stopped = `monthly cap reached (${usd(s.monthUsdBefore)} of ${usd(monthCapUsd)})`;
    return finish();
  }
  const month = new Date(nowMs).toISOString().slice(0, 7);
  const pull: PullOptions = {
    caller,
    maxCallUsd: runCapUsd,
    maxCallerUsd: runCapUsd,
    caps: [{ label: `the ${prefix} monthly cap (${month}, ${usd(s.monthUsdBefore)} spent before this run)`, limitUsd: monthCapUsd - s.monthUsdBefore, match: (e) => e.caller === caller }],
    dryRun: opts.priceOnly === true,
  };
  const syncLedger = async () => {
    if (!opts.ledger || opts.priceOnly) return;
    try {
      await opts.ledger.append(mine());
    } catch (err) {
      log(`prices-${mode}: could not copy the ledger lines (${errText(err)})`);
    }
  };

  const symbols = opts.tickers.map(toDatabentoSymbol);
  const tickerOf = new Map(opts.tickers.map((t) => [toDatabentoSymbol(t), t]));
  const touched = new Set<string>();
  let firstNew: string | null = null;
  try {
    for (const chunk of chunks) {
      const start = chunk[0]!;
      const end = addDays(chunk[chunk.length - 1]!, 1);
      if (opts.priceOnly) {
        const req: RangeRequest = { dataset: PRICES_DATASET, schema: "ohlcv-1d", symbols, start, end };
        const priced = await client.getCost(req);
        s.pricedUsd += priced;
        s.requests++;
        log(`prices-${mode}: ${start} to ${chunk[chunk.length - 1]} (${chunk.length} sessions) would cost ${usd(priced)}`);
        continue;
      }
      let got;
      try {
        got = await fetchStockDaily(client, { symbols, start, end, dataset: PRICES_DATASET, pull });
      } catch (err) {
        const acct = accountProblem(err);
        if (acct) {
          s.accountError = acct;
          s.stopped = acct;
        } else if (err instanceof BudgetError) s.stopped = err.message;
        else if (err instanceof DatabentoError) s.stopped = `Databento: ${errText(err)}`;
        else throw err;
        break;
      }
      s.requests++;
      s.bought += chunk.length;
      await syncLedger();
      const rows = barsToRows(got, tickerOf);
      try {
        s.rows += await opts.store!.save(rows);
      } catch (err) {
        s.stopped = `price store write failed (${errText(err)})`;
        break;
      }
      for (const r of rows) touched.add(r.ticker);
      if (!firstNew || start < firstNew) firstNew = start;
      log(`prices-${mode}: ${start} to ${chunk[chunk.length - 1]}: ${rows.length} bars stored (${got.size} symbols)`);
    }
  } finally {
    await syncLedger();
  }
  s.tickers = touched.size;
  s.spendUsd = mine().reduce((a, e) => a + e.costUsd, 0);
  if (opts.priceOnly) s.spendUsd = 0;

  // Splits among the new bars (with a month of stored bars before them as the baseline).
  if (opts.store && firstNew && touched.size) {
    try {
      const bars = await opts.store.bars(addDays(firstNew, -SPLIT_CONTEXT_DAYS), to, mode === "daily" ? [...touched] : undefined);
      const found: Split[] = [];
      for (const [t, list] of bars) for (const sp of detectSplits(t, list)) if (sp.date >= firstNew) found.push(sp);
      if (found.length) await opts.store.saveSplits(found);
      s.splits = found;
      if (found.length) log(`prices-${mode}: splits detected: ${found.map((x) => `${x.ticker} ${x.date} x${x.ratio}`).join(", ")}`);
    } catch (err) {
      log(`prices-${mode}: split detection failed (${errText(err)})`);
    }
  }
  return finish();
}

/**
 * Runs the detector over every stored bar and replaces the detected splits
 * with what it finds (rows entered by hand stay). Free: no Databento call.
 * For after a detector change: `prices-daily -- --redetect`.
 */
export async function redetectSplits(store: PricesStore, nowMs = Date.now()): Promise<Split[]> {
  const bars = await store.bars(PRICES_DATA_START, new Date(nowMs).toISOString().slice(0, 10));
  const found: Split[] = [];
  for (const [t, list] of bars) found.push(...detectSplits(t, list));
  await store.replaceDetectedSplits(found);
  return found;
}

/** One summary line. Pure. */
export function pricesLine(s: PricesSummary, priceOnly = false): string {
  if (!s.to) return `prices-${s.mode}: skipped (${s.stopped ?? "no sessions"})`;
  const range = `${s.from} to ${s.to}`;
  const head = priceOnly
    ? `prices-${s.mode} (price only): ${s.sessions - s.stored} of ${s.sessions} sessions (${range}) would cost ${usd(s.pricedUsd)}`
    : `prices-${s.mode}: ${s.bought} of ${s.sessions} sessions (${range}) bought, ${s.rows} bars for ${s.tickers} tickers; ${s.stored} already stored`;
  const sp = s.splits.length ? `; ${s.splits.length} split(s) detected` : "";
  const stop = s.stopped ? `; stopped: ${s.stopped}` : "";
  const money = priceOnly ? "" : `; ${usd(s.spendUsd)} this run (cap ${usd(s.runCapUsd)}), ${usd(s.monthUsdBefore + s.spendUsd)} this month (cap ${usd(s.monthCapUsd)})`;
  return `${head}${sp}${stop}${money}`;
}
