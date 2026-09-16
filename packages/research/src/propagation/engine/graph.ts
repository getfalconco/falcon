/**
 * §3 graph contract — the indexed reader over the Deep Research graph.
 *
 * Tolerant by design: the reader never edits the graph, never drops an edge
 * it cannot fully explain, and treats name-only counterparties (no ticker) as
 * legitimate targets. Hygiene (duplicate name nodes, suspect ticker mappings)
 * is a separate task. The version stamp (`generatedAt`, `pipelineVersion`)
 * travels with every run for reproducibility.
 */

import { readFile } from "node:fs/promises";
import fs from "node:fs";
import type { GraphEdge } from "../types.js";
import type { GraphVersion, StrengthTier } from "./types.js";

export type GraphFileLike = {
  generatedAt?: string;
  pipelineVersion?: number;
  nodes?: Array<{ id: string; label: string; kind: "ticker" | "name" }>;
  edges?: GraphEdge[];
};

export type GraphIndex = {
  version: GraphVersion;
  edges: GraphEdge[];
  /** Edges where the key ticker is `root_ticker` (forward). */
  forward: Map<string, GraphEdge[]>;
  /** Edges where the key ticker is `counterparty_ticker` (reverse). */
  reverse: Map<string, GraphEdge[]>;
  /** Display label per counterparty / root id. */
  labels: Map<string, string>;
  /** Every ticker that appears as a root (has a filing in the graph). */
  roots: Set<string>;
};

export const STRENGTH_RANK: Record<StrengthTier, number> = { critical: 3, important: 2, marginal: 1 };

/** `strength_tier` is optional on pre-strength edges; treat missing as marginal. */
export function edgeTier(edge: Pick<GraphEdge, "strength_tier">): StrengthTier {
  return edge.strength_tier ?? "marginal";
}

/** Identity for a counterparty: the ticker when known, else the graph's name id. */
export function counterpartyKey(edge: Pick<GraphEdge, "counterparty_ticker" | "counterparty_id">): string {
  return edge.counterparty_ticker ? edge.counterparty_ticker.toUpperCase() : edge.counterparty_id;
}

export function indexGraph(file: GraphFileLike): GraphIndex {
  const edges = Array.isArray(file.edges) ? file.edges : [];
  const forward = new Map<string, GraphEdge[]>();
  const reverse = new Map<string, GraphEdge[]>();
  const labels = new Map<string, string>();
  const roots = new Set<string>();
  for (const node of file.nodes ?? []) {
    if (node && typeof node.id === "string") labels.set(node.id, node.label ?? node.id);
  }
  for (const edge of edges) {
    if (!edge || typeof edge.root_ticker !== "string") continue;
    const root = edge.root_ticker.toUpperCase();
    roots.add(root);
    push(forward, root, edge);
    if (edge.counterparty_ticker) push(reverse, edge.counterparty_ticker.toUpperCase(), edge);
    const key = counterpartyKey(edge);
    if (!labels.has(key) && edge.counterparty_name) labels.set(key, edge.counterparty_name);
    if (!labels.has(root)) labels.set(root, root);
  }
  return {
    version: {
      generatedAt: typeof file.generatedAt === "string" ? file.generatedAt : "unknown",
      pipelineVersion: typeof file.pipelineVersion === "number" ? file.pipelineVersion : 0,
    },
    edges,
    forward,
    reverse,
    labels,
    roots,
  };
}

function push(map: Map<string, GraphEdge[]>, key: string, edge: GraphEdge): void {
  const list = map.get(key);
  if (list) list.push(edge);
  else map.set(key, [edge]);
}

export async function loadGraphIndex(graphPath: string): Promise<GraphIndex> {
  const raw = await readFile(graphPath, "utf8");
  return indexGraph(JSON.parse(raw) as GraphFileLike);
}

export function loadGraphIndexSync(graphPath: string): GraphIndex {
  return indexGraph(JSON.parse(fs.readFileSync(graphPath, "utf8")) as GraphFileLike);
}
