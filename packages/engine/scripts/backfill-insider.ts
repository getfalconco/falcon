/**
 * F7 own estimate (design docs/design/ripple-engine-v1.md 10 a10, 7.1 "Documented").
 *
 *   node --import tsx scripts/backfill-insider.ts [phase ...] [--control-sample 0.2]
 *
 * Phases (default: all, in order; each one resumes from its cache):
 *   download  SEC Insider Transactions Data Sets 2012Q1-2026Q2 quarterly zips
 *             into .cache/study/insider (system curl, resumable)
 *   parse     unzip -p the three tables -> one compact JSON per quarter of
 *             open-market P and S rows
 *   events    routine and 10b5-1 filters, cluster and single-purchase rules,
 *             2015-01-01 .. 2026-06-30 -> f7-events.json
 *   sec       company_tickers_exchange.json, XBRL frames of
 *             dei:EntityCommonStockSharesOutstanding, and per-CIK submissions
 *             (SIC, 8-K Item 2.02 dates) for event issuers and the control pool
 *   prices    Yahoo daily chart per ticker (internal research stand-in; nothing
 *             is displayed), split events kept so unadjusted prices can be
 *             rebuilt for the $5 gate
 *   accept    EDGAR acceptance times of the filings that complete each gated event
 *   measure   market-model legs, matched controls, summaries -> f7-panel.ndjson,
 *             f7-summary.json, f7-summary.md
 *
 * Everything lives under packages/engine/.cache/study (gitignored). SEC is
 * read at <= 8 requests a second with a declared User-Agent; Yahoo politely.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  closeReturn,
  entryIndex,
  eventStudy,
  fitMarketModel,
  measureEvent,
  nyInstantMs,
  nyseSessions,
  reactionDayIndex,
  ESTIMATION,
  type PriceSeries,
  type StudySummary,
} from "../src/study/abnormal.ts";
import { matchedOutcome, selectControls, type ControlCandidate } from "../src/study/controls.ts";
import { eventPublicMs, findInsiderEvents, isRoutine, tradeMonths, type InsiderEvent, type PurchaseFiling } from "../src/study/insider-events.ts";
import { median, neweyWestMean, seededRandom } from "../src/study/stats.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(here, "..", ".cache", "study");
const ZIP_DIR = path.join(ROOT, "insider");
const PARSED_DIR = path.join(ROOT, "insider-parsed");
const SUB_DIR = path.join(ROOT, "submissions");
const YAHOO_DIR = path.join(ROOT, "yahoo");
const FRAMES_DIR = path.join(ROOT, "frames");
const ACCEPT_FILE = path.join(ROOT, "acceptance.ndjson");
const EVENTS_FILE = path.join(ROOT, "f7-events.json");
const PANEL_FILE = path.join(ROOT, "f7-panel.ndjson");
const SUMMARY_FILE = path.join(ROOT, "f7-summary.json");
const SUMMARY_MD = path.join(ROOT, "f7-summary.md");

const SEC_UA = "Falcon research research@getfalcon.co";
// Yahoo answers 429 to some full browser strings and 200 to this short one (checked 2026-11-14).
const BROWSER_UA = "Mozilla/5.0";

const EVENT_FROM = "2015-01-01";
const EVENT_TO = "2026-06-30";
const PRICE_FROM = "2013-06-01";
const WINDOWS = [5, 20, 60] as const;
const LISTED = new Set(["Nasdaq", "NYSE", "CBOE"]);

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const CONTROL_SAMPLE = Number(flag("--control-sample") ?? "1");
const phases = args.filter((a, i) => !a.startsWith("--") && !(i > 0 && args[i - 1]!.startsWith("--")));
const want = (p: string) => phases.length === 0 || phases.includes(p) || phases.includes("all");

const t0 = Date.now();
function log(...xs: unknown[]): void {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0).padStart(5)}s]`, ...xs);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(ROOT, { recursive: true });

// ---------------------------------------------------------------------------
// Polite HTTP: one spacing queue per host family, retries with backoff.

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

const secQueue = limiter(125, 6); // <= 8 a second
const yahooQueue = limiter(200, 3);

async function getText(url: string, ua: string, queue: ReturnType<typeof limiter>, tries = 6): Promise<{ status: number; body: string }> {
  let wait = 2000;
  for (let k = 0; k < tries; k++) {
    try {
      const res = await queue(() => fetch(url, { headers: { "User-Agent": ua, Accept: "*/*" }, signal: AbortSignal.timeout(30_000) }));
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        await sleep(res.status === 429 ? Math.max(wait, 20_000) : wait);
        wait *= 2;
        continue;
      }
      return { status: res.status, body: await res.text() };
    } catch {
      await sleep(wait);
      wait = Math.min(wait * 2, 60_000);
    }
  }
  return { status: 0, body: "" };
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
// Phase: parse

type Row = {
  acc: string;
  issuer: string;
  owner: string;
  filed: string;
  trans: string;
  code: "P" | "S";
  shares: number;
  price: number;
  /** Purchase usable for events: original Form 4, common stock, acquired, not 10b5-1. */
  ok: boolean;
  od: boolean;
  aff: string;
  sym: string;
};

const MONTHS: Record<string, string> = { JAN: "01", FEB: "02", MAR: "03", APR: "04", MAY: "05", JUN: "06", JUL: "07", AUG: "08", SEP: "09", OCT: "10", NOV: "11", DEC: "12" };
function sasDate(s: string | undefined): string | null {
  const m = /^(\d{2})-([A-Z]{3})-(\d{4})/.exec((s ?? "").trim().toUpperCase());
  if (m) return `${m[3]}-${MONTHS[m[2]!]}-${m[1]}`;
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(s ?? "");
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null;
}

function readTsv(zip: string, table: string): { header: string[]; rows: string[][] } {
  const names = execFileSync("unzip", ["-Z1", zip], { encoding: "utf8" }).split("\n").map((x) => x.trim());
  const name = names.find((n) => n.toUpperCase() === `${table}.TSV` || n.toUpperCase().endsWith(`/${table}.TSV`));
  if (!name) throw new Error(`${path.basename(zip)}: no ${table}.tsv`);
  const text = execFileSync("unzip", ["-p", zip, name], { encoding: "latin1", maxBuffer: 1 << 30 });
  const lines = text.split(/\r?\n/);
  const header = lines[0]!.split("\t").map((h) => h.trim().toUpperCase());
  const rows: string[][] = [];
  for (let i = 1; i < lines.length; i++) if (lines[i]) rows.push(lines[i]!.split("\t"));
  return { header, rows };
}

