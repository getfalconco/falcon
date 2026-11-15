/**
 * Graph v1 extraction (design 4.2, step 2) for a list of filers: each one's
 * latest annual report (10-K, 20-F, 40-F) from EDGAR, cut to the passages
 * that can name a business link (src/graph/locate.ts), read by Claude Haiku
 * 5.5 into candidate links with verbatim quotes (stage A), checked in code
 * (src/graph/extract.ts: quote in the filing, name in the quote, share in
 * the quote), resolved to tickers (src/graph/resolve.ts), then optionally
 * read again claim by claim (stage B, --verify). Writes a graph in
 * data/graph.json's shape to --out (never over graph.json) and the full run
 * (every proposal, every rejection and why) to .cache/graph-extract/.
 *
 * Every filing and every model answer is cached on disk (.cache/http,
 * .cache/llm), so a rerun or a resumed run pays only for what it has not
 * read yet. FALCON_LLM_CACHE=0 turns the model cache off.
 *
 *   pnpm --filter @falcon/engine run graph-extract -- --pilot --budget 7.5 --verify sonnet
 *   pnpm --filter @falcon/engine run graph-extract -- --tickers WMT,GM --dry
 *
 * Flags:
 *   --pilot            the pilot list below (about 50 filers in 9 sectors)
 *   --tickers A,B      filers to read (instead of --pilot)
 *   --universe FILE    filers from a graph-universe output (instead of --pilot)
 *   --out FILE         graph output (default data/graph-pilot.json)
 *   --budget USD       hard cap on model spend for the run (default 7.5)
 *   --verify MODE      off | haiku | sonnet: stage B reader (default off)
 *   --max-chars N      passage characters per filing (default 120000)
 *   --chunk-chars N    passage characters per model call (default 15000: Haiku misses links in longer calls)
 *   --extract MODEL    haiku | sonnet: stage A reader (default haiku)
 *   --concurrency N    filers read at once (default 4)
 *   --batch            Message Batches API (half price): each pass records the
 *                      calls the cache cannot answer, submits them, waits, and
 *                      passes again until every answer is cached; resumable
 *                      (state in .cache/graph-extract/<out>-batches.json, whose
 *                      spend counts against --budget)
 *   --dry              locate passages only, no model calls
 */

import fs from "node:fs";
import path from "node:path";
import { loadListings, type Listings } from "../src/feed/companies.ts";
import { ENGINE_ROOT } from "../src/http.ts";
import { collectBatch, llmUsage, structured, takePendingBatch, TRIAGE_MODEL, VERIFY_MODEL } from "../src/detectors/llm.ts";
import { readBatchState, runBatches } from "../src/detectors/llm-batch.ts";
import { documentText, filingDocuments, recentFilings, type Filing } from "../src/sec.ts";
import { normalizeForMatch } from "../src/text.ts";
import { NAMES } from "../src/universe.ts";
import type { Graph } from "../src/graph.ts";
import { chunkPassages, locateLinkPassages, type Passage } from "../src/graph/locate.ts";
import {
  applyVerdict,
  checkLink,
  dedupeEdges,
  edgeIdOf,
  EXTRACT_SCHEMA,
  EXTRACT_SYSTEM,
  EXTRACTOR_VERSION,
  extractUser,
  latestAnnual,
  parseLinks,
  parseVerdicts,
  VERIFY_SCHEMA,
  VERIFY_SYSTEM,
  verifyUser,
  type ExtractedEdge,
  type RawLink,
  type Verdict,
} from "../src/graph/extract.ts";
import { displayName, resolveCounterparty } from "../src/graph/resolve.ts";

