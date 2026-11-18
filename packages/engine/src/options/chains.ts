/**
 * The shared core of the options jobs: one OPRA cbbo-1m snapshot per chain at
 * 15:45 New York of the latest completed session, turned into the per-ticker
 * record cards.ts builds the card block from (`TickerOptions`).
 *
 * Used by the Sightings run (sightings-options.ts: the card tickers) and the
 * daily universe job (daily.ts: every liquid ticker of the graph). Both pass
 * what is already known for the snapshot (the options_daily store, the
 * snapshot file cache), so a chain is bought at most once a session.
 *
 * Work goes batch by batch (15 parents a request by default; `pullConcurrency`
 * batches in flight): pull the quotes of [15:40, 15:46) (priced with get_cost
 * first, checked against the caps under the ledger lock), pull the spot bars
 * of the names that came back, compute them, hand them to `onBatch` (the
 * store write), drop the records. Memory stays at a few batches whatever the
 * universe size. A batch that fails (one unknown parent, or a gateway
 * timeout on large chains) is retried name by name.
 *
 * Stops quietly (no throw) on a cap (BudgetError), on an account refusal
 * (Databento answering 401/402/403 or naming billing, credit or payment: the
 * free credit is used up or the key is revoked), at the deadline, and after
 * five batches in a row with nothing pulled (Databento unreachable). The
 * outcome says why.
 */

import { HOUR_MS, plainGet } from "../http.ts";
import type { MarketData } from "../market.ts";
import { addDays, isNyseEarlyClose, nyInstantMs, nyseSessions } from "../study/abnormal.ts";
import { BudgetError, DatabentoClient, DatabentoError, fetchStockSpot, quotesAt, type PullOptions } from "./client.ts";
import { betaFromCloses, chainProblem, latestOnOrBefore, tickerOptionsFrom, type TickerOptions } from "./cards.ts";
import { discountToContinuous, dividendYieldOn, fetchDividends, fetchDtb3, parseFredCsv, rateOn } from "./rates.ts";
import { earningsStraddle, releaseSessions, type EarningsRelease, type EarningsStraddle } from "./earnings-straddle.ts";
import { definitionsFromRecords, osiRoot, recordsByRoot } from "./study-options.ts";
import { surfaceFeatures, type SurfaceFeatures } from "./surface.ts";

export const DEFAULT_BATCH = 15;
export const DEFAULT_CONCURRENCY = 6;
/**
 * Minutes of cbbo-1m before the snapshot. cbbo-1m only carries a contract in
 * a minute its quote changed, so thin chains need the lookback: on 2026-11-13
 * ABM had 105 contracts quoted in [15:40, 15:46) but 11 in [15:43, 15:46).
 */
export const LOOKBACK_MIN = 5;
const MIN_SNAPSHOT_AGE_MS = 15 * 60_000;
const VIX_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS";
/** Batches in a row with nothing pulled before the job decides Databento is unreachable. */
const MAX_EMPTY_BATCHES = 5;

/** US listed common tickers (OPRA roots): AAPL, BRK.B, BRK-B; not preferreds (PCG-PE) or foreign listings. */
export const US_TICKER = /^[A-Z]{1,5}$|^[A-Z]{1,4}[.-][A-Z]$/;

export type Snapshot = { date: string; minute: number; asOfMs: number; label: string };

/**
 * What is known about a ticker at a snapshot: its record, or why it has none
 * (a data reason, kept so it is not bought again). A poor chain on the session
 * before an earnings reaction still keeps its nearest-strike straddle.
 */
export type KnownEntry = TickerOptions | { skip: string; earningsStraddle?: EarningsStraddle };

/** The skip stored when OPRA lists no options for a name (Databento cannot resolve the parent symbol). */
export const NO_OPTIONS_LISTED = "no options listed";

/** True when Databento refused a request because none of its symbols resolve (HTTP 422 symbology). Pure. */
export function noOptionsListed(err: unknown): boolean {
  return err instanceof DatabentoError && err.status === 422 && /symbolog|could (not )?be resolved|did not resolve/i.test(err.message);
}

export type Skip = { ticker: string; why: string };

/** New York snapshot minute of a session: 15:45, or 12:45 on an early-close day. */
export function snapshotMinute(date: string): number {
  return isNyseEarlyClose(date) ? 12 * 60 + 45 : 15 * 60 + 45;
}

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/**
 * The snapshot to use at `nowMs`: the latest NYSE session whose snapshot
 * instant is at least 15 minutes old and, when known, whose quote window
 * ends inside Databento's available range. Pure.
 */