function quarters(): string[] {
  const out: string[] = [];
  for (let y = 2012; y <= 2026; y++) for (let q = 1; q <= 4; q++) if (y < 2026 || q <= 2) out.push(`${y}q${q}`);
  return out;
}

/**
 * Quarterly zips from SEC's index page, with the system curl: resumable (-C -)
 * into <name>.part, checked with `unzip -t`, then renamed. Run again after a
 * network failure; finished zips are skipped.
 */
async function downloadPhase(): Promise<void> {
  fs.mkdirSync(ZIP_DIR, { recursive: true });
  const missing = quarters().filter((q) => !fs.existsSync(path.join(ZIP_DIR, `${q}_form345.zip`)));
  if (!missing.length) return;
  const page = await getText("https://www.sec.gov/data-research/sec-markets-data/insider-transactions-data-sets", SEC_UA, secQueue);
  const hrefs = [...page.body.matchAll(/href="([^"]*?(\d{4}q\d)_form345\.zip)"/g)].map((m) => ({ href: m[1]!, q: m[2]! }));
  for (const q of missing) {
    const h = hrefs.find((x) => x.q === q);
    if (!h) {
      log(`download: ${q} not on SEC's index page`);
      continue;
    }
    const dest = path.join(ZIP_DIR, `${q}_form345.zip`);
    for (let attempt = 1; attempt <= 6; attempt++) {
      try {
        execFileSync("curl", ["-s", "-f", "-C", "-", "--retry", "5", "--retry-delay", "5", "--max-time", "900", "-A", SEC_UA, "-o", `${dest}.part`, new URL(h.href, "https://www.sec.gov").href]);
        execFileSync("unzip", ["-tq", `${dest}.part`]);
        fs.renameSync(`${dest}.part`, dest);
        log(`download: ${q} ok`);
        break;
      } catch {
        log(`download: ${q} attempt ${attempt} failed`);
        await sleep(10_000);
      }
    }
    await sleep(500);
  }
}

function parsePhase(): void {
  fs.mkdirSync(PARSED_DIR, { recursive: true });
  for (const q of quarters()) {
    const out = path.join(PARSED_DIR, `${q}.json`);
    if (fs.existsSync(out)) continue;
    const zip = path.join(ZIP_DIR, `${q}_form345.zip`);
    if (!fs.existsSync(zip)) {
      log(`parse: ${q} zip missing, skipped (rerun after the download finishes)`);
      continue;
    }
    const sub = readTsv(zip, "SUBMISSION");
    const own = readTsv(zip, "REPORTINGOWNER");
    const nd = readTsv(zip, "NONDERIV_TRANS");
    const col = (h: string[], n: string) => h.indexOf(n);
    const S = { acc: col(sub.header, "ACCESSION_NUMBER"), filed: col(sub.header, "FILING_DATE"), doc: col(sub.header, "DOCUMENT_TYPE"), issuer: col(sub.header, "ISSUERCIK"), sym: col(sub.header, "ISSUERTRADINGSYMBOL"), aff: col(sub.header, "AFF10B5ONE") };
    const subs = new Map<string, { filed: string; doc: string; issuer: string; sym: string; aff: string }>();
    for (const r of sub.rows) {
      const filed = sasDate(r[S.filed]);
      if (!filed) continue;
      subs.set(r[S.acc]!, { filed, doc: (r[S.doc] ?? "").trim(), issuer: String(Number(r[S.issuer])), sym: (r[S.sym] ?? "").trim().toUpperCase(), aff: S.aff >= 0 ? (r[S.aff] ?? "").trim() : "" });
    }
    const O = { acc: col(own.header, "ACCESSION_NUMBER"), cik: col(own.header, "RPTOWNERCIK"), rel: col(own.header, "RPTOWNER_RELATIONSHIP") };
    const owners = new Map<string, { owner: string; od: boolean }>();
    for (const r of own.rows) {
      const acc = r[O.acc]!;
      if (owners.has(acc)) continue; // first reporting owner = the insider of the filing
      const rel = (r[O.rel] ?? "").toLowerCase();
      owners.set(acc, { owner: String(Number(r[O.cik])), od: rel.includes("director") || rel.includes("officer") });
    }
    const N = {
      acc: col(nd.header, "ACCESSION_NUMBER"),
      title: col(nd.header, "SECURITY_TITLE"),
      date: col(nd.header, "TRANS_DATE"),
      code: col(nd.header, "TRANS_CODE"),
      shares: col(nd.header, "TRANS_SHARES"),
      price: col(nd.header, "TRANS_PRICEPERSHARE"),
      ad: col(nd.header, "TRANS_ACQUIRED_DISP_CD"),
    };
    const rows: Row[] = [];
    for (const r of nd.rows) {
      const code = (r[N.code] ?? "").trim().toUpperCase();
      if (code !== "P" && code !== "S") continue;
      const s = subs.get(r[N.acc]!);
      const o = owners.get(r[N.acc]!);
      const trans = sasDate(r[N.date]);
      if (!s || !o || !trans) continue;
      const shares = Number(r[N.shares]);
      const price = Number(r[N.price]);
      const title = (r[N.title] ?? "").toLowerCase();
      const common = /common|ordinary|class a|cl a|shares/.test(title) && !/preferred|warrant|option|unit|note|debenture|right/.test(title);
      const ok = code === "P" && s.doc === "4" && common && (r[N.ad] ?? "").trim().toUpperCase() === "A" && shares > 0 && price > 0 && s.aff !== "1" && s.aff.toLowerCase() !== "true";
      rows.push({ acc: r[N.acc]!, issuer: s.issuer, owner: o.owner, filed: s.filed, trans, code, shares: Number.isFinite(shares) ? shares : 0, price: Number.isFinite(price) ? price : 0, ok, od: o.od, aff: s.aff, sym: s.sym });
    }
    fs.writeFileSync(out, JSON.stringify(rows));
    log(`parse: ${q} ${rows.length} P/S rows (${rows.filter((r) => r.ok).length} usable purchases)`);
  }
}