/** The pilot: about 50 filers across 9 sectors, semis included to compare with the seed graph. */
const PILOT: Record<string, string[]> = {
  retail: ["WMT", "TGT", "COST", "HD", "BBY", "NKE"],
  consumer: ["CLX", "HAS"],
  autos: ["GM", "F", "TSLA", "APTV", "BWA", "LEA"],
  aerospace_airlines: ["BA", "DAL", "UAL", "HWM", "HXL", "TDG"],
  pharma_health: ["PFE", "LLY", "ABBV", "MRK", "MCK", "DXCM"],
  energy: ["COP", "CVX", "SLB", "HAL", "LNG", "VLO"],
  software: ["MSFT", "ORCL", "SNOW", "CRM", "ADBE", "DDOG"],
  industrials: ["CAT", "DE", "HON", "GWW", "UPS", "FDX"],
  semis: ["NVDA", "AMD", "INTC", "NXPI", "ANET", "CDNS", "CRUS", "UCTT"],
};

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? null) : null;
}

const flag = (name: string) => process.argv.includes(`--${name}`);

const budget = Number(arg("budget") ?? 7.5);
const verifyMode = (arg("verify") ?? "off") as "off" | "haiku" | "sonnet";
const maxChars = Number(arg("max-chars") ?? 120_000);
const chunkChars = Number(arg("chunk-chars") ?? 15_000);
const extractModel = arg("extract") === "sonnet" ? VERIFY_MODEL : TRIAGE_MODEL;
const concurrency = Number(arg("concurrency") ?? 4);
const dry = flag("dry");
const batch = flag("batch") && !dry;
const outFile = path.resolve(arg("out") ?? path.join(ENGINE_ROOT, "data", "graph-pilot.json"));
const RUN_DIR = path.join(ENGINE_ROOT, ".cache", "graph-extract");

function filers(): Array<{ ticker: string; sector: string }> {
  const t = arg("tickers");
  if (t) return t.split(",").map((s) => ({ ticker: s.trim().toUpperCase(), sector: "" })).filter((x) => x.ticker);
  const u = arg("universe");
  if (u) return (JSON.parse(fs.readFileSync(u, "utf8")) as { members: Array<{ ticker: string; sector?: string }> }).members.map((m) => ({ ticker: m.ticker, sector: m.sector ?? "" }));
  if (flag("pilot")) return Object.entries(PILOT).flatMap(([sector, ts]) => ts.map((ticker) => ({ ticker, sector })));
  throw new Error("give --pilot, --tickers or --universe");
}

