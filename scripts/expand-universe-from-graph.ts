/**
 * Grow the tracked universe toward the relationship graph (§S2).
 *
 * Which names to add next is not a judgement call. Propagation walks the graph
 * from a root to its counterparties and then asks the Tracker for a price; a
 * counterparty the Tracker does not follow comes back `pricing: unknown` and
 * the target is unscoreable. So the right names to add are exactly the
 * counterparty tickers the graph already reaches and the Tracker does not
 * follow — measured on the 2026-08-26 graph, 120 of them, against 66 it does.
 *
 * They join the **price tier**: bars and filings, no news polling. Propagation
 * needs a price on a target, not a headline, and news is what the Finnhub free
 * tier actually meters (a single busy name's baseline costs up to 24 calls).
 * A name that should also be an event source in its own right belongs in the
 * event tier, which is a separate, deliberate promotion.
 *
 * Usage:
 *   pnpm expand-universe                      # dry run, prints what would change
 *   pnpm expand-universe --write              # update the tracker config
 *   pnpm expand-universe --min-roots 2        # only names ≥2 roots reach
 *   pnpm expand-universe --config <path> --graph <path>
 */

import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fromRoot = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const WRITE = process.argv.includes("--write");
const MIN_ROOTS = Number(arg("min-roots", "1"));
const GRAPH_PATH = fromRoot(arg("graph", "apps/desktop/data/graph.json"));
const CONFIG_PATH = fromRoot(arg("config", "apps/falcon-engine/seed-data/tracker/config.json"));

type GraphEdgeRow = {
  root_ticker: string;
  counterparty_ticker: string | null;
  counterparty_type?: string | null;
};

type TrackerConfigFile = {
  tickers: string[];
  priceTierTickers?: string[];
  benchmark: string;
  [key: string]: unknown;
};

function main(): void {
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, "utf8")) as { edges: GraphEdgeRow[] };
  const config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) as TrackerConfigFile;

  const tracked = new Set(config.tickers.map((t) => t.toUpperCase()));
  const benchmark = (config.benchmark ?? "SPY").toUpperCase();

  // How many distinct roots reach each counterparty. A name several roots
  // depend on is worth more than one a single filing mentions once, so this
  // orders the list and drives --min-roots.
  const reachedBy = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    const ticker = edge.counterparty_ticker?.toUpperCase();
    if (!ticker || ticker === benchmark) continue;
    // Only public companies can be priced; the rest never become targets.
    if (edge.counterparty_type != null && edge.counterparty_type !== "public_company") continue;
    const roots = reachedBy.get(ticker) ?? new Set<string>();
    roots.add(edge.root_ticker.toUpperCase());
    reachedBy.set(ticker, roots);
  }

  const candidates = [...reachedBy.entries()]
    .filter(([ticker]) => !tracked.has(ticker))
    .filter(([, roots]) => roots.size >= MIN_ROOTS)
    .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]));

  console.log(`graph:  ${GRAPH_PATH}`);
  console.log(`config: ${CONFIG_PATH}`);
  console.log(`\ngraph counterparty tickers: ${reachedBy.size}`);
  console.log(`  already tracked: ${reachedBy.size - [...reachedBy.keys()].filter((t) => !tracked.has(t)).length}`);
  console.log(`  to add (≥${MIN_ROOTS} root${MIN_ROOTS === 1 ? "" : "s"}): ${candidates.length}`);
  console.log(`\n${"ticker".padEnd(8)}${"roots".padEnd(7)}reached from`);
  for (const [ticker, roots] of candidates) {
    console.log(`${ticker.padEnd(8)}${String(roots.size).padEnd(7)}${[...roots].sort().join(" ")}`);
  }

  const added = candidates.map(([t]) => t);
  const nextTickers = [...new Set([...config.tickers.map((t) => t.toUpperCase()), ...added])].sort();
  const nextPriceTier = [...new Set([...(config.priceTierTickers ?? []).map((t) => t.toUpperCase()), ...added])].sort();

  console.log(`\ntracked universe: ${config.tickers.length} → ${nextTickers.length}`);
  console.log(
    `  event tier (news + filings + price): ${nextTickers.length - nextPriceTier.length}` +
      `   price tier (filings + price only): ${nextPriceTier.length}`,
  );
  console.log(
    `\nNews quota is unchanged: the ${added.length} added name(s) never poll news.` +
      `\nThey gain a price, which is what propagation needs to score a target.`,
  );

  if (!WRITE) {
    console.log("\nDry run — pass --write to apply.");
    return;
  }
  config.tickers = nextTickers;
  config.priceTierTickers = nextPriceTier;
  // The list is now a deliberate choice, not a rediscovery of whatever
  // happens to be cached, so pin the mode with it.
  config.universeMode = "explicit";
  fs.copyFileSync(CONFIG_PATH, `${CONFIG_PATH}.bak`);
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 1)}\n`);
  console.log(`\nWritten. Previous config saved to ${CONFIG_PATH}.bak`);
}

main();
