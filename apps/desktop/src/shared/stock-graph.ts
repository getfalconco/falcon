/**
 * The Stock tab's ego graph: one company at the centre, the companies its
 * filings (and the filings that name it) link it to, and one ring further out.
 *
 * Pure on purpose: the main process builds it from the filing graph
 * (`stock:graph`), the renderer reads it, and the tests run it on plain
 * arrays. Every link here comes from a 10-K or 20-F: step1 keeps an edge only
 * when its quote is found in the filing, and `normalizeLinks` drops anything
 * that arrives without a source URL or a quote, so nothing is drawn that a
 * reader cannot open at the source.
 *
 * Direction matters. An edge is stored as "the filer names X as its
 * {category}", so X's role towards the filer is the category, and the filer's
 * role towards X is its inverse (a supplier's filer is that supplier's
 * customer). Every role below is read that way: the role of a node relative to
 * the node on the other end of the link.
 */

export type StrengthTier = "critical" | "important" | "marginal";

/** The numeric weight of a tier, as step1 assigns it when no share is disclosed. */
export const TIER_STRENGTH: Record<StrengthTier, number> = { critical: 1, important: 0.6, marginal: 0.3 };

const TIER_RANK: Record<StrengthTier, number> = { critical: 3, important: 2, marginal: 1 };

/** A graph edge as the file (or a step1 result) gives it; every field optional, older graphs carry fewer. */
export type RawGraphEdge = {
  root_ticker?: string | null;
  counterparty_id?: string | null;
  counterparty_ticker?: string | null;
  counterparty_name?: string | null;
  counterparty_type?: string | null;
  category?: string | null;
  subtype?: string | null;
  strength?: number | null;
  strength_tier?: string | null;
  /** The share the filing states, in percent; null when none; absent on graphs built before it was carried. */
  disclosed_share_pct?: number | null;
  confidence?: number | null;
  evidence_quote?: string | null;
  source_url?: string | null;
  valid_from?: string | null;
  filing_date?: string | null;
  accession_number?: string | null;
  form?: "10-K" | "20-F" | null;
};

export type FilingForm = "10-K" | "20-F";

/** A filing-backed link: `filer`'s filing names `named` as its `category`. */
export type StockGraphLink = {
  filer: string;
  named: string;
  /** The named party's type as step1 recorded it (public_company, government, ...); null on older graphs. */
  namedType: string | null;
  category: string;
  subtype: string;
  tier: StrengthTier;
  /** 0 to 1: the disclosed share over 100, or the tier's weight. */
  strength: number;
  /** The share the filing discloses, in percent; null when it gives none. */
  share: number | null;
  confidence: number;
  sourceUrl: string;
  quote: string;
  filingDate: string | null;
  form: FilingForm | null;
  accession: string | null;
};

export type StockGraphNode = {
  id: string;
  /** The listed symbol, when the party has one. */
  ticker: string | null;
  name: string;
  hop: 0 | 1 | 2;
};

export type StockGraph = {
  ticker: string;
  /** The company's name as other filings write it; null when no filing names it. */
  name: string | null;
  /** True when the stock's own filing is in the graph (not only filings that name it). */
  researched: boolean;
  nodes: StockGraphNode[];
  links: StockGraphLink[];
  /** True when links were left out to keep the answer small. */
  truncated: boolean;
};

export type StockGraphResult = { ok: true; graph: StockGraph } | { ok: false; error: string };

/** What `stock:graph` is asked with besides the ticker. */
export type StockGraphOptions = {
  /** Tickers (the reader's holdings and watchlist) whose links are kept whatever the cap. */
  related?: string[];
};

// ---------------------------------------------------------------------------
// Reading the file
// ---------------------------------------------------------------------------

const FILING_URL = /^https?:\/\//i;

function upper(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim().toUpperCase() : "";
}

function asTier(value: unknown): StrengthTier {
  return value === "critical" || value === "important" || value === "marginal" ? value : "important";
}

