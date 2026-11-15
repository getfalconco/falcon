/**
 * The daily options job over the whole universe: every US-listed, liquid
 * ticker of the live graph (data/graph.json) gets one OPRA cbbo-1m snapshot
 * at 15:45 New York of the latest completed session, the same per-ticker
 * record and card block as Sightings cards (chains.ts, cards.ts), and an IV
 * percentile against its own stored days once 20 exist. Results go into
 * Supabase public.options_daily (store.ts), which the Sightings run reads
 * before buying anything and the website serves at /api/options.
 *
 * Order: snapshot (free metadata), what the store already has for that
 * session (rows from an earlier run or from Sightings: never bought again),
 * the liquidity gate on the rest (Yahoo closes: price > $5 and a 20-day
 * median dollar volume >= $5M, quality.ts), then the pulls batch by batch.
 *
 * Caps: per run (`OPTIONS_DAILY_RUN_CAP_USD`, default $7: this run's caller)
 * and per UTC month (`OPTIONS_DAILY_MONTH_CAP_USD`, default $110: every
 * `options-daily` charge in public.options_spend, the persistent ledger, plus
 * this run's). Every pull is priced with get_cost first and checked under the
 * file ledger's lock; each batch's ledger lines are copied to options_spend
 * as it ends. A cap, or Databento refusing for billing (the free credit used
 * up), stops the pulls quietly: what was priced stays stored, the summary
 * says why, nothing throws.
 */

import { env } from "../env.ts";
import type { MarketData } from "../market.ts";
import { isLiquid, liquidityOf } from "../quality.ts";
import { addDays } from "../study/abnormal.ts";
import { DatabentoClient, type PullOptions } from "./client.ts";
import type { SpendEntry } from "./cost.ts";
import { US_TICKER, mapPool, priceChains, resolveSnapshot, type KnownEntry, type Skip } from "./chains.ts";
import { capFromEnv, reasons } from "./sightings-options.ts";
import { KEEP_DAYS, type OptionsStore, type SpendLedgerStore } from "./store.ts";

export const DAILY_CALLER_PREFIX = "options-daily";
export const DEFAULT_DAILY_RUN_CAP_USD = 7;
export const DEFAULT_DAILY_MONTH_CAP_USD = 110;
/** Parents a request: large chains in one request can pass Databento's gateway timeout (about 4 minutes). */
export const DEFAULT_DAILY_BATCH = 4;
/** Requests in flight: a request takes about 10 s plus its size, so the universe needs several at once. */
export const DEFAULT_DAILY_PARALLEL = 6;
export const DEFAULT_DAILY_MAX_MINUTES = 100;

/** The graph's US listings (OPRA roots), sorted and deduplicated. Pure. */
export function universeTickers(graph: { names: Record<string, string> }): string[] {
  return [...new Set(Object.keys(graph.names).map((t) => t.trim().toUpperCase()))].filter((t) => US_TICKER.test(t)).sort();
}

export type DailyOptions = {
  client?: DatabentoClient;
  market: MarketData | null;
  store: OptionsStore | null;
  ledger: SpendLedgerStore | null;
  tickers: readonly string[];
  log?: (line: string) => void;
  nowMs?: number;
  runCapUsd?: number;
  monthCapUsd?: number;
  /** Only price the pulls (get_cost): nothing charged, stored or written. */
  priceOnly?: boolean;
  /** Skip the liquidity gate (every ticker is tried). */
  noLiquidity?: boolean;
  batchSize?: number;
  /** Quote requests in flight at once. */
  pullConcurrency?: number;
  concurrency?: number;
  /** No new batch after this many minutes (the workflow's own timeout is longer). */
  maxMinutes?: number;
};

export type DailySummary = {
  snapshot: string | null;
  date: string | null;
  universe: number;
  /** Already in the store for this session (records and data skips). */
  stored: number;
  notLiquid: number;
  /** Names sent to Databento this run. */
  wanted: number;
  priced: number;
  skipped: Skip[];
  /** Charged this run (this run's ledger lines). */
  spendUsd: number;
  pricedUsd: number;
  monthUsdBefore: number;
  runCapUsd: number;
  monthCapUsd: number;
  batches: number;
  pruned: number;
  stopped: string | null;
  accountError: string | null;
  line: string;
};

const usd = (x: number) => `$${x.toFixed(2)}`;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***").slice(0, 160);

