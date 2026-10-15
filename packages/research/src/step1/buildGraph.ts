import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  canonicalCounterpartyKey,
  sanitizeCounterpartyTicker,
  usGovernmentBody,
  US_GOVERNMENT_KEY,
  US_GOVERNMENT_LABEL,
  type TickerSanitizeOptions,
} from "./canonical.js";
import { isNotTheListedEntity, isRefusedCounterpartyName } from "./entityResolution.js";
import { normalizeCompanyName } from "./normalize.js";
import { disclosedShareOfEdge, resolveEdgeStrength } from "./strength.js";
import { TICKER_ALIASES } from "./tickerMatch.js";
import type { AnnualFilingForm, ValidatedEdge } from "./types.js";
import { PIPELINE_VERSION } from "./version.js";

export type GraphNode = {
  id: string;
  label: string;
  kind: "ticker" | "name";
};

export type GraphEdge = {
  id: string;
  root_ticker: string;
  counterparty_id: string;
  counterparty_name: string;
  counterparty_ticker: string | null;
  /**
   * The specific body behind a counterparty folded onto a broader node: a US
   * federal agency or branch ("U.S. Department of Defense", "U.S. Navy") on the
   * single "U.S. government" node. Null otherwise (and for the government itself).
   */
  counterparty_detail: string | null;
  /**
   * What kind of thing the counterparty is, carried straight from the
   * extractor. Only `public_company` can ever be priced, so propagation reads
   * this to keep regulators, agencies, products and private names out of the
   * target list instead of spending traversal slots and judge tokens on names
   * that can never resolve to a security.
   */
  counterparty_type: string | null;
  category: string;
  subtype: string;
  confidence: number;
  strength: number;
  strength_tier: "critical" | "important" | "marginal";
  /**
   * The share the filing states for this relationship, in percent (revenue
   * share, purchase share, concentration); null when it states none. Read
   * this, not `strength`, to tell a disclosed share from a tier default.
   */
  disclosed_share_pct: number | null;
  /** The filing quote that states `disclosed_share_pct`; null with it. */
  disclosed_share_quote: string | null;
  evidence_quote: string;
  source_url: string;
  valid_from: string;
  /** Date the source filing was filed with the SEC (YYYY-MM-DD). Same as valid_from today, but authoritative per accession. */
  filing_date: string;
  /** SEC accession number of the source filing, dashed form (e.g. 0001193125-26-106120). */
  accession_number: string | null;
  /** The source filing's form (10-K or 20-F), from the root's meta file; null when it was not recorded. */
  form: AnnualFilingForm | null;
};

export type GraphFile = {
  generatedAt: string;
  pipelineVersion: number;
  nodeCount: number;
  edgeCount: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  reverseIndex: Record<string, GraphEdge[]>;
};

/** What the hygiene pass did while building — for reports / dry runs. */
export type GraphHygieneDiagnostics = {
  /** Counterparty nodes that absorbed more than one pre-hygiene node id. */
  collapsedClusters: Array<{
    nodeId: string;
    kind: GraphNode["kind"];
    label: string;
    /** Distinct `counterparty_name` spellings folded into the node. */
    variants: string[];
    /** Node ids the legacy builder (ticker ?? name:normalizeCompanyName) would have produced. */
    legacyIds: string[];
    edgeCount: number;
  }>;
  /** `counterparty_ticker` values cleared to null. */
  clearedTickers: Array<{
    ticker: string;
    counterparty_name: string;
    root_ticker: string;
    /**
     * `refused_name`: the name is a parent / JV / affiliate next to a listed
     * company (`isNotTheListedEntity`); `self`: the ticker is the filer's own.
     */
    reason: "blocklist" | "not_in_catalog" | "refused_name" | "self";
    nodeId: string;
  }>;
  /** Name-form counterparties folded onto an existing ticker node. */
  foldedIntoTicker: Array<{ ticker: string; counterparty_name: string; root_ticker: string }>;
  /** Edges dropped because the counterparty is the filer itself under another name. */
  droppedSelfEdges: Array<{ root_ticker: string; counterparty_name: string }>;
};

export type BuildGraphOptions = TickerSanitizeOptions & {
  /** Receives the hygiene diagnostics once the graph is assembled. */
  onDiagnostics?: (diagnostics: GraphHygieneDiagnostics) => void;
};

