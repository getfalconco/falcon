/**
 * Point-in-time graph, step 1: reads every annual report (10-K, 20-F, 40-F
 * and amendments) a filer sent since --since with the live graph's own
 * extraction, stage A of scripts/graph-extract.ts (the same passages from
 * src/graph/locate.ts, the same prompt and model, the same code checks in
 * src/graph/extract.ts and ticker resolution in src/graph/resolve.ts), and
 * writes what each report states to .cache/graph-history/reads/<TICKER>.json.
 * The report the live graph was read from is not read again: its links come
 * from data/graph-v1.json. `--build` then writes data/graph-pit.json
 * (src/graph/pit.ts: first seen, last seen, possibly ended per edge).
 *
 *   pnpm --filter @falcon/engine exec node --import tsx scripts/graph-history.ts --tickers NVDA,AMD --budget 2
 *   pnpm --filter @falcon/engine exec node --import tsx scripts/graph-history.ts --build
 *
 * Flags:
 *   --tickers A,B   filers to read (default: every filer of the live graph)
 *   --since DATE    oldest filing date read (default 2014-01-01)
 *   --budget USD    hard cap on model spend for the run (default 2)
 *   --concurrency N reports read at once (default 6)
 *   --dry           fetch and locate only, no model calls (sizes the run)
 *   --plan          list the reports to read and stop
 *   --batch         Message Batches API (half price): passes that record the calls the
 *                   cache cannot answer, submit them, wait, until every answer is cached
 *                   (resumable; state in .cache/graph-history/batches.json, its spend counts
 *                   against --budget); then the reads are written from the cache
 *   --build         no reads: write data/graph-pit.json from the cached reads
 *
 * EDGAR: at most 8 requests a second with the engine's declared User-Agent.
 * Submissions indexes come from --edgar-cache when given (files written as
 * {url, status, fetchedAtMs, body}) or EDGAR. Raw HTML is never kept (disk):
 * each report's plain text is cached gzipped in .cache/graph-history/text/.
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { loadListings, type Listings } from "../src/feed/companies.ts";
import { ENGINE_ROOT, SEC_USER_AGENT } from "../src/http.ts";
import { collectBatch, llmUsage, structured, takePendingBatch, TRIAGE_MODEL } from "../src/detectors/llm.ts";
import { readBatchState, runBatches } from "../src/detectors/llm-batch.ts";
import { parseFilingIndex } from "../src/sec.ts";
import { htmlToText } from "../src/text.ts";
import { loadGraph, type Graph, type GraphEdge } from "../src/graph.ts";
import { chunkPassages, locateLinkPassages } from "../src/graph/locate.ts";
import { checkLink, dedupeEdges, edgeIdOf, EXTRACT_SCHEMA, EXTRACT_SYSTEM, extractUser, parseLinks, type ExtractedEdge, type RawLink } from "../src/graph/extract.ts";
import { resolveCounterparty } from "../src/graph/resolve.ts";
import { accessionFromUrl, annualFilings, buildPit, type FilingLink, type FilingRead, type FilingRef } from "../src/graph/pit.ts";

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const since = arg("since") ?? "2014-01-01";
const budget = Number(arg("budget") ?? 2);
const concurrency = Number(arg("concurrency") ?? 6);
const dry = flag("dry");
const edgarCache = arg("edgar-cache");
const DIR = path.join(ENGINE_ROOT, ".cache", "graph-history");
const READS = path.join(DIR, dry ? "reads-dry" : "reads");
const TEXT = path.join(DIR, "text");
// Same settings as the graph-v1 run (scripts/graph-extract.ts defaults).
const MAX_CHARS = 120_000;
const CHUNK_CHARS = 15_000;

const t0 = Date.now();
const log = (line: string) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`);

// ---------------------------------------------------------------------------
// EDGAR, politely: one queue, at most 8 requests a second.

let lastAt = 0;
let chain: Promise<unknown> = Promise.resolve();
const stats = { requests: 0, bytes: 0, fetchMs: 0 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function secFetch(url: string): Promise<string> {
  const run = async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const wait = lastAt + 125 - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      stats.requests++;
      const t = Date.now();
      try {
        const res = await fetch(url, { headers: { "User-Agent": SEC_USER_AGENT, "Accept-Encoding": "gzip, deflate" }, signal: AbortSignal.timeout(60_000) });
        if (res.ok) {
          const body = await res.text();
          stats.bytes += body.length;
          stats.fetchMs += Date.now() - t;
          return body;
        }
        if (res.status !== 429 && res.status < 500) throw new Error(`HTTP ${res.status} for ${url}`);
      } catch (err) {
        if (/HTTP 4\d\d/.test((err as Error).message) && !/HTTP 429/.test((err as Error).message)) throw err;
      }
      await sleep(1000 * 2 ** attempt);
    }
    throw new Error(`gave up on ${url}`);
  };
  const next = chain.then(run, run);
  chain = next.catch(() => undefined);
  return next;
}

async function submissionsBlocks(cik: string): Promise<Array<Record<string, string[]>>> {
  const read = async (name: string): Promise<Record<string, unknown>> => {
    const cached = edgarCache ? path.join(edgarCache, name) : null;
    if (cached && fs.existsSync(cached)) return JSON.parse((JSON.parse(fs.readFileSync(cached, "utf8")) as { body: string }).body) as Record<string, unknown>;
    const own = path.join(DIR, "submissions", name);
    if (fs.existsSync(own) && Date.now() - fs.statSync(own).mtimeMs < 7 * 86_400_000) return JSON.parse(fs.readFileSync(own, "utf8")) as Record<string, unknown>;
    const body = await secFetch(`https://data.sec.gov/submissions/${name}`);
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, body);
    return JSON.parse(body) as Record<string, unknown>;
  };
  const main = await read(`CIK${cik}.json`);
  const filings = main.filings as { recent: Record<string, string[]>; files?: Array<{ name: string; filingTo: string }> };
  const blocks = [filings.recent];
  for (const f of filings.files ?? []) {
    if (f.filingTo < since) continue;
    blocks.push((await read(f.name)) as Record<string, string[]>);
  }
  return blocks;
}

/** A report's text, as graph-extract's annualText reads it (40-F exhibits; a short 10-K's EX-13), cached gzipped. */
async function reportText(f: FilingRef): Promise<string> {
  const file = path.join(TEXT, `${f.accession}.txt.gz`);
  if (fs.existsSync(file)) return zlib.gunzipSync(fs.readFileSync(file)).toString("utf8");
  const base = f.url.slice(0, f.url.lastIndexOf("/"));
  let text = f.url.endsWith("-index.htm") ? "" : htmlToText(await secFetch(f.url));
  if (/^40-F/.test(f.form) || text.length < 150_000) {
    const index = await secFetch(`${base}/${f.accession}-index.htm`).catch(() => "");
    const docs = parseFilingIndex(index);
    const extra = docs.filter((d) => (/^40-F/.test(f.form) ? /^EX-99\.[1-3]$/ : /^EX-13/).test(d.type) && /\.html?$/i.test(d.url));
    if (!text) {
      const primary = docs.find((d) => d.type === f.form && /\.html?$/i.test(d.url));
      if (primary) text = htmlToText(await secFetch(primary.url));
    }
    for (const d of extra) text += `\n${htmlToText(await secFetch(d.url))}`;
  }
  fs.mkdirSync(TEXT, { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(text));
  return text;
}

// ---------------------------------------------------------------------------
// One report, read exactly as scripts/graph-extract.ts reads a filer's latest (stage A).

type ReportRun = FilingRead & { docChars?: number; passageChars?: number; calls?: number; proposed?: number; rejected?: number; unresolved?: number; error?: string; seconds?: number };

async function readReport(ticker: string, name: string, f: FilingRef, listings: Listings): Promise<ReportRun> {
  const t = Date.now();
  const run: ReportRun = { ...f, ok: false, links: [] };
  try {
    const doc = await reportText(f);
    const { passages, stats: s } = locateLinkPassages(doc, f.form, MAX_CHARS);
    Object.assign(run, { docChars: doc.length, passageChars: s.keptChars });
    if (dry) return { ...run, ok: true, seconds: (Date.now() - t) / 1000 };
    const chunks = chunkPassages(passages, CHUNK_CHARS);
    run.calls = chunks.length;
    const filer = { name, ticker, form: f.form, filedAt: f.filedAt };
    const answers = await Promise.all(
      chunks.map((c, i) => structured({ system: EXTRACT_SYSTEM, user: extractUser(filer, c), schema: EXTRACT_SCHEMA as unknown as Record<string, unknown>, maxTokens: 8000, model: TRIAGE_MODEL }, budget, log, `extract ${ticker} ${f.filedAt} ${i + 1}/${chunks.length}`)),
    );
    if (answers.some((a) => a === null)) {
      run.error = "a model call failed or the budget is spent";
      return run;
    }
    const raw: RawLink[] = answers.flatMap((a) => parseLinks(a));
    run.proposed = raw.length;
    let rejected = 0;
    const edges: ExtractedEdge[] = [];
    for (const r of raw) {
      const c = checkLink(r, doc, name);
      if (!c.ok) {
        rejected++;
        continue;
      }
      const res = resolveCounterparty(r.counterparty, r.us_ticker, listings);
      if (res.ticker === ticker) {
        rejected++;
        continue;
      }
      const e = {
        id: "",
        from: ticker,
        to: res.ticker,
        toName: r.counterparty.trim(),
        category: r.relation,
        tier: c.value.tier,
        disclosedSharePct: c.value.sharePct,
        quote: c.value.quote,
        form: f.form,
        filedAt: f.filedAt,
        url: f.url,
        origin: "graph-history",
        accession: f.accession,
        section: "",
        shareBasis: c.value.shareBasis,
        soleSource: c.value.soleSource,
        resolvedBy: res.by,
        extractor: TRIAGE_MODEL,
      } as ExtractedEdge;
      e.id = edgeIdOf(e);
      edges.push(e);
    }
    run.rejected = rejected;
    const kept = dedupeEdges(edges);
    run.unresolved = kept.filter((e) => !e.to).length;
    run.links = kept.map((e): FilingLink => ({ to: e.to, toName: e.toName, category: e.category, tier: e.tier, disclosedSharePct: e.disclosedSharePct, quote: e.quote }));
    run.ok = true;
  } catch (err) {
    run.error = (err as Error).message.split("\n")[0];
  }
  run.seconds = (Date.now() - t) / 1000;
  return run;
}

async function pool<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) await fn(items[next++]!);
    }),
  );
}

