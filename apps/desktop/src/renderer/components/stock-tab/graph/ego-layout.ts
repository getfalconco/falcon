/**
 * Where the Stock tab's ego graph puts each node. Deterministic, no physics:
 * the stock sits in the middle, its suppliers to the left (upstream), its
 * customers to the right (downstream), competitors above and dependencies
 * below, each group fanned across its own arc of an ellipse. One ring
 * further out, a few second-hop companies sit just outside the neighbour
 * that links them in.
 *
 * Pure, so the caps and the bounds are tested without a DOM.
 */

import {
  STOCK_GRAPH_TABS,
  compareLinks,
  otherEnd,
  type NeighbourRow,
  type StockGraph,
  type StockGraphLink,
  type StockGraphTab,
} from "../../../../shared/stock-graph";

export const VIEW_W = 560;
export const VIEW_H = 280;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2;
const INNER = { rx: 150, ry: 92 };
const OUTER = { rx: 238, ry: 122 };
const MARGIN_X = 34;
const MARGIN_Y = 16;

/** The middle of each group's arc, in degrees (0 is right, 90 is down). */
const SECTOR: Record<StockGraphTab, number> = { customers: 0, dependencies: 90, suppliers: 180, competitors: 270 };
/** The groups on either side of each group's arc. */
const ADJACENT: Record<StockGraphTab, StockGraphTab[]> = {
  customers: ["competitors", "dependencies"],
  dependencies: ["customers", "suppliers"],
  suppliers: ["dependencies", "competitors"],
  competitors: ["suppliers", "customers"],
};
/** Degrees between two nodes of a group, and the most a group fans either side of its middle. */
const STEP = 11;
const SPREAD_SHARED = 40;
const SPREAD_ALONE = 75;

export type LayoutNode = {
  id: string;
  ticker: string | null;
  name: string;
  label: string;
  hop: 0 | 1 | 2;
  /** The group the node is drawn in (an outer node takes its parent's). */
  tab: StockGraphTab | null;
  x: number;
  y: number;
};

export type LayoutEdge = {
  id: string;
  from: string;
  to: string;
  tab: StockGraphTab | null;
  hop: 1 | 2;
  /** Marginal, or read at under 0.7 confidence: drawn dashed and fainter. */
  weak: boolean;
  link: StockGraphLink;
};

export type EgoLayout = { nodes: LayoutNode[]; edges: LayoutEdge[]; hiddenNeighbours: number };

export type LayoutOptions = {
  maxInner?: number;
  maxOuter?: number;
  /** Tickers to prefer for the outer ring (the reader's holdings). */
  prefer?: readonly string[];
};

export function isWeak(link: StockGraphLink): boolean {
  return link.tier === "marginal" || link.confidence < 0.7;
}

/** A short label: the ticker, or the name's first words cut to fit. */
export function nodeLabel(ticker: string | null, name: string): string {
  if (ticker) return ticker;
  const clean = name
    .replace(/(,?\s+(inc|corp|corporation|co|ltd|llc|plc|limited|company|holdings|n\.?a|s\.?a|ag|n\.?v)\.?)+$/i, "")
    .trim();
  if (clean.length <= 13) return clean;
  const words = clean.split(/\s+/).map((w) => w.replace(/[,;:]+$/, ""));
  let label = words[0] ?? clean;
  for (const w of words.slice(1)) {
    if (`${label} ${w}`.length > 13) break;
    label = `${label} ${w}`;
  }
  return label.length <= 13 ? label : `${label.slice(0, 12)}…`;
}

function clampX(x: number): number {
  return Math.min(VIEW_W - MARGIN_X, Math.max(MARGIN_X, x));
}
function clampY(y: number): number {
  return Math.min(VIEW_H - MARGIN_Y, Math.max(MARGIN_Y, y));
}

function point(deg: number, ring: { rx: number; ry: number }): { x: number; y: number } {
  const rad = (deg * Math.PI) / 180;
  return { x: clampX(CX + ring.rx * Math.cos(rad)), y: clampY(CY + ring.ry * Math.sin(rad)) };
}

/** Angles for `n` nodes fanned around `mid`, at most `limit` either side. */
function fan(mid: number, n: number, limit: number): number[] {
  if (n <= 1) return [mid];
  const spread = Math.min(limit, (STEP * (n - 1)) / 2 + STEP);
  return Array.from({ length: n }, (_, i) => mid - spread + (2 * spread * i) / (n - 1));
}

/**
 * Picks the neighbours to draw (up to `maxInner`, each group's strongest
 * first, round-robin so no group crowds the others out) and up to `maxOuter`
 * second-hop companies, then places them.
 */
