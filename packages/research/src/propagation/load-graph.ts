import { readFile } from "node:fs/promises";
import type { GraphFile } from "./types.js";

/**
 * Reads the relationship graph step1 writes to disk. Kept after the old
 * propagation engine was removed because the worker's graph sync (and
 * anything else that renders relationships) still needs to load it.
 */
export async function loadGraphFile(graphPath: string): Promise<GraphFile> {
  const raw = await readFile(graphPath, "utf8");
  const parsed = JSON.parse(raw) as GraphFile & { edges: GraphFile["edges"] };
  return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
}
