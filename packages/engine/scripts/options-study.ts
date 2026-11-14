/**
 * Options hypotheses 4-7: pulls, features and tests.
 * Pre-registration: data/preregistration/options-v1.json. Write-up: docs/options-study.md.
 *
 *   node --import tsx scripts/options-study.ts <phase> [--dry-run] [--concurrency 3]
 *
 * Phases (each resumes from its cache under packages/engine/.cache/options-study):
 *   prices   Yahoo daily charts for the universe and SPY (yahoo/<T>.json)
 *   events   H7 events: 8-K 2.02 earnings (sign from the Yahoo EPS record) and
 *            Taiwan monthly revenue, with public instants (h7-events.json)
 *   panel    month-end snapshots 2013-06..2026-10 (H4, H5, H6): plan, price
 *            (--dry-run stops there), pull, surface features (panel.ndjson)
 *   h7       hit snapshots after each H7 event: plan, price, pull, features
 *            (h7-snapshots.ndjson)
 *   analyze  outcomes and tests (results.json, results.md)
 *
 * Every Databento pull goes through DatabentoClient.getRange with caller
 * "options-hypotheses" and a $50 per-caller cap; the shared $90 total is the
 * guard's. Already cached requests cost nothing.
 */

import fs from "node:fs";
import path from "node:path";
import { DatabentoClient, BudgetError, fetchStockSpot, parseOhlcv, quotesAt, volumeByInstrument, type PullOptions } from "../src/options/client.ts";
import { dividendYieldOn, fetchDtb3, parseFredCsv, rateOn, type DividendHistory, type RatePoint } from "../src/options/rates.ts";
import { surfaceFeatures, type SurfaceFeatures } from "../src/options/surface.ts";
import {
  alignBars,
  benjaminiHochberg,
  definitionsFromRecords,
  impliedAbsMovePct,
  monthEndSessions,
  osiRoot,
  perNameCorrelations,
  recordsByRoot,
  snapshotIndexAfter,
  sortSpreads,
  summarizeH7,
  summarizeSort,
  trailingChange,
  trailingMedian,
  type AlignedSeries,
  type H7Pair,
  type H7Summary,
  type PanelRow,
  type SpreadSummary,
  type YahooBars,
} from "../src/options/study-options.ts";
import { isNyseEarlyClose, measureEvent, nyInstantMs, nyseSessions, type PriceSeries } from "../src/study/abnormal.ts";
import { ENGINE_ROOT, HOUR_MS, plainGet } from "../src/http.ts";
import { sectorTickers } from "../src/universe.ts";
import { loadGraph, walk } from "../src/graph.ts";
import { edgarPastEvents, type PastEvent } from "../src/past-events.ts";
import { backtestMarketData } from "../src/market.ts";
import { matchQuarters, HISTORY_MIN_SAMPLE } from "../src/history.ts";

// ---------------------------------------------------------------------------
// Settings (mirror the pre-registration)

const CALLER = "options-hypotheses";
const PULL_BASE = { caller: CALLER, maxCallUsd: 1, maxCallerUsd: 50 };
const DIR = path.join(ENGINE_ROOT, ".cache", "options-study");
const YAHOO_DIR = path.join(DIR, "yahoo");
const PANEL_FILE = path.join(DIR, "panel.ndjson");
const EVENTS_FILE = path.join(DIR, "h7-events.json");
const H7_FILE = path.join(DIR, "h7-snapshots.ndjson");
const PRICE_FROM = "2012-01-03";
const DATA_TO = "2026-11-13";
const SESSIONS = nyseSessions(PRICE_FROM, "2027-03-31");
const SESSION_INDEX = new Map(SESSIONS.map((d, i) => [d, i]));
const PANEL_FROM = "2013-06";
const PANEL_TO = "2026-10";
const ITCH_FROM = "2018-05-01";
const OTC = new Set(["HNHPF", "HXSCL", "IFNNY"]);
const TAIWAN_MONTHLY = new Set(["TSM", "UMC", "ASX"]);
const H6_EXCLUDE_TOP = 15;
const BATCH = 15;
const H7_FROM = "2023-01-01";
const H7_TO = "2026-11-05";
const HISTORY_YEARS = 5;
const MIN_PRIOR_SESSIONS = 150;

const args = process.argv.slice(2);
const phase = args[0];
const DRY = args.includes("--dry-run");
const conc = Number(args[args.indexOf("--concurrency") + 1]) || 3;
const pull: PullOptions = { ...PULL_BASE, dryRun: DRY };

