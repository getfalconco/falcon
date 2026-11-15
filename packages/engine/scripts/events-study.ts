/**
 * events-v1 study (data/preregistration/events-v1.json): Falcon's own
 * post-2015 estimate for late-filing notices (F6 distress_nt), initial
 * Schedule 13D stakes (F8 activist_stake) and 8-K item 4.02 restatements
 * (restatement_402). No LLM; EDGAR full index, efts and the F7 study's
 * Yahoo cache.
 *
 *   node --max-old-space-size=6144 --import tsx scripts/events-study.ts [phase ...]
 *
 * Phases (default: all, in order; each resumes from its cache):
 *   index    EDGAR full-index master.gz 2015 QTR1 .. 2026 QTR4 -> NT, 13D, Form 25 rows
 *   efts     8-K item 4.02 records per year from efts full-text search
 *   headers  SEC headers of 13Ds whose subject company is ambiguous from the index
 *   events   the three event samples, de-duplicated -> events-v1-events.json
 *   sec      submissions (SIC, 8-K 2.02 dates) for event issuers not in the F7 cache
 *   prices   Yahoo daily history for event tickers not in the F7 cache
 *   accept   EDGAR acceptance instants of near-gate events
 *   measure  legs, matched controls, summaries, pass bar -> events-v1-summary.{json,md}
 *
 * Cache: STUDY_ROOT (default packages/engine/.cache/study, shared with F7).
 * SEC at <= 8 requests a second with a declared User-Agent; Yahoo politely.
 * Internal research only: Yahoo is a stand-in; no price-derived number here
 * is displayed except the registry estimate a passing family earns.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { eventStudy, fitMarketModel, measureEvent, nyInstantMs, nyseSessions, reactionDayIndex, ESTIMATION, type PriceSeries, type StudySummary } from "../src/study/abnormal.ts";
import { matchedOutcome, selectControls, type ControlCandidate } from "../src/study/controls.ts";
import { byAccession, dedupeByIssuer, delistedAfter, hasItem402, headerParties, parseMasterIndex, passesBar, subjectOf13D, type IndexRow } from "../src/study/filing-events.ts";
import { median } from "../src/study/stats.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.STUDY_ROOT ?? path.join(here, "..", ".cache", "study");
const INDEX_DIR = path.join(ROOT, "full-index");
const EFTS_DIR = path.join(ROOT, "efts-402");
const HEADER_DIR = path.join(ROOT, "headers-13d");
const SUB_DIR = path.join(ROOT, "submissions");
const YAHOO_DIR = path.join(ROOT, "yahoo");
const FRAMES_DIR = path.join(ROOT, "frames");
const ACCEPT_FILE = path.join(ROOT, "acceptance.ndjson");
const INDEX_ROWS = path.join(ROOT, "events-v1-index.json");
const EVENTS_FILE = path.join(ROOT, "events-v1-events.json");
const PANEL_FILE = path.join(ROOT, "events-v1-panel.ndjson");
const SUMMARY_FILE = path.join(ROOT, "events-v1-summary.json");
const SUMMARY_MD = path.join(ROOT, "events-v1-summary.md");

const SEC_UA = "Falcon research research@getfalcon.co";
const BROWSER_UA = "Mozilla/5.0";
const EVENT_FROM = "2015-01-01";
const EVENT_TO = "2026-06-30";
const PRICE_FROM = "2013-06-01";
const WINDOWS = [5, 20, 60] as const;
const LISTED = new Set(["Nasdaq", "NYSE", "CBOE"]);
const NT_FORMS = ["NT 10-K", "NT 10-Q"];
const D13_FORMS = ["SC 13D", "SCHEDULE 13D"];
const F25_FORMS = ["25", "25-NSE"];

type Family = "F6_late_filing" | "F8_activist_stake" | "F6_restatement_402";
const FAMILIES: Record<Family, { expected: 1 | -1; registryEventType: string; label: string }> = {
  F6_late_filing: { expected: -1, registryEventType: "distress_nt", label: "Late filing notice (NT 10-K / NT 10-Q)" },
  F8_activist_stake: { expected: 1, registryEventType: "activist_stake", label: "Initial Schedule 13D by a third party" },
  F6_restatement_402: { expected: -1, registryEventType: "restatement_402", label: "8-K item 4.02 non-reliance" },
};

const args = process.argv.slice(2);
const phases = args.filter((a) => !a.startsWith("--"));
const want = (p: string) => phases.length === 0 || phases.includes(p) || phases.includes("all");

const t0 = Date.now();
function log(...xs: unknown[]): void {
  console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...xs);
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
fs.mkdirSync(ROOT, { recursive: true });

// ---------------------------------------------------------------------------
// Polite HTTP (as scripts/backfill-insider.ts)

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
const secQueue = limiter(125, 6);
const yahooQueue = limiter(200, 3);

async function getText(url: string, ua: string, queue: ReturnType<typeof limiter>, tries = 6): Promise<{ status: number; body: string }> {
  let wait = 2000;
  for (let k = 0; k < tries; k++) {
    try {
      const res = await queue(() => fetch(url, { headers: { "User-Agent": ua, Accept: "*/*" }, signal: AbortSignal.timeout(60_000) }));
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
// Phase: index