export function pickSnapshot(nowMs: number, availableEndMs: number | null): { date: string; minute: number; asOfMs: number } | null {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const sessions = nyseSessions(addDays(today, -12), today);
  for (let i = sessions.length - 1; i >= 0; i--) {
    const date = sessions[i]!;
    const minute = snapshotMinute(date);
    const asOfMs = nyInstantMs(date, minute);
    if (asOfMs + MIN_SNAPSHOT_AGE_MS > nowMs) continue;
    if (availableEndMs !== null && nyInstantMs(date, minute + 1) > availableEndMs) continue;
    return { date, minute, asOfMs };
  }
  return null;
}

/** The snapshot for a run: Databento's cbbo-1m range (free metadata), then `pickSnapshot`. */
export async function resolveSnapshot(client: DatabentoClient, nowMs: number, log: (l: string) => void = () => undefined): Promise<Snapshot | null> {
  let availableEndMs: number | null = null;
  try {
    const range = await client.getDatasetRange("OPRA.PILLAR");
    const end = range.schema?.["cbbo-1m"]?.end ?? range.end;
    const ms = Date.parse(end);
    availableEndMs = Number.isFinite(ms) ? ms : null;
  } catch (err) {
    // An account refusal shows again on the first pull, which stops the job there.
    log(`options: dataset range unavailable (${errText(err, 120)}); assuming the latest session is there`);
  }
  const s = pickSnapshot(nowMs, availableEndMs);
  return s ? { ...s, label: `${s.date} ${hhmm(s.minute)} ET` } : null;
}

/**
 * Why Databento refused for account reasons (billing, credit, payment,
 * authentication), or null for any other error. Pure.
 */
export function accountProblem(err: unknown): string | null {
  if (!(err instanceof DatabentoError)) return null;
  const msg = err.message;
  const billing = /payment|billing|credit|insufficient|balance|subscription|past due|plan/i.test(msg);
  if (err.status === 401 || err.status === 402 || err.status === 403 || (billing && err.status >= 400)) {
    const what = err.status === 401 ? "the API key was refused" : billing || err.status === 402 ? "billing (free credit used up or no payment method?)" : "access refused";
    return `Databento refused the request: ${what} (HTTP ${err.status})`;
  }
  return null;
}

function errText(err: unknown, n: number): string {
  return (err instanceof Error ? err.message : String(err)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***").slice(0, n);
}

/** Runs `fn` over `items` with at most `limit` at once; results in input order. */
export async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]!, i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export type ChainsContext = {
  client: DatabentoClient;
  /** Yahoo daily closes (beta, fallback spot); without it no beta, so no market-adjusted numbers. */
  market: MarketData | null;
  log?: (line: string) => void;
  /** Caller name, per-call / per-caller caps, extra caps, dry run (price only). */
  pull: PullOptions;
  snapshot: Snapshot;
  /** Already known at this snapshot: reused, never pulled again. */
  known?: ReadonlyMap<string, KnownEntry>;
  /** Earnings releases whose straddle belongs to this snapshot (earnings-straddle.ts): the record gets `earningsStraddle`. */
  earnings?: ReadonlyMap<string, EarningsRelease>;
  batchSize?: number;
  /** Quote requests in flight at once (default 1). Databento answers a request in roughly 10 s plus its size. */
  pullConcurrency?: number;
  /** Names computed at once within a batch (Yahoo dividends and closes are the slow part). */
  concurrency?: number;
  /** No new batch starts after this instant (ms); the outcome says "time limit reached". */
  deadlineMs?: number;
  /** Log a progress line every N batches. */
  progressEvery?: number;
  /** After each batch: what it priced or found unusable (data reasons only). Errors are logged, never thrown. */
  onBatch?: (entries: ReadonlyMap<string, KnownEntry>) => Promise<void>;
};

export type ChainsOutcome = {
  /** Every ticker with a record: reused and newly priced. */
  result: Map<string, TickerOptions>;
  /** New this run: records and data skips (no quotes, no spot, poor chain), for the caches. */
  fresh: Map<string, KnownEntry>;
  skipped: Skip[];
  reused: number;
  priced: number;
  /** get_cost estimates of this run's pulls (also in price-only mode). */
  pricedUsd: number;
  batches: number;
  /** Why the pulls stopped early (a cap, an account refusal, Databento unreachable). */
  stopped: string | null;
  /** Set when Databento refused for account reasons (billing, auth). */
  accountError: string | null;
};