function log(s: string): void {
  console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function pool<T>(items: readonly T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  let stop: unknown = null;
  await Promise.all(
    Array.from({ length: Math.max(1, n) }, async () => {
      while (i < items.length && !stop) {
        const k = i++;
        try {
          await fn(items[k]!, k);
        } catch (err) {
          if (err instanceof BudgetError) stop = err;
          else throw err;
        }
      }
    }),
  );
  if (stop) throw stop;
}

function universe(): string[] {
  const g = loadGraph();
  const set = new Set(sectorTickers("semis"));
  for (const e of g.edges) {
    set.add(e.from);
    if (e.to) set.add(e.to);
  }
  return [...set].filter((t) => !OTC.has(t)).sort();
}

function snapMin(d: string): number {
  return isNyseEarlyClose(d) ? 12 * 60 + 45 : 15 * 60 + 45;
}
function snapMs(d: string): number {
  return nyInstantMs(d, snapMin(d));
}
function nyIso(d: string, m: number): string {
  return new Date(nyInstantMs(d, m)).toISOString();
}
function nextDay(d: string): string {
  return new Date(Date.parse(`${d}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Yahoo

type YahooFile = YahooBars & { divs: Array<{ date: string; amount: number }>; status: number };

function yahooPath(t: string): string {
  return path.join(YAHOO_DIR, `${t.replace(/[^A-Z0-9.-]/g, "_")}.json`);
}

async function fetchYahoo(ticker: string): Promise<void> {
  const f = yahooPath(ticker);
  if (fs.existsSync(f)) return;
  const p1 = Math.floor(Date.parse(`${PRICE_FROM}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse("2026-11-15T00:00:00Z") / 1000);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker.replace(/\./g, "-"))}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
  let status = 0;
  let body = "";
  for (let k = 0, wait = 2000; k < 5; k++, wait *= 2) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(30_000) });
      status = res.status;
      body = await res.text();
      if (status === 429 || status >= 500) {
        await sleep(Math.max(wait, status === 429 ? 20_000 : 0));
        continue;
      }
      break;
    } catch {
      await sleep(wait);
    }
  }
  if (status === 0) return;
  const out: YahooFile = { d: [], o: [], c: [], a: [], v: [], splits: [], divs: [], status };
  if (status === 200) {
    type Chart = {
      chart?: {
        result?: Array<{
          meta?: { gmtoffset?: number };
          timestamp?: number[];
          events?: { splits?: Record<string, { date: number; numerator: number; denominator: number }>; dividends?: Record<string, { date: number; amount: number }> };
          indicators?: { quote?: Array<{ open?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }>; adjclose?: Array<{ adjclose?: (number | null)[] }> };
        }>;
      };
    };
    const res = (JSON.parse(body) as Chart).chart?.result?.[0];
    const ts = res?.timestamp ?? [];
    const q = res?.indicators?.quote?.[0];
    const adj = res?.indicators?.adjclose?.[0]?.adjclose;
    const off = res?.meta?.gmtoffset ?? -5 * 3600;
    const good = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
    const day = (sec: number) => new Date((sec + off) * 1000).toISOString().slice(0, 10);
    for (let i = 0; i < ts.length; i++) {
      const o = q?.open?.[i];
      const c = q?.close?.[i];
      const a = adj?.[i];
      if (!good(o) || !good(c)) continue;
      const d = day(ts[i]!);
      if (out.d.length && out.d[out.d.length - 1] === d) continue;
      out.d.push(d);
      out.o.push(o);
      out.c.push(c);
      out.a.push(good(a) ? a : c);
      out.v.push(q?.volume?.[i] ?? 0);
    }
    for (const s of Object.values(res?.events?.splits ?? {})) if (s.numerator > 0 && s.denominator > 0) out.splits.push({ date: day(s.date), ratio: s.numerator / s.denominator });
    for (const v of Object.values(res?.events?.dividends ?? {})) if (v.amount > 0) out.divs.push({ date: day(v.date), amount: v.amount });
    out.divs.sort((a, b) => (a.date < b.date ? -1 : 1));
  }
  fs.mkdirSync(YAHOO_DIR, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(out));
}

const yahooMemo = new Map<string, YahooFile | null>();
function readYahoo(t: string): YahooFile | null {
  if (yahooMemo.has(t)) return yahooMemo.get(t)!;
  let y: YahooFile | null = null;
  try {
    y = JSON.parse(fs.readFileSync(yahooPath(t), "utf8")) as YahooFile;
    if (y.status !== 200 || y.d.length < 30) y = null;
  } catch {
    y = null;
  }
  yahooMemo.set(t, y);
  return y;
}

const seriesMemo = new Map<string, AlignedSeries | null>();
function series(t: string): AlignedSeries | null {
  if (seriesMemo.has(t)) return seriesMemo.get(t)!;
  const y = readYahoo(t);
  const s = y ? alignBars(y, SESSIONS) : null;
  seriesMemo.set(t, s);
  return s;
}

function dividends(t: string): DividendHistory {
  const y = readYahoo(t);
  if (!y) return { dividends: [], closes: new Map() };
  return { dividends: y.divs, closes: new Map(y.d.map((d, i) => [d, y.c[i]!])) };
}

/** Eligible on session i: a bar that day, >= 150 prior sessions with prices, unadjusted close >= $5. */
function eligible(t: string, i: number): boolean {
  const s = series(t);
  if (!s || !(s.close[i]! > 0) || !(s.rawClose[i]! >= 5)) return false;
  let n = 0;
  for (let k = Math.max(0, i - 260); k < i; k++) if (s.close[k]! > 0) n++;
  return n >= MIN_PRIOR_SESSIONS;
}

async function phasePrices(): Promise<void> {
  const tickers = [...universe(), "SPY"];
  const todo = tickers.filter((t) => !fs.existsSync(yahooPath(t)));
  log(`prices: ${tickers.length} tickers, ${todo.length} to fetch`);
  for (const t of todo) {
    await fetchYahoo(t);
    await sleep(300);
  }
  const bad = tickers.filter((t) => !readYahoo(t));
  log(`prices: done; no usable history for ${bad.join(", ") || "none"}`);
}

// ---------------------------------------------------------------------------
// Rates and VIX

let rates: RatePoint[] | null = null;
let vix: RatePoint[] | null = null;
async function loadRates(): Promise<void> {
  if (!rates) rates = await fetchDtb3();
  if (!vix) vix = parseFredCsv(await plainGet("https://fred.stlouisfed.org/graph/fredgraph.csv?id=VIXCLS", { maxAgeMs: 12 * HOUR_MS, staleOk: true }));
}
function latestOnOrBefore(points: readonly RatePoint[], d: string): number | null {
  let best: RatePoint | null = null;
  for (const p of points) {
    if (p.date > d) break;
    best = p;
  }
  return best && Date.parse(d) - Date.parse(best.date) <= 10 * 86_400_000 ? best.pct : null;
}

// ---------------------------------------------------------------------------
// One snapshot (a set of names on one date): pull and features