function loadRows(): Row[] {
  const all: Row[] = [];
  for (const q of quarters()) {
    const f = path.join(PARSED_DIR, `${q}.json`);
    if (!fs.existsSync(f)) throw new Error(`parsed ${q} missing; run the parse phase after the download finishes`);
    for (const r of JSON.parse(fs.readFileSync(f, "utf8")) as Row[]) all.push(r);
  }
  return all;
}

// ---------------------------------------------------------------------------
// Phase: sec (frames, tickers, submissions)

type SharesPoint = { end: string; val: number };

async function framesPhase(): Promise<void> {
  fs.mkdirSync(FRAMES_DIR, { recursive: true });
  const periods: string[] = [];
  for (let y = 2013; y <= 2026; y++) for (let q = 1; q <= 4; q++) if (y < 2026 || q <= 3) periods.push(`CY${y}Q${q}I`);
  await pool(periods, 3, async (p) => {
    const f = path.join(FRAMES_DIR, `${p}.json`);
    if (fs.existsSync(f)) return;
    const r = await getText(`https://data.sec.gov/api/xbrl/frames/dei/EntityCommonStockSharesOutstanding/shares/${p}.json`, SEC_UA, secQueue);
    if (r.status === 200) fs.writeFileSync(f, r.body);
    else log(`frames ${p}: HTTP ${r.status}`);
  });
}

function loadShares(): Map<string, SharesPoint[]> {
  const out = new Map<string, SharesPoint[]>();
  for (const f of fs.readdirSync(FRAMES_DIR)) {
    const j = JSON.parse(fs.readFileSync(path.join(FRAMES_DIR, f), "utf8")) as { data?: Array<{ cik: number; end: string; val: number }> };
    for (const d of j.data ?? []) {
      const k = String(d.cik);
      let a = out.get(k);
      if (!a) out.set(k, (a = []));
      a.push({ end: d.end, val: d.val });
    }
  }
  for (const a of out.values()) a.sort((x, y) => (x.end < y.end ? -1 : 1));
  return out;
}

/** Shares outstanding as of the latest cover-page instant on or before `date` (within 15 months). */
function sharesAt(points: SharesPoint[] | undefined, date: string): number | null {
  if (!points) return null;
  let best: SharesPoint | null = null;
  for (const p of points) if (p.end <= date) best = p;
  if (!best || Date.parse(date) - Date.parse(best.end) > 460 * 86_400_000) return null;
  return best.val > 0 ? best.val : null;
}

type Listing = { cik: string; ticker: string; exchange: string };

async function tickersFile(): Promise<Listing[]> {
  const f = path.join(ROOT, "company_tickers_exchange.json");
  if (!fs.existsSync(f)) {
    const r = await getText("https://www.sec.gov/files/company_tickers_exchange.json", SEC_UA, secQueue);
    if (r.status !== 200) throw new Error(`company_tickers_exchange.json: HTTP ${r.status}`);
    fs.writeFileSync(f, r.body);
  }
  const j = JSON.parse(fs.readFileSync(f, "utf8")) as { data: Array<[number, string, string, string | null]> };
  return j.data.map(([cik, , ticker, exchange]) => ({ cik: String(cik), ticker, exchange: exchange ?? "" }));
}

/** First listed ticker per CIK (SEC lists the primary class first). */
function primaryListings(all: Listing[]): Map<string, Listing> {
  const out = new Map<string, Listing>();
  for (const l of all) if (LISTED.has(l.exchange) && !out.has(l.cik) && /^[A-Z]{1,5}(-[A-Z])?$/.test(l.ticker)) out.set(l.cik, l);
  return out;
}

type CompanyInfo = { sic: string | null; earnings: string[]; name: string };

async function submissionsFor(cik: string): Promise<CompanyInfo | null> {
  const f = path.join(SUB_DIR, `${cik}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")) as CompanyInfo;
  const pad = cik.padStart(10, "0");
  const r = await getText(`https://data.sec.gov/submissions/CIK${pad}.json`, SEC_UA, secQueue);
  if (r.status === 404) {
    fs.writeFileSync(f, JSON.stringify({ sic: null, earnings: [], name: "" }));
    return null;
  }
  if (r.status !== 200) return null;
  type Recent = { form?: string[]; filingDate?: string[]; items?: string[] };
  const j = JSON.parse(r.body) as { sic?: string; name?: string; filings?: { recent?: Recent; files?: Array<{ name: string; filingFrom: string; filingTo: string }> } };
  const earnings = new Set<string>();
  const take = (rec: Recent | undefined) => {
    const forms = rec?.form ?? [];
    for (let i = 0; i < forms.length; i++) {
      if (!/^8-K/.test(forms[i]!)) continue;
      if ((rec!.items?.[i] ?? "").split(",").map((s) => s.trim()).includes("2.02")) earnings.add(rec!.filingDate![i]!);
    }
  };
  take(j.filings?.recent);
  for (const extra of j.filings?.files ?? []) {
    if (extra.filingTo < "2014-06-01") continue;
    const e = await getText(`https://data.sec.gov/submissions/${extra.name}`, SEC_UA, secQueue);
    if (e.status === 200) take(JSON.parse(e.body) as Recent);
    else return null; // incomplete: retry on the next run
  }
  const info: CompanyInfo = { sic: j.sic ? String(j.sic) : null, earnings: [...earnings].sort(), name: j.name ?? "" };
  fs.writeFileSync(f, JSON.stringify(info));
  return info;
}

async function submissionsPhase(ciks: string[]): Promise<void> {
  fs.mkdirSync(SUB_DIR, { recursive: true });
  const todo = ciks.filter((c) => !fs.existsSync(path.join(SUB_DIR, `${c}.json`)));
  log(`sec: submissions for ${ciks.length} CIKs (${todo.length} to fetch)`);
  let done = 0;
  let failed = 0;
  await pool(todo, 6, async (cik) => {
    const r = await submissionsFor(cik);
    if (!r) failed++;
    if (++done % 250 === 0) log(`sec: ${done}/${todo.length} (${failed} not read)`);
  });
  log(`sec: submissions done (${failed} not read)`);
}

function readInfo(cik: string): CompanyInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(SUB_DIR, `${cik}.json`), "utf8")) as CompanyInfo;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase: prices (Yahoo chart, own compact cache)

