/**
 * Historical earnings events for every company in the link graph, 2016 to
 * today -> Supabase public.historical_events
 * (apps/web/supabase/migrations/20261121_historical_events.sql).
 *
 *   node --import tsx scripts/earnings-events.ts [--dry-run] [phase ...]
 *
 * After the first build: `classify build write report` re-reads everything
 * from the caches (the classify phase fetches only filings it has not read).
 *
 * Phases (default: all, in order; each resumes from its cache):
 *   universe  graph tickers (apps/web/data/graph/_all.json) -> CIK (SEC company_tickers.json)
 *   edgar     submissions JSON + older `files` pages per CIK (cached raw, with fetch time)
 *   calibrate the clock of each submissions file / page (true UTC or shifted by New
 *             York's offset, see src/edgar-time.ts), read from one EDGAR filing
 *             index page per file: its "Accepted" line is New York wall time
 *   prices    Yahoo adjusted closes (packages/backtest's YahooPriceSource) for the
 *             tickers and the SPDR sector ETFs + SPY; Databento EQUS.SUMMARY closes
 *             (Supabase prices_daily, split-adjusted with prices_splits) since 2024-07
 *   classify  event_kind per filing (src/study/event-kind.ts): timing against the
 *             company's 10-Q / 10-K windows, and for filings that share a window,
 *             fall outside one or are amendments, the 8-K's Item 2.02 text (and
 *             exhibit 99's first lines when that is silent) -> event-kinds.json
 *   build     8-K / 8-K/A with item 2.02 since 2016-01-01 -> events.ndjson
 *   write     upsert into historical_events in batches (skipped with --dry-run)
 *   verify    acceptance instants of sampled events read against their EDGAR index pages
 *   report    historical-events-report.md
 *
 * Event day, returns and flags: src/study/earnings-events.ts. Prices: the
 * stock's d-1, d0 and d1 closes all from Databento when it has the three
 * (price_source 'mixed': the ETFs are not in prices_daily, so they come from
 * Yahoo), else all from Yahoo (price_source 'yahoo'). No paid data is bought.
 *
 * Cache: EARNINGS_EVENTS_DIR (default packages/engine/.cache/earnings-events):
 * edgar-cache/ (raw SEC answers), price-cache/, events.ndjson, verify.json,
 * historical-events-report.md. SEC at <= 6 requests a second with the
 * engine's declared User-Agent; Yahoo at ~3 a second. Secrets are read from
 * the environment or apps/web/.env.local and never printed.
 */

import fs from "node:fs";
import path from "node:path";
import pg from "pg";
import { edgarAcceptanceMs, edgarIndexConvention, edgarStampState, type EdgarIndexConvention } from "../src/edgar-time.ts";
import { env } from "../src/env.ts";
import { ENGINE_ROOT, SEC_USER_AGENT } from "../src/http.ts";
import { parseFilingIndex } from "../src/sec.ts";
import { htmlToText } from "../src/text.ts";
import {
  EVENT_KINDS,
  classifyCompany,
  isPeriodicForm,
  item202Section,
  needsText,
  readKindText,
  type EventKind,
  type KindInput,
  type KindOut,
  type PeriodicReport,
  type TextRead,
} from "../src/study/event-kind.ts";
import { nyInstantMs } from "../src/study/abnormal.ts";
import { seededRandom } from "../src/study/stats.ts";
import {
  MARKET_ETF,
  SECTOR_ETF,
  SUSPICIOUS_ABS,
  abnormalReturn,
  dayReturns,
  eventDay,
  filingIndexUrl,
  hasItem202,
  isEarningsForm,
  nyDate,
  percentile,
  sameDayAccessions,
  twoDayReturn,
  windowSessions,
  type EventFlag,
} from "../src/study/earnings-events.ts";

const REPO = path.resolve(ENGINE_ROOT, "..", "..");
const ROOT = process.env.EARNINGS_EVENTS_DIR ?? path.join(ENGINE_ROOT, ".cache", "earnings-events");
const EDGAR_DIR = path.join(ROOT, "edgar-cache");
const PRICE_DIR = path.join(ROOT, "price-cache");
const YAHOO_DIR = path.join(PRICE_DIR, "yahoo");
const DATABENTO_FILE = path.join(PRICE_DIR, "databento.json");
const UNIVERSE_FILE = path.join(ROOT, "universe.json");
const EVENTS_FILE = path.join(ROOT, "events.ndjson");
const VERIFY_FILE = path.join(ROOT, "verify.json");
const CALIBRATION_FILE = path.join(ROOT, "clock-calibration.json");
const REPORT_FILE = path.join(ROOT, "historical-events-report.md");
const KINDS_FILE = path.join(ROOT, "event-kinds.json");

const FROM = "2016-01-01";
const PRICE_FROM = "2015-11-01";
const DATABENTO_FROM = "2024-07-01";
const DISAGREE_ABS = 0.03;
const ETFS = [...new Set([...Object.values(SECTOR_ETF), MARKET_ETF])];

const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const phases = args.filter((a) => !a.startsWith("--"));
const want = (p: string) => phases.length === 0 || phases.includes(p) || phases.includes("all");

const t0 = Date.now();
function log(...xs: unknown[]): void {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...xs);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function readJson<T>(f: string): T {
  return JSON.parse(fs.readFileSync(f, "utf8")) as T;
}
function writeJson(f: string, v: unknown): void {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v));
  fs.renameSync(tmp, f);
}
function safeMessage(err: unknown): string {
  const e = err as { code?: string; message?: string };
  return `${e.code ? `(${e.code}) ` : ""}${(e.message ?? String(err)).replace(/postgres(ql)?:\/\/\S+/g, "postgres://***")}`;
}

// ---------------------------------------------------------------------------
// SEC: one spaced queue, <= 6 requests a second (SEC allows 10)

function limiter(gapMs: number, concurrency: number) {
  let next = 0;
  let active = 0;
  const waiting: Array<() => void> = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= concurrency) await new Promise<void>((r) => waiting.push(r));
    active++;
    const now = Date.now();
    const at = Math.max(now, next);
    next = at + gapMs;
    if (at > now) await sleep(at - now);
    try {
      return await fn();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
const secQueue = limiter(170, 4);
/** Filing documents for the classify phase: <= 8 a second. */
const docQueue = limiter(125, 6);

type Cached = { url: string; status: number; fetchedAtMs: number; body: string };

function cacheFile(name: string): string {
  return path.join(EDGAR_DIR, name);
}

/** GET a SEC URL through the queue; the raw answer (with its fetch time) is kept under `name`. */
async function secCached(url: string, name: string, queue = secQueue): Promise<Cached> {
  const f = cacheFile(name);
  if (fs.existsSync(f)) return readJson<Cached>(f);
  const out = await secFetch(url, queue);
  if (out.status === 200 || out.status === 404) writeJson(f, out);
  return out;
}

/** GET a SEC document and keep only `keep(body)` (its plain text, cut short) under `name`. */
async function secDocText(url: string, name: string, keep: (body: string) => string): Promise<Cached> {
  const f = cacheFile(name);
  if (fs.existsSync(f)) return readJson<Cached>(f);
  const raw = await secFetch(url, docQueue);
  const out: Cached = { ...raw, body: raw.status === 200 ? keep(raw.body) : "" };
  if (out.status === 200 || out.status === 404) writeJson(f, out);
  return out;
}

async function secFetch(url: string, queue: ReturnType<typeof limiter>): Promise<Cached> {
  let wait = 2000;
  for (let k = 0; k < 6; k++) {
    try {
      const res = await queue(() => fetch(url, { headers: { "User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate" }, signal: AbortSignal.timeout(60_000) }));
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        await sleep(res.status === 429 ? Math.max(wait, 15_000) : wait);
        wait *= 2;
        continue;
      }
      return { url, status: res.status, fetchedAtMs: Date.now(), body: await res.text() };
    } catch {
      await sleep(wait);
      wait = Math.min(wait * 2, 60_000);
    }
  }
  return { url, status: 0, fetchedAtMs: Date.now(), body: "" };
}

async function pool<T>(items: readonly T[], n: number, fn: (x: T, i: number) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) {
        const k = i++;
        await fn(items[k]!, k);
      }
    }),
  );
}

// ---------------------------------------------------------------------------
// Phase: universe

type UniverseEntry = {
  ticker: string;
  name: string;
  sector: string | null;
  etf: string | null;
  cik: number | null;
  /** How the CIK was found: exact ticker, a share-class spelling, the base ticker, the graph's own filing URLs. */
  cikVia: "exact" | "class" | "base" | "graph_url" | null;
};