type NameFeatures = {
  date: string;
  ticker: string;
  spot: number;
  spotSource: "itch" | "parity" | "close";
  rate: number;
  q: number;
  contracts: number;
  withIv: number;
  atmIv30: number | null;
  skew: number | null;
  skewMean: number | null;
  cw: number | null;
  cwPairs: number;
  optionVolume: number | null;
  stockVolume: number | null;
  oToS: number | null;
  expiries: Array<{ e: string; days: number; iv: number | null }>;
  warnings: string[];
};

type SnapshotPlan = { date: string; names: string[]; volumeNames: string[] };

async function pullSnapshot(client: DatabentoClient, plan: SnapshotPlan): Promise<{ priced: number; charged: number; features: NameFeatures[] }> {
  const { date } = plan;
  const sm = snapMin(date);
  let priced = 0;
  let charged = 0;
  const cbbo = new Map<string, Array<Record<string, unknown>>>();
  for (let b = 0; b < plan.names.length; b += BATCH) {
    const names = plan.names.slice(b, b + BATCH);
    const res = await client.getRange<Record<string, unknown>>(
      { dataset: "OPRA.PILLAR", schema: "cbbo-1m", symbols: names.map((t) => `${osiRoot(t)}.OPT`), stype_in: "parent", start: nyIso(date, sm - 5), end: nyIso(date, sm + 1) },
      pull,
    );
    priced += res.pricedUsd;
    charged += res.costUsd;
    for (const [root, recs] of recordsByRoot(res.records)) cbbo.set(root, recs);
  }
  const vol = new Map<string, Map<number, number>>();
  for (let b = 0; b < plan.volumeNames.length; b += BATCH) {
    const names = plan.volumeNames.slice(b, b + BATCH);
    const res = await client.getRange<Record<string, unknown>>(
      { dataset: "OPRA.PILLAR", schema: "ohlcv-1d", symbols: names.map((t) => `${osiRoot(t)}.OPT`), stype_in: "parent", start: date, end: nextDay(date) },
      pull,
    );
    priced += res.pricedUsd;
    charged += res.costUsd;
    for (const [root, recs] of recordsByRoot(res.records)) vol.set(root, volumeByInstrument(parseOhlcv(recs as never)));
  }
  let spots = new Map<string, number>();
  if (date >= ITCH_FROM) {
    // ITCH 1-minute bars cost ~$0.00001 a name; fetchStockSpot does not report its charge, so it is
    // left out of the per-snapshot figures (the ledger by caller, printed at the end, has it).
    // client.ts accepts only HTTP 200; Databento sometimes answers these with 206 (Partial Content),
    // which throws. Retry in chunks of 10; a chunk that still fails falls back to the parity spot.
    const spotChunk = async (symbols: string[]) => {
      const m = await fetchStockSpot(client, { symbols, date, snapshotMin: sm, pull });
      for (const [k, v] of m) spots.set(k, v);
    };
    for (let b = 0; b < plan.names.length; b += 50) {
      const chunk = plan.names.slice(b, b + 50);
      try {
        await spotChunk(chunk);
      } catch (err) {
        if (err instanceof BudgetError) throw err;
        for (let c = 0; c < chunk.length; c += 10) {
          try {
            await spotChunk(chunk.slice(c, c + 10));
          } catch (e2) {
            if (e2 instanceof BudgetError) throw e2;
            log(`${date}: ITCH spot unavailable for ${chunk.slice(c, c + 10).join(",")} (${e2 instanceof Error ? e2.message.slice(0, 60) : ""}); parity spot used`);
          }
        }
      }
    }
  }
  if (DRY) return { priced, charged, features: [] };
  await loadRates();
  const i = SESSION_INDEX.get(date)!;
  const rate = rateOn(rates!, date) ?? 0.02;
  const features: NameFeatures[] = [];
  for (const t of plan.names) {
    const recs = cbbo.get(osiRoot(t));
    const s = series(t)!;
    if (!recs?.length) continue;
    const asOfMs = nyInstantMs(date, sm);
    const allDefs = definitionsFromRecords(recs, t);
    const quotes = quotesAt(recs as never, asOfMs);
    const close = s.rawClose[i]!;
    const q = dividendYieldOn(dividends(t), date) ?? 0;
    const volume = vol.get(osiRoot(t));
    const stockVolume = s.rawVolume[i]! > 0 ? s.rawVolume[i]! : undefined;
    const run = (spot: number): SurfaceFeatures => {
      const defs = allDefs.filter((d) => d.strike / spot >= 0.7 && d.strike / spot <= 1.3 && (Date.parse(d.expiration) - Date.parse(date)) / 86_400_000 <= 400);
      return surfaceFeatures({ underlying: t, date, asOfMs, spot, rate, divYield: q, definitions: defs, quotes, volume, stockVolume, moveDates: [] });
    };
    let spot = spots.get(t) ?? null;
    let spotSource: NameFeatures["spotSource"] = "itch";
    let f: SurfaceFeatures;
    if (spot && Math.abs(spot / close - 1) < 0.15) f = run(spot);
    else {
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
    // Option volume counts every contract of the standard root, not only those in the moneyness band.
    const optionVolume = volume ? [...volume.values()].reduce((a, b) => a + b, 0) : null;
    features.push({
      date,
      ticker: t,
      spot,
      spotSource,
      rate,
      q,
      contracts: f.quality.contracts,
      withIv: f.quality.withIv,
      atmIv30: f.atmIv30,
      skew: f.skew,
      skewMean: f.skewMean,
      cw: f.callPutSpread,
      cwPairs: f.callPutPairs,
      optionVolume,
      stockVolume: stockVolume ?? null,
      oToS: optionVolume !== null && stockVolume ? optionVolume / (stockVolume / 100) : null,
      expiries: f.expiries.map((e) => ({ e: e.expiration, days: Math.round(e.days * 100) / 100, iv: e.atmIv })),
      warnings: f.quality.warnings,
    });
  }
  return { priced, charged, features };
}

// ---------------------------------------------------------------------------
// Panel (H4, H5, H6)

function h6Names(i: number, names: readonly string[]): string[] {
  const semis = new Set(sectorTickers("semis"));
  const ranked = names
    .filter((t) => semis.has(t))
    .map((t) => ({ t, dv: trailingMedian(series(t)!.dollarVolume, i, 60) ?? 0 }))
    .sort((a, b) => b.dv - a.dv);
  return ranked.slice(H6_EXCLUDE_TOP).map((x) => x.t).sort();
}

function panelPlans(): SnapshotPlan[] {
  const dates = monthEndSessions(SESSIONS.filter((d) => d <= DATA_TO), PANEL_FROM, PANEL_TO);
  const all = universe().filter((t) => readYahoo(t));
  return dates.map((date) => {
    const i = SESSION_INDEX.get(date)!;
    const names = all.filter((t) => eligible(t, i));
    return { date, names, volumeNames: h6Names(i, names) };
  });
}

function doneDates(file: string): Set<string> {
  const out = new Set<string>();
  if (!fs.existsSync(file)) return out;
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    const r = JSON.parse(line) as { date: string; kind?: string };
    if (r.kind === "done") out.add(r.date);
  }
  return out;
}

