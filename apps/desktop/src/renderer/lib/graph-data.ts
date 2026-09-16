import type { GraphEdge, GraphFile, GraphNode } from "../../shared/graph-types";

export type ForceGraphNode = GraphNode & {
  isSeeded: boolean;
  displayLabel: string;
  x?: number;
  y?: number;
};

export type ForceGraphLink = GraphEdge & {
  source: string;
  target: string;
};

export function shortNodeLabel(node: GraphNode): string {
  if (node.kind === "ticker") return node.id;
  const label = node.label.trim();
  if (label.length <= 20) return label;
  const first = label.split(/\s+/)[0] ?? label;
  if (first.length <= 20) return first;
  return `${label.slice(0, 18)}…`;
}

export function buildForceGraphData(graph: GraphFile): {
  nodes: ForceGraphNode[];
  links: ForceGraphLink[];
  seededTickers: Set<string>;
} {
  const seededTickers = new Set(graph.edges.map((e) => e.root_ticker));
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

  const nodes: ForceGraphNode[] = graph.nodes.map((node) => ({
    ...node,
    isSeeded: seededTickers.has(node.id),
    displayLabel: shortNodeLabel(node),
  }));

  const links: ForceGraphLink[] = graph.edges
    .filter((edge) => nodeById.has(edge.root_ticker) && nodeById.has(edge.counterparty_id))
    .map((edge) => ({
      ...edge,
      source: edge.root_ticker,
      target: edge.counterparty_id,
    }));

  return { nodes, links, seededTickers };
}

export type NodeEdgeRow = {
  direction: "outbound" | "inbound";
  peerId: string;
  peerLabel: string;
  category: string;
  subtype: string;
  confidence: number;
  evidence_quote: string;
  source_ticker: string;
  source_url: string;
};

export function edgesForNode(
  nodeId: string,
  edges: GraphEdge[],
  nodeById: Map<string, GraphNode>,
): NodeEdgeRow[] {
  const rows: NodeEdgeRow[] = [];

  for (const edge of edges) {
    if (edge.root_ticker === nodeId) {
      const peer = nodeById.get(edge.counterparty_id);
      rows.push({
        direction: "outbound",
        peerId: edge.counterparty_id,
        peerLabel: peer?.label ?? edge.counterparty_name,
        category: edge.category,
        subtype: edge.subtype,
        confidence: edge.confidence,
        evidence_quote: edge.evidence_quote,
        source_ticker: edge.root_ticker,
        source_url: edge.source_url,
      });
    } else if (edge.counterparty_id === nodeId) {
      const peer = nodeById.get(edge.root_ticker);
      rows.push({
        direction: "inbound",
        peerId: edge.root_ticker,
        peerLabel: peer?.label ?? edge.root_ticker,
        category: edge.category,
        subtype: edge.subtype,
        confidence: edge.confidence,
        evidence_quote: edge.evidence_quote,
        source_ticker: edge.root_ticker,
        source_url: edge.source_url,
      });
    }
  }

  return rows.sort(
    (a, b) =>
      a.category.localeCompare(b.category) ||
      b.confidence - a.confidence ||
      a.peerLabel.localeCompare(b.peerLabel),
  );
}

export function matchNodes(query: string, nodes: ForceGraphNode[]): ForceGraphNode[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return nodes.filter(
    (n) =>
      n.id.toLowerCase().includes(q) ||
      n.label.toLowerCase().includes(q) ||
      n.displayLabel.toLowerCase().includes(q),
  );
}
