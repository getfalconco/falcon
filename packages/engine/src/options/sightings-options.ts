/**
 * The options data job of a Sightings run: one OPRA cbbo-1m snapshot of each
 * chain on the cards being published, turned into the @falcon/ripple
 * RippleOptions block on the card (event company) and on each hit.
 *
 * What it pulls, per run:
 *   - OPRA.PILLAR cbbo-1m, parent symbology, [snapshot - 5 min, snapshot + 1
 *     min), batches of 15 parents (Databento prices a 10-minute block; about
 *     $0.003 a name). Definitions come from the OSI symbols in the records
 *     (no `definition` pull). No open interest (about $0.035 a name: no GEX).
 *   - XNAS.ITCH ohlcv-1m for the spot at the snapshot (about $0.00001 a name).
 * Free: Databento metadata (get_cost before every pull, the dataset's end),
 * FRED DTB3 and VIXCLS, Yahoo dividends and daily closes (beta, fallback spot).
 *
 * Snapshot: 15:45 New York (12:45 on early-close days) of the latest session
 * whose snapshot is at least 15 minutes old and inside Databento's available
 * range; so the morning runs read the previous session's close and the
 * evening run that day's. A snapshot already computed is reused from
 * `.cache/options/` (kept by the workflow's cache) and costs nothing.
 *
 * Caps: every pull is priced first (`get_cost`) and checked under the ledger
 * lock (cost.ts) against the per-run cap (`runCapUsd`, default $0.75: the
 * run's own caller name) and the monthly cap (`monthCapUsd`, default $20:
 * every `sightings-options` caller this calendar month, UTC). A refused pull
 * stops the job quietly: the names already priced keep their block, the rest
 * get none, and the summary line says so.
 */

import fs from "node:fs";
import path from "node:path";
import type { RippleCard } from "@falcon/ripple";
import { HOUR_MS, ENGINE_ROOT, plainGet } from "../http.ts";
import { env } from "../env.ts";
import type { MarketData } from "../market.ts";
import { isLiquid, type Liquidity } from "../quality.ts";
import { addDays, isNyseEarlyClose, nyInstantMs, nyseSessions } from "../study/abnormal.ts";
import { BudgetError, DatabentoClient, DatabentoError, fetchStockSpot, quotesAt, type PullOptions } from "./client.ts";
import type { SpendCap, SpendEntry } from "./cost.ts";
import { betaFromCloses, chainProblem, latestOnOrBefore, optionsBlock, tickerOptionsFrom, type TickerOptions } from "./cards.ts";
import { dividendYieldOn, fetchDividends, fetchDtb3, parseFredCsv, rateOn } from "./rates.ts";
import { definitionsFromRecords, osiRoot, recordsByRoot } from "./study-options.ts";
import { surfaceFeatures, type SurfaceFeatures } from "./surface.ts";

export const CALLER_PREFIX = "sightings-options";
export const DEFAULT_RUN_CAP_USD = 0.75;
export const DEFAULT_MONTH_CAP_USD = 20;
export const DEFAULT_MAX_NAMES = 80;
const BATCH = 15;
const MIN_SNAPSHOT_AGE_MS = 15 * 60_000;
export const OPTIONS_CACHE_DIR = path.join(ENGINE_ROOT, ".cache", "options");
const VIX_URL = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS";

/** US listed common tickers only (OPRA roots); foreign listings and OTC names have no chain here. */
const US_TICKER = /^[A-Z]{1,5}$|^[A-Z]{1,4}\.[A-Z]$/;