async function runSnapshots(plans: SnapshotPlan[], file: string, label: string): Promise<void> {
  const client = new DatabentoClient();
  const done = doneDates(file);
  // Newest first: if a budget cap stops the run, what is left is a later-start panel (the pre-registered fallback).
  // `--oldest-first` lets a second process work up from the other end (cached requests are free if they meet).
  const dir = args.includes("--oldest-first") ? -1 : 1;
  const todo = plans.filter((p) => !done.has(p.date)).sort((a, b) => (a.date < b.date ? dir : -dir));
  log(`${label}: ${plans.length} snapshot dates, ${todo.length} to do, ${todo.reduce((s, p) => s + p.names.length, 0)} name-days (${todo.reduce((s, p) => s + p.volumeNames.length, 0)} with volume)${DRY ? " [dry run]" : ""}`);
  log(`ledger before: total $${client.guard.spentUsd().toFixed(4)}, ${CALLER} $${callerSpend(client).toFixed(4)}`);
  let priced = 0;
  let charged = 0;
  let k = 0;
  await pool(todo, conc, async (p) => {
    // A dropped download (the guard refunds it) is retried; cached parts cost nothing again.
    let r: Awaited<ReturnType<typeof pullSnapshot>> | null = null;
    for (let attempt = 1; !r; attempt++) {
      try {
        r = await pullSnapshot(client, p);
      } catch (err) {
        if (err instanceof BudgetError || attempt >= 3) throw err;
        log(`${label} ${p.date}: attempt ${attempt} failed (${err instanceof Error ? err.message.slice(0, 120) : String(err)}), retrying`);
        await sleep(15_000 * attempt);
      }
    }
    priced += r.priced;
    charged += r.charged;
    if (!DRY) {
      const lines = r.features.map((f) => JSON.stringify(f)).join("\n");
      fs.appendFileSync(file, (lines ? lines + "\n" : "") + JSON.stringify({ kind: "done", date: p.date, names: r.features.length }) + "\n");
    }
    k++;
    if (k % 10 === 0 || k === todo.length) log(`${label}: ${k}/${todo.length} dates, priced $${priced.toFixed(4)}, charged $${charged.toFixed(4)}`);
  });
  log(`${label}: ${DRY ? "projected" : "charged"} $${(DRY ? priced : charged).toFixed(4)}; ledger total $${client.guard.spentUsd().toFixed(4)}, ${CALLER} $${callerSpend(client).toFixed(4)}`);
}

function callerSpend(client: DatabentoClient): number {
  return client.guard.entries().filter((e) => e.caller === CALLER).reduce((s, e) => s + e.costUsd, 0);
}

// ---------------------------------------------------------------------------
// H7 events

type StudyEvent = { ticker: string; kind: "earnings" | "monthly_revenue"; accession: string; publicMs: number; sign: -1 | 0 | 1; label?: string };

async function phaseEvents(): Promise<void> {
  const g = loadGraph();
  const uni = new Set(universe());
  const md = await backtestMarketData();
  if ("error" in md) throw new Error(md.error);
  const out: StudyEvent[] = [];
  const since = "2017-06-01";
  for (const t of sectorTickers("semis")) {
    const hits = walk(g, t, 1).map((p) => p.ticker).filter((h) => uni.has(h));
    if (!hits.length) continue;
    const kind = TAIWAN_MONTHLY.has(t) ? "monthly_revenue" : "earnings";
    let past: PastEvent[];
    try {
      past = await edgarPastEvents(t, kind, since, (l) => log(l));
    } catch (err) {
      log(`events ${t}: EDGAR unreadable (${err instanceof Error ? err.message : String(err)})`);
      continue;
    }
    let n = 0;
    if (kind === "earnings") {
      const quarters = await md.market.earnings(t, "2017-05-01", DATA_TO).catch(() => []);
      for (const { event, quarter } of matchQuarters(past, quarters)) {
        if (event.sign === null) continue;
        let pub = Date.parse(event.acceptedAt);
        if (quarter && quarter.time !== "unknown") {
          const m = quarter.time === "before_open" ? 8 * 60 : quarter.time === "during" ? 12 * 60 : 16 * 60 + 5;
          pub = Math.min(pub, nyInstantMs(quarter.date, m));
        }
        out.push({ ticker: t, kind, accession: event.accession, publicMs: pub, sign: event.sign });
        n++;
      }
    } else {
      for (const e of past) {
        if (e.sign === null) continue;
        let pub = Date.parse(e.acceptedAt);
        if (e.releasedOn) pub = Math.min(pub, nyInstantMs(e.releasedOn, 4 * 60));
        out.push({ ticker: t, kind, accession: e.accession, publicMs: pub, sign: e.sign, label: e.label });
        n++;
      }
    }
    log(`events ${t} (${kind}): ${past.length} filings, ${n} signed events, ${hits.length} hits`);
  }
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(EVENTS_FILE, JSON.stringify(out, null, 0));
  log(`events: ${out.length} written`);
}

