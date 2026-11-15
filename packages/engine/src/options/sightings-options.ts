/**
 * The options data job of a Sightings run: one OPRA cbbo-1m snapshot of each
 * chain on the cards being published, turned into the @falcon/ripple
 * RippleOptions block on the card (event company) and on each hit.
 *
 * What it pulls, per run (chains.ts does the pulling and the math):
 *   - OPRA.PILLAR cbbo-1m, parent symbology, [snapshot - 5 min, snapshot + 1
 *     min), batches of 15 parents (Databento prices a 10-minute block; about
 *     $0.001 a name). Definitions come from the OSI symbols in the records
 *     (no `definition` pull). No open interest (about $0.035 a name: no GEX).
 *   - XNAS.ITCH ohlcv-1m for the spot at the snapshot (about $0.00001 a name).
 * Free: Databento metadata (get_cost before every pull, the dataset's end),
 * FRED DTB3 and VIXCLS, Yahoo dividends and daily closes (beta, fallback spot).
 *
 * Snapshot: 15:45 New York (12:45 on early-close days) of the latest session
 * whose snapshot is at least 15 minutes old and inside Databento's available
 * range; so the morning runs read the previous session's close and the
 * evening run that day's. A snapshot already computed is reused for free:
 * from `.cache/options/` (kept by the workflow's cache) and from the options
 * store (Supabase options_daily, store.ts), which the daily universe job
 * (daily.ts) fills for every liquid graph ticker. What this job prices goes
 * into the store too.
 *
 * Caps: every pull is priced first (`get_cost`) and checked under the ledger
 * lock (cost.ts) against the per-run cap (`runCapUsd`, default $0.75: the
 * run's own caller name) and the monthly cap (`monthCapUsd`, default $20:
 * every `sightings-options` caller this calendar month, UTC). A refused pull
 * (a cap, or Databento refusing for billing) stops the job quietly: the
 * names already priced keep their block, the rest get none, and the summary
 * line says so.
 */

import fs from "node:fs";
import path from "node:path";
import type { RippleCard } from "@falcon/ripple";
import { ENGINE_ROOT } from "../http.ts";
import { env } from "../env.ts";
import type { MarketData } from "../market.ts";
import { isLiquid, type Liquidity } from "../quality.ts";
import { DatabentoClient, type PullOptions } from "./client.ts";
import type { SpendCap, SpendEntry } from "./cost.ts";
import { optionsBlock } from "./cards.ts";
import { US_TICKER, pickSnapshot, priceChains, resolveSnapshot, snapshotMinute, type KnownEntry } from "./chains.ts";
import type { OptionsStore } from "./store.ts";

export { pickSnapshot, snapshotMinute };

export const CALLER_PREFIX = "sightings-options";
export const DEFAULT_RUN_CAP_USD = 0.75;
export const DEFAULT_MONTH_CAP_USD = 20;
export const DEFAULT_MAX_NAMES = 80;
export const OPTIONS_CACHE_DIR = path.join(ENGINE_ROOT, ".cache", "options");

export type OptionsJobOptions = {
  client?: DatabentoClient;
  /** Yahoo daily closes (beta, fallback spot); without it no beta, so no market-adjusted numbers. */
  market: MarketData | null;
  /** The run's liquidity gate (quality.ts); without it every US ticker is tried. */
  liquidity?: ((ticker: string) => Promise<Liquidity | null>) | null;
  /** The options store (Supabase options_daily): read before pulling, written after (not in price-only mode). */
  store?: OptionsStore | null;
  log?: (line: string) => void;
  nowMs?: number;
  runCapUsd?: number;
  monthCapUsd?: number;
  maxNames?: number;
  /** Only price the pulls (get_cost): no ledger line, no data, no blocks. */
  priceOnly?: boolean;
  cacheDir?: string;
};

export type OptionsJobSummary = {
  snapshot: string | null;
  wanted: number;
  priced: number;
  reused: number;
  skipped: Array<{ ticker: string; why: string }>;
  /** Charged to the ledger this run. */
  spendUsd: number;
  /** get_cost estimates of this run's pulls (also in price-only mode). */
  pricedUsd: number;
  monthUsd: number;
  runCapUsd: number;
  monthCapUsd: number;
  /** Why the job stopped early or did not run (a cap, no key, no session, a Databento account refusal). */
  stopped: string | null;
  line: string;
};

/** Positive number from the environment, else the default. */
export function capFromEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  const v = raw ? Number(raw) : NaN;
  return Number.isFinite(v) && v >= 0 ? v : fallback;
}

