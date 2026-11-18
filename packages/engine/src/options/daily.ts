/**
 * The daily options job over the whole universe: every US-listed, liquid
 * ticker of the live graph (data/graph.json) gets one OPRA cbbo-1m snapshot
 * at 15:45 New York of the latest completed session, the same per-ticker
 * record and card block as Sightings cards (chains.ts, cards.ts), and an IV
 * percentile against its own stored days once 20 exist. Results go into
 * Supabase public.options_daily (store.ts), which the Sightings run reads
 * before buying anything and the website serves at /api/options.
 *
 * Sessions: the latest session whose 15:45 snapshot Databento has and the
 * ones before it (DEFAULT_DAILY_BACKFILL, OPTIONS_DAILY_BACKFILL), oldest
 * first, each at its own 15:45 New York (12:45 on early-close days) however
 * late the run: a missed or late run is caught up, never moved to another
 * minute. Names already stored for a session cost nothing.
 *
 * Earnings straddles (earnings-straddle.ts): releases from Yahoo (the
 * /earnings source: v7 quote per universe name, plus the earnings calendar
 * by date for names outside it). On the last session before a release's
 * reaction, the reporting names (outside the universe too, through the same
 * liquidity gate) are priced and their row's metrics get `earnings_straddle`.
 *
 * Scoreboard coverage (`alwaysTickers`, the CLI reads them from Supabase):
 * the tickers of ripple forecasts whose window is still open and of the
 * Sightings cards not marked stale are priced every session, inside or
 * outside the universe, past the liquidity gate (still under both caps), and
 * first, so a cap leaves the universe short rather than the scoreboard. A
 * name OPRA lists no options for is stored as the skip "no options listed";
 * a chain too thin for the card block still stores its earnings straddle.
 *
 * Order: snapshot (free metadata), what the store already has for that
 * session (rows from an earlier run or from Sightings: never bought again),
 * the liquidity gate on the rest (Yahoo closes: price > $5 and a 20-day
 * median dollar volume >= $5M, quality.ts; `alwaysTickers` skip it), then
 * the pulls batch by batch.
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
import { addDays, nyInstantMs, nyseSessions } from "../study/abnormal.ts";
import { horizonExit, lastClosedSession } from "../study/scoreboard.ts";
import { DatabentoClient, type PullOptions } from "./client.ts";
import type { SpendEntry } from "./cost.ts";
import { US_TICKER, mapPool, pickSnapshot, priceChains, snapshotMinute, type KnownEntry, type Skip, type Snapshot } from "./chains.ts";
import { releaseForSession, type EarningsRelease } from "./earnings-straddle.ts";
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
/** Sessions a run fills (the latest and the ones before it): a missed or late run is caught up at each session's own 15:45. */
export const DEFAULT_DAILY_BACKFILL = 3;