/** Node id the pre-hygiene builder produced (kept for diagnostics only). */
function legacyCounterpartyNodeId(edge: ValidatedEdge): string {
  if (edge.counterparty_ticker) return edge.counterparty_ticker.toUpperCase();
  return `name:${normalizeCompanyName(edge.counterparty_name)}`;
}

/**
 * Label for a collapsed name node: prefer spellings that reach the key without an
 * alias (the legal/complete form), then the longest, then lexical — deterministic.
 */
function pickNameLabel(key: string, labels: Iterable<string>): string {
  const ranked = [...labels].sort((a, b) => {
    const aDirect = canonicalCounterpartyKey(a, { applyAliases: false }) === key ? 0 : 1;
    const bDirect = canonicalCounterpartyKey(b, { applyAliases: false }) === key ? 0 : 1;
    return aDirect - bDirect || b.length - a.length || a.localeCompare(b);
  });
  return ranked[0]!;
}

type RawRootResult = {
  ticker: string;
  companyName: string;
  filingDate: string;
  accessionNumber: string | null;
  form: AnnualFilingForm | null;
  validated: ValidatedEdge[];
};

type PreparedEdge = {
  root: RawRootResult;
  edge: ValidatedEdge;
  /** Sanitised ticker (null when absent, blocklisted or outside the catalog). */
  ticker: string | null;
  key: string;
  cleared: GraphHygieneDiagnostics["clearedTickers"][number]["reason"] | null;
  /** The resolver refuses the name: it is never folded onto a ticker node by name alone. */
  refused: boolean;
  /** Set when the counterparty is a US federal body folded onto the "U.S. government" node. */
  government: { detail: string | null } | null;
};

async function readRootResults(researchDir: string): Promise<RawRootResult[]> {
  const entries = await readdir(researchDir);
  const rootFiles = entries
    .filter((f) => /^[A-Z0-9.-]+\.json$/i.test(f) && !/\.(rejected|merged|meta|stats)\.json$/i.test(f))
    .sort((a, b) => a.localeCompare(b));

  const results: RawRootResult[] = [];
  for (const file of rootFiles) {
    const ticker = file.replace(/\.json$/i, "").toUpperCase();
    let validated: ValidatedEdge[];
    let companyName = ticker;
    let filingDate = "";
    let accessionNumber: string | null = null;
    let form: AnnualFilingForm | null = null;
    try {
      const raw = await readFile(path.join(researchDir, file), "utf8");
      validated = JSON.parse(raw) as ValidatedEdge[];
      const metaRaw = await readFile(path.join(researchDir, `${ticker}.meta.json`), "utf8").catch(
        () => null,
      );
      if (metaRaw) {
        const meta = JSON.parse(metaRaw) as {
          companyName?: string;
          filingDate?: string;
          accessionNumber?: string;
          form?: string;
        };
        if (meta.companyName) companyName = meta.companyName;
        if (meta.filingDate) filingDate = meta.filingDate;
        if (meta.accessionNumber) accessionNumber = meta.accessionNumber;
        if (meta.form === "10-K" || meta.form === "20-F") form = meta.form;
      }
    } catch {
      continue;
    }
    if (!Array.isArray(validated) || validated.length === 0) continue;
    results.push({ ticker, companyName, filingDate, accessionNumber, form, validated });
  }
  return results;
}

/**
 * Build the merged relationship graph from per-ticker step1 results.
 *
 * Hygiene (deterministic, builder-side only; the edge schema is unchanged):
 * - implausible `counterparty_ticker` values are cleared (blocklist, plus an
 *   optional caller-supplied symbol catalog) and the edge keeps a name node;
 * - name variants of one company collapse onto one node via
 *   `canonicalCounterpartyKey` (legal suffixes, dotted abbreviations, aliases);
 * - a name-form counterparty whose canonical key matches a ticker node already
 *   in the graph (root SEC title, a tickered counterparty's name, a ticker alias)
 *   is folded onto that ticker node and its
 *   `counterparty_ticker` is set accordingly, so propagation's reverse index sees it;
 * - the label of a collapsed name node is the longest (then lexically first) variant;
 * - a parent / JV / affiliate next to a listed company (`isNotTheListedEntity`)
 *   never carries a ticker, and no name the resolver refuses
 *   (`isRefusedCounterpartyName`) is folded onto a ticker node by name alone;
 * - no edge points at its own root: a stored ticker equal to the filer's is
 *   cleared (the affiliate keeps a name node), and a name that folds back onto
 *   the filer is the filer itself, so that edge is dropped.
 * Apart from those self-references every validated edge keeps its own evidence.
 */
