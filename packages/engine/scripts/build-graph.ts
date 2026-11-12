/**
 * Builds data/graph.json, the engine's seed graph, from two sources:
 *
 *   1. The graph the old step1 pipeline extracted from 10-K and 20-F filings
 *      (removed from the tree on 2026-11-08; read from git history, or from a
 *      file given with --old). Kept: links between companies (not
 *      governments, banks or places) within two links of a watched sector.
 *   2. data/graph-additions.json, links read by hand since then.
 *
 * Every quote is checked against its filing (fetched from EDGAR, cached);
 * a link whose quote is not in the filing is dropped and reported.
 *
 *   pnpm --filter @falcon/engine run build-graph
 *   pnpm --filter @falcon/engine run build-graph -- --old path/to/graph.json --no-verify
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ENGINE_ROOT } from "../src/http.ts";
import { GRAPH_PATH, type EdgeCategory, type Graph, type GraphEdge, type StrengthTier } from "../src/graph.ts";
import { cikForTicker, documentText, recentFilings } from "../src/sec.ts";
import { quoteInDocument } from "../src/text.ts";
import { NAMES, SECTORS } from "../src/universe.ts";

const OLD_REV = "682ec64^:apps/desktop/data/graph.json";
const REPO_ROOT = path.resolve(ENGINE_ROOT, "..", "..");

type OldEdge = {
  root_ticker: string;
  counterparty_name: string;
  counterparty_ticker: string | null;
  counterparty_type: string;
  category: string;
  strength_tier: string;
  disclosed_share_pct: number | null;
  evidence_quote: string;
  source_url: string;
  filing_date: string;
  form: string | null;
};

type OldGraph = { nodes: Array<{ id: string; label: string }>; edges: OldEdge[] };

/**
 * Names the old extraction left without a ticker that do have one we use:
 * subsidiaries are read as their listed parent (SPIL and ASE are ASE
 * Technology Holding; Microsemi is Microchip; Ansys is Synopsys).
 */
const ALIASES: Array<[RegExp, string]> = [
  [/^Advanced Semiconductor Engineering/i, "ASX"],
  [/^Siliconware Precision Industries/i, "ASX"],
  [/^ASE Technology/i, "ASX"],
  [/^Arrow( Electronics)?$/i, "ARW"],
  [/^Avnet/i, "AVT"],
  [/^Microsemi/i, "MCHP"],
  [/^Ansys$/i, "SNPS"],
];

/**
 * Quotes that describe a person's career ("he served at Intel Corp. as ..."),
 * not a business link between the companies: the old extraction read some
 * 20-F director biographies as partnerships. And names that are banks or
 * depositaries (an ADR's depositary is not a supplier in any useful sense).
 */
const BIOGRAPHY = /\b(served|serves|serving) (at|as|in)\b|prior to (that|joining)|\b(Mr|Ms|Mrs|Dr)\. [A-Z]|\b(is|was) (currently )?the (Chairman|Director|Chief)|\bthe Director of\b|board of directors of/i;
const NOT_A_BUSINESS_LINK = /\b(bank|citibank|depositary|depository|clearing|trust company)\b/i;

const COMPANY_TYPES = /^(public_company|private_company|company|subsidiary|subsidiary_of_public_company|technology company|joint_venture|brand_of_public_company)$/;

function resolveTicker(e: OldEdge): string | null {
  if (e.counterparty_ticker) return e.counterparty_ticker.toUpperCase();
  for (const [re, t] of ALIASES) if (re.test(e.counterparty_name.trim())) return t;
  return null;
}

function category(c: string): EdgeCategory | null {
  return c === "supplier" || c === "customer" || c === "competitor" || c === "partner" ? c : null;
}

function tier(t: string): StrengthTier {
  return t === "critical" || t === "important" ? t : "marginal";
}

function readOld(file: string | null): OldGraph {
  const body = file ? fs.readFileSync(file, "utf8") : execFileSync("git", ["show", OLD_REV], { cwd: REPO_ROOT, maxBuffer: 64 << 20 }).toString("utf8");
  return JSON.parse(body) as OldGraph;
}

function titleCase(s: string): string {
  return s
    .toLowerCase()
    .replace(/\b([a-z])/g, (m) => m.toUpperCase())
    .replace(/\b(Inc|Corp|Co|Ltd|Plc|N\.v|S\.a)\b\.?/gi, "")
    .replace(/[,\s]+$/, "")
    .trim();
}

async function annualMeta(ticker: string, url: string): Promise<{ form: string; filedAt: string }> {
  const cik = await cikForTicker(ticker);
  if (!cik) throw new Error(`no CIK for ${ticker}`);
  const f = (await recentFilings(cik)).find((x) => x.url === url);
  if (!f) throw new Error(`${url} is not among ${ticker}'s recent filings`);
  return { form: f.form, filedAt: f.filedAt };
}