function loadEvents(): StudyEvent[] {
  return JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8")) as StudyEvent[];
}

const spyMemo: { s: AlignedSeries | null } = { s: null };
function spy(): AlignedSeries {
  if (!spyMemo.s) spyMemo.s = series("SPY")!;
  return spyMemo.s;
}

/** CAR_L (percent) and beta of `t` from the open after the snapshot at session index `si`. */
function carAfterSnapshot(t: string, si: number, L: number): { car: number | null; raw: number | null; beta: number | null } {
  const s = series(t);
  if (!s) return { car: null, raw: null, beta: null };
  const m = measureEvent({ sessions: SESSIONS, stock: s as PriceSeries, market: spy(), publicMs: snapMs(SESSIONS[si]!), windows: [L] });
  if (!m.ok) return { car: null, raw: null, beta: null };
  const d = m.drift[L];
  return { car: d ? d.car * 100 : null, raw: d ? d.raw * 100 : null, beta: m.model.beta };
}

type H7Candidate = { event: StudyEvent; si: number; hit: string; history: Record<number, { mean: number; n: number }> };

/** H7 pairs whose history (>= 6 similar past events) is measurable; no option data needed. */
function h7Candidates(): H7Candidate[] {
  const g = loadGraph();
  const uni = new Set(universe());
  const events = loadEvents();
  const out: H7Candidate[] = [];
  for (const ev of events) {
    const d = new Date(ev.publicMs).toISOString().slice(0, 10);
    if (d < H7_FROM || d > H7_TO) continue;
    const si = snapshotIndexAfter(SESSIONS, ev.publicMs, snapMs);
    if (si === null || SESSIONS[si]! > DATA_TO) continue;
    const similar = events.filter(
      (p) => p.ticker === ev.ticker && p.kind === ev.kind && p.sign === ev.sign && p.publicMs < ev.publicMs && p.publicMs >= ev.publicMs - HISTORY_YEARS * 365.25 * 86_400_000,
    );
    const hits = [...new Set(walk(g, ev.ticker, 1).map((p) => p.ticker))].filter((h) => uni.has(h) && eligible(h, si));
    for (const hit of hits) {
      const history: Record<number, { mean: number; n: number }> = {};
      for (const L of [5, 20]) {
        const abs: number[] = [];
        for (const p of similar) {
          const psi = snapshotIndexAfter(SESSIONS, p.publicMs, snapMs);
          if (psi === null) continue;
          // The past window (entry psi + 1, L sessions) must end before the current snapshot.
          if (psi + L >= si) continue;
          const r = carAfterSnapshot(hit, psi, L);
          if (r.car !== null) abs.push(Math.abs(r.car));
        }
        if (abs.length >= HISTORY_MIN_SAMPLE) history[L] = { mean: abs.reduce((a, b) => a + b, 0) / abs.length, n: abs.length };
      }
      if (history[5] || history[20]) out.push({ event: ev, si, hit, history });
    }
  }
  return out;
}

function h7Plans(cands: readonly H7Candidate[]): SnapshotPlan[] {
  const by = new Map<string, Set<string>>();
  for (const c of cands) {
    const d = SESSIONS[c.si]!;
    if (!by.has(d)) by.set(d, new Set());
    by.get(d)!.add(c.hit);
  }
  return [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, s]) => ({ date, names: [...s].sort(), volumeNames: [] }));
}

// ---------------------------------------------------------------------------
// Analysis