export type OptionsJobOptions = {
  client?: DatabentoClient;
  /** Yahoo daily closes (beta, fallback spot); without it no beta, so no market-adjusted numbers. */
  market: MarketData | null;
  /** The run's liquidity gate (quality.ts); without it every US ticker is tried. */
  liquidity?: ((ticker: string) => Promise<Liquidity | null>) | null;
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
  /** Why the job stopped early or did not run (a cap, no key, no session). */
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

/** New York snapshot minute of a session: 15:45, or 12:45 on an early-close day. */
export function snapshotMinute(date: string): number {
  return isNyseEarlyClose(date) ? 12 * 60 + 45 : 15 * 60 + 45;
}

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

/** Ledger lines of the Sightings options job in the calendar month (UTC) of `nowMs`. */
export function monthMatcher(nowMs: number): (e: SpendEntry) => boolean {
  const month = new Date(nowMs).toISOString().slice(0, 7);
  return (e) => e.caller.startsWith(CALLER_PREFIX) && e.at.slice(0, 7) === month;
}

type CacheEntry = TickerOptions | { skip: string };

function cacheFile(dir: string, date: string, minute: number): string {
  return path.join(dir, `snapshot-${date}-${String(Math.floor(minute / 60)).padStart(2, "0")}${String(minute % 60).padStart(2, "0")}.json`);
}

function readCache(file: string): Record<string, CacheEntry> {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, CacheEntry>;
  } catch {
    return {};
  }
}