/** Tickers to price, in feed order: each card's event company, then its hits; deduplicated, US listings only. Pure. */
export function optionTickers(cards: readonly RippleCard[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string) => {
    const s = t.trim().toUpperCase();
    if (!US_TICKER.test(s) || seen.has(s)) return;
    seen.add(s);
    out.push(s);
  };
  for (const c of cards) {
    add(c.event.ticker);
    for (const h of c.hits) add(h.ticker);
  }
  return out;
}

/** Ledger lines of the Sightings options job in the calendar month (UTC) of `nowMs`. */
export function monthMatcher(nowMs: number): (e: SpendEntry) => boolean {
  const month = new Date(nowMs).toISOString().slice(0, 7);
  return (e) => e.caller.startsWith(CALLER_PREFIX) && e.at.slice(0, 7) === month;
}

function cacheFile(dir: string, date: string, minute: number): string {
  return path.join(dir, `snapshot-${date}-${String(Math.floor(minute / 60)).padStart(2, "0")}${String(minute % 60).padStart(2, "0")}.json`);
}

function readCache(file: string): Record<string, KnownEntry> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, KnownEntry>;
  } catch {
    return {};
  }
}

function writeCache(dir: string, file: string, data: Record<string, KnownEntry>, keepDays = 10, nowMs = Date.now()): void {
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
  // Old snapshots are never read again.
  for (const f of fs.readdirSync(dir)) {
    const m = /^snapshot-(\d{4}-\d{2}-\d{2})-\d{4}\.json$/.exec(f);
    if (m && Date.parse(m[1]!) < nowMs - keepDays * 86_400_000) fs.rmSync(path.join(dir, f), { force: true });
  }
}

const usd = (x: number) => `$${x.toFixed(2)}`;
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***").slice(0, 160);

/**
 * Prices the chains of the tickers on `cards` and writes the options blocks
 * onto them in place (card.options for the event company, hit.options for
 * each hit, with the matched comparison against the hit's record). Never
 * throws for data, budget or account problems: those end in the summary.
 */