/** Feature rows (progress markers dropped; a date-ticker written twice by two workers counts once). */
function readNdjson<T extends { date: string; ticker: string }>(file: string): T[] {
  if (!fs.existsSync(file)) return [];
  const seen = new Set<string>();
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T & { kind?: string })
    .filter((r) => {
      if (r.kind === "done") return false;
      const k = `${r.date}|${r.ticker}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
}

type TestRow = { id: string; hypothesis: string; primary: boolean; feature: string; L: number; universe: string; summary: SpreadSummary; perName: ReturnType<typeof perNameCorrelations> };

function panelRows(feats: NameFeatures[], h6: boolean): PanelRow[] {
  const plans = new Map(panelPlans().map((p) => [p.date, p]));
  const rows: PanelRow[] = [];
  for (const f of feats) {
    if (h6 && !plans.get(f.date)?.volumeNames.includes(f.ticker)) continue;
    const si = SESSION_INDEX.get(f.date)!;
    const c5 = carAfterSnapshot(f.ticker, si, 5).car;
    const c20 = carAfterSnapshot(f.ticker, si, 20).car;
    rows.push({ date: f.date, ticker: f.ticker, x: { skewMean: f.skewMean, cw: f.cw, os: f.oToS }, y: { car5: c5, car20: c20 } });
  }
  return rows;
}

function demeanedLegMeans(rows: readonly PanelRow[], yk: string, feature: (r: PanelRow) => number | null, sign: 1 | -1): { long: number | null; short: number | null } {
  const res = sortSpreads(rows, { feature, outcome: (r) => r.y[yk] ?? null, sign });
  // Date means over all sorted names (the cross-sectional benchmark).
  const byDate = new Map<string, number[]>();
  for (const r of rows) {
    const x = feature(r);
    const y = r.y[yk];
    if (x === null || y === null || y === undefined || !Number.isFinite(x)) continue;
    if (!byDate.has(r.date)) byDate.set(r.date, []);
    byDate.get(r.date)!.push(y);
  }
  const avg = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const l: number[] = [];
  const s: number[] = [];
  for (const d of res.dates) {
    const m = avg(byDate.get(d.date)!);
    l.push(d.longMean - m);
    s.push(d.shortMean - m);
  }
  return { long: l.length ? avg(l) : null, short: s.length ? avg(s) : null };
}

async function phaseAnalyze(): Promise<void> {
  const feats = readNdjson<NameFeatures>(PANEL_FILE);
  log(`analyze: ${feats.length} panel name-dates`);
  const panel = panelRows(feats, false);
  const h6 = panelRows(feats, true);
  const chg = (rows: PanelRow[], k: string, logRatio = false) => {
    const m = trailingChange(rows, k, 6, 3, logRatio);
    return (r: PanelRow) => m.get(`${r.date}|${r.ticker}`) ?? null;
  };
  const lvl = (k: string) => (r: PanelRow) => r.x[k] ?? null;
  const specs: Array<{ id: string; hypothesis: string; primary: boolean; feature: string; L: number; rows: PanelRow[]; f: (r: PanelRow) => number | null; sign: 1 | -1; universe: string }> = [];
  const skewChg = chg(panel, "skewMean");
  const cwChg = chg(panel, "cw");
  const osChg = chg(h6, "os", true);
  for (const L of [20, 5]) {
    specs.push({ id: `H4-change-L${L}`, hypothesis: "H4", primary: L === 20, feature: "skewMean change vs own trailing mean", L, rows: panel, f: skewChg, sign: -1, universe: "panel" });
    specs.push({ id: `H4-level-L${L}`, hypothesis: "H4", primary: false, feature: "skewMean level", L, rows: panel, f: lvl("skewMean"), sign: -1, universe: "panel" });
  }
  for (const L of [5, 20]) {
    specs.push({ id: `H5-level-L${L}`, hypothesis: "H5", primary: L === 5, feature: "call-put spread level", L, rows: panel, f: lvl("cw"), sign: 1, universe: "panel" });
    specs.push({ id: `H5-change-L${L}`, hypothesis: "H5", primary: false, feature: "call-put spread change vs own trailing mean", L, rows: panel, f: cwChg, sign: 1, universe: "panel" });
  }
  for (const L of [5, 20]) {
    specs.push({ id: `H6-spike-L${L}`, hypothesis: "H6", primary: L === 5, feature: "O/S spike ln(O/S / own trailing mean)", L, rows: h6, f: osChg, sign: -1, universe: "semis minus top 15 by dollar volume" });
    specs.push({ id: `H6-level-L${L}`, hypothesis: "H6", primary: false, feature: "O/S level", L, rows: h6, f: lvl("os"), sign: -1, universe: "semis minus top 15 by dollar volume" });
  }
  const tests: Array<TestRow & { demeaned: { long: number | null; short: number | null } }> = [];
  for (const s of specs) {
    const yk = `car${s.L}`;
    const res = sortSpreads(s.rows, { feature: s.f, outcome: (r) => r.y[yk] ?? null, sign: s.sign });
    tests.push({
      id: s.id,
      hypothesis: s.hypothesis,
      primary: s.primary,
      feature: s.feature,
      L: s.L,
      universe: s.universe,
      summary: summarizeSort(res),
      perName: perNameCorrelations(s.rows, s.f, (r) => r.y[yk] ?? null, s.sign),
      demeaned: demeanedLegMeans(s.rows, yk, s.f, s.sign),
    });
    log(`${s.id}: dates ${res.dates.length}, mean spread ${tests[tests.length - 1]!.summary.fm?.mean.toFixed(3)}, t ${tests[tests.length - 1]!.summary.fm?.t.toFixed(2)}`);
  }

  // H7
  await loadRates();
  const snaps = readNdjson<NameFeatures>(H7_FILE);
  const snapBy = new Map(snaps.map((f) => [`${f.date}|${f.ticker}`, f]));
  const cands = fs.existsSync(EVENTS_FILE) ? h7Candidates() : [];
  const h7: Record<string, { pairs: H7Pair[]; raw: H7Pair[] }> = {};
  for (const L of [5, 20]) {
    const pairs: H7Pair[] = [];
    const raw: H7Pair[] = [];
    for (const c of cands) {
      const hist = c.history[L];
      if (!hist) continue;
      const date = SESSIONS[c.si]!;
      const f = snapBy.get(`${date}|${c.hit}`);
      if (!f) continue;
      const exit = SESSIONS[c.si + 1 + L - 1]!;
      const ex = f.expiries.find((e) => e.e >= exit && e.iv !== null);
      if (!ex) continue;
      const r = carAfterSnapshot(c.hit, c.si, L);
      if (r.car === null || r.beta === null || r.raw === null) continue;
      const v = latestOnOrBefore(vix!, date);
      if (v === null) continue;
      const implied = impliedAbsMovePct(ex.iv!, L, r.beta, v / 100);
      const key = { date, event: `${c.event.ticker} ${c.event.kind} ${c.event.accession}`, hit: c.hit, historyPct: hist.mean, historyN: hist.n };
      pairs.push({ ...key, impliedPct: implied, realizedPct: Math.abs(r.car) });
      // Raw units: total implied move vs |raw return| (history stays abnormal: Falcon's card number).
      raw.push({ ...key, impliedPct: impliedAbsMovePct(ex.iv!, L), realizedPct: Math.abs(r.raw) });
    }
    h7[L] = { pairs, raw };
  }
  const h7Sum = (pairs: H7Pair[]) => {
    const all = summarizeH7(pairs);
    const dates = [...new Set(pairs.map((p) => p.date))].sort();
    const cutDate = dates[Math.ceil((dates.length * 2) / 3)] ?? "9999";
    const lastDate = dates[dates.length - 1] ?? "0000";
    const recentFrom = new Date(Date.parse(`${lastDate}T12:00:00Z`) - 365 * 86_400_000).toISOString().slice(0, 10);
    const years = [...new Set(pairs.map((p) => p.date.slice(0, 4)))].sort();
    return {
      all,
      early: summarizeH7(pairs.filter((p) => p.date < cutDate)),
      late: summarizeH7(pairs.filter((p) => p.date >= cutDate)),
      cut: cutDate,
      recent: summarizeH7(pairs.filter((p) => p.date > recentFrom)),
      recentFrom,
      byYear: years.map((y) => ({ year: y, s: summarizeH7(pairs.filter((p) => p.date.startsWith(y))) })),
    };
  };
  const h7Out = { L5: h7Sum(h7[5]!.pairs), L20: h7Sum(h7[20]!.pairs), rawL5: h7Sum(h7[5]!.raw), rawL20: h7Sum(h7[20]!.raw), candidates: cands.length };

  // Pass / fail on the primaries.
  const prim = tests.filter((t) => t.primary);
  const h7p = h7Out.L5.all.exceedTest;
  const ps = [...prim.map((t) => t.summary.fm?.pOne ?? 1), h7p?.pOne ?? 1];
  const adj = benjaminiHochberg(ps);
  const verdicts = [
    ...prim.map((t, k) => {
      const mean = t.summary.fm?.mean ?? NaN;
      const recent = t.summary.recent.mean ?? NaN;
      const pass = adj[k]! < 0.05 && mean > 0 && recent > 0;
      return { hypothesis: t.hypothesis, test: t.id, estimate: mean, pOne: ps[k]!, pBH: adj[k]!, recent, pass };
    }),
    (() => {
      const est = h7p?.mean ?? NaN;
      const recent = h7Out.L5.recent.exceedShare !== null ? h7Out.L5.recent.exceedShare - 0.5 : NaN;
      const pass = adj[3]! < 0.05 && est > 0 && recent > 0;
      return { hypothesis: "H7", test: "H7-exceed-L5", estimate: est, pOne: ps[3]!, pBH: adj[3]!, recent, pass };
    })(),
  ];
  const client = new DatabentoClient();
  const ledger = client.guard.entries().filter((e) => e.caller === CALLER);
  const spend = {
    total: ledger.reduce((s, e) => s + e.costUsd, 0),
    lines: ledger.length,
    bySchema: Object.fromEntries(
      [...new Set(ledger.map((e) => `${e.dataset} ${e.schema}`))].map((k) => [k, ledger.filter((e) => `${e.dataset} ${e.schema}` === k).reduce((s, e) => s + e.costUsd, 0)]),
    ),
    ledgerTotal: client.guard.spentUsd(),
  };
  const quality = panelQuality(feats);
  const out = { computedAt: new Date().toISOString(), spend, quality, verdicts, tests, h7: h7Out };
  fs.writeFileSync(path.join(DIR, "results.json"), JSON.stringify(out, null, 1));
  fs.writeFileSync(path.join(DIR, "results.md"), renderMarkdown(out));
  fs.writeFileSync(path.join(DIR, "h7-pairs.json"), JSON.stringify(h7[5]!.pairs.concat(h7[20]!.pairs.map((p) => ({ ...p, L: 20 }) as H7Pair)), null, 0));
  log(`analyze: wrote results.json and results.md`);
  console.log(renderMarkdown(out));
}

function panelQuality(feats: NameFeatures[]) {
  const n = feats.length;
  const cnt = (f: (x: NameFeatures) => boolean) => feats.filter(f).length;
  return {
    nameDates: n,
    dates: new Set(feats.map((f) => f.date)).size,
    names: new Set(feats.map((f) => f.ticker)).size,
    withSkew: cnt((f) => f.skewMean !== null),
    withCw: cnt((f) => f.cw !== null),
    withOs: cnt((f) => f.oToS !== null),
    spot: { itch: cnt((f) => f.spotSource === "itch"), parity: cnt((f) => f.spotSource === "parity"), close: cnt((f) => f.spotSource === "close") },
    withWarnings: cnt((f) => f.warnings.length > 0),
    medianSkewMean: med(feats.map((f) => f.skewMean)),
    medianCw: med(feats.map((f) => f.cw)),
    medianOs: med(feats.map((f) => f.oToS)),
  };
}

function med(xs: Array<number | null>): number | null {
  const v = xs.filter((x): x is number => x !== null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : (v[m - 1]! + v[m]!) / 2;
}

// ---------------------------------------------------------------------------
// Markdown

const f2 = (x: number | null | undefined, d = 2) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x.toFixed(d));
const pf = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : x < 0.001 ? "<0.001" : x.toFixed(3));
const pct = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "n/a" : `${(x * 100).toFixed(1)}%`);

type H7Block = { all: H7Summary; early: H7Summary; late: H7Summary; cut: string; recent: H7Summary; recentFrom: string; byYear: Array<{ year: string; s: H7Summary }> };

function renderMarkdown(out: {
  spend: { total: number; lines: number; bySchema: Record<string, number>; ledgerTotal: number };
  quality: ReturnType<typeof panelQuality>;
  verdicts: Array<{ hypothesis: string; test: string; estimate: number; pOne: number; pBH: number; recent: number; pass: boolean }>;
  tests: Array<TestRow & { demeaned: { long: number | null; short: number | null } }>;
  h7: { L5: H7Block; L20: H7Block; rawL5: H7Block; rawL20: H7Block; candidates: number };
}): string {
  const L: string[] = [];
  L.push(`### Spend (ledger, caller ${CALLER})`, "");
  L.push(`Total $${out.spend.total.toFixed(4)} over ${out.spend.lines} pulls (ledger total, all callers: $${out.spend.ledgerTotal.toFixed(4)}).`, "");
  L.push("| dataset schema | USD |", "|---|---:|");
  for (const [k, v] of Object.entries(out.spend.bySchema)) L.push(`| ${k} | ${v.toFixed(4)} |`);
  L.push("", "### Panel coverage", "");
  const q = out.quality;
  L.push(
    `${q.nameDates} name-dates, ${q.dates} dates, ${q.names} names; skew on ${q.withSkew}, call-put spread on ${q.withCw}, O/S on ${q.withOs}. Spot: ITCH ${q.spot.itch}, parity ${q.spot.parity}, close ${q.spot.close}. Median skewMean ${f2(q.medianSkewMean, 4)}, median CW ${f2(q.medianCw, 4)}, median O/S ${f2(q.medianOs, 4)}. Name-dates with a surface warning: ${q.withWarnings}.`,
  );
  L.push("", "### Verdicts (primary tests, pre-registered)", "");
  L.push("| hypothesis | primary test | estimate | one-sided p | BH p | recent year | pass |", "|---|---|---:|---:|---:|---:|---|");
  for (const v of out.verdicts) L.push(`| ${v.hypothesis} | ${v.test} | ${f2(v.estimate, 3)} | ${pf(v.pOne)} | ${pf(v.pBH)} | ${f2(v.recent, 3)} | ${v.pass ? "PASS" : "fail"} |`);
  L.push("", "Panel estimate = mean per-date long-short spread of CAR_L in percent (predicted orientation, so > 0 = as published). H7 estimate = share of gap > 0 pairs with realized > implied, minus 0.5.");
  L.push("", "### Panel sorts (H4, H5, H6)", "");
  L.push(
    "| test | primary | dates | leg obs | spread % (mean) | median | t (dates) | p one-sided | hit rate | net of 0.40 | long - date mean | short - date mean | pooled t (date) | pooled t (two-way) | early mean (t) | late mean (t) | recent 12 | per-name rho (t, share >0) |",
    "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|---|",
  );
  for (const t of out.tests) {
    const s = t.summary;
    L.push(
      `| ${t.id} | ${t.primary ? "yes" : ""} | ${s.dates} | ${s.legObs} | ${f2(s.fm?.mean, 3)} | ${f2(s.fm?.median, 3)} | ${f2(s.fm?.t)} | ${pf(s.fm?.pOne)} | ${pct(s.fm?.hit)} | ${f2(s.netMean, 3)} | ${f2(t.demeaned.long, 3)} | ${f2(t.demeaned.short, 3)} | ${f2(s.pooled?.tDate)} | ${f2(s.pooled?.tTwoWay)} | ${f2(s.split.early?.mean, 3)} (${f2(s.split.early?.t)}) | ${f2(s.split.late?.mean, 3)} (${f2(s.split.late?.t)}) | ${f2(s.recent.mean, 3)} | ${f2(t.perName.test?.mean, 3)} (${f2(t.perName.test?.t)}, ${pct(t.perName.positiveShare)}) |`,
    );
  }
  L.push("", "#### By year (mean spread %, dates)", "");
  const years = [...new Set(out.tests.flatMap((t) => t.summary.byYear.map((y) => y.year)))].sort();
  L.push(`| test | ${years.join(" | ")} |`, `|---|${years.map(() => "---:").join("|")}|`);
  for (const t of out.tests) {
    const m = new Map(t.summary.byYear.map((y) => [y.year, y]));
    L.push(`| ${t.id} | ${years.map((y) => (m.has(y) ? `${f2(m.get(y)!.mean)} (${m.get(y)!.dates})` : "")).join(" | ")} |`);
  }
  L.push("", "### H7: implied move vs ripple history", "");
  L.push(`Candidate (event, hit) pairs with >= ${HISTORY_MIN_SAMPLE} similar past events: ${out.h7.candidates}.`, "");
  L.push(
    "| sample | pairs | dates | mean implied % | mean history % | mean realized % | gap > 0 | realized > implied (gap > 0) | t | p one-sided | same, gap <= 0 | options >= history | realized <= implied (all) | slope (R-I on gap) | t | Spearman | median R/I | R on I: b (t) | R on H: b (t) |",
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
  );
  const row = (name: string, s: H7Summary) =>
    L.push(
      `| ${name} | ${s.pairs} | ${s.dates} | ${f2(s.meanImplied)} | ${f2(s.meanHistory)} | ${f2(s.meanRealized)} | ${s.gapPositive} | ${pct(s.exceedShare)} | ${f2(s.exceedTest?.t)} | ${pf(s.exceedTest?.pOne)} | ${pct(s.exceedShareGapNeg)} | ${pct(s.optionsAtLeastHistoryShare)} | ${pct(s.pricedInShare)} | ${f2(s.slope?.beta, 3)} | ${f2(s.slope?.t)} | ${f2(s.rho, 3)} | ${f2(s.medianRatioRealizedToImplied)} | ${f2(s.partial?.bI, 3)} (${f2(s.partial?.tI)}) | ${f2(s.partial?.bH, 3)} (${f2(s.partial?.tH)}) |`,
    );
  for (const [name, b] of [["L=5 abnormal (primary)", out.h7.L5], ["L=20 abnormal", out.h7.L20], ["L=5 raw units", out.h7.rawL5], ["L=20 raw units", out.h7.rawL20]] as const) {
    row(name, b.all);
    row(`  first 2/3 (< ${b.cut})`, b.early);
    row(`  last 1/3`, b.late);
    row(`  recent year (> ${b.recentFrom})`, b.recent);
    for (const y of b.byYear) row(`  ${y.year}`, y.s);
  }
  return L.join("\n") + "\n";
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  fs.mkdirSync(DIR, { recursive: true });
  if (phase === "prices") return phasePrices();
  if (phase === "events") return phaseEvents();
  if (phase === "panel") return runSnapshots(panelPlans(), PANEL_FILE, "panel");
  if (phase === "h7") {
    const cands = h7Candidates();
    const plans = h7Plans(cands);
    log(`h7: ${cands.length} (event, hit) pairs with history, ${plans.length} snapshot dates`);
    return runSnapshots(plans, H7_FILE, "h7");
  }
  if (phase === "analyze") return phaseAnalyze();
  throw new Error("phase: prices | events | panel | h7 | analyze");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
