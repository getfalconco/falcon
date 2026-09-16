/**
 * Desktop wiring for the Risk host.
 *
 * The host moved into `@meridian/research/risk` so the always-on engine
 * service can run it against the Tracker that is actually being polled. What
 * stays here is the one desktop-only piece: pushing a fresh snapshot to open
 * windows over the `risk:snapshot` channel.
 */

import { BrowserWindow } from "electron";
import { setRiskNotifier, type RiskLatest } from "@meridian/research/risk";

let wired = false;

export function wireRiskHost(): void {
  if (wired) return;
  wired = true;
  setRiskNotifier((payload: RiskLatest) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue;
      win.webContents.send("risk:snapshot", payload);
    }
  });
}

export { RiskHost, getRiskHost } from "@meridian/research/risk";
