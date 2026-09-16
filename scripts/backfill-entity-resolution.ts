/**
 * Backfill entity resolution onto an existing graph.
 *
 * Re-extracting every filing to pick up the new resolver would cost the full
 * Anthropic bill for information we already have on disk, so this script does
 * the two things the new pipeline would have done, in place:
 *
 *   1. fills `counterparty_ticker` for names the old alias-then-exact matcher
 *      could not reach ("Amazon", "Dell", "Chevron U.S.A. Inc.");
 *   2. stamps `counterparty_type` from the step1 candidates cache, so
 *      propagation can keep regulators, agencies, products and private names
 *      out of the target list.
 *
 * It never overwrites a ticker that is already set: an edge the pipeline
 * resolved stays exactly as the pipeline resolved it, and a disagreement is
 * reported rather than applied. The point is to add what is missing, not to
 * relitigate what is there.
 *
 * Usage:
 *   pnpm backfill-entity-resolution               # dry run, prints the diff
 *   pnpm backfill-entity-resolution --write       # apply in place
 *   pnpm backfill-entity-resolution --graph <path> --cache <dir>
 */

import fs from "node:fs";
import path from "node:path";
import {
  counterpartyKey,
  resolveCounterparty,
  type SecTickerLookup,
} from "../packages/research/src/step1/entityResolution.js";

const SEC_TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";

type GraphEdgeRow = {
  id: string;
  root_ticker: string;
  counterparty_name: string;
  counterparty_ticker: string | null;
  counterparty_type?: string | null;
  [key: string]: unknown;
};

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

// pnpm runs workspace scripts with the cwd set to the filtered package, so the
// defaults hang off this file's own location rather than off `process.cwd()`.
const REPO_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const fromRoot = (p: string): string => (path.isAbsolute(p) ? p : path.resolve(REPO_ROOT, p));

const WRITE = process.argv.includes("--write");
const GRAPH_PATH = fromRoot(arg("graph", "apps/desktop/data/graph.json"));
const CACHE_DIR = fromRoot(arg("cache", "apps/desktop/data/cache"));

/** Counterparty kind per normalized name, read from the step1 candidates cache. */
function loadCounterpartyTypes(dir: string): Map<string, string> {
  const types = new Map<string, string>();
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir);
  } catch {
    console.warn(`[backfill] no candidates cache at ${dir} — counterparty_type will be left unset`);
    return types;
  }
  for (const file of files) {
    if (!file.endsWith(".candidates.json")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    } catch {
      continue;
    }
    const rows = Array.isArray(parsed)
      ? parsed
      : ((parsed as { candidates?: unknown[]; edges?: unknown[] })?.candidates ??
        (parsed as { edges?: unknown[] })?.edges ??
        []);
    for (const row of rows as Array<{ counterparty_name?: string; counterparty_type?: string }>) {
      if (!row?.counterparty_name || !row.counterparty_type) continue;
      const key = counterpartyKey(row.counterparty_name);
      if (key && !types.has(key)) types.set(key, row.counterparty_type);
    }
  }
  return types;
}

async function loadSecTickers(): Promise<SecTickerLookup[]> {
  const agent = process.env.SEC_USER_AGENT?.trim();
  if (!agent) throw new Error("SEC_USER_AGENT must be set (SEC requires a contact address)");
  const res = await fetch(SEC_TICKERS_URL, { headers: { "User-Agent": agent, Accept: "application/json" } });
  if (!res.ok) throw new Error(`company_tickers.json: HTTP ${res.status}`);
  const data = (await res.json()) as Record<string, { ticker: string; title: string }>;
  return Object.values(data).map((e) => ({ ticker: e.ticker, title: e.title }));
}

async function main(): Promise<void> {
  const graph = JSON.parse(fs.readFileSync(GRAPH_PATH, "utf8")) as { edges: GraphEdgeRow[] };
  const sec = await loadSecTickers();
  const types = loadCounterpartyTypes(CACHE_DIR);

  let resolved = 0;
  let typed = 0;
  let disagreed = 0;
  let alreadySet = 0;
  const byKind = new Map<string, number>();
  const gained: string[] = [];
  const conflicts: string[] = [];

  for (const edge of graph.edges) {
    const key = counterpartyKey(edge.counterparty_name);

    const kind = types.get(key);
    if (kind && edge.counterparty_type == null) {
      edge.counterparty_type = kind;
      typed += 1;
    }
    byKind.set(edge.counterparty_type ?? "unknown", (byKind.get(edge.counterparty_type ?? "unknown") ?? 0) + 1);

    // Only public companies get a ticker — the extractor already decided that,
    // and asking the resolver about a government agency invites a bad match.
    if (edge.counterparty_type != null && edge.counterparty_type !== "public_company") continue;

    const match = resolveCounterparty(edge.counterparty_name, sec);
    if (edge.counterparty_ticker) {
      alreadySet += 1;
      if (match.ticker && match.ticker !== edge.counterparty_ticker) {
        disagreed += 1;
        if (conflicts.length < 20) {
          conflicts.push(
            `  ${edge.counterparty_name} — kept ${edge.counterparty_ticker}, resolver said ${match.ticker} (${match.method})`,
          );
        }
      }
      continue;
    }
    if (!match.ticker) continue;
    edge.counterparty_ticker = match.ticker;
    resolved += 1;
    if (gained.length < 60) {
      gained.push(`  ${edge.counterparty_name.slice(0, 46).padEnd(46)} → ${match.ticker} (${match.method})`);
    }
  }

  console.log(`graph: ${GRAPH_PATH}`);
  console.log(`edges: ${graph.edges.length}`);
  console.log(`\ncounterparty_type stamped on ${typed} edge(s):`);
  for (const [kind, count] of [...byKind].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${kind.padEnd(18)} ${String(count).padStart(4)}`);
  }
  console.log(`\ntickers newly resolved: ${resolved}`);
  gained.forEach((line) => console.log(line));
  console.log(`\nalready had a ticker: ${alreadySet} (resolver disagreed on ${disagreed}, all kept as-is)`);
  conflicts.forEach((line) => console.log(line));

  if (!WRITE) {
    console.log("\nDry run — pass --write to apply.");
    return;
  }
  const backup = `${GRAPH_PATH}.bak`;
  fs.copyFileSync(GRAPH_PATH, backup);
  fs.writeFileSync(GRAPH_PATH, `${JSON.stringify(graph, null, 1)}\n`);
  console.log(`\nWritten. Previous graph saved to ${backup}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
