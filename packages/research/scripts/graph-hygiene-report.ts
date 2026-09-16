/**
 * Relationship-graph hygiene report (read-only).
 *
 * Lists (i) probable duplicate name nodes — clusters of name nodes that share a
 * canonical identity key, and name nodes that match a ticker node already in the
 * graph; (ii) every counterparty_ticker with its counterparty name(s), flagged
 * when the symbol is on the blocklist, absent from the US exchange symbol
 * catalog (the nasdaqtrader listing files the desktop stock catalog loads), or
 * when the name does not resemble the SEC title for that symbol; (iii) counts.
 *
 * Usage:
 *   pnpm --filter @meridian/research exec tsx scripts/graph-hygiene-report.ts [--graph <path>]
 *     [--catalog <file>]   symbols file: one symbol per line, or nasdaqtrader pipe format
 *     [--no-fetch]         skip the network (no exchange catalog / SEC title checks)
 *     [--json]             machine-readable output
 *
 * Default graph: <repo>/apps/desktop/data/graph.json. Never writes anything.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COUNTERPARTY_ALIASES,
  IMPLAUSIBLE_COUNTERPARTY_TICKERS,
  TICKER_ALIASES,
  canonicalCounterpartyKey,
  loadCompanyTickers,
  looksLikeTickerSymbol,
  type GraphEdge,
  type GraphFile,
  type GraphNode,
} from "../src/step1/index.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const NASDAQ_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt";
const OTHER_LISTED_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt";

type Args = { graph: string; catalog: string | null; fetch: boolean; json: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = {
    graph: path.join(repoRoot, "apps", "desktop", "data", "graph.json"),
    catalog: null,
    fetch: true,
    json: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--graph" && argv[i + 1]) args.graph = path.resolve(argv[++i]!);
    else if (a === "--catalog" && argv[i + 1]) args.catalog = path.resolve(argv[++i]!);
    else if (a === "--no-fetch") args.fetch = false;
    else if (a === "--json") args.json = true;
    else if (a === "--help" || a === "-h") {
      console.log("usage: graph-hygiene-report.ts [--graph <path>] [--catalog <file>] [--no-fetch] [--json]");
      process.exit(0);
    }
  }
  return args;
}

/** Parse a symbols file: nasdaqtrader pipe format (first column) or one symbol per line. */
function parseSymbolList(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || /^(Symbol|ACT Symbol)\|/i.test(line) || /^File Creation Time/i.test(line)) continue;
    const sym = (line.includes("|") ? line.split("|")[0]! : line).trim().toUpperCase();
    if (sym) out.add(sym);
  }
  return out;
}