function writeCache(dir: string, file: string, data: Record<string, CacheEntry>, keepDays = 10, nowMs = Date.now()): void {
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

function nyIso(date: string, minutes: number): string {
  return new Date(nyInstantMs(date, minutes)).toISOString();
}

const usd = (x: number) => `$${x.toFixed(2)}`;

/**
 * Prices the chains of the tickers on `cards` and writes the options blocks
 * onto them in place (card.options for the event company, hit.options for
 * each hit, with the matched comparison against the hit's record). Never
 * throws for data or budget problems: those end in the summary.
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
  let availableEndMs: number | null = null;
  try {
    const range = await client.getDatasetRange("OPRA.PILLAR");
    const end = range.schema?.["cbbo-1m"]?.end ?? range.end;
    const ms = Date.parse(end);
    availableEndMs = Number.isFinite(ms) ? ms : null;
  } catch (err) {
    log(`options: dataset range unavailable (${err instanceof Error ? err.message.slice(0, 120) : String(err)}); assuming the latest session is there`);
  }
  const snap = pickSnapshot(nowMs, availableEndMs);
  if (!snap) {
    summary.stopped = "no session snapshot available";
    return finish();
  }
  const { date, minute, asOfMs } = snap;
  summary.snapshot = `${date} ${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")} ET`;

  const file = cacheFile(dir, date, minute);
  const cache = readCache(file);
  const result = new Map<string, TickerOptions>();
  const todo: string[] = [];
  for (const t of tickers) {
    const c = cache[t];
    if (!c) todo.push(t);
    else if ("skip" in c) summary.skipped.push({ ticker: t, why: c.skip });
    else {
      result.set(t, c);
      summary.reused++;
    }
  }

  // Caps: the run's own caller, and every Sightings options caller this month.
  const caps: SpendCap[] = [{ label: `the Sightings options monthly cap (${new Date(nowMs).toISOString().slice(0, 7)})`, limitUsd: monthCapUsd, match: inMonth }];
  const pull: PullOptions = { caller, maxCallUsd: runCapUsd, maxCallerUsd: runCapUsd, caps, dryRun: opts.priceOnly === true };
  if (todo.length && summary.monthUsd >= monthCapUsd) {
    summary.stopped = `monthly cap reached (${usd(summary.monthUsd)} of ${usd(monthCapUsd)})`;
    for (const t of todo) summary.skipped.push({ ticker: t, why: "monthly cap" });
    todo.length = 0;
  }

  // Quotes, in batches; a refused pull (a cap) stops the pulls quietly.
  const recs = new Map<string, Array<Record<string, unknown>>>();
  const pulled = new Set<string>();
  const quoteReq = (names: string[]) => ({
    dataset: "OPRA.PILLAR",
    schema: "cbbo-1m",
    symbols: names.map((t) => `${osiRoot(t)}.OPT`),
    stype_in: "parent" as const,
    start: nyIso(date, minute - 5),
    end: nyIso(date, minute + 1),
  });
  const pullBatch = async (names: string[]): Promise<void> => {
    const res = await client.getRange<Record<string, unknown>>(quoteReq(names), pull);
    summary.pricedUsd += res.pricedUsd;
    if (res.partial) log(`options: partial answer for ${names.join(",")}${res.warning ? ` (${res.warning})` : ""}`);
    for (const [root, rs] of recordsByRoot(res.records)) recs.set(root, rs);
    for (const n of names) pulled.add(n);
  };
  for (let b = 0; b < todo.length && !summary.stopped; b += BATCH) {
    const names = todo.slice(b, b + BATCH);
    try {
      await pullBatch(names);
    } catch (err) {
      if (err instanceof BudgetError) {
        summary.stopped = `cap reached: ${err.message}`;
        log(`options: ${summary.stopped}`);
        break;
      }
      // One unknown parent can fail a batch: try the names one by one.
      log(`options: batch ${names[0]}..${names[names.length - 1]} failed (${err instanceof Error ? err.message.slice(0, 160) : String(err)}); one by one`);
      for (const n of names) {
        try {
          await pullBatch([n]);
        } catch (e2) {
          if (e2 instanceof BudgetError) {
            summary.stopped = `cap reached: ${e2.message}`;
            log(`options: ${summary.stopped}`);
            break;
          }
          summary.skipped.push({ ticker: n, why: e2 instanceof DatabentoError ? `Databento HTTP ${e2.status}` : "pull failed" });
        }
      }
    }
  }
  for (const t of todo) if (!pulled.has(t) && !summary.skipped.some((s) => s.ticker === t)) summary.skipped.push({ ticker: t, why: summary.stopped ? "cap" : "not pulled" });

  if (opts.priceOnly) return finish();

  const toCompute: string[] = [];
  for (const t of todo) {
    if (!pulled.has(t)) continue;
    if (recs.get(osiRoot(t))?.length) toCompute.push(t);
    else {
      cache[t] = { skip: "no quotes at the snapshot" };
      summary.skipped.push({ ticker: t, why: "no quotes at the snapshot" });
    }
  }
  if (toCompute.length) {
    // Spot: ITCH 1-minute bar ending at the snapshot; failures fall back to Yahoo's close / the parity spot.
    const spots = new Map<string, number>();
    for (let b = 0; b < toCompute.length && !summary.stopped; b += 50) {
      const chunk = toCompute.slice(b, b + 50);
      try {
        const m = await fetchStockSpot(client, { symbols: chunk, date, snapshotMin: minute, pull });
        for (const [k, v] of m) spots.set(k, v);
      } catch (err) {
        if (err instanceof BudgetError) log(`options: spot pull refused (${err.message}); Yahoo close / parity spot used`);
        else log(`options: ITCH spot unavailable for ${chunk.length} names (${err instanceof Error ? err.message.slice(0, 100) : String(err)}); Yahoo close / parity spot used`);
      }
    }

    const rate = await fetchDtb3()
      .then((p) => rateOn(p, date))
      .catch(() => null);
    const vixPct = await plainGet(VIX_URL, { maxAgeMs: 12 * HOUR_MS, staleOk: true })
      .then((t) => latestOnOrBefore(parseFredCsv(t), date))
      .catch(() => null);
    const vix = vixPct === null ? null : vixPct / 100;
    const from = addDays(date, -420);
    const spy = opts.market ? await opts.market.dailyCloses("SPY", from, date).catch(() => []) : [];

    for (const t of toCompute) {
      const rs = recs.get(osiRoot(t));
      if (!rs?.length) {
        cache[t] = { skip: "no quotes at the snapshot" };
        summary.skipped.push({ ticker: t, why: "no quotes at the snapshot" });
        continue;
      }
      const closes = opts.market ? await opts.market.dailyCloses(t, from, date).catch(() => []) : [];
      const last = closes.length ? closes[closes.length - 1]! : null;
      const close = last && last.date === date ? last.rawClose ?? last.close : null;
      const q = await fetchDividends(t)
        .then((h) => dividendYieldOn(h, date) ?? 0)
        .catch(() => 0);
      const defsAll = definitionsFromRecords(rs, t);
      const quotes = quotesAt(rs as never, asOfMs);
      const run = (spot: number): SurfaceFeatures => {
        const defs = defsAll.filter((d) => d.strike / spot >= 0.7 && d.strike / spot <= 1.3 && (Date.parse(d.expiration) - Date.parse(date)) / 86_400_000 <= 400);
        return surfaceFeatures({ underlying: t, date, asOfMs, spot, rate: rate ?? 0.04, divYield: q, definitions: defs, quotes, moveDates: [] });
      };
      let spot = spots.get(t) ?? null;
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
      if (!f || spot === null) {
        cache[t] = { skip: "no spot" };
        summary.skipped.push({ ticker: t, why: "no spot" });
        continue;
      }
      const problem = chainProblem(f);
      if (problem) {
        cache[t] = { skip: `poor chain: ${problem}` };
        summary.skipped.push({ ticker: t, why: `poor chain: ${problem}` });
        continue;
      }
      const beta = spy.length && closes.length ? betaFromCloses(closes, spy, date) : null;
      const rec = tickerOptionsFrom(f, { ticker: t, spotSource, beta, vix });
      cache[t] = rec;
      result.set(t, rec);
      summary.priced++;
    }
  }
  if (pulled.size) {
    try {
      writeCache(dir, file, cache, 10, nowMs);
    } catch (err) {
      log(`options: could not keep the snapshot cache (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  // Blocks onto the cards.
  for (const card of cards) {
    const ev = result.get(card.event.ticker);
    if (ev) card.options = optionsBlock(ev);
    for (const h of card.hits) {
      const r = result.get(h.ticker);
      if (r) h.options = optionsBlock(r, h.history);
    }
  }
  return finish();
}

/** One summary line: "options: 34 of 41 names priced at 2026-11-13 15:45 ET (...); $0.12 this run (cap $0.75), $1.40 this month (cap $20.00)". Pure. */
export function summaryLine(s: OptionsJobSummary, priceOnly = false): string {
  if (s.stopped && !s.snapshot) return `options: skipped (${s.stopped})`;
  if (!s.wanted) return `options: no names to price${s.skipped.length ? ` (${s.skipped.length} left out: ${reasons(s)})` : ""}`;
  const have = s.priced + s.reused;
  const head = priceOnly
    ? `options (price only): ${s.wanted} names at ${s.snapshot} would cost ${usd(s.pricedUsd)}`
    : `options: ${have} of ${s.wanted} names priced at ${s.snapshot}${s.reused ? ` (${s.reused} from this snapshot's cache)` : ""}`;
  const left = s.skipped.length ? `; left out ${s.skipped.length}: ${reasons(s)}` : "";
  const stop = s.stopped ? `; stopped: ${s.stopped}` : "";
  return `${head}${left}${stop}; ${usd(s.spendUsd)} this run (cap ${usd(s.runCapUsd)}), ${usd(s.monthUsd)} this month (cap ${usd(s.monthCapUsd)})`;
}

function reasons(s: OptionsJobSummary): string {
  const by = new Map<string, string[]>();
  for (const x of s.skipped) {
    const k = x.why.startsWith("poor chain") ? "poor chain" : x.why;
    by.set(k, [...(by.get(k) ?? []), x.ticker]);
  }
  return [...by].map(([k, ts]) => `${k} ${ts.length} (${ts.slice(0, 6).join(", ")}${ts.length > 6 ? ", ..." : ""})`).join(", ");
}
