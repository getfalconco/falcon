import { app, shell } from "electron";
import fs from "node:fs";
import { registerIpcHandler } from "../ipc-register";
import { resolveDataRoot } from "../data-root";
import { readGitCommit } from "./git-commit";
import { registerThemeEditorHandlers } from "./theme-editor-window";
import type { DeveloperBuildInfo, DeveloperFolder } from "../../shared/developer-info";

/**
 * Settings → Developer IPC.
 *
 *   developer:info            — versions, build type, commit (dev checkouts only)
 *                               and the two folders worth opening.
 *   developer:toggle-devtools — open or close DevTools on the window that asked,
 *                               detached, since the window itself cannot grow.
 *   developer:open-folder     — reveal one of a fixed set of folders. The
 *                               renderer picks a name, never a path.
 *   developer:open-theme-editor, developer:theme-editor-on-top
 *                             — the dark theme colour editor window
 *                               (theme-editor-window.ts).
 */

function folderPath(which: DeveloperFolder): string | null {
  if (which === "data") return resolveDataRoot();
  if (which === "userData") return app.getPath("userData");
  return null;
}

export function registerDeveloperHandlers(): void {
  registerThemeEditorHandlers();

  registerIpcHandler("developer:info", (event) => {
    try {
      const info: DeveloperBuildInfo = {
        appVersion: app.getVersion(),
        electron: process.versions.electron ?? "?",
        chrome: process.versions.chrome ?? "?",
        node: process.versions.node ?? "?",
        v8: process.versions.v8 ?? "?",
        platform: process.platform,
        arch: process.arch,
        packaged: app.isPackaged,
        // out/main sits inside the checkout in dev; a packaged app has no .git to find.
        commit: app.isPackaged ? null : readGitCommit(__dirname),
        dataRoot: resolveDataRoot(),
        userData: app.getPath("userData"),
        devToolsOpen: event?.sender.isDevToolsOpened() ?? false,
      };
      return { ok: true as const, info };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("developer:toggle-devtools", (event) => {
    const contents = event?.sender;
    if (!contents) return { ok: false as const, error: "No window to attach DevTools to." };
    if (contents.isDevToolsOpened()) {
      contents.closeDevTools();
      return { ok: true as const, open: false };
    }
    contents.openDevTools({ mode: "detach" });
    return { ok: true as const, open: true };
  });

  registerIpcHandler("developer:open-folder", async (_event, which: DeveloperFolder) => {
    const target = folderPath(which);
    if (!target) return { ok: false as const, error: "Unknown folder." };
    try {
      fs.mkdirSync(target, { recursive: true });
    } catch {
      /* openPath reports the real problem below */
    }
    // openPath resolves to an error message, or "" on success.
    const error = await shell.openPath(target);
    return error ? { ok: false as const, error } : { ok: true as const };
  });
}