/**
 * Fallback for graphs built before `disclosed_share_pct` (use `edgeShare`).
 * The share a filing disclosed, recovered from the stored strength: step1
 * stores `pct / 100` when the filing gives a percentage and the tier's own
 * weight otherwise, so a strength that is not a tier weight is a disclosure.
 * (A disclosed 100%, 60% or 30% reads as undisclosed; no filing in the graph
 * gives one, and claiming a share that was not written is the worse error.)
 */
export function disclosedShare(strength: number | null | undefined): number | null {
  if (typeof strength !== "number" || !Number.isFinite(strength) || strength <= 0 || strength > 1) return null;
  if (Object.values(TIER_STRENGTH).some((w) => Math.abs(w - strength) < 1e-9)) return null;
  return Math.round(strength * 1000) / 10;
}

/**
 * The share an edge's filing discloses, in percent: the graph's own
 * `disclosed_share_pct` when the edge carries it (null there means the filing
 * states none), else, on graphs built before that field, recovered from the
 * strength as above.
 */
export function edgeShare(e: Pick<RawGraphEdge, "disclosed_share_pct" | "strength">): number | null {
  if (e.disclosed_share_pct !== undefined) {
    const pct = e.disclosed_share_pct;
    return typeof pct === "number" && Number.isFinite(pct) && pct > 0 ? Math.min(100, pct) : null;
  }
  return disclosedShare(e.strength);
}

/** A party's node id: its ticker when it has one, else the graph's canonical name key. */
export function nodeIdOf(ticker: string | null | undefined, id: string | null | undefined, name: string | null | undefined): string {
  const symbol = upper(ticker);
  if (symbol) return symbol;
  const key = typeof id === "string" ? id.trim() : "";
  if (key) return /^[A-Z0-9.\-]{1,10}$/.test(key) ? key : key.toLowerCase();
  const label = typeof name === "string" ? name.trim().toLowerCase() : "";
  return label ? `name:${label}` : "";
}

export type NormalizeOptions = {
  /** Links below this confidence are dropped (the Stock tab draws from 0.5 up). */
  minConfidence?: number;
  /** The form of the filer's filing when the edge does not carry it. */
  formOf?: (ticker: string) => FilingForm | null;
};

/**
 * The file's edges as links: filing-backed only (a source URL and a quote),
 * at or above `minConfidence`, no self links. Also returns every party's name
 * as the filings write it, so a filer (stored by ticker only) gets its name
 * from the filings that name it.
 */
export function normalizeLinks(
  edges: readonly RawGraphEdge[],
  opts: NormalizeOptions = {},
): { links: StockGraphLink[]; names: Map<string, string> } {
  const min = opts.minConfidence ?? 0;
  const names = new Map<string, string>();
  const links: StockGraphLink[] = [];
  const forms = new Map<string, FilingForm | null>();
  const formOf = (ticker: string): FilingForm | null => {
    if (!opts.formOf) return null;
    if (!forms.has(ticker)) forms.set(ticker, opts.formOf(ticker));
    return forms.get(ticker) ?? null;
  };

  for (const e of edges) {
    const filer = upper(e.root_ticker);
    const named = nodeIdOf(e.counterparty_ticker, e.counterparty_id, e.counterparty_name);
    // US federal bodies share one node (step1 canonical.ts); the agency stays in the edge's quote.
    const name =
      named === "name:us government" ? "U.S. government" : typeof e.counterparty_name === "string" ? e.counterparty_name.trim() : "";
    if (named && name && !names.has(named)) names.set(named, name);

    const url = typeof e.source_url === "string" ? e.source_url.trim() : "";
    const quote = typeof e.evidence_quote === "string" ? e.evidence_quote.trim() : "";
    if (!filer || !named || filer === named) continue;
    if (!FILING_URL.test(url) || !quote) continue;
    const confidence = typeof e.confidence === "number" && Number.isFinite(e.confidence) ? e.confidence : 0;
    if (confidence < min) continue;

    const tier = asTier(e.strength_tier);
    const share = edgeShare(e);
    const strength =
      typeof e.strength === "number" && Number.isFinite(e.strength) && e.strength > 0 ? Math.min(1, e.strength) : TIER_STRENGTH[tier];
    links.push({
      filer,
      named,
      namedType: typeof e.counterparty_type === "string" ? e.counterparty_type : null,
      category: (e.category ?? "").trim().toLowerCase() || "partner",
      subtype: (e.subtype ?? "").replace(/_/g, " ").trim(),
      tier,
      strength,
      share,
      confidence,
      sourceUrl: url,
      quote,
      filingDate: e.filing_date || e.valid_from || null,
      form: e.form === "10-K" || e.form === "20-F" ? e.form : formOf(filer),
      accession: e.accession_number ?? null,
    });
  }
  return { links, names };
}