function quarters(): Array<{ y: number; q: number }> {
  const out: Array<{ y: number; q: number }> = [];
  for (let y = 2015; y <= 2026; y++) for (let q = 1; q <= 4; q++) out.push({ y, q });
  return out;
}

async function indexPhase(): Promise<void> {
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const forms = new Set([...NT_FORMS, ...D13_FORMS, ...F25_FORMS]);
  const rows: IndexRow[] = [];
  for (const { y, q } of quarters()) {
    const f = path.join(INDEX_DIR, `${y}-QTR${q}.master.gz`);
    // The current quarter's file grows; refetch it.
    const current = y === 2026 && q === 4;
    if (!fs.existsSync(f) || current) {
      execFileSync("curl", ["-sSf", "--retry", "5", "-A", SEC_UA, "-o", f, `https://www.sec.gov/Archives/edgar/full-index/${y}/QTR${q}/master.gz`]);
      await sleep(300);
    }
    const text = execFileSync("gunzip", ["-c", f], { maxBuffer: 1 << 30 }).toString("latin1");
    const got = parseMasterIndex(text, forms);
    rows.push(...got);
    log(`index ${y} QTR${q}: ${got.length} rows`);
  }
  fs.writeFileSync(INDEX_ROWS, JSON.stringify(rows));
}

function loadIndexRows(): IndexRow[] {
  return JSON.parse(fs.readFileSync(INDEX_ROWS, "utf8")) as IndexRow[];
}

// ---------------------------------------------------------------------------
// Phase: efts (8-K item 4.02)

type EftsRec = { adsh: string; form: string; date: string; ciks: string[]; items: string[]; sics: string[] };
const EFTS_QUERIES = ['"Item 4.02"', '"non-reliance"'];
const EFTS_DIAGNOSTIC = '"4.02"';

async function eftsQuery(q: string, year: number): Promise<EftsRec[]> {
  const f = path.join(EFTS_DIR, `${year}-${q.replace(/[^a-z0-9]+/gi, "_")}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")) as EftsRec[];
  const to = year === 2026 ? EVENT_TO : `${year}-12-31`;
  const out = new Map<string, EftsRec>();
  for (let from = 0; from < 10_000; from += 100) {
    const url = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(q)}&forms=8-K&startdt=${year}-01-01&enddt=${to}&from=${from}`;
    const r = await getText(url, SEC_UA, secQueue);
    if (r.status !== 200) throw new Error(`efts ${q} ${year} from ${from}: HTTP ${r.status}`);
    type Hit = { _id: string; _source: { adsh?: string; form?: string; file_date?: string; ciks?: string[]; items?: string[]; sics?: string[] } };
    const j = JSON.parse(r.body) as { hits: { total: { value: number }; hits: Hit[] } };
    for (const h of j.hits.hits) {
      const s = h._source;
      const adsh = s.adsh ?? h._id.split(":")[0]!;
      if (!out.has(adsh)) out.set(adsh, { adsh, form: s.form ?? "", date: s.file_date ?? "", ciks: (s.ciks ?? []).map((c) => String(Number(c))), items: s.items ?? [], sics: s.sics ?? [] });
    }
    if (from + 100 >= j.hits.total.value || j.hits.hits.length === 0) break;
    if (j.hits.total.value >= 10_000) log(`efts ${q} ${year}: total ${j.hits.total.value} hits the 10,000 cap`);
  }
  fs.mkdirSync(EFTS_DIR, { recursive: true });
  const recs = [...out.values()];
  fs.writeFileSync(f, JSON.stringify(recs));
  return recs;
}

