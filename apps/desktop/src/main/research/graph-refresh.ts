import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { buildGraphFromResearchDir, type GraphFile } from "@meridian/research/step1";
import { resolveStep1DataDir } from "./research-paths";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolveGraphOutputPath(): Promise<string | null> {
  const fromEnv = process.env.FALCON_GRAPH_PATH?.trim();
  if (fromEnv) return fromEnv;

  const candidates = [
    path.resolve(process.cwd(), "data", "graph.json"),
    path.resolve(process.cwd(), "..", "..", "data", "graph.json"),
    path.join(app.getPath("userData"), "graph.json"),
  ];

  for (const candidate of candidates) {
    const parent = path.dirname(candidate);
    if (await fileExists(parent)) return candidate;
  }

  return candidates[0] ?? null;
}

/** Persist merged graph for CLI / external tools (best-effort). */
export async function refreshGraphFile(researchDir?: string): Promise<GraphFile> {
  const dir = researchDir ?? resolveStep1DataDir();
  const graph = await buildGraphFromResearchDir(dir);
  const outPath = await resolveGraphOutputPath();
  if (outPath) {
    await mkdir(path.dirname(outPath), { recursive: true });
    await writeFile(outPath, JSON.stringify(graph, null, 2), "utf8");
  }
  return graph;
}