/** How strongly a link reads, for ranking: tier first, then a disclosed share, then confidence. */
export function linkScore(link: StockGraphLink): number {
  return TIER_RANK[link.tier] * 100 + (link.share ?? 0) * 0.5 + link.confidence;
}

export function compareLinks(a: StockGraphLink, b: StockGraphLink): number {
  return (
    TIER_RANK[b.tier] - TIER_RANK[a.tier] ||
    (b.share ?? -1) - (a.share ?? -1) ||
    b.confidence - a.confidence ||
    a.filer.localeCompare(b.filer) ||
    a.named.localeCompare(b.named)
  );
}

/** The node on the other end of `link` from `node`. */
export function otherEnd(link: StockGraphLink, node: string): string {
  return link.filer === node ? link.named : link.filer;
}

// ---------------------------------------------------------------------------
// The ego network
// ---------------------------------------------------------------------------

export type EgoOptions = {
  /** Most first-ring neighbours kept, strongest first. */
  maxNeighbours?: number;
  /** Most second-ring links kept, strongest first (links touching `keep` always stay). */
  maxOuterLinks?: number;
  /** Tickers whose links are kept whatever the cap (holdings, watchlist). */
  keep?: readonly string[];
};

/**
 * `ticker` and the links within two hops of it: every link touching it, then
 * every link touching one of its neighbours (including links between two
 * neighbours). Capped so a hub (a large filer named by dozens of others)
 * still answers in a few kilobytes.
 */
export function extractEgo(
  links: readonly StockGraphLink[],
  names: ReadonlyMap<string, string>,
  ticker: string,
  opts: EgoOptions = {},
): StockGraph {
  const center = upper(ticker);
  const maxNeighbours = opts.maxNeighbours ?? 60;
  const maxOuter = opts.maxOuterLinks ?? 240;
  const keep = new Set((opts.keep ?? []).map(upper).filter(Boolean));

  const inner = links.filter((l) => l.filer === center || l.named === center);
  const best = new Map<string, StockGraphLink>();
  for (const l of inner) {
    const other = otherEnd(l, center);
    const prev = best.get(other);
    if (!prev || compareLinks(l, prev) < 0) best.set(other, l);
  }
  const ranked = [...best.entries()].sort((a, b) => compareLinks(a[1], b[1]) || a[0].localeCompare(b[0]));
  let truncated = ranked.length > maxNeighbours;
  const neighbours = new Set(
    ranked.filter(([id], i) => i < maxNeighbours || keep.has(id)).map(([id]) => id),
  );

  const innerKept = inner.filter((l) => neighbours.has(otherEnd(l, center)));
  const outerAll = links.filter(
    (l) =>
      l.filer !== center &&
      l.named !== center &&
      (neighbours.has(l.filer) || neighbours.has(l.named)),
  );
  const pinned = outerAll.filter((l) => keep.has(l.filer) || keep.has(l.named));
  const rest = outerAll.filter((l) => !(keep.has(l.filer) || keep.has(l.named))).sort(compareLinks);
  if (rest.length > maxOuter) truncated = true;
  const outer = [...pinned, ...rest.slice(0, maxOuter)];

  const hop = new Map<string, 0 | 1 | 2>([[center, 0]]);
  for (const id of neighbours) hop.set(id, 1);
  for (const l of outer) {
    for (const id of [l.filer, l.named]) if (!hop.has(id)) hop.set(id, 2);
  }

  const nodes: StockGraphNode[] = [...hop.entries()].map(([id, h]) => ({
    id,
    ticker: isTickerId(id) ? id : null,
    name: names.get(id) ?? (isTickerId(id) ? id : prettyKey(id)),
    hop: h,
  }));

  return {
    ticker: center,
    name: names.get(center) ?? null,
    researched: links.some((l) => l.filer === center),
    nodes,
    links: [...innerKept, ...outer],
    truncated,
  };
}