const hhmm = (minute: number) => `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;

/**
 * The snapshots a run fills, oldest first: the latest session whose snapshot
 * Databento has (chains.ts pickSnapshot) and the `n - 1` sessions before it.
 * Every one is that session's own snapshot minute, 15:45 New York (12:45 on
 * early-close days), however late the run is: the stored daily snapshot never
 * moves to "the latest available minute". Pure.
 */
export function snapshotsToFill(nowMs: number, availableEndMs: number | null, n = DEFAULT_DAILY_BACKFILL): Snapshot[] {
  const latest = pickSnapshot(nowMs, availableEndMs);
  if (!latest) return [];
  const sessions = nyseSessions(addDays(latest.date, -Math.max(10, 3 * n)), latest.date).slice(-Math.max(1, n));
  return sessions.map((date) => {
    const minute = snapshotMinute(date);
    return { date, minute, asOfMs: nyInstantMs(date, minute), label: `${date} ${hhmm(minute)} ET` };
  });
}

/** Releases whose straddle belongs to session `date`, per ticker. Pure. */
export function straddlesDue(releases: ReadonlyMap<string, readonly EarningsRelease[]>, date: string): Map<string, EarningsRelease> {
  const out = new Map<string, EarningsRelease>();
  for (const [t, rs] of releases) {
    const r = releaseForSession(rs, date);
    if (r) out.set(t, r);
  }
  return out;
}

/**
 * The scoreboard's names for a run at `nowMs`: tickers of ripple forecasts
 * whose window is still open (their last session, `window_days` NYSE sessions
 * after the last close before creation, is the latest closed session or
 * later) and of the Sightings cards not marked stale. US listings only,
 * sorted and deduplicated. Pure.
 */
export function coverageTickers(
  forecasts: ReadonlyArray<{ created_at: string | Date; ticker: string; window_days: number }>,
  freshCardTickers: readonly string[],
  nowMs: number,
): { tickers: string[]; forecasts: number; cards: number } {
  const last = lastClosedSession(nowMs);
  const fromForecasts = new Set<string>();
  for (const f of forecasts) {
    const created = new Date(f.created_at).getTime();
    if (!Number.isFinite(created)) continue;
    const L = Math.max(1, Math.min(63, Math.round(Number(f.window_days) || 20)));
    const exit = horizonExit(lastClosedSession(created), L);
    if (exit && exit >= last) fromForecasts.add(f.ticker.trim().toUpperCase());
  }
  const fromCards = new Set(freshCardTickers.map((t) => t.trim().toUpperCase()));
  const tickers = [...new Set([...fromForecasts, ...fromCards])].filter((t) => US_TICKER.test(t)).sort();
  return { tickers, forecasts: [...fromForecasts].filter((t) => US_TICKER.test(t)).length, cards: [...fromCards].filter((t) => US_TICKER.test(t)).length };
}

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
  /**
   * Priced every filled session whatever the gate says, inside or outside `tickers`, before the rest (still under
   * both caps): the scoreboard's names (open ripple forecasts, fresh Sightings cards; CLI: store.ts coverageTickers).
   */
  alwaysTickers?: readonly string[];
  batchSize?: number;
  /** Quote requests in flight at once. */
  pullConcurrency?: number;
  concurrency?: number;
  /** No new batch after this many minutes (the workflow's own timeout is longer). */
  maxMinutes?: number;
  /** Sessions filled per run (default DEFAULT_DAILY_BACKFILL / OPTIONS_DAILY_BACKFILL). */
  backfill?: number;
  /**
   * Earnings releases per ticker (dates New York) between two dates, the universe's and any other US ticker's
   * (engine yahoo.ts yahooEarningsReleases in the CLI). Tickers whose straddle belongs to a filled session are priced
   * that session (also outside `tickers`) and get metrics.earnings_straddle.
   */
  earnings?: (tickers: readonly string[], from: string, to: string) => Promise<{ releases: Map<string, EarningsRelease[]>; problems: string[] }>;
};

export type DailySummary = {
  snapshot: string | null;
  date: string | null;
  universe: number;
  /** Scoreboard names priced every session past the liquidity gate (alwaysTickers), and how many sit outside the universe. */
  always: number;
  alwaysOutside: number;
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
  /** Per filled session (oldest first): names already stored, priced this run, straddles stored. */
  sessions: Array<{ date: string; stored: number; priced: number; straddles: number; earnings: number }>;
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
    always: 0,
    alwaysOutside: 0,
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
    sessions: [],
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

  let availableEndMs: number | null = null;
  try {
    const range = await client.getDatasetRange("OPRA.PILLAR");
    const ms = Date.parse(range.schema?.["cbbo-1m"]?.end ?? range.end);
    availableEndMs = Number.isFinite(ms) ? ms : null;
  } catch (err) {
    // An account refusal shows again on the first pull, which stops the job there.
    log(`options: dataset range unavailable (${errText(err)}); assuming the latest session is there`);
  }
  const snaps = snapshotsToFill(nowMs, availableEndMs, opts.backfill ?? capFromEnv("OPTIONS_DAILY_BACKFILL", DEFAULT_DAILY_BACKFILL));
  if (!snaps.length) {
    s.stopped = "no session snapshot available";
    return finish();
  }
  const last = snaps[snaps.length - 1]!;
  s.snapshot = last.label;
  s.date = last.date;

  // Earnings releases around the filled sessions (their straddles): from the first one to a week after the last.
  let releases = new Map<string, EarningsRelease[]>();
  if (opts.earnings) {
    try {
      const got = await opts.earnings(opts.tickers, snaps[0]!.date, addDays(last.date, 7));
      releases = got.releases;
      if (got.problems.length) log(`options-daily: earnings calendar: ${got.problems.slice(0, 3).join("; ")}`);
    } catch (err) {
      log(`options-daily: earnings calendar unavailable (${errText(err)}); no straddles this run`);
    }
  }

  // Caps: this run, and the month in the persistent ledger plus this run.
  if (opts.ledger) {
    try {
      // The Desk's on-demand volume delta (apps/web lib/desk/tools/flow.ts, caller "desk-flow") shares this monthly cap.
      s.monthUsdBefore = (await opts.ledger.monthSpend(DAILY_CALLER_PREFIX, nowMs)) + (await opts.ledger.monthSpend("desk-flow", nowMs));
    } catch (err) {
      s.stopped = `spend ledger unreadable (${errText(err)}); nothing bought`;
      return finish();
    }
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
  const deadlineMs = Date.now() + (opts.maxMinutes ?? capFromEnv("OPTIONS_DAILY_MAX_MINUTES", DEFAULT_DAILY_MAX_MINUTES)) * 60_000;
  const universe = new Set(opts.tickers);
  const always = new Set([...(opts.alwaysTickers ?? [])].map((t) => t.trim().toUpperCase()).filter((t) => US_TICKER.test(t)));
  s.always = always.size;
  s.alwaysOutside = [...always].filter((t) => !universe.has(t)).length;

  // Oldest session first, so a session's IV percentile sees the ones before it.
  for (const snap of snaps) {
    if (s.stopped) break;
    const due = straddlesDue(releases, snap.date);
    const extra = [...due.keys()].filter((t) => !universe.has(t) && !always.has(t) && US_TICKER.test(t));
    const row = { date: snap.date, stored: 0, priced: 0, straddles: 0, earnings: due.size };
    s.sessions.push(row);

    // What the store already has for this session; a reporting name without its straddle is priced again.
    // The scoreboard's names go first, so a cap cuts the universe rather than them.
    let todo = [...always, ...opts.tickers.filter((t) => !always.has(t)), ...extra];
    if (opts.store) {
      try {
        const known = await opts.store.known(snap.date, todo);
        const done = (t: string) => {
          const k = known.get(t);
          if (!k) return false;
          if (!due.has(t) || "skip" in k) return true;
          return !!k.earningsStraddle;
        };
        row.stored = [...known.keys()].filter(done).length;
        todo = todo.filter((t) => !done(t));
      } catch (err) {
        s.stopped = `options store unreadable (${errText(err)})`;
        break;
      }
    }
    s.stored += row.stored;
    log(`options-daily: ${s.universe} tickers${s.alwaysOutside ? ` + ${s.alwaysOutside} scoreboard names outside the universe` : ""}${extra.length ? ` + ${extra.length} reporting outside the universe` : ""}, ${row.stored} already stored for ${snap.label}, ${todo.length} to check, ${due.size} straddles due`);

    // Liquidity gate as of the snapshot session (also warms the closes cache the beta reads); the scoreboard's names pass.
    const gated = todo.filter((t) => !always.has(t));
    if (opts.market && !opts.noLiquidity && gated.length) {
      const from = addDays(snap.date, -420);
      const market = opts.market;
      const ok = await mapPool(gated, opts.concurrency ?? 6, async (t) => isLiquid(liquidityOf(await market.dailyCloses(t, from, snap.date).catch(() => []))));
      const thin = new Set(gated.filter((_, i) => !ok[i]));
      s.notLiquid += thin.size;
      todo = todo.filter((t) => !thin.has(t));
      log(`options-daily: ${todo.length} to price (${todo.filter((t) => always.has(t)).length} scoreboard names past the gate), ${thin.size} left out (price <= $5, thin volume or no Yahoo history)`);
    }
    s.wanted += todo.length;
    if (!todo.length) continue;
    if (s.monthUsdBefore >= monthCapUsd) {
      s.stopped = `monthly cap reached (${usd(s.monthUsdBefore)} of ${usd(monthCapUsd)})`;
      break;
    }

    let out;
    try {
      out = await priceChains(todo, {
        client,
        market: opts.market,
        log,
        pull,
        snapshot: snap,
        earnings: due,
        batchSize: opts.batchSize ?? capFromEnv("OPTIONS_DAILY_BATCH", DEFAULT_DAILY_BATCH),
        pullConcurrency: opts.pullConcurrency ?? capFromEnv("OPTIONS_DAILY_PARALLEL", DEFAULT_DAILY_PARALLEL),
        concurrency: opts.concurrency,
        deadlineMs,
        progressEvery: 25,
        onBatch: async (entries: ReadonlyMap<string, KnownEntry>) => {
          await syncLedger();
          if (store) await store.save(snap.date, entries, "daily");
        },
      });
    } finally {
      await syncLedger();
    }
    row.priced = out.priced;
    // Records with their straddle, and thin chains that kept one.
    row.straddles = [...out.result.values()].filter((r) => r.earningsStraddle).length + [...out.fresh.values()].filter((e) => "skip" in e && e.earningsStraddle).length;
    s.priced += out.priced;
    s.pricedUsd += out.pricedUsd;
    s.batches += out.batches;
    s.skipped.push(...out.skipped);
    s.stopped = out.stopped;
    s.accountError = out.accountError;
  }
  s.spendUsd = mine().reduce((a, e) => a + e.costUsd, 0);
  if (store) {
    try {
      s.pruned = await store.prune(last.date, KEEP_DAYS);
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
  const ctx = `; universe ${s.universe}${s.always ? `, scoreboard names ${s.always} (${s.alwaysOutside} outside the universe)` : ""}, already stored ${s.stored}, not liquid ${s.notLiquid}`;
  const left = s.skipped.length ? `; left out ${s.skipped.length}: ${reasons(s.skipped)}` : "";
  const stop = s.stopped ? `; stopped: ${s.stopped}` : "";
  const filled = s.sessions.length > 1 ? `; sessions ${s.sessions.map((x) => `${x.date} +${x.priced}`).join(", ")}` : "";
  const st = s.sessions.reduce((a, x) => a + x.straddles, 0);
  const due = s.sessions.reduce((a, x) => a + x.earnings, 0);
  const straddles = due ? `; earnings straddles ${st} of ${due} due` : "";
  return `${head}${ctx}${filled}${straddles}${left}${stop}; ${usd(s.spendUsd)} this run (cap ${usd(s.runCapUsd)}), ${usd(s.monthUsdBefore + s.spendUsd)} this month (cap ${usd(s.monthCapUsd)})`;
}