async function universePhase(): Promise<UniverseEntry[]> {
  const all = readJson<{ n: Array<[string, string, number, string]> }>(path.join(REPO, "apps", "web", "data", "graph", "_all.json"));
  const sicFile = readJson<{ sic: Record<string, number> }>(path.join(ENGINE_ROOT, "data", "company-sic.json"));
  const sectorsPath = path.join(REPO, "apps", "web", "scripts", "sic-sectors.mjs");
  const { sectorFor } = (await import(sectorsPath)) as { sectorFor: (t: string, sic: number | undefined) => string | null };

  const ct = await secCached("https://www.sec.gov/files/company_tickers.json", "company_tickers.json");
  if (ct.status !== 200) throw new Error(`company_tickers.json: HTTP ${ct.status}`);
  const cikOf = new Map<string, number>();
  for (const row of Object.values(JSON.parse(ct.body) as Record<string, { cik_str: number; ticker: string }>)) {
    if (!cikOf.has(row.ticker)) cikOf.set(row.ticker, row.cik_str);
  }
  // The graph's own edges carry the filer's EDGAR URL (.../edgar/data/<cik>/...): a fallback for tickers SEC no longer lists.
  const graph = readJson<{ edges: Array<{ from: string; url?: string }> }>(path.join(ENGINE_ROOT, "data", "graph.json"));
  const graphCik = new Map<string, number>();
  for (const e of graph.edges) {
    const m = /\/edgar\/data\/(\d+)\//.exec(e.url ?? "");
    if (m && e.from && !graphCik.has(e.from)) graphCik.set(e.from, Number(m[1]));
  }

  const out: UniverseEntry[] = [];
  for (const [ticker, name, , graphSector] of all.n) {
    let cik: number | null = null;
    let via: UniverseEntry["cikVia"] = null;
    if (cikOf.has(ticker)) [cik, via] = [cikOf.get(ticker)!, "exact"];
    else {
      const alt = [ticker.replace(/-/g, "."), ticker.replace(/\./g, "-"), ticker.replace(/[.-]/g, "")].find((t) => cikOf.has(t));
      if (alt) [cik, via] = [cikOf.get(alt)!, "class"];
      else if (graphCik.has(ticker)) [cik, via] = [graphCik.get(ticker)!, "graph_url"];
      else {
        const base = ticker.split(/[.-]/)[0]!;
        if (base !== ticker && cikOf.has(base)) [cik, via] = [cikOf.get(base)!, "base"];
      }
    }
    const sector = sectorFor(ticker, sicFile.sic[ticker]) ?? graphSector ?? null;
    out.push({ ticker, name, sector, etf: sector ? SECTOR_ETF[sector] ?? null : null, cik, cikVia: via });
  }
  writeJson(UNIVERSE_FILE, out);
  const miss = out.filter((u) => u.cik === null);
  log(`universe: ${out.length} tickers, ${out.length - miss.length} with a CIK (${out.filter((u) => u.cikVia !== "exact" && u.cik !== null).length} not by exact ticker); no CIK: ${miss.map((u) => u.ticker).join(" ") || "none"}`);
  return out;
}

// ---------------------------------------------------------------------------
// Phase: edgar

type Recent = {
  accessionNumber?: string[];
  filingDate?: string[];
  acceptanceDateTime?: string[];
  form?: string[];
  items?: string[];
  primaryDocument?: string[];
  reportDate?: string[];
};
type Submissions = {
  cik?: string | number;
  name?: string;
  tickers?: string[];
  exchanges?: string[];
  filings?: { recent?: Recent; files?: Array<{ name: string; filingFrom: string; filingTo: string; filingCount: number }> };
};

function subName(cik: number): string {
  return `CIK${String(cik).padStart(10, "0")}.json`;
}

async function edgarPhase(universe: UniverseEntry[]): Promise<void> {
  const ciks = [...new Set(universe.map((u) => u.cik).filter((c): c is number => c !== null))];
  log(`edgar: ${ciks.length} CIKs`);
  let done = 0;
  let pages = 0;
  let failed = 0;
  await pool(ciks, 4, async (cik) => {
    const name = subName(cik);
    const main = await secCached(`https://data.sec.gov/submissions/${name}`, name);
    if (main.status !== 200) {
      failed++;
      return;
    }
    const sub = JSON.parse(main.body) as Submissions;
    for (const extra of sub.filings?.files ?? []) {
      if (extra.filingTo < FROM) continue;
      const page = await secCached(`https://data.sec.gov/submissions/${extra.name}`, extra.name);
      pages++;
      if (page.status !== 200) failed++;
    }
    if (++done % 200 === 0) log(`edgar: ${done}/${ciks.length} (${pages} older pages)`);
  });
  log(`edgar: done, ${done} companies, ${pages} older pages, ${failed} failures`);
}

// ---------------------------------------------------------------------------
// Phase: calibrate (one EDGAR index page per submissions file)

type Calibration = {
  convention: EdgarIndexConvention | "unknown";
  accession: string | null;
  accepted: string | null;
  /** What the heuristic in src/edgar-time.ts said, for the report. */
  heuristic: EdgarIndexConvention | null;
};

function acceptedLine(html: string): string | null {
  return /Accepted<\/div>\s*<div class="info">([^<]+)<\/div>/.exec(html)?.[1]?.trim() ?? null;
}

/** The New York wall clock of an instant as EDGAR prints it ("YYYY-MM-DD HH:MM:SS"). */
function nyWall(ms: number): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).format(new Date(ms));
}

async function calibratePhase(universe: UniverseEntry[]): Promise<void> {
  const done: Record<string, Calibration> = fs.existsSync(CALIBRATION_FILE) ? readJson<Record<string, Calibration>>(CALIBRATION_FILE) : {};
  const jobs: Array<{ file: string; cik: number; rec: Recent; fetchedAtMs: number }> = [];
  for (const cik of new Set(universe.map((u) => u.cik).filter((c): c is number => c !== null))) {
    const f = cacheFile(subName(cik));
    if (!fs.existsSync(f)) continue;
    const main = readJson<Cached>(f);
    if (main.status !== 200) continue;
    const sub = JSON.parse(main.body) as Submissions;
    if (sub.filings?.recent) jobs.push({ file: subName(cik), cik, rec: sub.filings.recent, fetchedAtMs: main.fetchedAtMs });
    for (const extra of sub.filings?.files ?? []) {
      if (extra.filingTo < FROM || !fs.existsSync(cacheFile(extra.name))) continue;
      const page = readJson<Cached>(cacheFile(extra.name));
      if (page.status === 200) jobs.push({ file: extra.name, cik, rec: JSON.parse(page.body) as Recent, fetchedAtMs: page.fetchedAtMs });
    }
  }
  const todo = jobs.filter((j) => !done[j.file] || done[j.file]!.convention === "unknown");
  log(`calibrate: ${todo.length} of ${jobs.length} files to read`);
  let n = 0;
  await pool(todo, 4, async (j) => {
    const heuristic = edgarIndexConvention(j.rec, j.fetchedAtMs);
    // Candidates: older entries (not the fetch day's), earnings 8-Ks first, newest first.
    const idx: number[] = [];
    const forms = j.rec.form ?? [];
    for (let i = 0; i < forms.length; i++) {
      const date = j.rec.filingDate?.[i];
      if (!j.rec.acceptanceDateTime?.[i] || edgarStampState(date, j.fetchedAtMs) !== "old") continue;
      idx.push(i);
    }
    idx.sort((a, b) => Number(isEarningsForm(forms[b]) && hasItem202(j.rec.items?.[b])) - Number(isEarningsForm(forms[a]) && hasItem202(j.rec.items?.[a])));
    let result: Calibration = { convention: "unknown", accession: null, accepted: null, heuristic };
    for (const i of idx.slice(0, 2)) {
      const acc = j.rec.accessionNumber![i]!;
      const page = await secCached(filingIndexUrl(j.cik, acc), `index-${acc}.htm.json`);
      const accepted = acceptedLine(page.body);
      if (!accepted) continue;
      const ctx = { filingDate: j.rec.filingDate![i]!, fetchedAtMs: j.fetchedAtMs };
      const asUtc = edgarAcceptanceMs(j.rec.acceptanceDateTime![i], { ...ctx, convention: "utc" });
      const asShifted = edgarAcceptanceMs(j.rec.acceptanceDateTime![i], { ...ctx, convention: "shifted" });
      const convention = asUtc !== null && nyWall(asUtc) === accepted ? "utc" : asShifted !== null && nyWall(asShifted) === accepted ? "shifted" : "unknown";
      result = { convention, accession: acc, accepted, heuristic };
      if (convention !== "unknown") break;
    }
    done[j.file] = result;
    if (++n % 200 === 0) {
      writeJson(CALIBRATION_FILE, done);
      log(`calibrate: ${n}/${todo.length}`);
    }
  });
  writeJson(CALIBRATION_FILE, done);
  calibration = done;
  const tally: Record<string, number> = {};
  for (const j of jobs) {
    const c = done[j.file];
    const k = `${c?.convention ?? "missing"} (heuristic ${c?.heuristic ?? "null"})`;
    tally[k] = (tally[k] ?? 0) + 1;
  }
  log(`calibrate: ${JSON.stringify(tally)}`);
}