/** True for an id that is a listed symbol rather than a name key. */
export function isTickerId(id: string): boolean {
  return /^[A-Z0-9][A-Z0-9.\-]{0,9}$/.test(id);
}

function prettyKey(id: string): string {
  const bare = id.replace(/^name:/, "").trim();
  return bare.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

// ---------------------------------------------------------------------------
// Roles and the four categories
// ---------------------------------------------------------------------------

/** A party's role relative to the party on the other end of a link. */
export type LinkRole = "supplier" | "customer" | "competitor" | "partner" | "dependency" | "dependent";

/** The four groups the Stock tab shows, in order. */
export const STOCK_GRAPH_TABS = ["suppliers", "customers", "competitors", "dependencies"] as const;
export type StockGraphTab = (typeof STOCK_GRAPH_TABS)[number];

const INVERSE: Record<string, LinkRole> = {
  supplier: "customer",
  customer: "supplier",
  competitor: "competitor",
  partner: "partner",
  dependency: "dependent",
};

function asRole(category: string): LinkRole {
  return category === "supplier" ||
    category === "customer" ||
    category === "competitor" ||
    category === "dependency"
    ? category
    : "partner";
}

/** The role `node` plays towards the other end of `link`. */
export function roleOf(link: StockGraphLink, node: string): LinkRole {
  if (link.named === node) return asRole(link.category);
  return INVERSE[link.category] ?? "partner";
}

/**
 * Which of the four groups a neighbour sits in, from its role towards the
 * centre. A party that relies on the company (it named the company as a
 * dependency) reads as a customer. A partner goes by what the filing says the
 * partnership is: a licensor, foundry or manufacturer supplies, a licensee or
 * distributor buys, anything else (a joint venture, a collaboration) is
 * something the company depends on.
 */
export function tabOf(role: LinkRole, subtype: string): StockGraphTab {
  switch (role) {
    case "supplier":
      return "suppliers";
    case "customer":
    case "dependent":
      return "customers";
    case "competitor":
      return "competitors";
    case "dependency":
      return "dependencies";
    case "partner": {
      const s = subtype.toLowerCase();
      if (/licensee|distribut|resell|reseller|channel|customer/.test(s)) return "customers";
      if (/licens|suppl|foundry|manufactur|vendor|sourc|fabricat|assembly/.test(s)) return "suppliers";
      return "dependencies";
    }
  }
}

/** One neighbour in one of the four groups, with the link that puts it there. */
export type NeighbourRow = {
  id: string;
  ticker: string | null;
  name: string;
  tab: StockGraphTab;
  role: LinkRole;
  /** The strongest link between the centre and this neighbour for this group. */
  link: StockGraphLink;
  /** True when the link comes from the neighbour's filing rather than the centre's. */
  inbound: boolean;
};

/** The first ring, grouped: one row per neighbour per group, strongest first. */
export function neighbourRows(graph: StockGraph): Record<StockGraphTab, NeighbourRow[]> {
  const center = graph.ticker;
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const byKey = new Map<string, NeighbourRow>();
  for (const link of graph.links) {
    if (link.filer !== center && link.named !== center) continue;
    const id = otherEnd(link, center);
    const role = roleOf(link, id);
    const tab = tabOf(role, link.subtype);
    const key = `${tab}|${id}`;
    const prev = byKey.get(key);
    if (prev && compareLinks(prev.link, link) <= 0) continue;
    const node = nodeById.get(id);
    byKey.set(key, {
      id,
      ticker: node?.ticker ?? null,
      name: node?.name ?? id,
      tab,
      role,
      link,
      inbound: link.filer !== center,
    });
  }
  const out: Record<StockGraphTab, NeighbourRow[]> = { suppliers: [], customers: [], competitors: [], dependencies: [] };
  for (const row of byKey.values()) out[row.tab].push(row);
  for (const tab of STOCK_GRAPH_TABS) {
    out[tab].sort((a, b) => compareLinks(a.link, b.link) || a.name.localeCompare(b.name));
  }
  return out;
}

// ---------------------------------------------------------------------------
// The two questions
// ---------------------------------------------------------------------------

const COMPANY_TYPES = new Set(["public_company", "private_company"]);
const TAB_PRIORITY: Record<StockGraphTab, number> = { suppliers: 0, customers: 0, dependencies: 1, competitors: 2 };

/** True when the neighbour is a company (a listed one, or one the filing typed as a company). */
export function isCompanyRow(row: NeighbourRow): boolean {
  if (row.ticker) return true;
  if (row.inbound) return true; // the filer of a filing is always a company
  return row.link.namedType === null || COMPANY_TYPES.has(row.link.namedType);
}

/**
 * "Which company affects this stock the most?": the strongest first-ring link
 * to a company, ranked by tier, then the share the filing discloses, then
 * confidence; a supplier or customer ahead of a dependency, a competitor last
 * when all else ties. Null when no company is linked.
 */
export function strongestInfluence(graph: StockGraph): NeighbourRow | null {
  const rows = Object.values(neighbourRows(graph)).flat().filter(isCompanyRow);
  rows.sort(
    (a, b) =>
      compareLinksNoNames(a.link, b.link) ||
      TAB_PRIORITY[a.tab] - TAB_PRIORITY[b.tab] ||
      a.name.localeCompare(b.name),
  );
  return rows[0] ?? null;
}

function compareLinksNoNames(a: StockGraphLink, b: StockGraphLink): number {
  return TIER_RANK[b.tier] - TIER_RANK[a.tier] || (b.share ?? -1) - (a.share ?? -1) || b.confidence - a.confidence;
}

export type SharedHolding = {
  ticker: string;
  /** The first-ring companies this holding is also linked to, strongest first. */
  shared: { id: string; ticker: string | null; name: string }[];
};

/**
 * "Which of your other holdings connect to the same companies?": each
 * holding (not the stock itself) with the stock's first-ring neighbours it
 * also links to, most shared first.
 */
export function sharedHoldings(graph: StockGraph, holdings: readonly string[]): SharedHolding[] {
  const center = graph.ticker;
  const ring = new Set(graph.nodes.filter((n) => n.hop === 1).map((n) => n.id));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: SharedHolding[] = [];
  for (const raw of new Set(holdings.map(upper))) {
    if (!raw || raw === center) continue;
    const strength = new Map<string, StockGraphLink>();
    for (const link of graph.links) {
      if (link.filer !== raw && link.named !== raw) continue;
      const other = otherEnd(link, raw);
      if (other === center || other === raw || !ring.has(other)) continue;
      const prev = strength.get(other);
      if (!prev || compareLinks(link, prev) < 0) strength.set(other, link);
    }
    if (strength.size === 0) continue;
    const shared = [...strength.entries()]
      .sort((a, b) => compareLinks(a[1], b[1]) || a[0].localeCompare(b[0]))
      .map(([id]) => {
        const node = nodeById.get(id);
        return { id, ticker: node?.ticker ?? null, name: node?.name ?? id };
      });
    out.push({ ticker: raw, shared });
  }
  return out.sort((a, b) => b.shared.length - a.shared.length || a.ticker.localeCompare(b.ticker));
}