async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const oldAt = args.indexOf("--old");
  const verify = !args.includes("--no-verify");
  const old = readOld(oldAt >= 0 ? args[oldAt + 1]! : null);
  const watched = new Set(Object.values(SECTORS).flatMap((s) => s.tickers));

  // 1. Old step1 edges between companies, with a ticker on the filer's side.
  const candidates: GraphEdge[] = [];
  for (const e of old.edges) {
    const cat = category(e.category);
    if (!cat || !COMPANY_TYPES.test(e.counterparty_type)) continue;
    if (BIOGRAPHY.test(e.evidence_quote) || NOT_A_BUSINESS_LINK.test(e.counterparty_name)) continue;
    const to = resolveTicker(e);
    const from = e.root_ticker.toUpperCase();
    if (to === from) continue;
    candidates.push({
      id: "",
      from,
      to,
      toName: e.counterparty_name,
      category: cat,
      tier: tier(e.strength_tier),
      disclosedSharePct: typeof e.disclosed_share_pct === "number" ? e.disclosed_share_pct : null,
      quote: e.evidence_quote,
      form: e.form ?? "10-K",
      filedAt: e.filing_date,
      url: e.source_url,
      origin: "step1-2026-10",
    });
  }

  // 2. Hand-read additions.
  const additions = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, "data", "graph-additions.json"), "utf8")) as {
    filings: Record<string, string>;
    edges: Array<{
      from: string;
      to: string;
      toName: string;
      category: EdgeCategory;
      tier: StrengthTier;
      disclosedSharePct?: number;
      quote?: string;
      sameQuoteAs?: string;
    }>;
  };
  const quoteByKey = new Map<string, string>();
  for (const a of additions.edges) if (a.quote) quoteByKey.set(`${a.from}:${a.to}`, a.quote);
  for (const a of additions.edges) {
    const url = additions.filings[a.from];
    if (!url) throw new Error(`no filing listed for ${a.from}`);
    const quote = a.quote ?? (a.sameQuoteAs ? quoteByKey.get(a.sameQuoteAs) : undefined);
    if (!quote) throw new Error(`no quote for ${a.from} -> ${a.to}`);
    const meta = await annualMeta(a.from, url);
    candidates.push({
      id: "",
      from: a.from,
      to: a.to,
      toName: a.toName,
      category: a.category,
      tier: a.tier,
      disclosedSharePct: a.disclosedSharePct ?? null,
      quote,
      form: meta.form,
      filedAt: meta.filedAt,
      url,
      origin: "manual-2026-11",
    });
  }

  // Within two supply-chain links of a watched company.
  const near = new Set<string>(watched);
  for (const e of candidates) {
    if (!e.to || (e.category !== "supplier" && e.category !== "customer")) continue;
    if (watched.has(e.from)) near.add(e.to);
    if (watched.has(e.to)) near.add(e.from);
  }
  // Any link of a watched company; beyond them only supply-chain links (the
  // second step of a degree 2 path), so an oil major's joint ventures do not
  // ride in on one Intel partnership.
  const kept = candidates.filter(
    (e) =>
      watched.has(e.from) ||
      (e.to !== null && watched.has(e.to)) ||
      ((e.category === "supplier" || e.category === "customer") && (near.has(e.from) || (e.to !== null && near.has(e.to)))),
  );

  // One edge per (from, to, category); the stronger wins, ties keep the newer filing.
  const byKey = new Map<string, GraphEdge>();
  const tierRank = { critical: 3, important: 2, marginal: 1 } as const;
  for (const e of kept) {
    const key = `${e.from}|${e.to ?? `name:${e.toName.toLowerCase()}`}|${e.category}`;
    const known = byKey.get(key);
    if (
      !known ||
      tierRank[e.tier] > tierRank[known.tier] ||
      (tierRank[e.tier] === tierRank[known.tier] && e.filedAt > known.filedAt)
    ) {
      byKey.set(key, e);
    }
  }

  // Every quote checked against its filing.
  const edges: GraphEdge[] = [];
  const dropped: string[] = [];
  const docs = new Map<string, string>();
  for (const e of [...byKey.values()].sort((a, b) => a.from.localeCompare(b.from) || (a.to ?? "").localeCompare(b.to ?? ""))) {
    if (verify) {
      let doc = docs.get(e.url);
      if (doc === undefined) {
        try {
          doc = await documentText(e.url);
        } catch (err) {
          doc = "";
          console.error(`  cannot read ${e.url}: ${err instanceof Error ? err.message : err}`);
        }
        docs.set(e.url, doc);
      }
      if (!quoteInDocument(e.quote, doc)) {
        dropped.push(`${e.from} ${e.category} ${e.to ?? e.toName} (${e.origin}): quote not found in ${e.url}`);
        continue;
      }
    }
    e.id = `${e.from}:${e.category}:${e.to ?? e.toName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
    edges.push(e);
  }

  const names: Record<string, string> = {};
  const labels = new Map(old.nodes.map((n) => [n.id, n.label]));
  for (const e of edges) {
    for (const t of [e.from, e.to]) {
      if (!t || names[t]) continue;
      names[t] = NAMES[t] ?? (labels.get(t) ? titleCase(labels.get(t)!) : t);
    }
  }

  const graph: Graph = { generatedAt: new Date().toISOString(), names, edges };
  fs.mkdirSync(path.dirname(GRAPH_PATH), { recursive: true });
  fs.writeFileSync(GRAPH_PATH, `${JSON.stringify(graph, null, 1)}\n`);
  const listed = edges.filter((e) => e.to).length;
  console.log(`graph: ${edges.length} edges (${listed} between listed companies), ${Object.keys(names).length} companies -> ${GRAPH_PATH}`);
  console.log(`  from step1: ${edges.filter((e) => e.origin.startsWith("step1")).length}, manual: ${edges.filter((e) => e.origin.startsWith("manual")).length}`);
  if (dropped.length) {
    console.log(`dropped ${dropped.length} (quote not in filing):`);
    for (const d of dropped) console.log(`  - ${d}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack : err);
  process.exit(1);
});