async function loadExchangeCatalog(args: Args): Promise<{ symbols: Set<string> | null; source: string }> {
  if (args.catalog) {
    return { symbols: parseSymbolList(await readFile(args.catalog, "utf8")), source: args.catalog };
  }
  if (!args.fetch) return { symbols: null, source: "skipped (--no-fetch)" };
  try {
    const headers = { "User-Agent": "Mozilla/5.0 (compatible; Meridian Research/0.1)" };
    const [a, b] = await Promise.all([
      fetch(NASDAQ_LISTED_URL, { headers }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))),
      fetch(OTHER_LISTED_URL, { headers }).then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`)))),
    ]);
    const symbols = new Set([...parseSymbolList(a), ...parseSymbolList(b)]);
    return { symbols, source: "nasdaqtrader nasdaqlisted.txt + otherlisted.txt" };
  } catch (err) {
    return { symbols: null, source: `unavailable (${(err as Error).message})` };
  }
}

async function loadSecTitles(args: Args): Promise<Map<string, string> | null> {
  if (!args.fetch) return null;
  try {
    const entries = await loadCompanyTickers();
    const map = new Map<string, string>();
    for (const e of entries) if (!map.has(e.ticker.toUpperCase())) map.set(e.ticker.toUpperCase(), e.title);
    return map;
  } catch {
    return null;
  }
}

const STOP_TOKENS = new Set(["the", "of", "and", "de", "usa", "us", "international", "technologies", "technology", "energy", "health", "systems", "industries", "resources"]);

/** Loose name ≈ SEC title check: shared meaningful token or containment on canonical keys. */
function nameResemblesTitle(name: string, title: string): boolean {
  const a = canonicalCounterpartyKey(name, { applyAliases: false });
  const b = canonicalCounterpartyKey(title, { applyAliases: false });
  if (!a || !b) return false;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  const ta = new Set(a.split(" ").filter((t) => t.length >= 3 && !STOP_TOKENS.has(t)));
  const tb = new Set(b.split(" ").filter((t) => t.length >= 3 && !STOP_TOKENS.has(t)));
  for (const t of ta) if (tb.has(t)) return true;
  // Alias-aware: "Google" → GOOGL title "Alphabet Inc."
  const aliased = canonicalCounterpartyKey(name);
  const aliasedTitle = canonicalCounterpartyKey(title);
  return aliased === aliasedTitle;
}

type TickerRow = {
  ticker: string;
  names: string[];
  roots: string[];
  edgeCount: number;
  secTitle: string | null;
  flags: string[];
};

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const graph = JSON.parse(await readFile(args.graph, "utf8")) as GraphFile;
  const nodes: GraphNode[] = graph.nodes ?? [];
  const edges: GraphEdge[] = graph.edges ?? [];

  const tickerNodes = nodes.filter((n) => n.kind === "ticker");
  const nameNodes = nodes.filter((n) => n.kind === "name");
  const rootTickers = new Set(edges.map((e) => e.root_ticker));

  // ---- (i) duplicate name nodes -------------------------------------------------
  // Canonical key → name nodes.
  const byKey = new Map<string, GraphNode[]>();
  for (const n of nameNodes) {
    const key = canonicalCounterpartyKey(n.label);
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(n);
  }
  const nameClusters = [...byKey.entries()]
    .filter(([, ns]) => ns.length > 1)
    .map(([key, ns]) => ({ key, nodes: ns.map((n) => `${n.id} (${JSON.stringify(n.label)})`) }))
    .sort((a, b) => a.key.localeCompare(b.key));

  // Ticker node identity keys: SEC/root label, tickered counterparty names, matcher aliases, bare symbol.
  const tickerKeys = new Map<string, Set<string>>();
  const claim = (key: string, ticker: string) => {
    if (!key) return;
    if (!tickerKeys.has(key)) tickerKeys.set(key, new Set());
    tickerKeys.get(key)!.add(ticker);
  };
  for (const t of tickerNodes) claim(canonicalCounterpartyKey(t.label), t.id);
  for (const e of edges) if (e.counterparty_ticker) claim(canonicalCounterpartyKey(e.counterparty_name), e.counterparty_ticker.toUpperCase());
  for (const [alias, t] of Object.entries(TICKER_ALIASES)) if (nodes.some((n) => n.id === t.toUpperCase())) claim(alias, t.toUpperCase());
  const tickerIds = new Set(tickerNodes.map((t) => t.id));

  const nameMatchesTicker: Array<{ nameNode: string; label: string; ticker: string; via: string }> = [];
  for (const n of nameNodes) {
    const key = canonicalCounterpartyKey(n.label);
    const hits = tickerKeys.get(key);
    if (hits && hits.size === 1) {
      nameMatchesTicker.push({ nameNode: n.id, label: n.label, ticker: [...hits][0]!, via: "canonical key" });
    } else if (hits && hits.size > 1) {
      nameMatchesTicker.push({ nameNode: n.id, label: n.label, ticker: [...hits].join("|"), via: "ambiguous — left alone" });
    } else if (looksLikeTickerSymbol(n.label) && tickerIds.has(n.label.trim().toUpperCase())) {
      nameMatchesTicker.push({
        nameNode: n.id,
        label: n.label,
        ticker: n.label.trim().toUpperCase(),
        via: "bare symbol — suggestion only, builder does not fold (add a COUNTERPARTY_ALIASES entry if it is the same company)",
      });
    }
  }
  nameMatchesTicker.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.nameNode.localeCompare(b.nameNode));

  // ---- (ii) counterparty_ticker audit -------------------------------------------
  const [{ symbols: exchangeCatalog, source: catalogSource }, secTitles] = await Promise.all([
    loadExchangeCatalog(args),
    loadSecTitles(args),
  ]);

  const rowsByTicker = new Map<string, TickerRow>();
  for (const e of edges) {
    if (!e.counterparty_ticker) continue;
    const t = e.counterparty_ticker.toUpperCase();
    if (!rowsByTicker.has(t)) rowsByTicker.set(t, { ticker: t, names: [], roots: [], edgeCount: 0, secTitle: null, flags: [] });
    const row = rowsByTicker.get(t)!;
    row.edgeCount += 1;
    if (!row.names.includes(e.counterparty_name)) row.names.push(e.counterparty_name);
    if (!row.roots.includes(e.root_ticker)) row.roots.push(e.root_ticker);
  }
  for (const row of rowsByTicker.values()) {
    row.secTitle = secTitles?.get(row.ticker) ?? null;
    if (IMPLAUSIBLE_COUNTERPARTY_TICKERS.has(row.ticker)) row.flags.push("BLOCKLIST (builder clears)");
    if (exchangeCatalog && !exchangeCatalog.has(row.ticker)) row.flags.push("not in US exchange catalog");
    if (secTitles && !row.secTitle) row.flags.push("not in SEC company_tickers.json");
    if (row.secTitle && !row.names.some((n) => nameResemblesTitle(n, row.secTitle!))) {
      row.flags.push(`name/title mismatch (SEC: ${row.secTitle})`);
    }
    if (!/^[A-Z][A-Z0-9.-]{0,6}$/.test(row.ticker)) row.flags.push("odd symbol shape");
  }
  const tickerRows = [...rowsByTicker.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  const flaggedRows = tickerRows.filter((r) => r.flags.length > 0);
  const tickeredEdgeCount = edges.filter((e) => e.counterparty_ticker).length;

  // ---- output -----------------------------------------------------------------
  const summary = {
    graph: args.graph,
    pipelineVersion: graph.pipelineVersion,
    generatedAt: graph.generatedAt,
    nodes: nodes.length,
    tickerNodes: tickerNodes.length,
    rootTickers: rootTickers.size,
    nameNodes: nameNodes.length,
    edges: edges.length,
    tickeredEdges: tickeredEdgeCount,
    distinctCounterpartyTickers: tickerRows.length,
    nameClusters: nameClusters.length,
    nameNodesMatchingTicker: nameMatchesTicker.filter((m) => m.via === "canonical key").length,
    nameNodesBareSymbolHints: nameMatchesTicker.filter((m) => m.via.startsWith("bare symbol")).length,
    flaggedTickers: flaggedRows.length,
    exchangeCatalog: catalogSource,
    secTitles: secTitles ? `${secTitles.size} symbols` : "unavailable",
    aliasTableSize: Object.keys(COUNTERPARTY_ALIASES).length,
  };

  if (args.json) {
    console.log(JSON.stringify({ summary, nameClusters, nameMatchesTicker, tickers: tickerRows }, null, 2));
    return;
  }

  console.log(`Graph hygiene report — ${args.graph}`);
  console.log(`pipelineVersion ${graph.pipelineVersion}, generatedAt ${graph.generatedAt}`);
  console.log("");
  console.log("== Counts ==");
  for (const [k, v] of Object.entries(summary)) if (k !== "graph") console.log(`  ${k.padEnd(28)} ${v}`);

  console.log("");
  console.log(`== (i-a) Probable duplicate name nodes (same canonical key): ${nameClusters.length} cluster(s) ==`);
  if (nameClusters.length === 0) console.log("  none");
  for (const c of nameClusters) {
    console.log(`  [${c.key}]`);
    for (const n of c.nodes) console.log(`     - ${n}`);
  }

  console.log("");
  console.log(`== (i-b) Name nodes that match a ticker node in this graph: ${nameMatchesTicker.length} ==`);
  if (nameMatchesTicker.length === 0) console.log("  none");
  for (const m of nameMatchesTicker) {
    console.log(`  ${m.nameNode.padEnd(48)} ${JSON.stringify(m.label).padEnd(40)} -> ${m.ticker}  (${m.via})`);
  }

  console.log("");
  console.log(`== (ii) counterparty_ticker audit: ${tickerRows.length} distinct symbols over ${tickeredEdgeCount} edges ==`);
  console.log(`  exchange catalog: ${catalogSource}; SEC titles: ${summary.secTitles}`);
  for (const r of tickerRows) {
    const flag = r.flags.length ? `  <-- ${r.flags.join("; ")}` : "";
    console.log(
      `  ${r.ticker.padEnd(7)} ${String(r.edgeCount).padStart(2)}e  ${r.names.join(" | ")}  [roots: ${r.roots.join(",")}]` +
        (r.secTitle ? `  {SEC: ${r.secTitle}}` : "") +
        flag,
    );
  }
  console.log("");
  console.log(`== Flagged tickers: ${flaggedRows.length} ==`);
  if (flaggedRows.length === 0) console.log("  none");
  for (const r of flaggedRows) console.log(`  ${r.ticker.padEnd(7)} ${r.names.join(" | ")}  -> ${r.flags.join("; ")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
