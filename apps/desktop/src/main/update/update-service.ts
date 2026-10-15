import { app, ipcMain, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import type { UpdateStatus } from "../../shared/update-types";
import { mt } from "../i18n";
import type { UpdateCheckOutcome } from "../../shared/system-settings";

/**
 * Falcon's release feed: the public Falcon-Releases repo, holding only release assets, so
 * the source repo can stay private. electron-builder publishes here and
 * electron-updater reads `latest.yml` from the newest release.
 */
const RELEASES_OWNER = "KuzeyKovalak";
const RELEASES_REPO = "Falcon-Releases";
const LATEST_YML_URL = `https://github.com/${RELEASES_OWNER}/${RELEASES_REPO}/releases/latest/download/latest.yml`;

/** How often a running app looks again after the launch check. */
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

const UPDATE_STATUS_CHANNEL = "update:status";

type WindowGetter = () => BrowserWindow | null;

let current: UpdateStatus = { kind: "idle" };

/** Main-process listeners (the update notification) — the window gets its own push. */
const statusListeners = new Set<(status: UpdateStatus) => void>();

export function onUpdateStatusChange(listener: (status: UpdateStatus) => void): () => void {
  statusListeners.add(listener);
  return () => statusListeners.delete(listener);
}

function publish(getWindow: WindowGetter, status: UpdateStatus): void {
  current = status;
  const win = getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(UPDATE_STATUS_CHANNEL, status);
  for (const listener of statusListeners) {
    try {
      listener(status);
    } catch (err) {
      console.warn("[update] status listener failed:", err instanceof Error ? err.message : err);
    }
  }
}

export function getUpdateStatus(): UpdateStatus {
  return current;
}

/** The check startUpdateService wired, or null where this build does not check. */
let runCheck: (() => Promise<UpdateCheckOutcome>) | null = null;
let lastCheck: UpdateCheckOutcome | null = null;

/** Whether this build checks for updates at all (packaged, or forced). */
export function updateChecksEnabled(): boolean {
  return app.isPackaged || Boolean(process.env.FALCON_UPDATE_CHECK?.trim());
}

/** The most recent check's outcome, launch and periodic checks included. */
export function getLastUpdateCheck(): UpdateCheckOutcome | null {
  return lastCheck;
}

/** Settings → System → "Check for updates": the same check the timer runs, now. */
export async function checkForUpdatesNow(): Promise<UpdateCheckOutcome | null> {
  return runCheck ? runCheck() : null;
}

export function registerUpdateHandlers(): void {
  ipcMain.handle("update:get-status", () => current);
  ipcMain.handle("update:install", () => {
    if (current.kind !== "ready") return { ok: false as const, error: "no update downloaded" };
    // isSilent=false shows the installer's own progress; forceRunAfter relaunches.
    autoUpdater.quitAndInstall(false, true);
    return { ok: true as const };
  });
}

/**
 * Starts the launch check and the periodic re-check. Only runs in packaged
 * builds: electron-updater refuses dev builds, and nothing to compare against
 * exists until a release is out. Set FALCON_UPDATE_CHECK=1 to force a check
 * from a dev build (useful once a release exists).
 */
export function startUpdateService(getWindow: WindowGetter): void {
  if (!updateChecksEnabled()) return;

  const once = process.platform === "darwin"
    ? () => checkUnsignedMac(getWindow)
    : () => checkWithElectronUpdater(getWindow);
  const check = () =>
    once().then((outcome) => {
      lastCheck = outcome;
      return outcome;
    });
  runCheck = check;

  // Let the window come up first; the check is not on the critical path.
  setTimeout(() => void check(), 4_000);
  setInterval(() => void check(), RECHECK_INTERVAL_MS);
}

/**
 * Windows (and Linux): electron-updater downloads in the background and tells
 * us when the new version is sitting on disk. Install happens on the user's
 * click (update:install) or, failing that, on the next quit.
 */
let electronUpdaterWired = false;

function checkWithElectronUpdater(getWindow: WindowGetter): Promise<UpdateCheckOutcome> {
  if (!electronUpdaterWired) {
    electronUpdaterWired = true;
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = console;

    autoUpdater.on("update-downloaded", (info) => {
      publish(getWindow, { kind: "ready", version: info.version });
    });
    autoUpdater.on("error", (err) => {
      // A failed check is not something to show the user; the app is fine.
      console.warn("[update] check failed:", err instanceof Error ? err.message : err);
    });
  }
  const checkedAt = () => new Date().toISOString();
  return autoUpdater.checkForUpdates().then(
    (result): UpdateCheckOutcome =>
      result?.isUpdateAvailable
        ? { kind: "available", version: result.updateInfo.version, checkedAt: checkedAt() }
        : { kind: "current", checkedAt: checkedAt() },
    (err): UpdateCheckOutcome => ({
      kind: "error",
      error: err instanceof Error ? err.message : String(err),
      checkedAt: checkedAt(),
    }),
  );
}

/**
 * macOS without code signing: Squirrel.Mac will not install an unsigned
 * bundle, so electron-updater cannot help. We still want the user to know a
 * newer Falcon exists, so read the feed by hand and compare versions.
 */
async function checkUnsignedMac(getWindow: WindowGetter): Promise<UpdateCheckOutcome> {
  const checkedAt = new Date().toISOString();
  try {
    const res = await fetch(LATEST_YML_URL, { redirect: "follow" });
    if (!res.ok) return { kind: "error", error: mt("update.feedHttp", { status: res.status }), checkedAt };
    const latest = parseVersionFromYml(await res.text());
    if (!latest) return { kind: "error", error: mt("update.feedNoVersion"), checkedAt };
    if (compareVersions(latest, app.getVersion()) > 0) {
      publish(getWindow, { kind: "unsigned", version: latest });
      return { kind: "available", version: latest, checkedAt };
    }
    return { kind: "current", checkedAt };
  } catch (err) {
    console.warn("[update] mac check failed:", err instanceof Error ? err.message : err);
    return { kind: "error", error: err instanceof Error ? err.message : String(err), checkedAt };
  }
}

/** `latest.yml` is electron-builder's; its first line is `version: x.y.z`. */
export function parseVersionFromYml(yml: string): string | null {
  const match = /^version:\s*["']?([0-9]+\.[0-9]+\.[0-9]+[^\s"']*)/m.exec(yml);
  return match ? match[1] : null;
}

/** Numeric compare of dotted versions; a pre-release suffix sorts below its release. */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [core, pre] = v.split("-", 2);
    return { nums: core.split(".").map((n) => Number.parseInt(n, 10) || 0), pre };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.nums[i] ?? 0) - (right.nums[i] ?? 0);
    if (diff !== 0) return diff;
  }
  if (left.pre && !right.pre) return -1;
  if (!left.pre && right.pre) return 1;
  return 0;
}