async function eftsPhase(): Promise<void> {
  for (let y = 2015; y <= 2026; y++) {
    for (const q of [...EFTS_QUERIES, EFTS_DIAGNOSTIC]) {
      const recs = await eftsQuery(q, y);
      log(`efts ${y} ${q}: ${recs.length} filings, ${recs.filter((r) => r.form === "8-K" && hasItem402(r.items)).length} 8-Ks with 4.02`);
    }
  }
}

function load402(queries: readonly string[]): Map<string, EftsRec> {
  const out = new Map<string, EftsRec>();
  for (let y = 2015; y <= 2026; y++) {
    for (const q of queries) {
      const f = path.join(EFTS_DIR, `${y}-${q.replace(/[^a-z0-9]+/gi, "_")}.json`);
      if (!fs.existsSync(f)) continue;
      for (const r of JSON.parse(fs.readFileSync(f, "utf8")) as EftsRec[]) if (r.form === "8-K" && hasItem402(r.items) && !out.has(r.adsh)) out.set(r.adsh, r);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Listings

type Listing = { cik: string; ticker: string; exchange: string };

function tickersFile(): Listing[] {
  const j = JSON.parse(fs.readFileSync(path.join(ROOT, "company_tickers_exchange.json"), "utf8")) as { data: Array<[number, string, string, string | null]> };
  return j.data.map(([cik, , ticker, exchange]) => ({ cik: String(cik), ticker, exchange: exchange ?? "" }));
}

/** First common-like ticker per CIK: listed now (Nasdaq/NYSE/Cboe) first, else any other row (OTC, none). */
function listingMaps(): { listed: Map<string, Listing>; other: Map<string, Listing>; anyCik: Set<string> } {
  const all = tickersFile();
  const ok = (t: string) => /^[A-Z]{1,5}(-[A-Z])?$/.test(t);
  const listed = new Map<string, Listing>();
  for (const l of all) if (LISTED.has(l.exchange) && !listed.has(l.cik) && ok(l.ticker)) listed.set(l.cik, l);
  const other = new Map<string, Listing>();
  for (const l of all) if (!listed.has(l.cik) && !other.has(l.cik) && ok(l.ticker)) other.set(l.cik, l);
  return { listed, other, anyCik: new Set(all.map((l) => l.cik)) };
}

// ---------------------------------------------------------------------------
// Phase: headers (ambiguous 13D subjects)

function headerPath(acc: string): string {
  return path.join(HEADER_DIR, `${acc}.txt`);
}

async function headersPhase(): Promise<void> {
  const rows = loadIndexRows().filter((r) => D13_FORMS.includes(r.form) && r.date >= EVENT_FROM && r.date <= EVENT_TO);
  const { anyCik } = listingMaps();
  const todo: Array<{ acc: string; cik: string }> = [];
  // Every third-party 13D with a CIK that has a ticker: the index cannot tell a listed filer
  // (an asset manager, a holding company) from the subject when the subject has no ticker today.
  for (const [acc, rs] of byAccession(rows)) {
    const s = subjectOf13D(rs.map((r) => r.cik), (c) => anyCik.has(c));
    if ((s.kind === "ambiguous" || s.kind === "subject") && !fs.existsSync(headerPath(acc))) todo.push({ acc, cik: s.kind === "subject" ? s.cik : s.ciks[0]! });
  }
  log(`headers: ${todo.length} 13D headers to read`);
  fs.mkdirSync(HEADER_DIR, { recursive: true });
  let done = 0;
  await pool(todo, 6, async ({ acc, cik }) => {
    const r = await getText(`https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, "")}/${acc}-index-headers.html`, SEC_UA, secQueue);
    if (r.status !== 200) return;
    const m = /<SEC-HEADER>[\s\S]*?<\/SEC-HEADER>|&lt;SEC-HEADER&gt;[\s\S]*?&lt;\/SEC-HEADER&gt;/.exec(r.body);
    fs.writeFileSync(headerPath(acc), m ? m[0] : r.body.slice(0, 20_000));
    if (++done % 250 === 0) log(`headers: ${done}/${todo.length}`);
  });
}

// ---------------------------------------------------------------------------
// Phase: events

type StudyEvent = { family: Family; issuer: string; date: string; accession: string; form: string; sic?: string | null };

function eventsPhase(): void {
  const rows = loadIndexRows();
  const { anyCik } = listingMaps();
  const inSample = (d: string) => d >= EVENT_FROM && d <= EVENT_TO;
  const meta: Record<string, Record<string, number>> = {};

  // F6 late filing.
  const nt = rows.filter((r) => NT_FORMS.includes(r.form) && inSample(r.date)).map((r) => ({ family: "F6_late_filing" as const, issuer: r.cik, date: r.date, accession: r.accession, form: r.form }));
  const ntD = dedupeByIssuer(nt);
  meta.F6_late_filing = { filings: nt.length, duplicates: ntD.dropped, events: ntD.kept.length };

  // F8 13D.
  const d13 = rows.filter((r) => D13_FORMS.includes(r.form) && inSample(r.date));
  const counts = { accessions: 0, selfFiled: 0, noListedCik: 0, headerUnread: 0, headerSaysSelf: 0, headerSubjectNoTicker: 0, indexGuessCorrected: 0, fromHeader: 0 };
  const stakes: StudyEvent[] = [];
  for (const [acc, rs] of byAccession(d13)) {
    counts.accessions++;
    const s = subjectOf13D(rs.map((r) => r.cik), (c) => anyCik.has(c));
    let subject: string | null = null;
    if (s.kind === "self_filed") counts.selfFiled++;
    else if (s.kind === "no_listed_cik") counts.noListedCik++;
    else {
      // The SEC header decides (read for every 13D with a ticker-bearing CIK).
      const f = headerPath(acc);
      if (!fs.existsSync(f)) {
        counts.headerUnread++;
        continue;
      }
      const h = headerParties(fs.readFileSync(f, "utf8"));
      if (!h.subject) counts.headerUnread++;
      else if (h.filers.includes(h.subject)) counts.headerSaysSelf++;
      else if (!anyCik.has(h.subject)) counts.headerSubjectNoTicker++;
      else {
        subject = h.subject;
        counts.fromHeader++;
        if (s.kind === "subject" && s.cik !== h.subject) counts.indexGuessCorrected++;
      }
    }
    if (subject) stakes.push({ family: "F8_activist_stake", issuer: subject, date: rs[0]!.date, accession: acc, form: rs[0]!.form });
  }
  const d13D = dedupeByIssuer(stakes);
  meta.F8_activist_stake = { ...counts, thirdParty: stakes.length, duplicates: d13D.dropped, events: d13D.kept.length };

  // 4.02.
  const recs = [...load402(EFTS_QUERIES).values()].filter((r) => inSample(r.date) && r.ciks.length > 0);
  const diag = load402([...EFTS_QUERIES, EFTS_DIAGNOSTIC]);
  const r402 = recs.map((r) => ({ family: "F6_restatement_402" as const, issuer: r.ciks[0]!, date: r.date, accession: r.adsh, form: r.form, sic: r.sics[0] ?? null }));
  const r402D = dedupeByIssuer(r402);
  meta.F6_restatement_402 = { filings: r402.length, extraFromDiagnosticQuery: [...diag.values()].filter((r) => inSample(r.date)).length - r402.length, duplicates: r402D.dropped, events: r402D.kept.length };

  const events = [...ntD.kept, ...d13D.kept, ...r402D.kept];
  fs.writeFileSync(EVENTS_FILE, JSON.stringify({ meta, events }));
  log("events:", meta);
}

function loadEvents(): { meta: Record<string, Record<string, number>>; events: StudyEvent[] } {
  return JSON.parse(fs.readFileSync(EVENTS_FILE, "utf8"));
}

/** Form 25 / 25-NSE dates per CIK. */
function form25Dates(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of loadIndexRows()) {
    if (!F25_FORMS.includes(r.form)) continue;
    let a = out.get(r.cik);
    if (!a) out.set(r.cik, (a = []));
    a.push(r.date);
  }
  for (const a of out.values()) a.sort();
  return out;
}

/** The ticker an event is priced with and its listing group, or why not. */
function tickerFor(e: StudyEvent, maps: ReturnType<typeof listingMaps>, f25: Map<string, string[]>): { ticker: string; group: "listed_now" | "delisted_priced" } | { skip: "no_ticker_today" | "not_listed_at_event" } {
  const l = maps.listed.get(e.issuer);
  if (l) return { ticker: l.ticker, group: "listed_now" };
  const o = maps.other.get(e.issuer);
  if (!o) return { skip: "no_ticker_today" };
  if (!delistedAfter(f25.get(e.issuer), e.date)) return { skip: "not_listed_at_event" };
  return { ticker: o.ticker, group: "delisted_priced" };
}

// ---------------------------------------------------------------------------
// Phase: sec (submissions for issuers outside the F7 cache)

type CompanyInfo = { sic: string | null; earnings: string[]; name: string };

async function submissionsFor(cik: string): Promise<CompanyInfo | null> {
  const f = path.join(SUB_DIR, `${cik}.json`);
  if (fs.existsSync(f)) return JSON.parse(fs.readFileSync(f, "utf8")) as CompanyInfo;
  const r = await getText(`https://data.sec.gov/submissions/CIK${cik.padStart(10, "0")}.json`, SEC_UA, secQueue);
  if (r.status === 404) {
    fs.writeFileSync(f, JSON.stringify({ sic: null, earnings: [], name: "" }));
    return null;
  }
  if (r.status !== 200) return null;
  type Recent = { form?: string[]; filingDate?: string[]; items?: string[] };
  const j = JSON.parse(r.body) as { sic?: string; name?: string; filings?: { recent?: Recent; files?: Array<{ name: string; filingTo: string }> } };
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
    else return null;
  }
  const info: CompanyInfo = { sic: j.sic ? String(j.sic) : null, earnings: [...earnings].sort(), name: j.name ?? "" };
  fs.writeFileSync(f, JSON.stringify(info));
  return info;
}

function readInfo(cik: string): CompanyInfo | null {
  try {
    return JSON.parse(fs.readFileSync(path.join(SUB_DIR, `${cik}.json`), "utf8")) as CompanyInfo;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Phase: prices (Yahoo, same compact cache as F7)

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
  if (r.status === 0) return;
  const out: YahooFile = { d: [], o: [], c: [], a: [], v: [], splits: [], status: r.status };
  if (r.status === 200) {
    type Chart = {
      chart?: {
        result?: Array<{
          meta?: { gmtoffset?: number };
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
// Phase: accept

function loadAcceptance(): Map<string, number> {
  const out = new Map<string, number>();
  if (!fs.existsSync(ACCEPT_FILE)) return out;
  for (const line of fs.readFileSync(ACCEPT_FILE, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as { acc: string; ms: number | null };
      out.set(r.acc, r.ms ?? NaN);
    } catch {
      // torn line
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
    const r = await getText(`https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, "")}/${acc}-index.htm`, SEC_UA, secQueue);
    if (r.status === 0 || r.status >= 500 || r.status === 429) return;
    const m = /Accepted<\/div>\s*<div class="info">(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(r.body);
    const ms = m ? nyInstantMs(m[1]!, Number(m[2]) * 60 + Number(m[3])) + Number(m[4]) * 1000 : null;
    fs.appendFileSync(ACCEPT_FILE, JSON.stringify({ acc, ms }) + "\n");
    if (++done % 500 === 0) log(`accept: ${done}/${todo.length}`);
  });
}

// ---------------------------------------------------------------------------
// Shares (XBRL frames from the F7 study)

type SharesPoint = { end: string; val: number };
function loadShares(): Map<string, SharesPoint[]> {
  const out = new Map<string, SharesPoint[]>();
  if (!fs.existsSync(FRAMES_DIR)) return out;
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
function sharesAt(points: SharesPoint[] | undefined, date: string): number | null {
  if (!points) return null;
  let best: SharesPoint | null = null;
  for (const p of points) if (p.end <= date) best = p;
  if (!best || Date.parse(date) - Date.parse(best.end) > 460 * 86_400_000) return null;
  return best.val > 0 ? best.val : null;
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

function periodOf(d: string): string {
  return d <= "2021-12-31" ? "dev 2015-2021" : d <= "2023-12-31" ? "val 2022-2023" : "holdout 2024-2026H1";
}

// ---------------------------------------------------------------------------
// Phase: measure

type PanelRow = {
  family: Family;
  issuer: string;
  ticker: string;
  group: "listed_now" | "delisted_priced";
  date: string;
  accession: string;
  form: string;
  sic: string | null;
  publicTime: "acceptance" | "filing_date_close";
  publicAt: string;
  entryDate: string;
  price: number;
  dollarVolume: number;
  beta: number;
  pre: number | null;
  w: Record<number, { betaOnlyPct: number; carPct: number; rawMinusSpyPct: number; y: number | null; nControls: number } | null>;
};

type Funnel = Record<string, number>;

function nearGate(e: StudyEvent, ticker: string, cache: Map<string, Aligned | null>): boolean {
  if (!cache.has(ticker)) cache.set(ticker, loadAligned(ticker));
  const s = cache.get(ticker);
  if (!s) return false;
  const day0 = reactionDayIndex(SESSIONS, nyInstantMs(e.date, 16 * 60 + 1));
  if (day0 === null || day0 - 1 < s.first) return false;
  return lastValid(s.raw, day0 - 1) > 4 && median20(s.dv, day0 - 1) >= 4e6;
}

async function measurePhase(): Promise<void> {
  const { meta, events } = loadEvents();
  const maps = listingMaps();
  const f25 = form25Dates();
  const accept = loadAcceptance();
  const shares = loadShares();
  const spy = loadAligned("SPY");
  if (!spy) throw new Error("SPY prices missing");
  const series = new Map<string, Aligned | null>();
  const getSeries = (t: string) => {
    if (!series.has(t)) series.set(t, loadAligned(t));
    return series.get(t)!;
  };

  // Own events per family and issuer (screen controls).
  const ownEvents = new Map<string, string[]>();
  for (const e of events) {
    const k = `${e.family}|${e.issuer}`;
    let a = ownEvents.get(k);
    if (!a) ownEvents.set(k, (a = []));
    a.push(e.date);
  }
  for (const a of ownEvents.values()) a.sort();

  // Control pool: listed CIKs with SIC (F7 cache).
  const poolBySic2 = new Map<string, Array<{ cik: string; ticker: string; sic: string; earnings: string[] }>>();
  for (const l of maps.listed.values()) {
    const info = readInfo(l.cik);
    if (!info?.sic || /^0+$/.test(info.sic)) continue;
    const sic = info.sic.padStart(4, "0");
    let a = poolBySic2.get(sic.slice(0, 2));
    if (!a) poolBySic2.set(sic.slice(0, 2), (a = []));
    a.push({ cik: l.cik, ticker: l.ticker, sic, earnings: info.earnings });
  }

  const funnels: Record<string, Funnel> = {};
  const panel: PanelRow[] = [];
  const out = fs.createWriteStream(PANEL_FILE);
  let k = 0;
  for (const e of events) {
    if (++k % 2000 === 0) log(`measure: ${k}/${events.length}, ${panel.length} measured`);
    const fn = (funnels[e.family] ??= { events: 0, no_ticker_today: 0, not_listed_at_event: 0, listed_now: 0, delisted_priced: 0, noYahoo: 0, notCovered: 0, belowPrice: 0, belowVolume: 0, gated: 0, noEstimation: 0, measured: 0, measured_listed_now: 0, measured_delisted_priced: 0, acceptance: 0, filingDateClose: 0, withControls: 0 });
    fn.events!++;
    const tk = tickerFor(e, maps, f25);
    if ("skip" in tk) {
      fn[tk.skip]!++;
      continue;
    }
    fn[tk.group]!++;
    const s = getSeries(tk.ticker);
    if (!s) {
      fn.noYahoo!++;
      continue;
    }
    const acc = accept.get(e.accession);
    const fromAcceptance = acc !== undefined && Number.isFinite(acc);
    const publicMs = fromAcceptance ? acc! : nyInstantMs(e.date, 16 * 60 + 1);
    const day0 = reactionDayIndex(SESSIONS, publicMs);
    if (day0 === null || day0 - 1 < s.first || day0 > s.last) {
      fn.notCovered!++;
      continue;
    }
    const price = lastValid(s.raw, day0 - 1);
    const dv = median20(s.dv, day0 - 1);
    if (!(price > 5)) {
      fn.belowPrice!++;
      continue;
    }
    if (!(dv >= 5e6)) {
      fn.belowVolume!++;
      continue;
    }
    fn.gated!++;
    const m = measureEvent({ sessions: SESSIONS, stock: s, market: spy, publicMs, windows: WINDOWS });
    if (!m.ok) {
      fn.noEstimation!++;
      continue;
    }
    fn.measured!++;
    fn[`measured_${tk.group}`]!++;
    if (fromAcceptance) fn.acceptance!++;
    else fn.filingDateClose!++;
    const info = readInfo(e.issuer);
    const sic = e.sic ? e.sic.padStart(4, "0") : info?.sic ? info.sic.padStart(4, "0") : null;

    // Matched controls at L = 20 (secondary), as F7.
    const controlScar: number[] = [];
    if (sic) {
      const lo = day0 + ESTIMATION.from;
      const hi = day0 + ESTIMATION.to;
      const winFrom = SESSIONS[Math.max(0, day0 - 5)]!;
      const winTo = SESSIONS[Math.min(SESSIONS.length - 1, m.entry + 20)]!;
      const sh = sharesAt(shares.get(e.issuer), e.date);
      const cands: ControlCandidate[] = [];
      for (const c of (poolBySic2.get(sic.slice(0, 2)) ?? []).filter((c) => c.cik !== e.issuer)) {
        const cs = getSeries(c.ticker);
        if (!cs || cs.first > lo || cs.last < m.entry) continue;
        const cp = lastValid(cs.raw, day0 - 1);
        const cdv = median20(cs.dv, day0 - 1);
        if (!(cp > 5) || !(cdv >= 5e6)) continue;
        const csh = sharesAt(shares.get(c.cik), e.date);
        const mm = fitMarketModel(cs, spy, lo, hi);
        cands.push({ id: c.ticker, sic: c.sic, sizeUsd: csh === null ? null : csh * cp, beta: mm ? mm.beta : null, price: cp, dollarVolume: cdv, ownEarnings: hasDateIn(c.earnings, winFrom, winTo), ownEvent: hasDateIn(ownEvents.get(`${e.family}|${c.cik}`) ?? [], winFrom, winTo) });
      }
      const sel = selectControls({ id: tk.ticker, sic, sizeUsd: sh === null ? null : sh * price, beta: m.model.beta }, cands);
      for (const c of sel.controls) {
        const cm = measureEvent({ sessions: SESSIONS, stock: getSeries(c.id)!, market: spy, publicMs, windows: [20] });
        if (cm.ok && cm.drift[20]) controlScar.push(cm.drift[20].scar);
      }
      if (controlScar.length >= 3) fn.withControls!++;
    }

    const w: PanelRow["w"] = {};
    for (const L of WINDOWS) {
      const d = m.drift[L];
      w[L] = d
        ? {
            betaOnlyPct: (d.car + m.model.alpha * L) * 100,
            carPct: d.car * 100,
            rawMinusSpyPct: d.rawMinusMarket * 100,
            y: L === 20 ? matchedOutcome(d.scar, controlScar, 1) : null,
            nControls: L === 20 ? controlScar.length : 0,
          }
        : null;
    }
    const row: PanelRow = {
      family: e.family,
      issuer: e.issuer,
      ticker: tk.ticker,
      group: tk.group,
      date: e.date,
      accession: e.accession,
      form: e.form,
      sic,
      publicTime: fromAcceptance ? "acceptance" : "filing_date_close",
      publicAt: new Date(publicMs).toISOString(),
      entryDate: m.entryDate,
      price: +price.toFixed(2),
      dollarVolume: Math.round(dv),
      beta: m.model.beta,
      pre: m.pre ? m.pre.ar * 100 : null,
      w,
    };
    panel.push(row);
    out.write(JSON.stringify(row) + "\n");
  }
  await new Promise<void>((r) => out.end(r));
  for (const [f, fn] of Object.entries(funnels)) log(`funnel ${f}`, fn);

  // Summaries.
  const study = (rows: PanelRow[], f: (r: PanelRow) => number | null | undefined) =>
    eventStudy(
      rows.flatMap((r) => {
        const v = f(r);
        return v === null || v === undefined || !Number.isFinite(v) ? [] : [{ value: v, date: r.date, firm: r.issuer }];
      }),
    );
  const summary: Record<string, unknown> = { computedAt: new Date().toISOString(), meta, funnels, families: {} as Record<string, unknown> };
  for (const fam of Object.keys(FAMILIES) as Family[]) {
    const rows = panel.filter((r) => r.family === fam);
    const expected = FAMILIES[fam].expected;
    const groups: Record<string, PanelRow[]> = { all: rows };
    for (const r of rows) {
      (groups[`period: ${periodOf(r.date)}`] ??= []).push(r);
      (groups[`listing: ${r.group}`] ??= []).push(r);
      (groups[`form: ${r.form}`] ??= []).push(r);
      (groups[`time: ${r.publicTime}`] ??= []).push(r);
    }
    if (fam === "F6_restatement_402") groups["ex SIC 6770 (blank checks)"] = rows.filter((r) => r.sic !== "6770");
    const per: Record<string, unknown> = {};
    for (const [g, rs] of Object.entries(groups).sort()) {
      per[g] = {
        betaOnly20: study(rs, (r) => r.w[20]?.betaOnlyPct),
        betaOnly5: study(rs, (r) => r.w[5]?.betaOnlyPct),
        car20: study(rs, (r) => r.w[20]?.carPct),
        car5: study(rs, (r) => r.w[5]?.carPct),
        rawMinusSpy20: study(rs, (r) => r.w[20]?.rawMinusSpyPct),
        y20: study(rs, (r) => r.w[20]?.y),
        betaOnly60: study(rs, (r) => r.w[60]?.betaOnlyPct),
        pre: study(rs, (r) => r.pre),
      };
    }
    const primary = (per.all as { betaOnly20: StudySummary | null }).betaOnly20;
    const bar = passesBar(primary, expected);
    (summary.families as Record<string, unknown>)[fam] = { expected, label: FAMILIES[fam].label, bar, bonferroni: bar.pTwoWay < 0.05 / 3, groups: per };
    log(`${fam}: primary`, primary ? { n: primary.n, g: primary.g, mean: primary.mean, median: primary.median, tTwoWay: primary.twoWay.t, tDate: primary.byDate.t } : null, bar);
  }
  fs.writeFileSync(SUMMARY_FILE, JSON.stringify(summary, null, 1));
  fs.writeFileSync(SUMMARY_MD, renderMd(summary));
  console.log(renderMd(summary));
}

function fmt(x: number | null | undefined, d = 2): string {
  return x === null || x === undefined || !Number.isFinite(x) ? "-" : x.toFixed(d);
}

function renderMd(summary: Record<string, unknown>): string {
  const lines: string[] = [`computed ${summary.computedAt}`, `meta: ${JSON.stringify(summary.meta)}`, `funnels: ${JSON.stringify(summary.funnels)}`];
  for (const [fam, f] of Object.entries(summary.families as Record<string, { expected: number; bar: unknown; bonferroni: boolean; groups: Record<string, Record<string, StudySummary | null>> }>)) {
    lines.push("", `## ${fam} (expected ${f.expected > 0 ? "+" : "-"}) bar: ${JSON.stringify(f.bar)} bonferroni: ${f.bonferroni}`, "");
    lines.push("| group | measure | n | G | mean | median | t date | t 2-way | share > 0 |", "|---|---|---|---|---|---|---|---|---|");
    for (const [g, cells] of Object.entries(f.groups)) {
      for (const [m, s] of Object.entries(cells)) {
        if (!s) continue;
        lines.push(`| ${g} | ${m} | ${s.n} | ${s.g} | ${fmt(s.mean)} | ${fmt(s.median)} | ${fmt(s.byDate.t)} | ${fmt(s.twoWay.t)} | ${fmt(s.positive)} |`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (want("index")) await indexPhase();
  if (want("efts")) await eftsPhase();
  if (want("headers")) await headersPhase();
  if (want("events")) eventsPhase();
  if (want("sec") || want("prices") || want("accept")) {
    const { events } = loadEvents();
    const maps = listingMaps();
    const f25 = form25Dates();
    const priced = events.flatMap((e) => {
      const t = tickerFor(e, maps, f25);
      return "ticker" in t ? [{ e, ...t }] : [];
    });
    if (want("sec")) {
      fs.mkdirSync(SUB_DIR, { recursive: true });
      const ciks = [...new Set(priced.map((p) => p.e.issuer))].filter((c) => !fs.existsSync(path.join(SUB_DIR, `${c}.json`)));
      log(`sec: ${ciks.length} issuers to read`);
      let done = 0;
      await pool(ciks, 6, async (c) => {
        await submissionsFor(c);
        if (++done % 250 === 0) log(`sec: ${done}/${ciks.length}`);
      });
    }
    if (want("prices")) {
      const tickers = [...new Set(["SPY", ...priced.map((p) => p.ticker)])].filter((t) => !fs.existsSync(yahooPath(t)));
      log(`prices: ${tickers.length} tickers to fetch`);
      let done = 0;
      await pool(tickers, 3, async (t) => {
        await fetchYahoo(t);
        if (++done % 250 === 0) log(`prices: ${done}/${tickers.length}`);
      });
    }
    if (want("accept")) {
      const cache = new Map<string, Aligned | null>();
      await acceptPhase(priced.filter((p) => nearGate(p.e, p.ticker, cache)).map((p) => ({ acc: p.e.accession, cik: p.e.issuer })));
    }
  }
  if (want("measure")) await measurePhase();
  log("done");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