type Filing = {
  cik: number;
  accession: string;
  form: string;
  filingDate: string;
  acceptedMs: number;
  convention: EdgarIndexConvention | null;
  primaryDocument: string | null;
};

type CompanyFilings = {
  cik: number;
  name: string;
  tickers: string[];
  earnings: Filing[];
  /** 10-Q / 10-K filings (any date): the reporting windows of src/study/event-kind.ts. */
  reports: PeriodicReport[];
  /** Counts of a few telling forms across all pages read (any date). */
  forms: Record<string, number>;
  any8kSince: boolean;
  latestFiling: string | null;
  earliestFiling: string | null;
};

const TELLING = ["10-K", "10-Q", "20-F", "40-F", "6-K", "8-K", "N-CSR", "10-KT"];

let calibration: Record<string, Calibration> | null = null;
function calibrated(file: string): EdgarIndexConvention | null {
  if (calibration === null) calibration = fs.existsSync(CALIBRATION_FILE) ? readJson<Record<string, Calibration>>(CALIBRATION_FILE) : {};
  const c = calibration[file];
  return c && (c.convention === "utc" || c.convention === "shifted") ? c.convention : null;
}

function readCompany(cik: number): CompanyFilings | null {
  const f = cacheFile(subName(cik));
  if (!fs.existsSync(f)) return null;
  const main = readJson<Cached>(f);
  if (main.status !== 200) return null;
  const sub = JSON.parse(main.body) as Submissions;
  const out: CompanyFilings = { cik, name: sub.name ?? "", tickers: sub.tickers ?? [], earnings: [], reports: [], forms: {}, any8kSince: false, latestFiling: null, earliestFiling: null };
  const take = (rec: Recent | undefined, fetchedAtMs: number, file: string) => {
    if (!rec?.form) return;
    const convention = calibrated(file) ?? edgarIndexConvention(rec, fetchedAtMs);
    for (let i = 0; i < rec.form.length; i++) {
      const form = rec.form[i]!;
      const date = rec.filingDate?.[i] ?? "";
      if (TELLING.includes(form)) out.forms[form] = (out.forms[form] ?? 0) + 1;
      if (isPeriodicForm(form) && rec.reportDate?.[i]) out.reports.push({ form, filed: date, period: rec.reportDate[i]! });
      if (!out.latestFiling || date > out.latestFiling) out.latestFiling = date;
      if (date && (!out.earliestFiling || date < out.earliestFiling)) out.earliestFiling = date;
      if (date < FROM) continue;
      if (form === "8-K") out.any8kSince = true;
      if (!isEarningsForm(form) || !hasItem202(rec.items?.[i])) continue;
      const accepted = edgarAcceptanceMs(rec.acceptanceDateTime?.[i], { filingDate: date, fetchedAtMs, convention });
      if (accepted === null) continue;
      out.earnings.push({ cik, accession: rec.accessionNumber![i]!, form, filingDate: date, acceptedMs: accepted, convention, primaryDocument: rec.primaryDocument?.[i] || null });
    }
  };
  take(sub.filings?.recent, main.fetchedAtMs, subName(cik));
  for (const extra of sub.filings?.files ?? []) {
    if (extra.filingTo < FROM) continue;
    const pf = cacheFile(extra.name);
    if (!fs.existsSync(pf)) continue;
    const page = readJson<Cached>(pf);
    if (page.status === 200) take(JSON.parse(page.body) as Recent, page.fetchedAtMs, extra.name);
  }
  const seen = new Set<string>();
  out.earnings = out.earnings.filter((e) => (seen.has(e.accession) ? false : (seen.add(e.accession), true)));
  return out;
}

// ---------------------------------------------------------------------------
// Phase: prices

type Closes = Map<string, number>;
type YahooFile = { ticker: string; fetchedAtMs: number; status: "ok" | "empty" | "error"; error?: string; d: string[]; c: number[] };

type Bar = { date: string; close: number };
type YahooSourceCtor = new (cache: unknown, http?: unknown) => { dailyBars(t: string, from: string, to: string): Promise<Bar[]> };

async function yahooSource() {
  const base = path.join(REPO, "packages", "backtest", "src", "data");
  const { YahooPriceSource } = (await import(path.join(base, "yahoo.ts"))) as { YahooPriceSource: YahooSourceCtor };
  const { JsonCache } = (await import(path.join(base, "cache.ts"))) as { JsonCache: new (dir: string | null) => unknown };
  const { PoliteFetcher } = (await import(path.join(base, "http.ts"))) as { PoliteFetcher: new (o: object) => unknown };
  const http = new PoliteFetcher({ concurrency: 3, minGapMs: 300, timeoutMs: 20_000, retries: 2 });
  return new YahooPriceSource(new JsonCache(null), http);
}

function yahooFile(t: string): string {
  return path.join(YAHOO_DIR, `${t.replace(/[^A-Za-z0-9.-]/g, "_")}.json`);
}

async function pricesPhase(universe: UniverseEntry[]): Promise<void> {
  const src = await yahooSource();
  const today = nyDate(Date.now());
  const tickers = [...new Set([...ETFS, ...universe.map((u) => u.ticker)])];
  const todo = tickers.filter((t) => {
    if (!fs.existsSync(yahooFile(t))) return true;
    return readJson<YahooFile>(yahooFile(t)).status === "error";
  });
  log(`prices: Yahoo for ${todo.length} of ${tickers.length} tickers`);
  let done = 0;
  await pool(todo, 3, async (t) => {
    let file: YahooFile;
    try {
      const bars = await src.dailyBars(t, PRICE_FROM, today);
      file = { ticker: t, fetchedAtMs: Date.now(), status: bars.length ? "ok" : "empty", d: bars.map((b) => b.date), c: bars.map((b) => b.close) };
    } catch (err) {
      file = { ticker: t, fetchedAtMs: Date.now(), status: "error", error: safeMessage(err).slice(0, 200), d: [], c: [] };
    }
    writeJson(yahooFile(t), file);
    if (++done % 200 === 0) log(`prices: Yahoo ${done}/${todo.length}`);
  });
  const errors = tickers.filter((t) => readJson<YahooFile>(yahooFile(t)).status !== "ok");
  log(`prices: Yahoo done; no bars for ${errors.length}: ${errors.slice(0, 40).join(" ")}${errors.length > 40 ? " ..." : ""}`);

  if (fs.existsSync(DATABENTO_FILE) && !args.includes("--refresh-databento")) {
    log("prices: Databento closes cached");
    return;
  }
  const url = env("DATABASE_URL");
  if (!url) {
    log("prices: DATABASE_URL not set, Databento closes skipped (Yahoo only)");
    return;
  }
  const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    const out: { fetchedAtMs: number; closes: Record<string, [string[], number[]]>; splits: Record<string, Array<{ date: string; ratio: number }>> } = {
      fetchedAtMs: Date.now(),
      closes: {},
      splits: {},
    };
    const list = universe.map((u) => u.ticker);
    for (let i = 0; i < list.length; i += 150) {
      const chunk = list.slice(i, i + 150);
      const r = await db.query<{ ticker: string; d: string; close: number }>(
        "select ticker, date::text as d, close from public.prices_daily where ticker = any($1) and close is not null order by ticker, date",
        [chunk],
      );
      for (const row of r.rows) {
        const e = (out.closes[row.ticker] ??= [[], []]);
        e[0].push(row.d);
        e[1].push(Number(row.close));
      }
    }
    const s = await db.query<{ ticker: string; d: string; ratio: number }>("select ticker, date::text as d, ratio from public.prices_splits order by ticker, date");
    for (const row of s.rows) (out.splits[row.ticker] ??= []).push({ date: row.d, ratio: Number(row.ratio) });
    writeJson(DATABENTO_FILE, out);
    log(`prices: Databento closes for ${Object.keys(out.closes).length} tickers, ${s.rows.length} splits`);
  } finally {
    await db.end();
  }
}

/** apps/web/lib/prices-api.ts splitFactor: the product of the ratios of splits after `date`. */
function splitFactor(splits: ReadonlyArray<{ date: string; ratio: number }>, date: string): number {
  let f = 1;
  for (const s of splits) if (s.date > date && s.ratio > 0) f *= s.ratio;
  return f;
}

