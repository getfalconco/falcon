/**
 * Desktop wiring for the Propagation host.
 *
 * The host itself moved into `@meridian/research/propagation/engine` so the
 * always-on engine service can run the same cycle. What stays here is what is
 * genuinely desktop: the Supabase mirror signed with the user's own JWT, the
 * IPC fan-out to open windows, the Classifier host that answers verdict
 * lookups, and Electron's userData dir as the last resort for the graph file.
 *
 * Importers keep this path — there is no second implementation to drift.
 */

import { app, BrowserWindow } from "electron";
import {
  configurePropagationHost,
  setGraphPathFallback,
  type PropagationRun,
  type PropagationRunListItem,
} from "@meridian/research/propagation/engine";
import { getClassifierHost } from "@meridian/research/classifier";
import path from "node:path";
import { pullRemoteRuns, pushRemoteRuns } from "./runs-sync";

let wired = false;

/** Wire the shared host to this process. Safe to call twice. */
export function wirePropagationHost(): void {
  if (wired) return;
  wired = true;
  setGraphPathFallback(() => path.join(app.getPath("userData"), "graph.json"));
  configurePropagationHost({
    remote: {
      pull: () => pullRemoteRuns(),
      push: (runs: PropagationRun[]) => pushRemoteRuns(runs, "desktop"),
    },
    notify: {
      runProduced: (item: PropagationRunListItem) => broadcast("propagation:event", item),
      runsChanged: () => broadcast("propagation:runs-changed"),
    },
    classifier: getClassifierHost(),
  });
}

function broadcast(channel: string, payload?: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue;
    win.webContents.send(channel, payload);
  }
}

export { getPropagationHost, resolveGraphPath, PropagationHost } from "@meridian/research/propagation/engine";