type YahooFile = { d: string[]; o: number[]; c: number[]; a: number[]; v: number[]; splits: Array<{ date: string; ratio: number }>; status: number };

function yahooPath(t: string): string {
  return path.join(YAHOO_DIR, `${t.replace(/[^A-Z0-9.-]/g, "_")}.json`);
}

async function fetchYahoo(ticker: string): Promise<void> {
  const f = yahooPath(ticker);
  if (fs.existsSync(f)) return;
  const sym = ticker.replace(/\./g, "-");
  const p1 = Math.floor(Date.parse(`${PRICE_FROM}T00:00:00Z`) / 1000);
  const p2 = Math.floor(Date.parse("2026-11-01T00:00:00Z") / 1000);
  const url = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=${p1}&period2=${p2}&interval=1d&events=div%2Csplits&includeAdjustedClose=true`;
  const r = await getText(url, BROWSER_UA, yahooQueue);
  if (r.status === 0) return; // network trouble: leave for the next run
  const out: YahooFile = { d: [], o: [], c: [], a: [], v: [], splits: [], status: r.status };
  if (r.status === 200) {
    type Chart = {
      chart?: {
        result?: Array<{
          meta?: { gmtoffset?: number; instrumentType?: string };
          timestamp?: number[];
          events?: { splits?: Record<string, { date: number; numerator: number; denominator: number }> };
          indicators?: { quote?: Array<{ open?: (number | null)[]; close?: (number | null)[]; volume?: (number | null)[] }>; adjclose?: Array<{ adjclose?: (number | null)[] }> };
        }>;
      };
    };
    const res = (JSON.parse(r.body) as Chart).chart?.result?.[0];
    const ts = res?.timestamp ?? [];
    const q = res?.indicators?.quote?.[0];
    const adj = res?.indicators?.adjclose?.[0]?.adjclose;
    const off = res?.meta?.gmtoffset ?? -5 * 3600;
    const good = (x: number | null | undefined): x is number => typeof x === "number" && Number.isFinite(x) && x > 0;
    for (let i = 0; i < ts.length; i++) {
      const o = q?.open?.[i];
      const c = q?.close?.[i];
      const a = adj?.[i];
      if (!good(o) || !good(c)) continue;
      const d = new Date((ts[i]! + off) * 1000).toISOString().slice(0, 10);
      if (out.d.length && out.d[out.d.length - 1] === d) continue;
      out.d.push(d);
      out.o.push(+o.toPrecision(7));
      out.c.push(+c.toPrecision(7));
      out.a.push(+(good(a) ? a : c).toPrecision(7));
      out.v.push(q?.volume?.[i] ?? 0);
    }
    for (const s of Object.values(res?.events?.splits ?? {})) {
      if (s.numerator > 0 && s.denominator > 0) out.splits.push({ date: new Date((s.date + off) * 1000).toISOString().slice(0, 10), ratio: s.numerator / s.denominator });
    }
  }
  fs.mkdirSync(YAHOO_DIR, { recursive: true });
  fs.writeFileSync(f, JSON.stringify(out));
}

async function pricesPhase(tickers: string[], label: string): Promise<void> {
  const todo = tickers.filter((t) => !fs.existsSync(yahooPath(t)));
  log(`prices (${label}): ${tickers.length} tickers, ${todo.length} to fetch`);
  let done = 0;
  await pool(todo, 3, async (t) => {
    await fetchYahoo(t);
    if (++done % 250 === 0) log(`prices (${label}): ${done}/${todo.length}`);
  });
  const missing = tickers.filter((t) => !fs.existsSync(yahooPath(t)));
  log(`prices (${label}): done, ${missing.length} not read (rerun to retry)`);
}

// ---------------------------------------------------------------------------
// Aligned series

const SESSIONS = nyseSessions(PRICE_FROM, "2026-10-30");
const SESSION_INDEX = new Map(SESSIONS.map((d, i) => [d, i]));

type Aligned = PriceSeries & { raw: Float32Array; dv: Float32Array; first: number; last: number };

function loadAligned(ticker: string): Aligned | null {
  let y: YahooFile;
  try {
    y = JSON.parse(fs.readFileSync(yahooPath(ticker), "utf8")) as YahooFile;
  } catch {
    return null;
  }
  if (y.status !== 200 || y.d.length < 30) return null;
  const n = SESSIONS.length;
  const open = new Float32Array(n).fill(NaN);
  const close = new Float32Array(n).fill(NaN);
  const raw = new Float32Array(n).fill(NaN);
  const dv = new Float32Array(n).fill(NaN);
  const splits = [...y.splits].sort((a, b) => (a.date < b.date ? -1 : 1));
  // Unadjusted price = split-adjusted close x the product of later split ratios.
  let first = -1;
  let last = -1;
  for (let k = 0; k < y.d.length; k++) {
    const i = SESSION_INDEX.get(y.d[k]!);
    if (i === undefined) continue;
    const f = y.a[k]! / y.c[k]!;
    open[i] = y.o[k]! * f;
    close[i] = y.a[k]!;
    let ratio = 1;
    for (const s of splits) if (s.date > y.d[k]!) ratio *= s.ratio;
    raw[i] = y.c[k]! * ratio;
    dv[i] = y.c[k]! * y.v[k]!;
    if (first < 0) first = i;
    last = i;
  }
  return { open, close, raw, dv, first, last };
}

function median20(a: Float32Array, end: number): number {
  const xs: number[] = [];
  for (let i = Math.max(0, end - 19); i <= end; i++) if (a[i]! > 0) xs.push(a[i]!);
  return xs.length >= 10 ? median(xs) : NaN;
}

function lastValid(a: Float32Array, i: number): number {
  for (let k = i; k >= Math.max(0, i - 5); k--) if (a[k]! > 0) return a[k]!;
  return NaN;
}

// ---------------------------------------------------------------------------
// Phase: accept (EDGAR acceptance times)

function loadAcceptance(): Map<string, number> {
  const out = new Map<string, number>();
  if (!fs.existsSync(ACCEPT_FILE)) return out;
  for (const line of fs.readFileSync(ACCEPT_FILE, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as { acc: string; ms: number | null };
      if (r.ms !== null) out.set(r.acc, r.ms);
      else out.set(r.acc, NaN);
    } catch {
      // a torn last line from an interrupted run
    }
  }
  return out;
}

async function acceptPhase(items: Array<{ acc: string; cik: string }>): Promise<void> {
  const have = loadAcceptance();
  const todo = items.filter((x) => !have.has(x.acc));
  log(`accept: ${items.length} accessions, ${todo.length} to fetch`);
  let done = 0;
  await pool(todo, 6, async ({ acc, cik }) => {
    const nodash = acc.replace(/-/g, "");
    const r = await getText(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${nodash}/${acc}-index.htm`, SEC_UA, secQueue);
    if (r.status === 0 || r.status >= 500 || r.status === 429) return;
    const m = /Accepted<\/div>\s*<div class="info">(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(r.body);
    const ms = m ? nyInstantMs(m[1]!, Number(m[2]) * 60 + Number(m[3])) + Number(m[4]) * 1000 : null;
    fs.appendFileSync(ACCEPT_FILE, JSON.stringify({ acc, ms }) + "\n");
    if (++done % 500 === 0) log(`accept: ${done}/${todo.length}`);
  });
}