export function egoLayout(
  graph: StockGraph,
  rows: Record<StockGraphTab, NeighbourRow[]>,
  opts: LayoutOptions = {},
): EgoLayout {
  const maxInner = opts.maxInner ?? 14;
  const maxOuter = opts.maxOuter ?? 8;
  const prefer = new Set((opts.prefer ?? []).map((t) => t.toUpperCase()));
  const center = graph.ticker;

  // A neighbour in two groups is drawn once, in the group of its strongest link.
  const primary = new Map<string, NeighbourRow>();
  for (const tab of STOCK_GRAPH_TABS) {
    for (const row of rows[tab]) {
      const prev = primary.get(row.id);
      if (!prev || compareLinks(row.link, prev.link) < 0) primary.set(row.id, row);
    }
  }
  const groups = new Map(STOCK_GRAPH_TABS.map((tab) => [tab, rows[tab].filter((r) => primary.get(r.id) === r)]));
  const used = new Set(STOCK_GRAPH_TABS.filter((tab) => (groups.get(tab)?.length ?? 0) > 0));
  // A group with an empty group on both sides may take the room they leave.
  const roomy = (tab: StockGraphTab) => ADJACENT[tab].every((a) => !used.has(a));
  const queues = STOCK_GRAPH_TABS.map((tab) => (groups.get(tab) ?? []).slice(0, roomy(tab) ? 11 : 6));
  const chosen: NeighbourRow[] = [];
  for (let i = 0; chosen.length < maxInner && queues.some((q) => i < q.length); i++) {
    for (const q of queues) {
      if (chosen.length >= maxInner) break;
      if (i < q.length) chosen.push(q[i]!);
    }
  }
  const hiddenNeighbours = primary.size - chosen.length;

  const nodes: LayoutNode[] = [
    { id: center, ticker: center, name: graph.name ?? center, label: center, hop: 0, tab: null, x: CX, y: CY },
  ];
  const angleOf = new Map<string, number>();
  for (const tab of STOCK_GRAPH_TABS) {
    const group = chosen.filter((r) => r.tab === tab);
    const angles = fan(SECTOR[tab], group.length, roomy(tab) ? SPREAD_ALONE : SPREAD_SHARED);
    group.forEach((row, i) => {
      const deg = angles[i]!;
      angleOf.set(row.id, deg);
      const { x, y } = point(deg, INNER);
      nodes.push({ id: row.id, ticker: row.ticker, name: row.name, label: nodeLabel(row.ticker, row.name), hop: 1, tab, x, y });
    });
  }

  const inner = new Set(chosen.map((r) => r.id));
  const edges: LayoutEdge[] = chosen.map((row) => ({
    id: `1|${row.id}`,
    from: center,
    to: row.id,
    tab: row.tab,
    hop: 1,
    weak: isWeak(row.link),
    link: row.link,
  }));

  // Second ring: the strongest link from a drawn neighbour to a company not
  // already drawn, holdings first; each outer company once.
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const candidates = graph.links
    .filter((l) => l.filer !== center && l.named !== center)
    .map((l) => {
      const parent = inner.has(l.filer) ? l.filer : inner.has(l.named) ? l.named : null;
      if (!parent) return null;
      const outer = otherEnd(l, parent);
      if (outer === center || inner.has(outer)) return null;
      if (nodeById.get(outer)?.hop !== 2) return null;
      return { link: l, parent, outer };
    })
    .filter((c): c is { link: StockGraphLink; parent: string; outer: string } => c !== null)
    .sort(
      (a, b) =>
        Number(prefer.has(b.outer)) - Number(prefer.has(a.outer)) ||
        Number(nodeById.get(b.outer)?.ticker != null) - Number(nodeById.get(a.outer)?.ticker != null) ||
        compareLinks(a.link, b.link) ||
        a.outer.localeCompare(b.outer),
    );
  const placed = new Map<string, { parent: string; link: StockGraphLink }>();
  for (const c of candidates) {
    if (placed.size >= maxOuter) break;
    if (!placed.has(c.outer)) placed.set(c.outer, { parent: c.parent, link: c.link });
  }
  const perParent = new Map<string, string[]>();
  for (const [outer, { parent }] of placed) perParent.set(parent, [...(perParent.get(parent) ?? []), outer]);
  for (const [parent, outers] of perParent) {
    const base = angleOf.get(parent) ?? 0;
    outers.forEach((outer, i) => {
      const deg = base + (i - (outers.length - 1) / 2) * 9;
      const { x, y } = point(deg, OUTER);
      const node = nodeById.get(outer);
      const tab = nodes.find((n) => n.id === parent)?.tab ?? null;
      nodes.push({
        id: outer,
        ticker: node?.ticker ?? null,
        name: node?.name ?? outer,
        label: nodeLabel(node?.ticker ?? null, node?.name ?? outer),
        hop: 2,
        tab,
        x,
        y,
      });
      const link = placed.get(outer)!.link;
      edges.push({ id: `2|${parent}|${outer}`, from: parent, to: outer, tab, hop: 2, weak: isWeak(link), link });
    });
  }

  return { nodes, edges, hiddenNeighbours };
}
