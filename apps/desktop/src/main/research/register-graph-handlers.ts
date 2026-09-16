import { access } from "node:fs/promises";
import { buildGraphFromResearchDir } from "@meridian/research/step1";
import { registerIpcHandler } from "../ipc-register";
import { resolveStep1DataDir } from "./research-paths";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function registerGraphHandlers(): void {
  registerIpcHandler("graph:load", async () => {
    try {
      const researchDir = resolveStep1DataDir();
      if (!(await fileExists(researchDir))) {
        return {
          ok: false as const,
          error: `research folder not found (${researchDir})`,
        };
      }
      const graph = await buildGraphFromResearchDir(researchDir);
      if (graph.edgeCount === 0) {
        return {
          ok: false as const,
          error: "no validated edges yet — run Begin Analysis on a stock first",
        };
      }
      return { ok: true as const, graph, path: researchDir };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false as const, error: message };
    }
  });
}