type PriceBook = {
  yahoo: Map<string, Closes>;
  yahooFirst: Map<string, string>;
  databento: Map<string, Closes>;
  databentoFirst: Map<string, string>;
  lastYahoo: string;
};

function loadPrices(universe: UniverseEntry[]): PriceBook {
  const yahoo = new Map<string, Closes>();
  const yahooFirst = new Map<string, string>();
  let lastYahoo = "";
  for (const t of [...new Set([...ETFS, ...universe.map((u) => u.ticker)])]) {
    if (!fs.existsSync(yahooFile(t))) continue;
    const f = readJson<YahooFile>(yahooFile(t));
    if (f.status !== "ok") continue;
    yahoo.set(t, new Map(f.d.map((d, i) => [d, f.c[i]!])));
    yahooFirst.set(t, f.d[0]!);
    if (t === MARKET_ETF) lastYahoo = f.d[f.d.length - 1]!;
  }
  const databento = new Map<string, Closes>();
  const databentoFirst = new Map<string, string>();
  if (fs.existsSync(DATABENTO_FILE)) {
    const f = readJson<{ closes: Record<string, [string[], number[]]>; splits: Record<string, Array<{ date: string; ratio: number }>> }>(DATABENTO_FILE);
    for (const [t, [d, c]] of Object.entries(f.closes)) {
      const splits = f.splits[t] ?? [];
      databento.set(t, new Map(d.map((day, i) => [day, c[i]! / splitFactor(splits, day)])));
      if (d.length) databentoFirst.set(t, d[0]!);
    }
  }
  return { yahoo, yahooFirst, databento, databentoFirst, lastYahoo };
}

// ---------------------------------------------------------------------------
// Phase: classify (event_kind)

type KindRecord = KindOut & {
  /** Where the text read came from, when it was read. */
  via: "8-K" | "ex99" | null;
  cue: string | null;
  excerpt: string | null;
};
type KindsFile = {
  builtAtMs: number;
  kinds: Record<string, KindRecord>;
  /** CIKs drawn for the hand check: every filing's text read, used only for the comparison. */
  sample: number[];
  sampleReads: Record<string, { kind: EventKind | null; cue: string | null; via: "8-K" | "ex99" | null; excerpt: string | null }>;
};

const DOC_CHARS = 15_000;
const SAMPLE_COMPANIES = 30;