// ---------------------------------------------------------------------------

const live = loadGraph();
const v1 = loadGraph(path.join(ENGINE_ROOT, "data", "graph-v1.json"));
const v1Edges = v1.edges as Array<GraphEdge & { accession?: string }>;

/** Accessions the live graph was already read from, per filer: graph-v1's reads and the seed edges' filings. */
function sourceFilings(): Map<string, Map<string, FilingRead>> {
  const out = new Map<string, Map<string, FilingRead>>();
  const add = (e: GraphEdge & { accession?: string }) => {
    const acc = e.accession ?? accessionFromUrl(e.url);
    if (!acc) return;
    const m = out.get(e.from) ?? new Map<string, FilingRead>();
    const r = m.get(acc) ?? { form: e.form, accession: acc, filedAt: e.filedAt, url: e.url, ok: true, links: [] };
    if (!r.links.some((l) => l.to === e.to && l.toName === e.toName && l.category === e.category))
      r.links.push({ to: e.to, toName: e.toName, category: e.category, tier: e.tier, disclosedSharePct: e.disclosedSharePct, quote: e.quote });
    m.set(acc, r);
    out.set(e.from, m);
  };
  for (const e of v1Edges) add(e);
  for (const e of live.edges) add(e);
  return out;
}

if (flag("build")) {
  const sources = sourceFilings();
  const reads: Record<string, FilingRead[]> = {};
  for (const file of fs.existsSync(READS) ? fs.readdirSync(READS) : []) {
    const r = JSON.parse(fs.readFileSync(path.join(READS, file), "utf8")) as { ticker: string; reports: ReportRun[] };
    const own = [...(sources.get(r.ticker)?.values() ?? [])];
    reads[r.ticker] = [...r.reports.filter((x) => !own.some((o) => o.accession === x.accession)).map(({ form, accession, filedAt, url, ok, links }) => ({ form, accession, filedAt, url, ok, links })), ...own];
  }
  const edges = buildPit(live.edges, reads, live.names);
  const out = path.join(ENGINE_ROOT, "data", "graph-pit.json");
  const body = {
    generatedAt: new Date().toISOString(),
    method: `graph-extract stage A (${TRIAGE_MODEL}, ${MAX_CHARS} passage chars, ${CHUNK_CHARS}-char calls) on every annual report since ${since}; see scripts/graph-history.ts and src/graph/pit.ts`,
    since,
    filersRead: Object.keys(reads).length,
    edges,
  };
  fs.writeFileSync(out, `${JSON.stringify(body)}\n`);
  const cur = edges.filter((e) => e.current);
  log(`graph-pit: ${cur.length} live edges (${cur.filter((e) => e.basis === "history").length} with history), ${edges.length - cur.length} older-only edges -> ${out}`);
  process.exit(0);
}