export async function attachOptions(cards: RippleCard[], opts: OptionsJobOptions): Promise<OptionsJobSummary> {
  const log = opts.log ?? (() => undefined);
  const nowMs = opts.nowMs ?? Date.now();
  const runCapUsd = opts.runCapUsd ?? capFromEnv("OPTIONS_RUN_CAP_USD", DEFAULT_RUN_CAP_USD);
  const monthCapUsd = opts.monthCapUsd ?? capFromEnv("OPTIONS_MONTH_CAP_USD", DEFAULT_MONTH_CAP_USD);
  const maxNames = Math.floor(opts.maxNames ?? capFromEnv("OPTIONS_MAX_NAMES", DEFAULT_MAX_NAMES));
  const dir = opts.cacheDir ?? OPTIONS_CACHE_DIR;
  const summary: OptionsJobSummary = {
    snapshot: null,
    wanted: 0,
    priced: 0,
    reused: 0,
    skipped: [],
    spendUsd: 0,
    pricedUsd: 0,
    monthUsd: 0,
    runCapUsd,
    monthCapUsd,
    stopped: null,
    line: "",
  };
  let ledgerOf: (() => SpendEntry[]) | null = null;
  let runCaller = "";
  const finish = (): OptionsJobSummary => {
    if (ledgerOf) {
      const all = ledgerOf();
      summary.spendUsd = all.filter((e) => e.caller === runCaller).reduce((s, e) => s + e.costUsd, 0);
      summary.monthUsd = all.filter(monthMatcher(nowMs)).reduce((s, e) => s + e.costUsd, 0);
    }
    summary.line = summaryLine(summary, opts.priceOnly === true);
    return summary;
  };

  if (!opts.client && !env("DATABENTO_API_KEY")) {
    summary.stopped = "DATABENTO_API_KEY is not set";
    return finish();
  }
  const client = opts.client ?? new DatabentoClient();
  const inMonth = monthMatcher(nowMs);
  const caller = `${CALLER_PREFIX}@${new Date(nowMs).toISOString().slice(0, 16)}Z`;
  ledgerOf = () => client.guard.entries();
  runCaller = caller;
  summary.monthUsd = client.guard.entries().filter(inMonth).reduce((s, e) => s + e.costUsd, 0);

  // Which names: the cards' tickers, liquid only, at most maxNames.
  let tickers = optionTickers(cards);
  if (opts.liquidity) {
    const kept: string[] = [];
    for (const t of tickers) {
      const l = await opts.liquidity(t).catch(() => null);
      if (isLiquid(l)) kept.push(t);
      else summary.skipped.push({ ticker: t, why: "not liquid" });
    }
    tickers = kept;
  }
  for (const t of tickers.slice(maxNames)) summary.skipped.push({ ticker: t, why: `over ${maxNames} names` });
  tickers = tickers.slice(0, maxNames);
  summary.wanted = tickers.length;
  if (!tickers.length) return finish();

  // Which snapshot.
  const snap = await resolveSnapshot(client, nowMs, log);
  if (!snap) {
    summary.stopped = "no session snapshot available";
    return finish();
  }
  summary.snapshot = snap.label;

  // Known already: this snapshot's file cache, then the store (the daily universe job's rows).
  const file = cacheFile(dir, snap.date, snap.minute);
  const cache = readCache(file);
  const known = new Map<string, KnownEntry>();
  for (const t of tickers) if (cache[t]) known.set(t, cache[t]!);
  const unknown = tickers.filter((t) => !known.has(t));
  if (opts.store && unknown.length) {
    try {
      for (const [t, e] of await opts.store.known(snap.date, unknown)) known.set(t, e);
    } catch (err) {
      log(`options: store unavailable (${errText(err)}); pricing without it`);
    }
  }

  // Caps: the run's own caller, and every Sightings options caller this month.
  const caps: SpendCap[] = [{ label: `the Sightings options monthly cap (${new Date(nowMs).toISOString().slice(0, 7)})`, limitUsd: monthCapUsd, match: inMonth }];
  const pull: PullOptions = { caller, maxCallUsd: runCapUsd, maxCallerUsd: runCapUsd, caps, dryRun: opts.priceOnly === true };
  let names = tickers;
  if (summary.monthUsd >= monthCapUsd && tickers.some((t) => !known.has(t))) {
    summary.stopped = `monthly cap reached (${usd(summary.monthUsd)} of ${usd(monthCapUsd)})`;
    for (const t of tickers) if (!known.has(t)) summary.skipped.push({ ticker: t, why: "monthly cap" });
    names = tickers.filter((t) => known.has(t));
  }

  const store = opts.store && !opts.priceOnly ? opts.store : null;
  const out = await priceChains(names, {
    client,
    market: opts.market,
    log,
    pull,
    snapshot: snap,
    known,
    onBatch: store
      ? async (entries) => {
          await store.save(snap.date, entries, "sightings");
        }
      : undefined,
  });
  summary.reused = out.reused;
  summary.priced = out.priced;
  summary.pricedUsd = out.pricedUsd;
  summary.skipped.push(...out.skipped);
  if (out.stopped) summary.stopped = out.stopped;
  if (opts.priceOnly) return finish();

  if (out.fresh.size) {
    for (const [t, e] of out.fresh) cache[t] = e;
    try {
      writeCache(dir, file, cache, 10, nowMs);
    } catch (err) {
      log(`options: could not keep the snapshot cache (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // Blocks onto the cards.
  for (const card of cards) {
    const ev = out.result.get(card.event.ticker);
    if (ev) card.options = optionsBlock(ev);
    for (const h of card.hits) {
      const r = out.result.get(h.ticker);
      if (r) h.options = optionsBlock(r, h.history);
    }
  }
  return finish();
}

/** One summary line: "options: 34 of 41 names priced at 2026-11-13 15:45 ET (...); $0.12 this run (cap $0.75), $1.40 this month (cap $20.00)". Pure. */
export function summaryLine(s: OptionsJobSummary, priceOnly = false): string {
  if (s.stopped && !s.snapshot) return `options: skipped (${s.stopped})`;
  if (!s.wanted) return `options: no names to price${s.skipped.length ? ` (${s.skipped.length} left out: ${reasons(s.skipped)})` : ""}`;
  const have = s.priced + s.reused;
  const head = priceOnly
    ? `options (price only): ${s.wanted} names at ${s.snapshot} would cost ${usd(s.pricedUsd)}`
    : `options: ${have} of ${s.wanted} names priced at ${s.snapshot}${s.reused ? ` (${s.reused} already priced this session)` : ""}`;
  const left = s.skipped.length ? `; left out ${s.skipped.length}: ${reasons(s.skipped)}` : "";
  const stop = s.stopped ? `; stopped: ${s.stopped}` : "";
  return `${head}${left}${stop}; ${usd(s.spendUsd)} this run (cap ${usd(s.runCapUsd)}), ${usd(s.monthUsd)} this month (cap ${usd(s.monthCapUsd)})`;
}

/** "poor chain 3 (A, B, C), not liquid 2 (D, E)": skips grouped by reason. Pure. */
export function reasons(skipped: ReadonlyArray<{ ticker: string; why: string }>): string {
  const by = new Map<string, string[]>();
  for (const x of skipped) {
    const k = x.why.startsWith("poor chain") ? "poor chain" : x.why.startsWith("compute failed") ? "compute failed" : x.why;
    by.set(k, [...(by.get(k) ?? []), x.ticker]);
  }
  return [...by].map(([k, ts]) => `${k} ${ts.length} (${ts.slice(0, 6).join(", ")}${ts.length > 6 ? ", ..." : ""})`).join(", ");
}