// ---------------------------------------------------------------------------
// Phase: events

type StoredEvent = InsiderEvent & { symbol: string };

function eventsPhase(): void {
  const rows = loadRows();
  log(`events: ${rows.length} P/S rows 2012Q1-2026Q2`);
  const months = tradeMonths(rows.map((r) => ({ ownerCik: r.owner, issuerCik: r.issuer, transDate: r.trans })));
  // Purchase filings: usable P rows of non-routine insiders, one per accession.
  const byAcc = new Map<string, PurchaseFiling & { symbol: string; shares: number }>();
  let tenB5 = 0;
  let routine = 0;
  let purchaseRows = 0;
  for (const r of rows) {
    if (r.code !== "P") continue;
    if (r.filed < EVENT_FROM || r.filed > EVENT_TO) continue;
    if (r.aff === "1" || r.aff.toLowerCase() === "true") tenB5++;
    if (!r.ok) continue;
    purchaseRows++;
    const prev = byAcc.get(r.acc);
    if (prev) {
      prev.valueUsd += r.shares * r.price;
      prev.shares += r.shares;
      prev.price = prev.valueUsd / prev.shares;
      if (r.trans < prev.transDate) prev.transDate = r.trans;
      continue;
    }
    byAcc.set(r.acc, { accession: r.acc, issuerCik: r.issuer, ownerCik: r.owner, filingDate: r.filed, transDate: r.trans, isOfficerOrDirector: r.od, valueUsd: r.shares * r.price, shares: r.shares, price: r.price, symbol: r.sym });
  }
  const filings: Array<PurchaseFiling & { symbol: string }> = [];
  for (const f of byAcc.values()) {
    if (isRoutine(months, f.ownerCik, f.issuerCik, f.transDate)) {
      routine++;
      continue;
    }
    filings.push(f);
  }
  const shares = loadShares();
  const symbolOf = new Map(filings.map((f) => [f.issuerCik, f.symbol]));
  const events = findInsiderEvents(filings, (f) => {
    const s = sharesAt(shares.get(f.issuerCik), f.filingDate);
    return s === null ? null : s * f.price;
  });
  const stored: StoredEvent[] = events.map((e) => ({ ...e, symbol: symbolOf.get(e.issuerCik) ?? "" }));
  fs.writeFileSync(EVENTS_FILE, JSON.stringify({ purchaseRows, purchaseFilings: byAcc.size, tenB5RowsDropped: tenB5, routineFilingsDropped: routine, kept: filings.length, events: stored }));
  const kinds = { cluster: 0, single: 0, both: 0 };
  for (const e of events) kinds[e.kind]++;
  log(`events: ${byAcc.size} purchase filings, ${routine} routine dropped, ${tenB5} 10b5-1-flagged P rows dropped, ${events.length} events`, kinds);
}

function loadEvents(): { events: StoredEvent[]; meta: Record<string, number> } {
  const j = JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8")) as { events: StoredEvent[] } & Record<string, number>;
  const { events, ...meta } = j;
  return { events, meta: meta as Record<string, number> };
}

// ---------------------------------------------------------------------------
// Phase: measure

type PanelRow = {
  issuerCik: string;
  ticker: string;
  date: string;
  kind: InsiderEvent["kind"];
  insiders: number;
  valueUsd: number;
  publicTime: "acceptance" | "filing_date_close";
  publicAt: string;
  entryDate: string;
  sic: string | null;
  sizeUsd: number | null;
  sizeBucket: string;
  price: number;
  dollarVolume: number;
  alpha: number;
  beta: number;
  sigma: number;
  estDays: number;
  pre: number | null;
  /** Per window: CAR %, SCAR, raw %, raw minus SPY %, matched y, controls used, own 8-K 2.02 in window. */
  w: Record<number, { carPct: number; betaOnlyPct: number; scar: number; rawPct: number; rawMinusSpyPct: number; y: number | null; yBetaOnly: number | null; nControls: number; ownEarnings: boolean } | null>;
  controlLevel: string | null;
  controls: string[];
};

function sizeBucket(v: number | null): string {
  if (v === null) return "unknown";
  if (v < 300e6) return "micro <$300M";
  if (v < 2e9) return "small $300M-2B";
  if (v < 10e9) return "mid $2-10B";
  return "large >$10B";
}

function periodOf(d: string): string {
  return d <= "2021-12-31" ? "dev 2015-2021" : d <= "2023-12-31" ? "val 2022-2023" : "holdout 2024-2026H1";
}

function hasDateIn(sorted: string[], from: string, to: string): boolean {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (sorted[m]! < from) lo = m + 1;
    else hi = m;
  }
  return lo < sorted.length && sorted[lo]! <= to;
}

