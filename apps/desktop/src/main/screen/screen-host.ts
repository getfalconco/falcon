/**
 * Desktop wiring for the Screen host.
 *
 * The host moved into `@meridian/research/screen` so the always-on engine
 * service can run it against the Tracker that is actually being polled. What
 * stays here is the one desktop-only piece: pushing results to open windows.
 *
 * Importers keep this path; there is no second implementation to drift.
 */

import { BrowserWindow } from "electron";
import { setScreenNotifier } from "@meridian/research/screen";

let wired = false;

/** Push a fresh result to open windows. Safe to call twice. */
export function wireScreenHost(): void {
  if (wired) return;
  wired = true;
  setScreenNotifier((channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send(channel, payload);
    }
  });
}

export { ScreenHost, getScreenHost } from "@meridian/research/screen";