const listings = await loadListings();
const fromLive = [...new Set(live.edges.filter((e) => e.to && e.to !== e.from).map((e) => e.from))].sort();
const tickers = arg("tickers")?.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean) ?? fromLive;
const sources = sourceFilings();
log(`${tickers.length} filers since ${since}, budget $${budget}${dry ? ", dry" : ""}`);

type Job = { ticker: string; name: string; f: FilingRef };
const jobs: Job[] = [];
const perFiler = new Map<string, { name: string; reports: ReportRun[]; planned: number }>();
for (const ticker of tickers) {
  const l = listings.byTicker.get(ticker) ?? listings.byTicker.get(ticker.replace(".", "-")) ?? listings.byTicker.get(ticker.split(/[.-]/)[0]!);
  if (!l) {
    log(`${ticker}: no SEC listing`);
    continue;
  }
  const blocks = await submissionsBlocks(l.cik).catch((err) => {
    log(`${ticker}: submissions failed (${(err as Error).message})`);
    return null;
  });
  if (!blocks) continue;
  const own = sources.get(ticker) ?? new Map();
  const file = path.join(READS, `${ticker}.json`);
  const done = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as { reports: ReportRun[] }).reports.filter((r) => r.ok && (dry || r.calls !== undefined)) : [];
  const todo = annualFilings(l.cik, blocks, since).filter((f) => !own.has(f.accession));
  perFiler.set(ticker, { name: l.name, reports: done.filter((r) => todo.some((f) => f.accession === r.accession)), planned: todo.length });
  for (const f of todo) if (!done.some((r) => r.accession === f.accession)) jobs.push({ ticker, name: l.name, f });
}
log(`${jobs.length} reports to read (${[...perFiler.values()].reduce((s, p) => s + p.planned, 0)} in all, ${[...perFiler.values()].reduce((s, p) => s + p.reports.length, 0)} already read)`);
if (flag("plan")) {
  const byYear: Record<string, number> = {};
  for (const j of jobs) byYear[j.f.filedAt.slice(0, 4)] = (byYear[j.f.filedAt.slice(0, 4)] ?? 0) + 1;
  const amend = jobs.filter((j) => j.f.form.endsWith("/A")).length;
  log(`plan: ${jobs.length} reports (${amend} amendments) from ${perFiler.size} filers; by year ${JSON.stringify(byYear)}`);
  process.exit(0);
}