export async function buildGraphFromResearchDir(
  researchDir: string,
  options: BuildGraphOptions = {},
): Promise<GraphFile> {
  const roots = await readRootResults(researchDir);

  const nodes = new Map<string, GraphNode>();
  const addNode = (id: string, label: string, kind: GraphNode["kind"]) => {
    if (!nodes.has(id)) nodes.set(id, { id, label, kind });
  };

  // Pass 1: sanitise tickers, compute canonical keys, register ticker nodes.
  const prepared: PreparedEdge[] = [];
  /** canonical key → ticker node id (only unambiguous keys survive). */
  const tickerByKey = new Map<string, string | null>();
  const claimKey = (key: string, ticker: string) => {
    if (!key) return;
    const existing = tickerByKey.get(key);
    if (existing === undefined) tickerByKey.set(key, ticker);
    else if (existing !== ticker) tickerByKey.set(key, null); // ambiguous → never fold
  };

  for (const root of roots) {
    addNode(root.ticker, root.companyName, "ticker");
    claimKey(canonicalCounterpartyKey(root.companyName), root.ticker);
  }
  for (const root of roots) {
    for (const edge of root.validated) {
      const sanitized = sanitizeCounterpartyTicker(edge.counterparty_ticker, options);
      let ticker = sanitized.ticker;
      let cleared: PreparedEdge["cleared"] = sanitized.clearedReason;
      const refused = isRefusedCounterpartyName(edge.counterparty_name);
      if (ticker && isNotTheListedEntity(edge.counterparty_name)) {
        ticker = null;
        cleared = "refused_name";
      }
      // Never an edge from a company to itself. A distinctly named affiliate
      // the filing resolved to its own ticker keeps a name node (Pass 2 drops
      // it only when the name folds back onto the filer).
      if (ticker && (ticker === root.ticker || ticker === edge.root_ticker.trim().toUpperCase())) {
        ticker = null;
        cleared = "self";
      }
      const government = ticker ? null : usGovernmentBody(edge.counterparty_name, edge.counterparty_type);
      const key = government ? US_GOVERNMENT_KEY : canonicalCounterpartyKey(edge.counterparty_name);
      prepared.push({ root, edge, ticker, key, cleared, refused, government });
      if (ticker) {
        addNode(ticker, edge.counterparty_name, "ticker");
        claimKey(key, ticker);
      }
    }
  }
  // The matcher's own aliases ("google" → GOOGL), only for tickers present in the graph.
  for (const [alias, ticker] of Object.entries(TICKER_ALIASES)) {
    if (nodes.has(ticker.toUpperCase())) claimKey(alias, ticker.toUpperCase());
  }

  // Pass 2: resolve counterparty ids; fold name variants onto ticker nodes.
  const resolved: Array<PreparedEdge & { cpId: string; foldedTicker: string | null }> = [];
  /** name node id → candidate labels. */
  const nameLabels = new Map<string, Set<string>>();
  const droppedSelfEdges: GraphHygieneDiagnostics["droppedSelfEdges"] = [];
  for (const p of prepared) {
    if (p.ticker) {
      resolved.push({ ...p, cpId: p.ticker, foldedTicker: null });
      continue;
    }
    // Deliberately no "bare symbol == ticker node" rule: e.g. BNTX's licensor "MRT" is not
    // Marti Technologies (MRT). Acronyms fold only through COUNTERPARTY_ALIASES.
    const folded = p.refused ? null : (tickerByKey.get(p.key) ?? null);
    if (folded && (folded === p.root.ticker || folded === p.edge.root_ticker.trim().toUpperCase())) {
      // The name folds onto the filer itself ("JD.com" in JD's own 10-K): no edge.
      droppedSelfEdges.push({ root_ticker: p.edge.root_ticker, counterparty_name: p.edge.counterparty_name });
      continue;
    }
    if (folded) {
      resolved.push({ ...p, cpId: folded, foldedTicker: folded });
      continue;
    }
    const cpId = `name:${p.key}`;
    if (!nameLabels.has(cpId)) nameLabels.set(cpId, new Set());
    nameLabels.get(cpId)!.add(p.edge.counterparty_name.trim());
    resolved.push({ ...p, cpId, foldedTicker: null });
  }
  for (const [cpId, labels] of nameLabels) {
    const label =
      cpId === `name:${US_GOVERNMENT_KEY}` ? US_GOVERNMENT_LABEL : pickNameLabel(cpId.slice("name:".length), labels);
    addNode(cpId, label, "name");
  }

  // Pass 3: emit edges.
  const edges: GraphEdge[] = [];
  const reverseIndex: Record<string, GraphEdge[]> = {};
  const diagnostics: GraphHygieneDiagnostics = {
    collapsedClusters: [],
    clearedTickers: [],
    foldedIntoTicker: [],
    droppedSelfEdges,
  };
  const clusterAcc = new Map<
    string,
    { variants: Set<string>; legacyIds: Set<string>; edgeCount: number }
  >();

  for (const r of resolved) {
    const { edge, root, cpId } = r;
    const counterpartyTicker = r.ticker ?? r.foldedTicker;

    const strength =
      typeof edge.strength === "number" && Number.isFinite(edge.strength) && edge.strength_tier
        ? { strength: edge.strength, strength_tier: edge.strength_tier }
        : resolveEdgeStrength({ strength_tier: edge.strength_tier ?? "important" });
    const share = disclosedShareOfEdge(edge);

    const graphEdge: GraphEdge = {
      id: `${edge.root_ticker}:${cpId}:${edge.category}:${edge.subtype}:${edges.length}`,
      root_ticker: edge.root_ticker,
      counterparty_id: cpId,
      counterparty_name: edge.counterparty_name,
      counterparty_ticker: counterpartyTicker,
      counterparty_detail: r.government?.detail ?? null,
      counterparty_type: edge.counterparty_type ?? null,
      category: edge.category,
      subtype: edge.subtype,
      confidence: edge.confidence,
      strength: strength.strength,
      strength_tier: strength.strength_tier,
      disclosed_share_pct: share.disclosed_share_pct,
      disclosed_share_quote: share.disclosed_share_quote,
      evidence_quote: edge.evidence[0]?.quote ?? "",
      source_url: edge.evidence[0]?.source_url ?? "",
      valid_from: edge.valid_from,
      filing_date: root.filingDate || edge.valid_from,
      accession_number: root.accessionNumber,
      form: root.form,
    };
    edges.push(graphEdge);
    if (!reverseIndex[cpId]) reverseIndex[cpId] = [];
    reverseIndex[cpId].push(graphEdge);

    if (r.cleared) {
      diagnostics.clearedTickers.push({
        ticker: edge.counterparty_ticker!.trim().toUpperCase(),
        counterparty_name: edge.counterparty_name,
        root_ticker: edge.root_ticker,
        reason: r.cleared,
        nodeId: cpId,
      });
    }
    if (r.foldedTicker) {
      diagnostics.foldedIntoTicker.push({
        ticker: r.foldedTicker,
        counterparty_name: edge.counterparty_name,
        root_ticker: edge.root_ticker,
      });
    }
    if (!clusterAcc.has(cpId)) {
      clusterAcc.set(cpId, { variants: new Set(), legacyIds: new Set(), edgeCount: 0 });
    }
    const acc = clusterAcc.get(cpId)!;
    acc.variants.add(edge.counterparty_name.trim());
    acc.legacyIds.add(legacyCounterpartyNodeId(edge));
    acc.edgeCount += 1;
  }

  for (const [nodeId, acc] of clusterAcc) {
    if (acc.legacyIds.size < 2) continue;
    const node = nodes.get(nodeId)!;
    diagnostics.collapsedClusters.push({
      nodeId,
      kind: node.kind,
      label: node.label,
      variants: [...acc.variants].sort(),
      legacyIds: [...acc.legacyIds].sort(),
      edgeCount: acc.edgeCount,
    });
  }
  diagnostics.collapsedClusters.sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  options.onDiagnostics?.(diagnostics);

  return {
    generatedAt: new Date().toISOString(),
    pipelineVersion: PIPELINE_VERSION,
    nodeCount: nodes.size,
    edgeCount: edges.length,
    nodes: [...nodes.values()].sort((a, b) => a.id.localeCompare(b.id)),
    edges,
    reverseIndex,
  };
}

export function nodeDegree(edges: GraphEdge[], nodeId: string): number {
  let count = 0;
  for (const e of edges) {
    if (e.root_ticker === nodeId || e.counterparty_id === nodeId) count++;
  }
  return count;
}