async function measurePhase(): Promise<void> {
  const { events, meta } = loadEvents();
  const listings = primaryListings(await tickersFile());
  const shares = loadShares();
  const accept = loadAcceptance();
  const spy = loadAligned("SPY");
  if (!spy) throw new Error("SPY prices missing");
  // Calendar check: rule-based sessions vs SPY's trading days in the event span.
  const spyDays = SESSIONS.filter((_, i) => spy.close[i]! > 0);
  const missingSpy = SESSIONS.filter((d, i) => d >= "2014-01-01" && d <= "2026-10-28" && !(spy.close[i]! > 0));
  log(`calendar: ${SESSIONS.length} rule sessions, SPY has ${spyDays.length}; rule sessions without a SPY bar: ${missingSpy.slice(0, 10).join(", ") || "none"}`);

  // F7 events by CIK (any gate), to keep controls free of their own insider events.
  const ownEvents = new Map<string, string[]>();
  for (const e of events) {
    let a = ownEvents.get(e.issuerCik);
    if (!a) ownEvents.set(e.issuerCik, (a = []));
    a.push(e.date);
  }

  // Control pool: listed CIKs with SIC and prices.
  const series = new Map<string, Aligned | null>();
  const getSeries = (t: string) => {
    if (!series.has(t)) series.set(t, loadAligned(t));
    return series.get(t)!;
  };
  const poolBySic2 = new Map<string, Array<{ cik: string; ticker: string; sic: string; earnings: string[] }>>();
  for (const l of listings.values()) {
    const info = readInfo(l.cik);
    if (!info?.sic || /^0+$/.test(info.sic)) continue;
    const sic = info.sic.padStart(4, "0");
    const k = sic.slice(0, 2);
    let a = poolBySic2.get(k);
    if (!a) poolBySic2.set(k, (a = []));
    a.push({ cik: l.cik, ticker: l.ticker, sic, earnings: info.earnings });
  }
  log(`measure: control pool ${[...poolBySic2.values()].reduce((s, a) => s + a.length, 0)} listed firms with SIC`);

  const rnd = seededRandom(20261115);
  const funnel = { events: events.length, noCurrentListing: 0, noYahoo: 0, notCovered: 0, belowPrice: 0, belowVolume: 0, gated: 0, noEstimation: 0, measured: 0, acceptance: 0, filingDateClose: 0, withControls: 0, controlSampleSkipped: 0 };
  const panel: PanelRow[] = [];
  const out = fs.createWriteStream(PANEL_FILE);
  let k = 0;
  for (const e of events) {
    if (++k % 1000 === 0) log(`measure: ${k}/${events.length} events, ${panel.length} measured`);
    const listing = listings.get(e.issuerCik);
    if (!listing) {
      funnel.noCurrentListing++;
      continue;
    }
    const s = getSeries(listing.ticker);
    if (!s) {
      funnel.noYahoo++;
      continue;
    }
    // Public time: the acceptance completing the rule, else after the filing date's close.
    let publicMs = eventPublicMs(e, new Map([...e.dayFilings].flatMap((f) => (Number.isFinite(accept.get(f.accession)) ? [[f.accession, accept.get(f.accession)!] as const] : []))));
    const fromAcceptance = publicMs !== null;
    if (publicMs === null) publicMs = nyInstantMs(e.date, 16 * 60 + 1);
    const day0 = reactionDayIndex(SESSIONS, publicMs);
    if (day0 === null || day0 - 1 < s.first || day0 > s.last) {
      funnel.notCovered++;
      continue;
    }
    const price = lastValid(s.raw, day0 - 1);
    const dv = median20(s.dv, day0 - 1);
    if (!(price > 5)) {
      funnel.belowPrice++;
      continue;
    }
    if (!(dv >= 5e6)) {
      funnel.belowVolume++;
      continue;
    }
    funnel.gated++;
    const m = measureEvent({ sessions: SESSIONS, stock: s, market: spy, publicMs, windows: WINDOWS });
    if (!m.ok) {
      funnel.noEstimation++;
      continue;
    }
    funnel.measured++;
    if (fromAcceptance) funnel.acceptance++;
    else funnel.filingDateClose++;
    const info = readInfo(e.issuerCik);
    const sic = info?.sic ? info.sic.padStart(4, "0") : null;
    const sh = sharesAt(shares.get(e.issuerCik), e.date);
    const sizeUsd = sh === null ? null : sh * price;

    // Matched controls (same event date, same entry), chosen per window: the earnings and
    // own-event screens cover [-5, +L] sessions (capped at +20 for L = 60, since nearly
    // every firm reports earnings inside a 65-session span).
    let controlLevel: string | null = null;
    const controlsByL: Record<number, string[]> = { 5: [], 20: [], 60: [] };
    const controlScar: Record<number, number[]> = { 5: [], 20: [], 60: [] };
    const controlScarBetaOnly: Record<number, number[]> = { 5: [], 20: [], 60: [] };
    const useControls = CONTROL_SAMPLE >= 1 || rnd() < CONTROL_SAMPLE;
    if (!useControls) funnel.controlSampleSkipped++;
    if (useControls && sic) {
      const lo = day0 + ESTIMATION.from;
      const hi = day0 + ESTIMATION.to;
      const winFrom = SESSIONS[Math.max(0, day0 - 5)]!;
      const base: Array<ControlCandidate & { cik: string; earnings: string[] }> = [];
      const bySic2 = (poolBySic2.get(sic.slice(0, 2)) ?? []).filter((c) => c.cik !== e.issuerCik);
      for (const c of bySic2) {
        const cs = getSeries(c.ticker);
        if (!cs || cs.first > lo || cs.last < m.entry) continue;
        const cp = lastValid(cs.raw, day0 - 1);
        const cdv = median20(cs.dv, day0 - 1);
        if (!(cp > 5) || !(cdv >= 5e6)) continue;
        const csh = sharesAt(shares.get(c.cik), e.date);
        const mm = fitMarketModel(cs, spy, lo, hi);
        base.push({ id: c.ticker, cik: c.cik, earnings: c.earnings, sic: c.sic, sizeUsd: csh === null ? null : csh * cp, beta: mm ? mm.beta : null, price: cp, dollarVolume: cdv });
      }
      const measured = new Map<string, ReturnType<typeof measureEvent>>();
      for (const L of WINDOWS) {
        const winTo = SESSIONS[Math.min(SESSIONS.length - 1, m.entry + Math.min(L, 20))]!;
        const cands = base.map((c) => ({ ...c, ownEarnings: hasDateIn(c.earnings, winFrom, winTo), ownEvent: hasDateIn(ownEvents.get(c.cik) ?? [], winFrom, winTo) }));
        const sel = selectControls({ id: listing.ticker, sic, sizeUsd, beta: m.model.beta }, cands);
        if (L === 20) controlLevel = sel.level;
        controlsByL[L] = sel.controls.map((c) => c.id);
        for (const c of sel.controls) {
          if (!measured.has(c.id)) measured.set(c.id, measureEvent({ sessions: SESSIONS, stock: getSeries(c.id)!, market: spy, publicMs, windows: WINDOWS }));
          const cm = measured.get(c.id)!;
          if (!cm.ok) continue;
          const cd = cm.drift[L];
          if (!cd) continue;
          controlScar[L]!.push(cd.scar);
          controlScarBetaOnly[L]!.push((cd.car + cm.model.alpha * L) / (cm.model.sigma * Math.sqrt(L)));
        }
      }
      if (controlsByL[20]!.length) funnel.withControls++;
    }
    const controls = controlsByL[20]!;
    const ownE = info?.earnings ?? [];
    const w: PanelRow["w"] = {};
    for (const L of WINDOWS) {
      const d = m.drift[L];
      if (!d) {
        w[L] = null;
        continue;
      }
      w[L] = {
        carPct: d.car * 100,
        // Robustness: the same sum without the estimation-window alpha (insiders buy after declines,
        // so a negative pre-event alpha would otherwise add to the CAR).
        betaOnlyPct: (d.car + m.model.alpha * L) * 100,
        scar: d.scar,
        rawPct: d.raw * 100,
        rawMinusSpyPct: d.rawMinusMarket * 100,
        y: matchedOutcome(d.scar, controlScar[L]!, 1),
        yBetaOnly: matchedOutcome((d.car + m.model.alpha * L) / (m.model.sigma * Math.sqrt(L)), controlScarBetaOnly[L]!, 1),
        nControls: controlScar[L]!.length,
        ownEarnings: hasDateIn(ownE, SESSIONS[m.entry]!, d.exitDate),
      };
    }
    const row: PanelRow = {
      issuerCik: e.issuerCik,
      ticker: listing.ticker,
      date: e.date,
      kind: e.kind,
      insiders: e.insiders,
      valueUsd: Math.round(e.valueUsd),
      publicTime: fromAcceptance ? "acceptance" : "filing_date_close",
      publicAt: new Date(publicMs).toISOString(),
      entryDate: m.entryDate,
      sic,
      sizeUsd: sizeUsd === null ? null : Math.round(sizeUsd),
      sizeBucket: sizeBucket(sizeUsd),
      price: +price.toFixed(2),
      dollarVolume: Math.round(dv),
      alpha: m.model.alpha,
      beta: m.model.beta,
      sigma: m.model.sigma,
      estDays: m.model.n,
      pre: m.pre ? m.pre.ar * 100 : null,
      w,
      controlLevel,
      controls,
    };
    panel.push(row);
    out.write(JSON.stringify(row) + "\n");
  }
  await new Promise<void>((r) => out.end(r));
  log("measure: funnel", funnel);

  // Calendar-time check (L = 20): daily equal-weight portfolio of open positions, r_i - beta_i r_SPY.
  const calendar = (L: number, matched: boolean) => {
    const sum = new Float64Array(SESSIONS.length);
    const cnt = new Float64Array(SESSIONS.length);
    const daily = (s: Aligned, i: number, entry: number, beta: number) => {
      const r = i === entry ? s.close[i]! / s.open[i]! - 1 : closeReturn(s, i);
      const rm = i === entry ? spy.close[i]! / spy.open[i]! - 1 : closeReturn(spy, i);
      return r - beta * rm;
    };
    for (const p of panel) {
      if (!p.w[L]) continue;
      const entry = SESSION_INDEX.get(p.entryDate)!;
      const s = getSeries(p.ticker)!;
      const cs = matched ? p.controls.map((c) => ({ s: getSeries(c)!, beta: fitMarketModel(getSeries(c)!, spy, reactionDayIndex(SESSIONS, Date.parse(p.publicAt))! + ESTIMATION.from, reactionDayIndex(SESSIONS, Date.parse(p.publicAt))! + ESTIMATION.to)?.beta ?? NaN })) : [];
      if (matched && cs.length < 3) continue;
      for (let i = entry; i < entry + L && i < SESSIONS.length; i++) {
        let v = daily(s, i, entry, p.beta);
        if (matched) {
          const cv = cs.map((c) => daily(c.s, i, entry, c.beta)).filter(Number.isFinite);
          if (cv.length < 3) continue;
          v -= cv.reduce((a, b) => a + b, 0) / cv.length;
        }
        if (!Number.isFinite(v)) continue;
        sum[i] = sum[i]! + v;
        cnt[i] = cnt[i]! + 1;
      }
    }
    const xs: number[] = [];
    for (let i = 0; i < SESSIONS.length; i++) if (cnt[i]! > 0) xs.push((sum[i]! / cnt[i]!) * 1e4);
    const nw = neweyWestMean(xs);
    return { days: xs.length, meanBpsPerDay: nw.mean, t: nw.t, p: nw.p, lags: nw.lags, avgPositions: [...cnt].filter((c) => c > 0).reduce((a, b) => a + b, 0) / Math.max(1, xs.length) };
  };

  // Summaries.
  type Cell = { carPct: StudySummary | null; betaOnlyPct: StudySummary | null; scar: StudySummary | null; y: StudySummary | null; yBetaOnly: StudySummary | null; rawMinusSpyPct: StudySummary | null };
  const summarize = (rows: PanelRow[], L: number, opts: { exOwnEarnings?: boolean } = {}): Cell => {
    const rs = rows.filter((r) => r.w[L] && (!opts.exOwnEarnings || !r.w[L]!.ownEarnings));
    const obs = (f: (r: PanelRow) => number | null) =>
      rs.flatMap((r) => {
        const v = f(r);
        return v === null || !Number.isFinite(v) ? [] : [{ value: v, date: r.date, firm: r.issuerCik }];
      });
    return {
      carPct: eventStudy(obs((r) => r.w[L]!.carPct)),
      betaOnlyPct: eventStudy(obs((r) => r.w[L]!.betaOnlyPct)),
      scar: eventStudy(obs((r) => r.w[L]!.scar)),
      y: eventStudy(obs((r) => r.w[L]!.y)),
      yBetaOnly: eventStudy(obs((r) => r.w[L]!.yBetaOnly)),
      rawMinusSpyPct: eventStudy(obs((r) => r.w[L]!.rawMinusSpyPct)),
    };
  };
  const groups: Record<string, PanelRow[]> = { all: panel };
  for (const r of panel) {
    for (const key of [`period: ${periodOf(r.date)}`, `size: ${r.sizeBucket}`, `kind: ${r.kind === "single" ? "single >= $100k" : "cluster (incl. both)"}`, `time: ${r.publicTime}`]) (groups[key] ??= []).push(r);
  }
  const summary: Record<string, unknown> = {
    computedAt: new Date().toISOString(),
    funnel,
    eventsMeta: meta,
    controlSample: CONTROL_SAMPLE,
    windows: {} as Record<string, unknown>,
    calendarTime: { L20_marketAdjusted: calendar(20, false), L20_matched: calendar(20, true) },
  };
  for (const L of WINDOWS) {
    const per: Record<string, Cell> = {};
    for (const [g, rows] of Object.entries(groups).sort()) per[g] = summarize(rows, L);
    per["all, ex own 8-K 2.02 in window"] = summarize(panel, L, { exOwnEarnings: true });
    (summary.windows as Record<string, unknown>)[String(L)] = per;
  }
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 1));
  fs.writeFileSync(SUMMARY_MD, renderMd(summary));
  console.log(renderMd(summary));
}