const save = (ticker: string) => {
  const p = perFiler.get(ticker)!;
  fs.mkdirSync(READS, { recursive: true });
  p.reports.sort((a, b) => a.filedAt.localeCompare(b.filedAt));
  fs.writeFileSync(path.join(READS, `${ticker}.json`), `${JSON.stringify({ ticker, name: p.name, since, at: new Date().toISOString(), reports: p.reports }, null, 1)}\n`);
};

if (flag("batch") && !dry) {
  const stateFile = path.join(DIR, "batches.json");
  for (let round = 1; round <= 4; round++) {
    collectBatch(true);
    await pool(jobs, concurrency, async (j) => {
      await readReport(j.ticker, j.name, j.f, listings);
    });
    collectBatch(false);
    const todo = takePendingBatch();
    log(`batch pass ${round}: ${todo.length} calls not cached`);
    if (!todo.length) break;
    const r = await runBatches(todo, { stateFile, budgetUsd: budget, log });
    log(`batch pass ${round}: ${r.succeeded} answered, ${r.failed} failed, $${r.addedUsd.toFixed(2)}`);
  }
  log(`batch spend so far (half price): $${readBatchState(stateFile).spentUsd.toFixed(4)}`);
}

let n = 0;
await pool(jobs, concurrency, async (j) => {
  const r = await readReport(j.ticker, j.name, j.f, listings);
  const p = perFiler.get(j.ticker)!;
  p.reports = p.reports.filter((x) => x.accession !== r.accession).concat(r);
  save(j.ticker);
  n++;
  log(`${n}/${jobs.length} ${j.ticker} ${r.form} ${r.filedAt}: doc ${r.docChars ?? 0} -> ${r.passageChars ?? 0} chars${dry ? "" : `, ${r.calls ?? 0} calls, ${r.proposed ?? 0} proposed, ${r.links.length} kept`}${r.error ? ` (${r.error})` : ""}`);
});

const u = llmUsage();
const seconds = (Date.now() - t0) / 1000;
const summary = {
  at: new Date().toISOString(),
  filers: perFiler.size,
  reports: jobs.length,
  seconds,
  edgar: { requests: stats.requests, mb: +(stats.bytes / 1e6).toFixed(1), fetchSeconds: +(stats.fetchMs / 1000).toFixed(0) },
  llm: u,
};
fs.mkdirSync(DIR, { recursive: true });
fs.writeFileSync(path.join(DIR, `run-${Date.now()}.json`), `${JSON.stringify(summary, null, 1)}\n`);
log(`done: ${JSON.stringify(summary)}`);