function filingBase(cik: number, accession: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${cik}/${accession.replace(/-/g, "")}`;
}

/** What a filing's own words say: the 8-K's Item 2.02 section, else exhibit 99's first lines. */
async function readFilingText(f: Filing): Promise<{ read: TextRead; via: "8-K" | "ex99" | null; excerpt: string | null }> {
  let excerpt: string | null = null;
  if (f.primaryDocument) {
    const doc = await secDocText(`${filingBase(f.cik, f.accession)}/${f.primaryDocument}`, `doc-${f.accession}.json`, (b) => htmlToText(b).slice(0, DOC_CHARS));
    if (doc.status === 200 && doc.body) {
      excerpt = item202Section(doc.body);
      const read = readKindText(excerpt);
      // An 8-K that only mentions a presentation or other matter may still carry results in exhibit 99.
      if (read && read.kind !== "other") return { read, via: "8-K", excerpt };
      if (read) {
        const ex = await readExhibit(f);
        return ex.read && ex.read.kind !== "other" ? ex : { read, via: "8-K", excerpt };
      }
    }
  }
  const ex = await readExhibit(f);
  return ex.read ? ex : { read: null, via: null, excerpt };
}

/** Exhibit 99's description and first lines. */
async function readExhibit(f: Filing): Promise<{ read: TextRead; via: "ex99" | null; excerpt: string | null }> {
  const excerpt = null;
  const idx = await secCached(filingIndexUrl(f.cik, f.accession), `index-${f.accession}.htm.json`, docQueue);
  if (idx.status !== 200) return { read: null, via: null, excerpt };
  const docs = parseFilingIndex(idx.body);
  const ex = docs.find((d) => /^EX-99(\.0?1)?$/i.test(d.type)) ?? docs.find((d) => /^EX-99/i.test(d.type));
  if (!ex) return { read: null, via: null, excerpt };
  const doc = await secDocText(ex.url, `ex99-${f.accession}.json`, (b) => htmlToText(b).slice(0, 4000));
  const head = `${ex.description} ${doc.body.slice(0, 1200)}`;
  const read = readKindText(head);
  return { read, via: read ? "ex99" : null, excerpt: read ? head : excerpt };
}

async function classifyPhase(universe: UniverseEntry[]): Promise<KindsFile> {
  const ciks = [...new Set(universe.map((u) => u.cik).filter((c): c is number => c !== null))];
  const companies = ciks.map((c) => readCompany(c)).filter((c): c is CompanyFilings => !!c && c.earnings.length > 0);
  const rnd = seededRandom(20261122);
  const pick = [...companies];
  const sample: number[] = [];
  while (sample.length < SAMPLE_COMPANIES && pick.length) sample.push(pick.splice(Math.floor(rnd() * pick.length), 1)[0]!.cik);
  const sampleSet = new Set(sample);

  const jobs: Array<{ co: CompanyFilings; f: Filing; needed: boolean }> = [];
  const need = new Map<number, Set<string>>();
  for (const co of companies) {
    const inputs: KindInput[] = co.earnings.map((f) => ({ accession: f.accession, form: f.form, filed: f.filingDate }));
    const n = needsText(inputs, co.reports);
    need.set(co.cik, n);
    for (const f of co.earnings) if (n.has(f.accession) || sampleSet.has(co.cik)) jobs.push({ co, f, needed: n.has(f.accession) });
  }
  const cached = jobs.filter((j) => fs.existsSync(cacheFile(`doc-${j.f.accession}.json`))).length;
  log(`classify: ${companies.length} companies, ${jobs.length} filings to read (${jobs.filter((j) => j.needed).length} needed, the rest for the ${sample.length}-company hand check; ${cached} cached)`);
  const reads = new Map<string, { read: TextRead; via: "8-K" | "ex99" | null; excerpt: string | null }>();
  let n = 0;
  await pool(jobs, 6, async (j) => {
    reads.set(j.f.accession, await readFilingText(j.f));
    if (++n % 500 === 0) log(`classify: ${n}/${jobs.length}`);
  });

  const kinds: Record<string, KindRecord> = {};
  const sampleReads: KindsFile["sampleReads"] = {};
  for (const co of companies) {
    const n2 = need.get(co.cik)!;
    const inputs: KindInput[] = co.earnings.map((f) => ({
      accession: f.accession,
      form: f.form,
      filed: f.filingDate,
      ...(n2.has(f.accession) ? { text: reads.get(f.accession)?.read ?? null } : {}),
    }));
    const out = classifyCompany(inputs, co.reports);
    for (const f of co.earnings) {
      const k = out.get(f.accession)!;
      const r = n2.has(f.accession) ? reads.get(f.accession) : undefined;
      kinds[f.accession] = { ...k, via: r?.via ?? null, cue: r?.read?.cue ?? null, excerpt: r?.excerpt?.slice(0, 400) ?? null };
      if (sampleSet.has(co.cik)) {
        const s = reads.get(f.accession);
        sampleReads[f.accession] = { kind: s?.read?.kind ?? null, cue: s?.read?.cue ?? null, via: s?.via ?? null, excerpt: s?.excerpt?.slice(0, 400) ?? null };
      }
    }
  }
  const file: KindsFile = { builtAtMs: Date.now(), kinds, sample, sampleReads };
  writeJson(KINDS_FILE, file);
  const tally: Record<string, number> = {};
  for (const k of Object.values(kinds)) tally[k.kind] = (tally[k.kind] ?? 0) + 1;
  log(`classify: ${Object.keys(kinds).length} filings: ${JSON.stringify(tally)} -> ${KINDS_FILE}`);
  return file;
}

// ---------------------------------------------------------------------------
// Phase: build

export type EventRow = {
  ticker: string;
  cik: number;
  event_date: string;
  filed_at: string;
  accession: string;
  filing_url: string;
  form: string;
  sector_etf: string | null;
  abnormal_return_d0_d1: number | null;
  stock_return_d0_d1: number | null;
  etf_return_d0_d1: number | null;
  /** Single days: d0 = close(d0)/close(d-1) - 1, d1 = close(d1)/close(d0) - 1 (the next session alone); abnormal = stock - ETF. */
  abnormal_return_d0: number | null;
  stock_return_d0: number | null;
  etf_return_d0: number | null;
  abnormal_return_d1: number | null;
  stock_return_d1: number | null;
  etf_return_d1: number | null;
  price_source: string | null;
  flags: EventFlag[];
  event_kind: EventKind | null;
  kind_reason: string | null;
  /** Report only (not stored): the d1 session is after the last close we have. */
  pending?: boolean;
};

function readEvents(): EventRow[] {
  if (!fs.existsSync(EVENTS_FILE)) return [];
  return fs
    .readFileSync(EVENTS_FILE, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as EventRow);
}

function normTicker(t: string): string {
  return t.toUpperCase().replace(/[.-]/g, "");
}

function buildPhase(universe: UniverseEntry[]): EventRow[] {
  const prices = loadPrices(universe);
  const kinds = fs.existsSync(KINDS_FILE) ? readJson<KindsFile>(KINDS_FILE).kinds : {};
  const minus = (a: number | null, b: number | null) => (a === null || b === null ? null : a - b);
  const rows: EventRow[] = [];
  const companies = new Map<number, CompanyFilings | null>();
  for (const u of universe) {
    if (u.cik === null) continue;
    if (!companies.has(u.cik)) companies.set(u.cik, readCompany(u.cik));
    const co = companies.get(u.cik);
    if (!co) continue;
    const cikMismatch = u.cikVia !== "exact" || !co.tickers.some((t) => normTicker(t) === normTicker(u.ticker));
    const ySeries = prices.yahoo.get(u.ticker);
    const dSeries = prices.databento.get(u.ticker);
    const firstPrice = [prices.yahooFirst.get(u.ticker), prices.databentoFirst.get(u.ticker)].filter((x): x is string => !!x).sort()[0] ?? null;
    for (const f of co.earnings) {
      const d0 = eventDay(f.acceptedMs);
      const w = windowSessions(d0);
      const flags = new Set<EventFlag>();
      if (f.form === "8-K/A") flags.add("amended");
      if (cikMismatch) flags.add("cik_mismatch");
      if (!firstPrice || w.base < firstPrice) flags.add("before_first_price");

      const days = (s: Closes | undefined) => (s ? dayReturns(s.get(w.base), s.get(w.d0), s.get(w.d1)) : null);
      const yDays = days(ySeries);
      const dDays = w.base >= DATABENTO_FROM ? days(dSeries) : null;
      const yRet = yDays?.d0d1 ?? null;
      const dRet = dDays?.d0d1 ?? null;
      const stock = dRet ?? yRet;
      if (dRet !== null && yRet !== null && Math.abs(dRet - yRet) > DISAGREE_ABS) flags.add("price_source_disagree");
      // Single days from the same source as the two-day return; when that is missing (d1 not in yet), from the first source with d0.
      const stockDays = dRet !== null ? dDays : yRet !== null ? yDays : dDays?.d0 != null ? dDays : yDays;

      let etf = u.etf;
      let etfDays = etf ? days(prices.yahoo.get(etf)) : null;
      let etfRet: number | null = etfDays?.d0d1 ?? null;
      if (etfRet === null) {
        const spyDays = days(prices.yahoo.get(MARKET_ETF));
        const spy = spyDays?.d0d1 ?? null;
        if (spy !== null || !etf) {
          if (etf !== MARKET_ETF) flags.add("etf_fallback_spy");
          etf = MARKET_ETF;
          etfRet = spy;
          etfDays = spyDays;
        }
      }
      const abn = abnormalReturn(stock, etfRet);
      const sD0 = stockDays?.d0 ?? null;
      const sD1 = stock === null ? null : (stockDays?.d1 ?? null);
      const eD0 = etfDays?.d0 ?? null;
      const eD1 = etfRet === null ? null : (etfDays?.d1 ?? null);
      const kind = kinds[f.accession];
      if (stock === null || etfRet === null) flags.add("missing_price");
      if (abn !== null && Math.abs(abn) > SUSPICIOUS_ABS) flags.add("suspicious_move");
      rows.push({
        ticker: u.ticker,
        cik: u.cik,
        event_date: d0,
        filed_at: new Date(f.acceptedMs).toISOString(),
        accession: f.accession,
        filing_url: filingIndexUrl(u.cik, f.accession),
        form: f.form,
        sector_etf: etf,
        abnormal_return_d0_d1: abn,
        stock_return_d0_d1: stock,
        etf_return_d0_d1: etfRet,
        abnormal_return_d0: minus(sD0, eD0),
        stock_return_d0: sD0,
        etf_return_d0: eD0,
        abnormal_return_d1: minus(sD1, eD1),
        stock_return_d1: sD1,
        etf_return_d1: eD1,
        price_source: stock !== null ? (dRet !== null ? "mixed" : "yahoo") : sD0 === null ? null : stockDays === dDays ? "mixed" : "yahoo",
        flags: [...flags],
        event_kind: kind?.kind ?? null,
        kind_reason: kind?.reason ?? null,
        pending: w.d1 > prices.lastYahoo,
      });
    }
  }
  const same = sameDayAccessions(rows.map((r) => ({ ticker: r.ticker, accession: r.accession, eventDate: r.event_date })));
  for (const r of rows) if (same.has(r.accession)) r.flags.push("multiple_same_day");
  for (const r of rows) r.flags.sort();
  rows.sort((a, b) => (a.ticker === b.ticker ? (a.filed_at < b.filed_at ? -1 : 1) : a.ticker < b.ticker ? -1 : 1));
  fs.writeFileSync(EVENTS_FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  log(`build: ${rows.length} events for ${new Set(rows.map((r) => r.ticker)).size} tickers -> ${EVENTS_FILE}`);
  return rows;
}

// ---------------------------------------------------------------------------
// Phase: write

const UPSERT_SQL = `insert into public.historical_events
  (ticker, event_date, filed_at, accession, filing_url, form, sector_etf,
   abnormal_return_d0_d1, stock_return_d0_d1, etf_return_d0_d1,
   abnormal_return_d0, stock_return_d0, etf_return_d0, abnormal_return_d1, stock_return_d1, etf_return_d1,
   price_source, flags, event_kind, kind_reason)
select ticker, event_date, filed_at, accession, filing_url, form, sector_etf,
   abnormal_return_d0_d1, stock_return_d0_d1, etf_return_d0_d1,
   abnormal_return_d0, stock_return_d0, etf_return_d0, abnormal_return_d1, stock_return_d1, etf_return_d1,
   price_source, coalesce(flags, '{}'), event_kind, kind_reason
from jsonb_to_recordset($1::jsonb) as x(
  ticker text, event_date date, filed_at timestamptz, accession text, filing_url text, form text, sector_etf text,
  abnormal_return_d0_d1 double precision, stock_return_d0_d1 double precision, etf_return_d0_d1 double precision,
  abnormal_return_d0 double precision, stock_return_d0 double precision, etf_return_d0 double precision,
  abnormal_return_d1 double precision, stock_return_d1 double precision, etf_return_d1 double precision,
  price_source text, flags text[], event_kind text, kind_reason text)
on conflict (ticker, accession) do update set
  event_date = excluded.event_date,
  filed_at = excluded.filed_at,
  filing_url = excluded.filing_url,
  form = excluded.form,
  sector_etf = excluded.sector_etf,
  abnormal_return_d0_d1 = excluded.abnormal_return_d0_d1,
  stock_return_d0_d1 = excluded.stock_return_d0_d1,
  etf_return_d0_d1 = excluded.etf_return_d0_d1,
  abnormal_return_d0 = excluded.abnormal_return_d0,
  stock_return_d0 = excluded.stock_return_d0,
  etf_return_d0 = excluded.etf_return_d0,
  abnormal_return_d1 = excluded.abnormal_return_d1,
  stock_return_d1 = excluded.stock_return_d1,
  etf_return_d1 = excluded.etf_return_d1,
  price_source = excluded.price_source,
  flags = excluded.flags,
  event_kind = excluded.event_kind,
  kind_reason = excluded.kind_reason`;

async function writePhase(rows: EventRow[]): Promise<void> {
  const url = env("DATABASE_URL");
  if (!url) throw new Error("DATABASE_URL is not set (environment or apps/web/.env.local)");
  const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
  await db.connect();
  try {
    const exists = await db.query<{ t: string | null }>("select to_regclass('public.historical_events')::text as t");
    if (!exists.rows[0]?.t) throw new Error("public.historical_events does not exist; apply 20261121_historical_events.sql first");
    const cols = await db.query<{ n: string }>("select count(*)::text n from information_schema.columns where table_schema = 'public' and table_name = 'historical_events' and column_name in ('abnormal_return_d0', 'event_kind')");
    if (cols.rows[0]?.n !== "2") throw new Error("historical_events lacks the d0/d1 and event_kind columns; apply 20261122_historical_events_d0.sql first");
    const BATCH = 1000;
    for (let i = 0; i < rows.length; i += BATCH) {
      const batch = rows.slice(i, i + BATCH).map(({ cik: _c, pending: _p, ...r }) => r);
      await db.query(UPSERT_SQL, [JSON.stringify(batch)]);
      if ((i / BATCH) % 10 === 0) log(`write: ${Math.min(i + BATCH, rows.length)}/${rows.length}`);
    }
    const n = await db.query<{ n: string; t: string }>("select count(*)::text n, count(distinct ticker)::text t from public.historical_events");
    log(`write: table now holds ${n.rows[0]!.n} rows for ${n.rows[0]!.t} tickers`);
  } finally {
    await db.end();
  }
}

// ---------------------------------------------------------------------------
// Phase: verify (acceptance instants against the EDGAR index pages)

type Check = {
  ticker: string;
  accession: string;
  form: string;
  url: string;
  ours_filed_at_ny: string;
  edgar_accepted_ny: string | null;
  edgar_filing_date: string | null;
  match: boolean;
  event_date: string;
  event_date_from_edgar: string | null;
};

async function verifyPhase(rows: EventRow[], n: number): Promise<Check[]> {
  const rnd = seededRandom(20261116);
  const picks: EventRow[] = [];
  const pool_ = [...rows];
  while (picks.length < n && pool_.length) picks.push(pool_.splice(Math.floor(rnd() * pool_.length), 1)[0]!);
  // Plus some old ones: big filers' 2016-2018 filings sit on the older `files` pages, whose clock is decided apart.
  const old = pool_.filter((r) => r.event_date < "2019-01-01");
  for (let k = 0; k < Math.ceil(n / 2) && old.length; k++) picks.push(old.splice(Math.floor(rnd() * old.length), 1)[0]!);
  const out: Check[] = [];
  for (const r of picks) {
    const page = await secCached(r.filing_url, `index-${r.accession}.htm.json`);
    const accepted = acceptedLine(page.body);
    const filingDate = /Filing Date<\/div>\s*<div class="info">([^<]+)<\/div>/.exec(page.body)?.[1]?.trim() ?? null;
    const ours = nyWall(Date.parse(r.filed_at));
    let fromEdgar: string | null = null;
    if (accepted) {
      // EDGAR prints New York wall time.
      const [d, t] = accepted.split(" ");
      const [hh, mm, ss] = (t ?? "0:0:0").split(":").map(Number) as [number, number, number];
      fromEdgar = eventDay(nyInstantMs(d!, hh * 60 + mm) + ss * 1000);
    }
    out.push({
      ticker: r.ticker,
      accession: r.accession,
      form: r.form,
      url: r.filing_url,
      ours_filed_at_ny: ours,
      edgar_accepted_ny: accepted,
      edgar_filing_date: filingDate,
      match: accepted === ours,
      event_date: r.event_date,
      event_date_from_edgar: fromEdgar,
    });
  }
  writeJson(VERIFY_FILE, out);
  const ok = out.filter((c) => c.match).length;
  log(`verify: ${ok}/${out.length} acceptance instants match the EDGAR index pages`);
  return out;
}

// ---------------------------------------------------------------------------
// Phase: report

function pct(x: number | null, digits = 2): string {
  return x === null ? "n/a" : `${(x * 100).toFixed(digits)}%`;
}

function reportPhase(universe: UniverseEntry[], rows: EventRow[], checks: Check[], meta: { runtimeS: number; written: boolean }): void {
  const lines: string[] = [];
  const P = (s = "") => lines.push(s);
  const byTicker = new Map<string, EventRow[]>();
  for (const r of rows) (byTicker.get(r.ticker) ?? byTicker.set(r.ticker, []).get(r.ticker)!).push(r);

  P("# Historical earnings events: build report");
  P();
  P(`Generated ${new Date().toISOString()} by packages/engine/scripts/earnings-events.ts${meta.written ? "" : " (dry run: nothing written)"}.`);
  P(`Table: public.historical_events (migration apps/web/supabase/migrations/20261121_historical_events.sql). Runtime of this run: ${meta.runtimeS.toFixed(0)} s.`);
  P();
  P("Events are 8-K / 8-K/A filings with item 2.02 accepted on EDGAR from 2016-01-01 to today. Event day d0 is the first NYSE session whose close (16:00 New York, 13:00 on early-close days) comes after the EDGAR acceptance instant. Abnormal return = (1+r_stock_d0)(1+r_stock_d1) - (1+r_etf_d0)(1+r_etf_d1), r_d = close(d)/close(d-1) - 1.");
  P();
  P("## Totals");
  P();
  P(`- Rows: **${rows.length}** (${rows.filter((r) => r.form === "8-K/A").length} of them 8-K/A)`);
  P(`- Tickers in the graph: ${universe.length}; with a CIK: ${universe.filter((u) => u.cik !== null).length}; with at least one event: **${byTicker.size}**`);
  P(`- Rows with an abnormal return: ${rows.filter((r) => r.abnormal_return_d0_d1 !== null).length}`);
  P();
  P("## Events per year (by event day)");
  P();
  P("| Year | Events | Tickers | With abnormal return |");
  P("|---|---:|---:|---:|");
  for (let y = 2016; y <= 2026; y++) {
    const ys = rows.filter((r) => r.event_date.startsWith(String(y)));
    P(`| ${y} | ${ys.length} | ${new Set(ys.map((r) => r.ticker)).size} | ${ys.filter((r) => r.abnormal_return_d0_d1 !== null).length} |`);
  }
  P();

  // Zero-event tickers and why.
  P("## Tickers with zero events, and why");
  P();
  const reasons = new Map<string, string[]>();
  const companies = new Map<number, CompanyFilings | null>();
  for (const u of universe) {
    if (byTicker.has(u.ticker)) continue;
    let why: string;
    if (u.cik === null) why = "no CIK (not in SEC company_tickers.json, no filer URL in the graph)";
    else {
      if (!companies.has(u.cik)) companies.set(u.cik, readCompany(u.cik));
      const co = companies.get(u.cik);
      if (!co) why = "submissions file not readable";
      else {
        const foreign = (co.forms["20-F"] ?? 0) + (co.forms["40-F"] ?? 0) + (co.forms["6-K"] ?? 0);
        const domestic = (co.forms["10-K"] ?? 0) + (co.forms["10-Q"] ?? 0);
        if (foreign > domestic) why = "foreign private issuer (reports on 20-F / 40-F / 6-K, not 8-K item 2.02)";
        else if (/\b(trust|fund|etf)\b/i.test(co.name)) why = "exchange-traded fund or trust (no earnings releases)";
        else if (co.earliestFiling && co.earliestFiling >= "2025-01-01") why = "recent registrant (first EDGAR filing 2025 or later), no item 2.02 yet";
        else if (!co.any8kSince) why = "no 8-K since 2016";
        else why = "files 8-Ks but none with item 2.02 since 2016";
      }
    }
    (reasons.get(why) ?? reasons.set(why, []).get(why)!).push(u.ticker);
  }
  const zero = universe.length - byTicker.size;
  P(`${zero} tickers have no event.`);
  P();
  for (const [why, ts] of [...reasons.entries()].sort((a, b) => b[1].length - a[1].length)) P(`- **${why}** (${ts.length}): ${ts.join(", ")}`);
  P();

  // CIK mapping notes.
  P("## Ticker -> CIK mapping");
  P();
  const via = new Map<string, string[]>();
  for (const u of universe) (via.get(String(u.cikVia)) ?? via.set(String(u.cikVia), []).get(String(u.cikVia))!).push(u.ticker);
  for (const [k, ts] of via) P(`- ${k}: ${ts.length}${k === "exact" ? "" : ` (${ts.join(", ")})`}`);
  const mism = [...byTicker.entries()].filter(([, rs]) => rs[0]!.flags.includes("cik_mismatch")).map(([t]) => t);
  P(`- Tickers flagged cik_mismatch (found other than by exact ticker, or the CIK's EDGAR ticker list lacks the ticker): ${mism.length}${mism.length ? `: ${mism.join(", ")}` : ""}`);
  P();

  // Flags.
  P("## Flag counts");
  P();
  P("| Flag | Rows | Tickers |");
  P("|---|---:|---:|");
  const flagNames: EventFlag[] = ["missing_price", "etf_fallback_spy", "amended", "multiple_same_day", "suspicious_move", "before_first_price", "cik_mismatch", "price_source_disagree"];
  for (const f of flagNames) {
    const fr = rows.filter((r) => r.flags.includes(f));
    P(`| ${f} | ${fr.length} | ${new Set(fr.map((r) => r.ticker)).size} |`);
  }
  P(`| (no flag) | ${rows.filter((r) => r.flags.length === 0).length} | |`);
  P();
  const pending = rows.filter((r) => r.pending);
  P(`Of the missing_price rows, ${pending.length} are events whose d1 close is not in yet (latest SPY close ${loadPrices([]).lastYahoo}) and ${rows.filter((r) => r.flags.includes("missing_price") && r.flags.includes("before_first_price")).length} fall before the ticker's first price.`);
  P();
  P("ETF fallback to SPY by sector ETF:");
  const fb = new Map<string, number>();
  for (const r of rows.filter((r) => r.flags.includes("etf_fallback_spy"))) {
    const etf = universe.find((u) => u.ticker === r.ticker)?.etf ?? "none";
    fb.set(etf, (fb.get(etf) ?? 0) + 1);
  }
  P([...fb.entries()].map(([k, v]) => `${k} ${v}`).join(", ") || "none");
  P();

  P("## Tickers with missing or suspicious data");
  P();
  const worst = [...byTicker.entries()]
    .map(([t, rs]) => ({ t, n: rs.length, miss: rs.filter((r) => r.flags.includes("missing_price") && !r.pending).length, sus: rs.filter((r) => r.flags.includes("suspicious_move")).length, dis: rs.filter((r) => r.flags.includes("price_source_disagree")).length }))
    .filter((x) => x.miss || x.sus || x.dis)
    .sort((a, b) => b.miss + b.sus + b.dis - (a.miss + a.sus + a.dis));
  P(`${worst.length} tickers have at least one missing price (not counting events still in progress), suspicious move or source disagreement. Top 60:`);
  P();
  P("| Ticker | Events | Missing price | Suspicious (abs > 50%) | Source disagree |");
  P("|---|---:|---:|---:|---:|");
  for (const x of worst.slice(0, 60)) P(`| ${x.t} | ${x.n} | ${x.miss} | ${x.sus} | ${x.dis} |`);
  P();
  const noPrice = [...byTicker.entries()].filter(([, rs]) => rs.every((r) => r.abnormal_return_d0_d1 === null)).map(([t]) => t);
  P(`Tickers with events but no priced event at all (${noPrice.length}): ${noPrice.join(", ") || "none"}`);
  P();
  const sus = rows.filter((r) => r.flags.includes("suspicious_move")).sort((a, b) => Math.abs(b.abnormal_return_d0_d1!) - Math.abs(a.abnormal_return_d0_d1!));
  P("Largest suspicious moves:");
  P();
  P("| Ticker | Event day | Abnormal | Stock | ETF | Source |");
  P("|---|---|---:|---:|---:|---|");
  for (const r of sus.slice(0, 15)) P(`| ${r.ticker} | ${r.event_date} | ${pct(r.abnormal_return_d0_d1)} | ${pct(r.stock_return_d0_d1)} | ${pct(r.etf_return_d0_d1)} (${r.sector_etf}) | ${r.price_source} |`);
  P();

  const dis = rows.filter((r) => r.flags.includes("price_source_disagree"));
  P(`Databento and Yahoo disagree on the stock's two-day return by more than ${DISAGREE_ABS * 100} points (${dis.length} rows; the stored value is Databento's):`);
  P();
  for (const r of dis) P(`- ${r.ticker} ${r.event_date}: stored ${pct(r.stock_return_d0_d1)}`);
  P();
  P("## Price-source mix");
  P();
  const mix = new Map<string, number>();
  for (const r of rows) mix.set(String(r.price_source), (mix.get(String(r.price_source)) ?? 0) + 1);
  for (const [k, v] of mix) P(`- ${k === "null" ? "unpriced (null)" : k}: ${v}`);
  P("- 'mixed' = stock closes from Databento EQUS.SUMMARY (Supabase prices_daily, split-adjusted with prices_splits, not dividend-adjusted), ETF closes from Yahoo (no ETFs in prices_daily). 'yahoo' = stock and ETF Yahoo adjusted closes. Databento is used when d-1 >= 2024-07-01 and it has all three closes.");
  P();

  P("## Distribution of abnormal returns (d0+d1)");
  P();
  const abn = rows.map((r) => r.abnormal_return_d0_d1).filter((x): x is number => x !== null).sort((a, b) => a - b);
  const absAbn = abn.map(Math.abs).sort((a, b) => a - b);
  P(`N = ${abn.length}. p1 ${pct(percentile(abn, 0.01))}, p5 ${pct(percentile(abn, 0.05))}, p25 ${pct(percentile(abn, 0.25))}, **median ${pct(percentile(abn, 0.5))}**, p75 ${pct(percentile(abn, 0.75))}, p95 ${pct(percentile(abn, 0.95))}, p99 ${pct(percentile(abn, 0.99))}. Mean ${pct(abn.reduce((s, x) => s + x, 0) / Math.max(1, abn.length))}.`);
  P(`Absolute abnormal: median ${pct(percentile(absAbn, 0.5))}, p95 ${pct(percentile(absAbn, 0.95))}.`);
  P();
  P("| Year | N | p5 | Median | p95 | Median abs |");
  P("|---|---:|---:|---:|---:|---:|");
  for (let y = 2016; y <= 2026; y++) {
    const ys = rows.filter((r) => r.event_date.startsWith(String(y))).map((r) => r.abnormal_return_d0_d1).filter((x): x is number => x !== null).sort((a, b) => a - b);
    const ya = ys.map(Math.abs).sort((a, b) => a - b);
    P(`| ${y} | ${ys.length} | ${pct(percentile(ys, 0.05))} | ${pct(percentile(ys, 0.5))} | ${pct(percentile(ys, 0.95))} | ${pct(percentile(ya, 0.5))} |`);
  }
  P();

  reportKinds(rows, P);

  P("## Timing: acceptance vs the close");
  P();
  const sameDay = rows.filter((r) => nyDate(Date.parse(r.filed_at)) === r.event_date).length;
  P(`${sameDay} events react the acceptance day (accepted before the close), ${rows.length - sameDay} the next session (after the close, weekend or holiday).`);
  P();

  P("## Spot checks against EDGAR");
  P();
  const okN = checks.filter((c) => c.match).length;
  const indep = path.join(ROOT, "verify-independent.json");
  if (fs.existsSync(indep)) {
    const v = readJson<{ ok: number; n: number }>(indep);
    P(`Independent check: ${v.ok}/${v.n} further random events (seed 7, none used for the clock calibration or the check below) match EDGAR's Accepted line to the second.`);
    P();
  }
  P(`${checks.length} events drawn at random (seed 20261116); each EDGAR filing index page was read and its "Accepted" line (New York time) compared with filed_at. ${okN}/${checks.length} match to the second; event day recomputed from EDGAR's own time agrees for ${checks.filter((c) => c.event_date_from_edgar === c.event_date).length}/${checks.length}.`);
  P();
  P("First five (by hand):");
  P();
  P("| Ticker | Form | EDGAR Accepted (NY) | Our filed_at (NY) | Event day | Filing index |");
  P("|---|---|---|---|---|---|");
  for (const c of checks.slice(0, 5)) P(`| ${c.ticker} | ${c.form} | ${c.edgar_accepted_ny} | ${c.ours_filed_at_ny} | ${c.event_date} | ${c.url} |`);
  const bad = checks.filter((c) => !c.match || c.event_date_from_edgar !== c.event_date);
  if (bad.length) {
    P();
    P("Mismatches:");
    for (const c of bad) P(`- ${c.ticker} ${c.accession}: EDGAR ${c.edgar_accepted_ny}, ours ${c.ours_filed_at_ny}, event ${c.event_date} vs ${c.event_date_from_edgar}`);
  }
  P();
  if (fs.existsSync(CALIBRATION_FILE)) {
    const cal = Object.values(readJson<Record<string, Calibration>>(CALIBRATION_FILE));
    const t: Record<string, number> = {};
    for (const c of cal) t[`${c.convention} (heuristic said ${c.heuristic ?? "null"})`] = (t[`${c.convention} (heuristic said ${c.heuristic ?? "null"})`] ?? 0) + 1;
    P();
    P(`Clock calibration: each of ${cal.length} submissions files and older pages was checked against one of its filings' EDGAR index page (the Accepted line), and that file's stamps are read with the clock that matched: ${Object.entries(t).map(([k, v]) => `${k}: ${v}`).join("; ")}. Files left "unknown" fall back to the heuristic in src/edgar-time.ts.`);
  }
  P();
  P("## Notes");
  P();
  P("- Acceptance instants come from the submissions JSON `acceptanceDateTime`. src/edgar-time.ts holds that some files are written shifted by New York's offset since 2026-10; its heuristic called 332 of the files read here shifted, but the calibration (one EDGAR index page per file) found every file on the true UTC clock on 2026-11-16, so all stamps are read as UTC. Worth a look for the engine's live readers of edgar-time.ts.");
  P("- price_source_disagree rows: BDX, FTV and HON are spin-offs inside the window (Databento closes are not adjusted for them; Yahoo's are), CALY's 2024 Databento closes belong to the symbol's earlier holder; SUPN's Yahoo closes look wrong (Databento matches the listed price), which also makes its pre-2024-07 Yahoo-based rows doubtful.");
  P("- Every graph ticker is today's symbol. A company that changed ticker keeps its CIK history; Yahoo/Databento history is under today's symbol, so events from before a listing or a symbol change are flagged before_first_price and carry no return.");
  P("- eps_surprise is NULL for every row (no analyst estimate source wired yet).");
  P("- 8-K/A rows are kept beside their originals and flagged amended; an 8-K/A usually re-files exhibits, so its abnormal return repeats or follows the original's window.");
  fs.writeFileSync(REPORT_FILE, lines.join("\n") + "\n");
  log(`report: ${REPORT_FILE}`);
}

/** Event kinds and single-day moves: per year, what was reclassified, examples, the hand check. */
function reportKinds(rows: EventRow[], P: (s?: string) => void): void {
  const kindOf = (r: EventRow) => r.event_kind ?? "unclassified";
  P("## Event kinds");
  P();
  P("Each Item 2.02 filing is classified (src/study/event-kind.ts, phase classify): the only Item 2.02 8-K between a quarter end and its 10-Q / 10-K is the earnings release; filings that share such a window, fall outside every window or are 8-K/As are read (the 8-K's Item 2.02 paragraph and exhibit list, else exhibit 99's first lines) for results, preliminary, production/deliveries, monthly-sales and guidance wording.");
  P();
  P(`| Year | ${EVENT_KINDS.join(" | ")} | Total |`);
  P(`|---|${EVENT_KINDS.map(() => "---:").join("|")}|---:|`);
  for (let y = 2016; y <= 2026; y++) {
    const ys = rows.filter((r) => r.event_date.startsWith(String(y)));
    P(`| ${y} | ${EVENT_KINDS.map((k) => ys.filter((r) => kindOf(r) === k).length).join(" | ")} | ${ys.length} |`);
  }
  const tot = EVENT_KINDS.map((k) => rows.filter((r) => kindOf(r) === k).length);
  P(`| All | ${tot.join(" | ")} | ${rows.length} |`);
  const unclassified = rows.filter((r) => !r.event_kind).length;
  if (unclassified) P(`\n${unclassified} rows have no kind (their filing was not classified).`);
  P();
  const re = rows.filter((r) => r.event_kind && r.event_kind !== "earnings");
  const viaText = re.filter((r) => /text:/.test(r.kind_reason ?? "")).length;
  P(`Reclassified away from earnings: **${re.length}** rows (${new Set(re.map((r) => r.accession)).size} filings, ${new Set(re.map((r) => r.ticker)).size} tickers); ${viaText} on their own wording, ${re.length - viaText} on timing alone (amendments, second filings in a window, filings outside any window).`);
  P();
  const perTicker = new Map<string, number>();
  for (const r of re) perTicker.set(r.ticker, (perTicker.get(r.ticker) ?? 0) + 1);
  P(`Most reclassified tickers: ${[...perTicker.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([t, n]) => `${t} ${n}`).join(", ")}.`);
  P();
  const rnd = seededRandom(7);
  for (const k of EVENT_KINDS.filter((x) => x !== "earnings")) {
    const ks = rows.filter((r) => r.event_kind === k);
    if (!ks.length) continue;
    P(`Examples, ${k} (${ks.length}):`);
    P();
    const picks: EventRow[] = [];
    const pool_ = [...ks];
    while (picks.length < 6 && pool_.length) picks.push(pool_.splice(Math.floor(rnd() * pool_.length), 1)[0]!);
    for (const r of picks) P(`- ${r.ticker} ${r.event_date}: ${r.kind_reason} (${r.filing_url})`);
    P();
  }
  const tsla = rows.filter((r) => r.ticker === "TSLA");
  if (tsla.length) {
    P(`TSLA: ${tsla.length} Item 2.02 filings, ${EVENT_KINDS.map((k) => `${k} ${tsla.filter((r) => r.event_kind === k).length}`).join(", ")}.`);
    P();
    P("| Event day | Kind | Abnormal d0 | d1 | d0+d1 | Reason |");
    P("|---|---|---:|---:|---:|---|");
    for (const r of tsla.slice(-12)) P(`| ${r.event_date} | ${r.event_kind} | ${pct(r.abnormal_return_d0)} | ${pct(r.abnormal_return_d1)} | ${pct(r.abnormal_return_d0_d1)} | ${r.kind_reason} |`);
    P();
  }
  const hand = path.join(ROOT, "kind-handcheck.json");
  if (fs.existsSync(hand)) {
    const h = readJson<{ companies: number; filings: number; correct: number; earningsPrecision: string; nonEarningsPrecision: string; notes: string[] }>(hand);
    P(`Hand check: every filing of ${h.companies} companies drawn at random (seed 20261122) was read (8-K Item 2.02 text or exhibit 99) and compared with its kind: ${h.correct}/${h.filings} right. Precision of 'earnings' ${h.earningsPrecision}; of the other kinds ${h.nonEarningsPrecision}.`);
    for (const n of h.notes) P(`- ${n}`);
    P();
  }

  P("## Single-day moves (earnings releases)");
  P();
  const earn = rows.filter((r) => (r.event_kind ?? "earnings") === "earnings");
  const dist = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
    const a = v.map(Math.abs).sort((x, y) => x - y);
    return `N ${v.length}, median ${pct(percentile(v, 0.5))}, median abs ${pct(percentile(a, 0.5))}, p95 abs ${pct(percentile(a, 0.95))}`;
  };
  P(`- Abnormal d0 (event day alone): ${dist(earn.map((r) => r.abnormal_return_d0))}`);
  P(`- Abnormal d1 (next session alone): ${dist(earn.map((r) => r.abnormal_return_d1))}`);
  P(`- Abnormal d0+d1 (compounded): ${dist(earn.map((r) => r.abnormal_return_d0_d1))}`);
  P(`- Stock d0 (raw): ${dist(earn.map((r) => r.stock_return_d0))}`);
  let worst = 0;
  for (const r of rows) {
    for (const [d0, d1, two] of [
      [r.stock_return_d0, r.stock_return_d1, r.stock_return_d0_d1],
      [r.etf_return_d0, r.etf_return_d1, r.etf_return_d0_d1],
    ] as const) {
      if (d0 !== null && d1 !== null && two !== null) worst = Math.max(worst, Math.abs((1 + d0) * (1 + d1) - 1 - two));
    }
  }
  P(`- Consistency: (1 + d0)(1 + d1) - 1 equals the stored two-day return for the stock and the ETF on every row (largest difference ${worst.toExponential(1)}). Rows with d0 but no d1: ${rows.filter((r) => r.abnormal_return_d0 !== null && r.abnormal_return_d1 === null).length} (the d1 close not in yet, or missing).`);
  P();
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  fs.mkdirSync(EDGAR_DIR, { recursive: true });
  fs.mkdirSync(YAHOO_DIR, { recursive: true });
  log(`cache: ${ROOT}${DRY ? " (dry run: no database writes)" : ""}`);
  const universe = want("universe") || !fs.existsSync(UNIVERSE_FILE) ? await universePhase() : readJson<UniverseEntry[]>(UNIVERSE_FILE);
  if (want("edgar")) await edgarPhase(universe);
  if (want("calibrate")) await calibratePhase(universe);
  if (want("prices")) await pricesPhase(universe);
  if (want("classify")) await classifyPhase(universe);
  const rows = want("build") ? buildPhase(universe) : readEvents();
  let written = false;
  if (want("write")) {
    if (DRY) log("write: skipped (--dry-run)");
    else {
      await writePhase(rows);
      written = true;
    }
  }
  const checks = want("verify") ? await verifyPhase(rows, 25) : fs.existsSync(VERIFY_FILE) ? readJson<Check[]>(VERIFY_FILE) : [];
  if (want("report")) reportPhase(universe, rows, checks, { runtimeS: (Date.now() - t0) / 1000, written });
}

main().catch((err) => {
  console.error(`earnings-events failed: ${safeMessage(err)}`);
  process.exit(1);
});