function fmt(x: number | null | undefined, d = 2): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(d);
}

function renderMd(summary: Record<string, unknown>): string {
  const lines: string[] = [];
  lines.push(`funnel: ${JSON.stringify(summary.funnel)}`);
  lines.push(`events meta: ${JSON.stringify(summary.eventsMeta)}`);
  lines.push(`calendar time: ${JSON.stringify(summary.calendarTime)}`);
  for (const [L, per] of Object.entries(summary.windows as Record<string, Record<string, { carPct: StudySummary | null; betaOnlyPct: StudySummary | null; scar: StudySummary | null; y: StudySummary | null; yBetaOnly: StudySummary | null; rawMinusSpyPct: StudySummary | null }>>)) {
    lines.push("", `### DRIFT_${L} (entry open -> close ${L} sessions)`, "");
    lines.push("| group | n | G | mean CAR % | median CAR % | t (date) | p (date) | t (firm x month) | p (2-way) | boot p | mean SCAR | beta-only % | t beta-only | y n | mean y | t y (date) | t y (2-way) | p y | mean y beta-only | t y beta-only | raw-SPY % | t raw-SPY |");
    lines.push("|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
    for (const [g, c] of Object.entries(per)) {
      const a = c.carPct;
      if (!a) continue;
      lines.push(
        `| ${g} | ${a.n} | ${a.g} | ${fmt(a.mean)} | ${fmt(a.median)} | ${fmt(a.byDate.t)} | ${fmt(a.byDate.p, 4)} | ${fmt(a.twoWay.t)} | ${fmt(a.twoWay.p, 4)} | ${fmt(a.bootstrapP, 4)} | ${fmt(c.scar?.mean, 3)} | ${fmt(c.betaOnlyPct?.mean)} | ${fmt(c.betaOnlyPct?.byDate.t)} | ${c.y?.n ?? 0} | ${fmt(c.y?.mean, 3)} | ${fmt(c.y?.byDate.t)} | ${fmt(c.y?.twoWay.t)} | ${fmt(c.y?.byDate.p, 4)} | ${fmt(c.yBetaOnly?.mean, 3)} | ${fmt(c.yBetaOnly?.byDate.t)} | ${fmt(c.rawMinusSpyPct?.mean)} | ${fmt(c.rawMinusSpyPct?.byDate.t)} |`,
      );
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (want("download") || want("parse")) await downloadPhase();
  if (want("parse")) parsePhase();
  if (want("events")) {
    if (!fs.existsSync(FRAMES_DIR) || fs.readdirSync(FRAMES_DIR).length < 50) await framesPhase();
    eventsPhase();
  }
  const listings = want("sec") || want("prices") || want("accept") ? primaryListings(await tickersFile()) : new Map<string, Listing>();
  const { events } = fs.existsSync(EVENTS_FILE) ? loadEvents() : { events: [] as StoredEvent[] };
  const eventCiks = [...new Set(events.map((e) => e.issuerCik))];
  const eventTickers = [...new Set(eventCiks.flatMap((c) => (listings.get(c) ? [listings.get(c)!.ticker] : [])))];
  if (want("sec")) {
    await framesPhase();
    // Event issuers first (needed for the main estimate), then the control pool.
    await submissionsPhase(eventCiks.filter((c) => listings.has(c)));
    await submissionsPhase([...listings.keys()]);
  }
  if (want("prices")) {
    await pricesPhase(["SPY", ...eventTickers], "event issuers");
    const poolTickers = [...listings.values()].filter((l) => readInfo(l.cik)?.sic).map((l) => l.ticker);
    await pricesPhase(poolTickers, "control pool");
  }
  if (want("accept")) {
    // Accessions that can complete a rule on the event day, for events whose issuer has prices.
    const items: Array<{ acc: string; cik: string }> = [];
    // Only events near the universe gate (with slack: acceptance can move day 0 by a session).
    const sessionsCache = new Map<string, Aligned | null>();
    for (const e of events) {
      const l = listings.get(e.issuerCik);
      if (!l) continue;
      if (!sessionsCache.has(l.ticker)) sessionsCache.set(l.ticker, loadAligned(l.ticker));
      const s = sessionsCache.get(l.ticker);
      if (!s) continue;
      const day0 = reactionDayIndex(SESSIONS, nyInstantMs(e.date, 16 * 60 + 1));
      if (day0 === null || day0 - 1 < s.first) continue;
      if (!(lastValid(s.raw, day0 - 1) > 4) || !(median20(s.dv, day0 - 1) >= 4e6)) continue;
      for (const f of e.dayFilings) if (f.newOwner || f.single) items.push({ acc: f.accession, cik: e.issuerCik });
    }
    await acceptPhase(items);
  }
  if (want("measure")) await measurePhase();
  log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