type Raw = Record<string, unknown>;

/** Shared per-run inputs: the 3-month bill rate, the VIX close, SPY closes (beta). Loaded once, lazily. */
type Shared = { rate: number | null; vix: number | null; spy: Array<{ date: string; close: number }> };

/**
 * Prices the chains of `tickers` at the snapshot. Never throws for data,
 * budget or account problems: those end in the outcome.
 */
export async function priceChains(tickers: readonly string[], ctx: ChainsContext): Promise<ChainsOutcome> {
  const log = ctx.log ?? (() => undefined);
  const { client, snapshot, pull } = ctx;
  const { date, minute, asOfMs } = snapshot;
  const size = Math.max(1, Math.floor(ctx.batchSize ?? DEFAULT_BATCH));
  const out: ChainsOutcome = { result: new Map(), fresh: new Map(), skipped: [], reused: 0, priced: 0, pricedUsd: 0, batches: 0, stopped: null, accountError: null };

  const todo: string[] = [];
  for (const t of tickers) {
    const k = ctx.known?.get(t);
    if (!k) todo.push(t);
    else if ("skip" in k) out.skipped.push({ ticker: t, why: k.skip });
    else {
      out.result.set(t, k);
      out.reused++;
    }
  }

  const nyIso = (m: number) => new Date(nyInstantMs(date, m)).toISOString();
  const quoteReq = (names: string[]) => ({
    dataset: "OPRA.PILLAR",
    schema: "cbbo-1m",
    symbols: names.map((t) => `${osiRoot(t)}.OPT`),
    stype_in: "parent" as const,
    start: nyIso(minute - LOOKBACK_MIN),
    end: nyIso(minute + 1),
  });
  /** A stop reason for an error, or null when the job can go on (setting accountError on the way). */
  const stopFor = (err: unknown): string | null => {
    if (err instanceof BudgetError) return `cap reached: ${err.message}`;
    const acct = accountProblem(err);
    if (acct) {
      out.accountError = acct;
      return acct;
    }
    return null;
  };

  let shared: Promise<Shared> | null = null;
  const loadShared = (): Promise<Shared> => {
    shared ??= (async () => {
      let rate = await fetchDtb3()
        .then((p) => rateOn(p, date))
        .catch(() => null);
      let vixPct = await plainGet(VIX_URL, { maxAgeMs: 12 * HOUR_MS, staleOk: true })
        .then((t) => latestOnOrBefore(parseFredCsv(t), date))
        .catch(() => null);
      // FRED does not answer GitHub's runners: Yahoo's ^VIX close and ^IRX (13-week bill yield, percent) instead.
      const yahooOn = async (symbol: string): Promise<number | null> => {
        if (!ctx.market) return null;
        const rows = await ctx.market.dailyCloses(symbol, addDays(date, -10), date).catch(() => []);
        return latestOnOrBefore(rows.map((r) => ({ date: r.date, pct: r.rawClose ?? r.close })), date);
      };
      if (vixPct === null) {
        vixPct = await yahooOn("^VIX");
        if (vixPct !== null) log(`options: VIX from Yahoo (FRED unavailable): ${vixPct.toFixed(2)}`);
      }
      if (rate === null) {
        const irx = await yahooOn("^IRX");
        if (irx !== null && irx > 0 && irx < 25) rate = discountToContinuous(irx);
      }
      const spy = ctx.market ? await ctx.market.dailyCloses("SPY", addDays(date, -420), date).catch(() => []) : [];
      return { rate, vix: vixPct === null ? null : vixPct / 100, spy };
    })();
    return shared;
  };

  const stop = (why: string) => {
    if (out.stopped) return;
    out.stopped = why;
    log(`options: ${why}`);
  };
  const pulled = new Set<string>();
  let emptyInRow = 0;
  const batches: string[][] = [];
  for (let b = 0; b < todo.length; b += size) batches.push(todo.slice(b, b + size));
  let done = 0;
  const started = Date.now();

  // Batches run `pullConcurrency` at a time; a stop (cap, account, deadline) lets the running ones finish and starts no more.
  await mapPool(batches, Math.max(1, Math.floor(ctx.pullConcurrency ?? 1)), async (names) => {
    if (out.stopped) return;
    if (ctx.deadlineMs !== undefined && Date.now() > ctx.deadlineMs) {
      stop("time limit reached");
      return;
    }
    out.batches++;
    const recs = new Map<string, Raw[]>();
    const got = new Set<string>();
    /** Names Databento could not resolve on their own (OPRA lists no options for them): stored as a skip. */
    const noOpts: string[] = [];
    const pullBatch = async (ns: string[]): Promise<void> => {
      // A batch gets one HTTP attempt (a gateway timeout on big chains would only repeat); single names get the retries.
      const res = await client.getRange<Raw>(quoteReq(ns), ns.length > 1 ? { ...pull, attempts: 1 } : pull);
      out.pricedUsd += res.pricedUsd;
      if (res.partial) log(`options: partial answer for ${ns.length > 3 ? `${ns[0]}..${ns[ns.length - 1]}` : ns.join(",")}${res.warning ? ` (${res.warning.slice(0, 160)})` : ""}`);
      for (const [root, rs] of recordsByRoot(res.records)) recs.set(root, rs);
      for (const n of ns) got.add(n);
    };
    try {
      await pullBatch(names);
    } catch (err) {
      const why = stopFor(err);
      if (why) return stop(why);
      // One unknown parent (or one huge chain timing out) can fail a batch: try the names one by one.
      if (names.length > 1) log(`options: batch ${names[0]}..${names[names.length - 1]} failed (${errText(err, 120)}); one by one`);
      for (const n of names.length > 1 ? names : []) {
        if (out.stopped) break;
        try {
          await pullBatch([n]);
        } catch (e2) {
          const why2 = stopFor(e2);
          if (why2) {
            stop(why2);
            break;
          }
          if (noOptionsListed(e2)) noOpts.push(n);
          else out.skipped.push({ ticker: n, why: e2 instanceof DatabentoError ? `Databento HTTP ${e2.status}` : "pull failed" });
        }
      }
      if (names.length === 1) {
        if (noOptionsListed(err)) noOpts.push(names[0]!);
        else out.skipped.push({ ticker: names[0]!, why: err instanceof DatabentoError ? `Databento HTTP ${err.status}` : "pull failed" });
      }
    }
    for (const n of got) pulled.add(n);
    // A name with no listed options is an answer too (Databento is reachable).
    emptyInRow = got.size || noOpts.length ? 0 : emptyInRow + 1;
    if (emptyInRow >= MAX_EMPTY_BATCHES) stop(`nothing pulled in ${MAX_EMPTY_BATCHES} batches in a row (Databento unreachable?)`);
    done++;
    if (ctx.progressEvery && done % ctx.progressEvery === 0) {
      log(`options: ${done} of ${batches.length} batches, ${out.priced} priced, $${out.pricedUsd.toFixed(2)} priced so far, ${Math.round((Date.now() - started) / 1000)} s`);
    }
    if (pull.dryRun) {
      for (const n of noOpts) out.skipped.push({ ticker: n, why: NO_OPTIONS_LISTED });
      return;
    }
    if (!got.size && !noOpts.length) return;

    const batchEntries = new Map<string, KnownEntry>();
    const skip = (t: string, why: string, extra: { earningsStraddle?: EarningsStraddle } = {}) => {
      batchEntries.set(t, { skip: why, ...extra });
      out.skipped.push({ ticker: t, why });
    };
    for (const n of noOpts) skip(n, NO_OPTIONS_LISTED);
    const withQuotes: string[] = [];
    for (const t of names) {
      if (!got.has(t)) continue;
      if (recs.get(osiRoot(t))?.length) withQuotes.push(t);
      else skip(t, "no quotes at the snapshot");
    }
    if (withQuotes.length) {
      // Spot: the ITCH 1-minute bar ending at the snapshot; failures fall back to Yahoo's close / the parity spot.
      const spots = new Map<string, number>();
      try {
        for (const [k, v] of await fetchStockSpot(client, { symbols: withQuotes, date, snapshotMin: minute, pull })) spots.set(k, v);
      } catch (err) {
        const why = err instanceof BudgetError ? `refused (${err.message})` : `unavailable (${errText(err, 100)})`;
        log(`options: ITCH spot ${why} for ${withQuotes.length} names; Yahoo close / parity spot used`);
      }
      const sh = await loadShared();
      const computed = await mapPool(withQuotes, ctx.concurrency ?? DEFAULT_CONCURRENCY, async (t) => {
        try {
          return await computeOne(t, recs.get(osiRoot(t))!, spots.get(t) ?? null, sh, ctx.market, snapshot, ctx.earnings?.get(t) ?? null);
        } catch (err) {
          return { skip: `compute failed: ${errText(err, 80)}` };
        }
      });
      withQuotes.forEach((t, i) => {
        const r = computed[i]!;
        if ("skip" in r) skip(t, r.skip, r.earningsStraddle ? { earningsStraddle: r.earningsStraddle } : {});
        else {
          batchEntries.set(t, r);
          out.result.set(t, r);
          out.priced++;
        }
      });
    }
    for (const [k, v] of batchEntries) out.fresh.set(k, v);
    if (ctx.onBatch && batchEntries.size) {
      try {
        await ctx.onBatch(batchEntries);
      } catch (err) {
        log(`options: could not store a batch (${errText(err, 160)})`);
      }
    }
  });
  const skippedSet = new Set(out.skipped.map((s) => s.ticker));
  for (const t of todo) {
    if (pulled.has(t) || skippedSet.has(t)) continue;
    out.skipped.push({ ticker: t, why: out.accountError ? "Databento refused" : out.stopped?.startsWith("cap") ? "cap" : out.stopped?.startsWith("time") ? "time limit" : pull.dryRun ? "price only" : "not pulled" });
  }
  return out;
}