const t0 = Date.now();
const log = (line: string) => console.error(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${line}`);

/** The annual report's text; a 40-F's content is in its exhibits, a 10-K's sometimes in EX-13. */
async function annualText(f: Filing): Promise<string> {
  let text = await documentText(f.url);
  if (/^40-F/.test(f.form) || text.length < 150_000) {
    const docs = await filingDocuments(f).catch(() => []);
    const extra = docs.filter((d) => (/^40-F/.test(f.form) ? /^EX-99\.[1-3]$/ : /^EX-13/).test(d.type) && /\.html?$/i.test(d.url));
    for (const d of extra) text += `\n${await documentText(d.url)}`;
  }
  return text;
}

type Rejected = { ticker: string; counterparty: string; relation: string; reason: string; quote: string };

type FilerRun = {
  ticker: string;
  sector: string;
  name: string;
  form?: string;
  accession?: string;
  filedAt?: string;
  url?: string;
  error?: string;
  docChars?: number;
  passageChars?: number;
  passages?: number;
  calls?: number;
  proposed?: number;
  rejected?: Rejected[];
  /** Stage A edges, checked and resolved, before stage B. */
  edges?: ExtractedEdge[];
  /** Stage B verdicts by stage A edge id. */
  verdicts?: Record<string, Verdict>;
};

function sectionOf(quote: string, passages: Passage[], fallback: string): string {
  const head = normalizeForMatch(quote.split(/\s*\.\.\.\s*/)[0] ?? quote).slice(0, 80);
  const p = passages.find((x) => normalizeForMatch(x.text).includes(head));
  return p?.section ?? (fallback || "unknown");
}

async function readFiler(ticker: string, sector: string, listings: Listings): Promise<FilerRun> {
  const listing = listings.byTicker.get(ticker) ?? listings.byTicker.get(ticker.replace(".", "-"));
  const name = NAMES[ticker] ?? listing?.name ?? ticker;
  const run: FilerRun = { ticker, sector, name };
  if (!listing) return { ...run, error: "no SEC listing" };
  const filing = latestAnnual(await recentFilings(listing.cik));
  if (!filing) return { ...run, error: "no annual report in recent filings" };
  Object.assign(run, { form: filing.form, accession: filing.accession, filedAt: filing.filedAt, url: filing.url });
  const doc = await annualText(filing);
  const { passages, stats } = locateLinkPassages(doc, filing.form, maxChars);
  Object.assign(run, { docChars: doc.length, passageChars: stats.keptChars, passages: stats.kept });
  if (dry) return run;

  // Stage A: candidate links.
  const chunks = chunkPassages(passages, chunkChars);
  run.calls = chunks.length;
  const filer = { name: listing.name, ticker, form: filing.form, filedAt: filing.filedAt };
  const answers = await Promise.all(
    chunks.map((c, i) =>
      structured({ system: EXTRACT_SYSTEM, user: extractUser(filer, c), schema: EXTRACT_SCHEMA as unknown as Record<string, unknown>, maxTokens: 8000, model: extractModel }, budget, log, `extract ${ticker} ${i + 1}/${chunks.length}`),
    ),
  );
  if (answers.some((a) => a === null)) run.error = "a model call failed or the budget is spent";
  const raw: RawLink[] = answers.flatMap((a) => parseLinks(a));
  run.proposed = raw.length;
  run.rejected = [];
  const edges: ExtractedEdge[] = [];
  for (const r of raw) {
    const c = checkLink(r, doc, listing.name);
    if (!c.ok) {
      run.rejected.push({ ticker, counterparty: r.counterparty, relation: r.relation, reason: c.reason, quote: r.quote.slice(0, 300) });
      continue;
    }
    const res = resolveCounterparty(r.counterparty, r.us_ticker, listings);
    if (res.ticker === ticker) {
      run.rejected.push({ ticker, counterparty: r.counterparty, relation: r.relation, reason: "resolves to the filer", quote: r.quote.slice(0, 300) });
      continue;
    }
    const e: ExtractedEdge = {
      id: "",
      from: ticker,
      to: res.ticker,
      toName: r.counterparty.trim(),
      category: r.relation,
      tier: c.value.tier,
      disclosedSharePct: c.value.sharePct,
      quote: c.value.quote,
      form: filing.form,
      filedAt: filing.filedAt,
      url: filing.url,
      origin: `${EXTRACTOR_VERSION}-${new Date().toISOString().slice(0, 7)}`,
      accession: filing.accession,
      section: sectionOf(c.value.quote, passages, r.section),
      shareBasis: c.value.shareBasis,
      soleSource: c.value.soleSource,
      resolvedBy: res.by,
      extractor: extractModel,
    };
    e.id = edgeIdOf(e);
    edges.push(e);
  }
  run.edges = dedupeEdges(edges);

  // Stage B: each kept edge read again from its quote alone.
  if (verifyMode !== "off" && run.edges.length) {
    const model = verifyMode === "sonnet" ? VERIFY_MODEL : TRIAGE_MODEL;
    run.verdicts = {};
    for (let at = 0; at < run.edges.length; at += 40) {
      const batch = run.edges.slice(at, at + 40);
      const answer = await structured(
        { system: VERIFY_SYSTEM, user: verifyUser({ name: listing.name, ticker }, batch.map((e) => ({ counterparty: e.toName, quote: e.quote }))), schema: VERIFY_SCHEMA as unknown as Record<string, unknown>, maxTokens: 4000, model },
        budget,
        log,
        `verify ${ticker}`,
      );
      if (answer === null) continue;
      const verdicts = parseVerdicts(answer);
      batch.forEach((e, i) => {
        const v = verdicts.get(i + 1);
        if (v) run.verdicts![e.id] = v;
      });
    }
  }
  return run;
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(items[i]!);
      }
    }),
  );
  return out;
}

const list = filers();
log(`${list.length} filers, budget $${budget}, verify ${verifyMode}${dry ? ", dry (no model calls)" : ""}${batch ? ", batch" : ""}`);
const listings = await loadListings();

const readAll = (quiet: boolean) =>
  pool(list, concurrency, async ({ ticker, sector }) => {
    try {
      const r = await readFiler(ticker, sector, listings);
      if (!quiet) log(`${ticker}: ${r.form ?? "-"} ${r.filedAt ?? ""} doc ${r.docChars ?? 0} chars -> ${r.passages ?? 0} passages / ${r.passageChars ?? 0} chars${dry ? "" : `; ${r.proposed ?? 0} proposed, ${r.edges?.length ?? 0} kept`}${r.error ? ` (${r.error})` : ""}`);
      return r;
    } catch (err) {
      const why = (err as Error).message.split("\n")[0];
      log(`${ticker}: failed (${why})`);
      return { ticker, sector, name: ticker, error: why } as FilerRun;
    }
  });

const batchState = path.join(RUN_DIR, `${path.basename(outFile, ".json")}-batches.json`);
if (batch) {
  // Stage A's answers, then stage B's (it reads stage A's edges): one pass each,
  // plus passes for requests that failed; the last read below uses only the cache.
  for (let round = 1; round <= 4; round++) {
    collectBatch(true);
    await readAll(true);
    collectBatch(false);
    const todo = takePendingBatch();
    log(`batch pass ${round}: ${todo.length} calls not cached`);
    if (!todo.length) break;
    const r = await runBatches(todo, { stateFile: batchState, budgetUsd: budget, log });
    log(`batch pass ${round}: ${r.succeeded} answered, ${r.failed} failed, $${r.addedUsd.toFixed(2)}`);
  }
}
const runs = await readAll(false);

const u = llmUsage();
const seconds = Math.round((Date.now() - t0) / 1000);
fs.mkdirSync(RUN_DIR, { recursive: true });
const runFile = path.join(RUN_DIR, `${path.basename(outFile, ".json")}-run.json`);
fs.writeFileSync(runFile, `${JSON.stringify({ at: new Date().toISOString(), seconds, verify: verifyMode, extractModel, maxChars, chunkChars, usage: u, runs }, null, 1)}\n`);
log(`run detail -> ${runFile}`);
log(`model: ${u.calls} calls (${u.cached} from cache), ${u.inputTokens} in / ${u.outputTokens} out tokens, $${u.costUsd.toFixed(4)}${u.skipped ? `, ${u.skipped} skipped` : ""}`);
if (batch) log(`batch spend so far (half price): $${readBatchState(batchState).spentUsd.toFixed(4)}`);
for (const [m, mu] of Object.entries(u.byModel)) log(`  ${m}: ${mu.calls} calls, ${mu.inputTokens} in / ${mu.outputTokens} out, $${mu.costUsd.toFixed(4)}`);

if (!dry) {
  // Stage B's verdict, when it ran: an edge it does not support is left out, its relation wins.
  const edges = dedupeEdges(
    runs.flatMap((r) => (r.edges ?? []).flatMap((e) => applyVerdict(e, r.verdicts?.[e.id]) ?? [])),
  );
  const names: Record<string, string> = {};
  for (const r of runs) names[r.ticker] = NAMES[r.ticker] ?? displayName(r.name);
  for (const e of edges) {
    if (e.to && !names[e.to]) names[e.to] = NAMES[e.to] ?? displayName(listings.byTicker.get(e.to)?.name ?? e.toName);
  }
  const graph: Graph = { generatedAt: new Date().toISOString(), names, edges };
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, `${JSON.stringify(graph, null, 1)}\n`);
  log(`graph: ${edges.length} edges (${edges.filter((e) => e.to).length} with a ticker on both ends) from ${runs.filter((r) => r.edges).length} filers -> ${outFile}`);
}