/** Prices the universe for the latest completed session. Never throws for data, budget, store or account problems. */
export async function runDaily(opts: DailyOptions): Promise<DailySummary> {
  const log = opts.log ?? (() => undefined);
  const nowMs = opts.nowMs ?? Date.now();
  const runCapUsd = opts.runCapUsd ?? capFromEnv("OPTIONS_DAILY_RUN_CAP_USD", DEFAULT_DAILY_RUN_CAP_USD);
  const monthCapUsd = opts.monthCapUsd ?? capFromEnv("OPTIONS_DAILY_MONTH_CAP_USD", DEFAULT_DAILY_MONTH_CAP_USD);
  const s: DailySummary = {
    snapshot: null,
    date: null,
    universe: opts.tickers.length,
    stored: 0,
    notLiquid: 0,
    wanted: 0,
    priced: 0,
    skipped: [],
    spendUsd: 0,
    pricedUsd: 0,
    monthUsdBefore: 0,
    runCapUsd,
    monthCapUsd,
    batches: 0,
    pruned: 0,
    stopped: null,
    accountError: null,
    line: "",
  };
  const finish = () => {
    s.line = dailyLine(s, opts.priceOnly === true);
    return s;
  };
  if (!opts.client && !env("DATABENTO_API_KEY")) {
    s.stopped = "DATABENTO_API_KEY is not set";
    return finish();
  }
  if (!opts.priceOnly && (!opts.store || !opts.ledger)) {
    s.stopped = "no options store (DATABASE_URL is not set)";
    return finish();
  }
  const client = opts.client ?? new DatabentoClient();
  const caller = `${DAILY_CALLER_PREFIX}@${new Date(nowMs).toISOString().slice(0, 16)}Z`;
  const mine = (): SpendEntry[] => client.guard.entries().filter((e) => e.caller === caller);

  const snap = await resolveSnapshot(client, nowMs, log);
  if (!snap) {
    s.stopped = "no session snapshot available";
    return finish();
  }
  s.snapshot = snap.label;
  s.date = snap.date;

  // What the store already has for this session.
  let todo = [...opts.tickers];
  if (opts.store) {
    try {
      const known = await opts.store.known(snap.date, todo);
      s.stored = known.size;
      todo = todo.filter((t) => !known.has(t));
    } catch (err) {
      s.stopped = `options store unreadable (${errText(err)})`;
      return finish();
    }
  }
  log(`options-daily: ${s.universe} tickers, ${s.stored} already stored for ${snap.label}, ${todo.length} to check`);

  // Liquidity gate as of the snapshot session (also warms the closes cache the beta reads).
  if (opts.market && !opts.noLiquidity && todo.length) {
    const from = addDays(snap.date, -420);
    const market = opts.market;
    const ok = await mapPool(todo, opts.concurrency ?? 6, async (t) => isLiquid(liquidityOf(await market.dailyCloses(t, from, snap.date).catch(() => []))));
    const kept: string[] = [];
    todo.forEach((t, i) => (ok[i] ? kept.push(t) : s.notLiquid++));
    todo = kept;
    log(`options-daily: ${todo.length} liquid, ${s.notLiquid} left out (price <= $5, thin volume or no Yahoo history)`);
  }
  s.wanted = todo.length;
  if (!todo.length) return finish();

  // Caps: this run, and the month in the persistent ledger plus this run.
  if (opts.ledger) {
    try {
      s.monthUsdBefore = await opts.ledger.monthSpend(DAILY_CALLER_PREFIX, nowMs);
    } catch (err) {
      s.stopped = `spend ledger unreadable (${errText(err)}); nothing bought`;
      return finish();
    }
  }
  if (s.monthUsdBefore >= monthCapUsd) {
    s.stopped = `monthly cap reached (${usd(s.monthUsdBefore)} of ${usd(monthCapUsd)})`;
    return finish();
  }
  const month = new Date(nowMs).toISOString().slice(0, 7);
  const pull: PullOptions = {
    caller,
    maxCallUsd: runCapUsd,
    maxCallerUsd: runCapUsd,
    caps: [{ label: `the daily options monthly cap (${month}, ${usd(s.monthUsdBefore)} spent before this run)`, limitUsd: monthCapUsd - s.monthUsdBefore, match: (e) => e.caller === caller }],
    dryRun: opts.priceOnly === true,
  };
  const syncLedger = async () => {
    if (!opts.ledger || opts.priceOnly) return;
    try {
      await opts.ledger.append(mine());
    } catch (err) {
      log(`options-daily: could not copy the ledger lines (${errText(err)})`);
    }
  };
  const store = opts.priceOnly ? null : opts.store;
  let out;
  try {
    out = await priceChains(todo, {
      client,
      market: opts.market,
      log,
      pull,
      snapshot: snap,
      batchSize: opts.batchSize ?? capFromEnv("OPTIONS_DAILY_BATCH", DEFAULT_DAILY_BATCH),
      pullConcurrency: opts.pullConcurrency ?? capFromEnv("OPTIONS_DAILY_PARALLEL", DEFAULT_DAILY_PARALLEL),
      concurrency: opts.concurrency,
      deadlineMs: Date.now() + (opts.maxMinutes ?? capFromEnv("OPTIONS_DAILY_MAX_MINUTES", DEFAULT_DAILY_MAX_MINUTES)) * 60_000,
      progressEvery: 25,
      onBatch: async (entries: ReadonlyMap<string, KnownEntry>) => {
        await syncLedger();
        if (store) await store.save(snap.date, entries, "daily");
      },
    });
  } finally {
    await syncLedger();
  }
  s.priced = out.priced;
  s.pricedUsd = out.pricedUsd;
  s.batches = out.batches;
  s.skipped = out.skipped;
  s.stopped = out.stopped;
  s.accountError = out.accountError;
  s.spendUsd = mine().reduce((a, e) => a + e.costUsd, 0);
  if (store) {
    try {
      s.pruned = await store.prune(snap.date, KEEP_DAYS);
    } catch (err) {
      log(`options-daily: prune failed (${errText(err)})`);
    }
  }
  return finish();
}

/** One summary line. Pure. */
export function dailyLine(s: DailySummary, priceOnly = false): string {
  if (!s.snapshot) return `options-daily: skipped (${s.stopped ?? "no snapshot"})`;
  const head = priceOnly
    ? `options-daily (price only): ${s.wanted} names at ${s.snapshot} would cost ${usd(s.pricedUsd)}`
    : `options-daily: ${s.priced} of ${s.wanted} names priced at ${s.snapshot}`;
  const ctx = `; universe ${s.universe}, already stored ${s.stored}, not liquid ${s.notLiquid}`;
  const left = s.skipped.length ? `; left out ${s.skipped.length}: ${reasons(s.skipped)}` : "";
  const stop = s.stopped ? `; stopped: ${s.stopped}` : "";
  return `${head}${ctx}${left}${stop}; ${usd(s.spendUsd)} this run (cap ${usd(s.runCapUsd)}), ${usd(s.monthUsdBefore + s.spendUsd)} this month (cap ${usd(s.monthCapUsd)})`;
}