/** One name's record from its quote records, or why it has none. */
async function computeOne(t: string, rs: Raw[], itchSpot: number | null, sh: Shared, market: MarketData | null, snap: Snapshot, release: EarningsRelease | null = null): Promise<KnownEntry> {
  const { date, asOfMs } = snap;
  const from = addDays(date, -420);
  const closes = market ? await market.dailyCloses(t, from, date).catch(() => []) : [];
  const last = closes.length ? closes[closes.length - 1]! : null;
  const close = last && last.date === date ? last.rawClose ?? last.close : null;
  const q = await fetchDividends(t)
    .then((h) => dividendYieldOn(h, date) ?? 0)
    .catch(() => 0);
  const defsAll = definitionsFromRecords(rs, t);
  const quotes = quotesAt(rs as never, asOfMs);
  const run = (spot: number): SurfaceFeatures => {
    const defs = defsAll.filter((d) => d.strike / spot >= 0.7 && d.strike / spot <= 1.3 && (Date.parse(d.expiration) - Date.parse(date)) / 86_400_000 <= 400);
    return surfaceFeatures({ underlying: t, date, asOfMs, spot, rate: sh.rate ?? 0.04, divYield: q, definitions: defs, quotes, moveDates: [] });
  };
  let spot = itchSpot;
  let spotSource: TickerOptions["spotSource"] = "itch";
  let f: SurfaceFeatures | null = null;
  if (spot !== null && (close === null || Math.abs(spot / close - 1) < 0.15)) f = run(spot);
  else if (close !== null) {
    spot = close;
    spotSource = "close";
    f = run(spot);
    const p = f.parityImpliedSpot;
    if (p !== null && Math.abs(p / close - 1) < 0.03) {
      spot = p;
      spotSource = "parity";
      f = run(spot);
    }
  }
  if (!f || spot === null) return { skip: "no spot" };
  // The pre-earnings straddle, on the session before the reaction only (always this snapshot's 15:45 quotes).
  // It needs two quotes at one strike, not an IV surface: a chain too thin for the card block still has it.
  const st =
    release && releaseSessions(release).snapshotSession === date
      ? earningsStraddle(f.contracts, spot, release, { asOfMs, sourceMinute: snap.label, source: "OPRA.PILLAR cbbo-1m via Databento" })
      : null;
  const problem = chainProblem(f);
  if (problem) return st ? { skip: `poor chain: ${problem}`, earningsStraddle: st } : { skip: `poor chain: ${problem}` };
  const beta = sh.spy.length && closes.length ? betaFromCloses(closes, sh.spy, date) : null;
  const rec = tickerOptionsFrom(f, { ticker: t, spotSource, beta, vix: sh.vix });
  if (st) rec.earningsStraddle = st;
  return rec;
}
