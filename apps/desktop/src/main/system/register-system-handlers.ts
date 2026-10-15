import fs from "node:fs";
import path from "node:path";
import { app, BrowserWindow, dialog, session, shell } from "electron";
import { registerIpcHandler } from "../ipc-register";
import { dataRootChoice, defaultDataRoot, resolveDataRoot } from "../data-root";
import { mt } from "../i18n";
import {
  checkForUpdatesNow,
  getLastUpdateCheck,
  getUpdateStatus,
  updateChecksEnabled,
} from "../update/update-service";
import type {
  Capability,
  DataFolderInfo,
  DataMoveResult,
  QuickOpenResult,
  SystemInfo,
  SystemResult,
  SystemStorage,
  UpdateCheckOutcome,
} from "../../shared/system-settings";
import { directorySize, readSystemSettings, writeSystemSettings } from "./system-settings-store";
import { copyDataFolder, DataMoveError, planDataMove, readDataLocation, samePath, writeDataLocation } from "./data-location";
import { LOGIN_LAUNCH_ARG, traySupported } from "./presence";
import { presence } from "./presence-electron";

/**
 * Settings → System: what this install is, the machine-level switches, and
 * the storage it uses. Every switch here is the OS's or Chromium's own —
 * login items, hardware acceleration, the HTTP cache, the global shortcut,
 * the tray, the power save blocker — so the pane shows what is actually in
 * force, not a copy of it. The shortcut, tray and keep awake rules live in
 * presence.ts; moving the data folder in data-location.ts.
 */

/** What this run started with; the stored choice may differ until a restart. */
let activeHardwareAcceleration = true;

/**
 * Must run before `app` is ready: Chromium picks its GPU path at startup and
 * cannot change it afterwards, which is why the pane says "on restart".
 */
export function applyHardwareAccelerationPreference(): void {
  const { hardwareAcceleration } = readSystemSettings(resolveDataRoot());
  activeHardwareAcceleration = hardwareAcceleration;
  if (!hardwareAcceleration) {
    app.disableHardwareAcceleration();
    console.info("[system] hardware acceleration off (Settings → System)");
  }
}

/**
 * A dev build is `electron.exe <repo>` started by electron-vite: a login item
 * would register the bare Electron binary, and a relaunch would come back
 * without the dev server. Both only make sense for the installed app.
 */
function installedOnly(): Capability {
  return app.isPackaged
    ? { supported: true }
    : { supported: false, code: "installed-only", reason: "Available in the installed app." };
}

function loginCapability(): Capability {
  if (process.platform !== "win32" && process.platform !== "darwin") {
    return { supported: false, code: "unsupported-platform", reason: "Not supported on this system." };
  }
  return installedOnly();
}

/**
 * The Windows login item carries LOGIN_LAUNCH_ARG, so a launch at sign-in can
 * wait in the tray (presence-electron `takeStartInTray`). Windows matches a
 * login item by its exact command line, so the state is read with the same
 * arguments, and also without them for an item registered before they were
 * added; switching off removes either. A Mac ignores the arguments.
 */
const LOGIN_ITEM_ARGS = [LOGIN_LAUNCH_ARG];

function loginItemEnabled(): boolean {
  if (process.platform !== "win32") return app.getLoginItemSettings().openAtLogin;
  return app.getLoginItemSettings({ args: LOGIN_ITEM_ARGS }).openAtLogin || app.getLoginItemSettings().openAtLogin;
}

function trayCapability(): Capability {
  return traySupported(process.platform)
    ? { supported: true }
    : { supported: false, code: "unsupported-platform", reason: "Not supported on this system." };
}

/**
 * The folder in use, and a move waiting for the next launch: the folder the
 * data was copied to differs from the one this run started from.
 */
function dataFolderInfo(): DataFolderInfo {
  const choice = dataRootChoice();
  const change: Capability =
    choice.source === "env"
      ? { supported: false, code: "data-root-env", reason: "Set by FALCON_DATA_ROOT for this run." }
      : { supported: true };
  let pending: string | null = null;
  if (choice.source !== "env") {
    const chosen = readDataLocation(app.getPath("userData"));
    const stillMissing = chosen != null && choice.missing != null && samePath(chosen, choice.missing);
    const next = chosen ?? defaultDataRoot();
    if (!stillMissing && !samePath(next, choice.root)) pending = next;
  }
  return {
    path: choice.root,
    source: choice.source,
    pending,
    previous: pending ? choice.root : null,
    missing: choice.missing,
    change,
  };
}

function systemInfo(): SystemInfo {
  const login = loginCapability();
  const saved = readSystemSettings(resolveDataRoot());
  const tray = trayCapability();
  const updates: Capability = updateChecksEnabled()
    ? { supported: true }
    : { supported: false, code: "updates-installed-only", reason: "Updates are checked only in the installed app." };
  return {
    version: app.getVersion(),
    packaged: app.isPackaged,
    platform: process.platform,
    openAtLogin: { ...login, enabled: login.supported ? loginItemEnabled() : false },
    hardwareAcceleration: {
      saved: saved.hardwareAcceleration,
      active: activeHardwareAcceleration,
    },
    quickOpen: presence.quickOpen(),
    tray: { ...tray, enabled: tray.supported && saved.trayEnabled },
    keepAwake: { enabled: saved.keepAwake, active: presence.keepAwakeActive() },
    restart: installedOnly(),
    updates: { ...updates, status: getUpdateStatus(), lastCheck: getLastUpdateCheck() },
    dataRoot: resolveDataRoot(),
    dataFolder: dataFolderInfo(),
  };
}

async function storage(): Promise<SystemStorage> {
  const [data, cache] = await Promise.allSettled([
    directorySize(resolveDataRoot()),
    session.defaultSession.getCacheSize(),
  ]);
  return {
    dataBytes: data.status === "fulfilled" ? data.value : null,
    cacheBytes: cache.status === "fulfilled" ? cache.value : null,
  };
}

function failure(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

export function registerSystemHandlers(): void {
  registerIpcHandler("system:get-info", (): SystemResult<SystemInfo> => {
    try {
      return { ok: true, value: systemInfo() };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler("system:set-open-at-login", (_event, enabled: boolean): SystemResult<SystemInfo> => {
    try {
      const capability = loginCapability();
      if (!capability.supported) return { ok: false, error: capability.reason };
      app.setLoginItemSettings({ openAtLogin: enabled === true, args: LOGIN_ITEM_ARGS });
      return { ok: true, value: systemInfo() };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler("system:set-hardware-acceleration", (_event, enabled: boolean): SystemResult<SystemInfo> => {
    try {
      writeSystemSettings(resolveDataRoot(), { hardwareAcceleration: enabled === true });
      return { ok: true, value: systemInfo() };
    } catch (err) {
      return failure(err);
    }
  });

  /** Saved only once the OS has given Falcon the combination; a refusal leaves the old one in force. */
  registerIpcHandler("system:set-quick-open-shortcut", (_event, keys: unknown): QuickOpenResult => {
    try {
      const change = presence.changeShortcut(typeof keys === "string" && keys ? keys : null);
      if (!change.ok) {
        return {
          ok: false,
          problem: change.error,
          error: change.error === "taken" ? "Another app already uses this shortcut." : "This shortcut cannot be used.",
        };
      }
      writeSystemSettings(resolveDataRoot(), { quickOpenShortcut: change.state.keys });
      return { ok: true, value: systemInfo() };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler("system:set-tray", (_event, enabled: boolean): SystemResult<SystemInfo> => {
    try {
      const capability = trayCapability();
      if (enabled === true && !capability.supported) return { ok: false, error: capability.reason };
      presence.setTray(enabled === true);
      writeSystemSettings(resolveDataRoot(), { trayEnabled: enabled === true });
      return { ok: true, value: systemInfo() };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler("system:set-keep-awake", (_event, enabled: boolean): SystemResult<SystemInfo> => {
    try {
      presence.setKeepAwake(enabled === true);
      writeSystemSettings(resolveDataRoot(), { keepAwake: enabled === true });
      return { ok: true, value: systemInfo() };
    } catch (err) {
      return failure(err);
    }
  });

  /**
   * Storage folder, Change: pick a folder, copy the data folder there, check
   * the copy, and only then record it for the next launch. The folder in use
   * is only ever read, and is never deleted from here.
   */
  let moving = false;
  registerIpcHandler("system:change-data-folder", async (event): Promise<DataMoveResult> => {
    if (moving) return { ok: false, problem: "unavailable", error: "A move is already running." };
    const folder = dataFolderInfo();
    if (!folder.change.supported) return { ok: false, problem: "unavailable", error: folder.change.reason };
    moving = true;
    try {
      const owner = BrowserWindow.fromWebContents(event.sender);
      const options: Electron.OpenDialogOptions = {
        title: mt("dialog.dataFolder.title"),
        buttonLabel: mt("dialog.dataFolder.button"),
        defaultPath: path.dirname(folder.path),
        properties: ["openDirectory", "createDirectory", "promptToCreate"],
      };
      const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options);
      const chosen = picked.canceled ? undefined : picked.filePaths[0];
      if (!chosen) return { ok: true, moved: false };

      const plan = planDataMove(folder.path, chosen);
      if (!plan.ok) return { ok: false, problem: plan.problem, error: plan.problem };
      const copied = await copyDataFolder(folder.path, plan.target);
      // Back to the default is recorded as no choice at all.
      writeDataLocation(app.getPath("userData"), samePath(plan.target, defaultDataRoot()) ? null : plan.target);
      console.info(`[system] data folder copied to ${plan.target} (${copied.files} files), used from the next launch`);
      return { ok: true, moved: true, files: copied.files, info: systemInfo() };
    } catch (err) {
      if (err instanceof DataMoveError) return { ok: false, problem: err.problem, error: err.message };
      return { ok: false, problem: "copy-failed", error: err instanceof Error ? err.message : String(err) };
    } finally {
      moving = false;
    }
  });

  registerIpcHandler("system:get-storage", async (): Promise<SystemResult<SystemStorage>> => {
    try {
      return { ok: true, value: await storage() };
    } catch (err) {
      return failure(err);
    }
  });

  /**
   * Only Chromium's own caches: downloaded page assets, images, fonts and
   * compiled scripts, all fetched again on demand. The data folder — the
   * graph, the SEC research cache (slow and costly to rebuild), settings,
   * profile photos — is never touched from here.
   */
  registerIpcHandler("system:clear-cache", async (): Promise<SystemResult<SystemStorage>> => {
    try {
      await session.defaultSession.clearCache();
      await session.defaultSession.clearCodeCaches({});
      return { ok: true, value: await storage() };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler("system:show-data-folder", async (): Promise<SystemResult<string>> => {
    try {
      const root = resolveDataRoot();
      fs.mkdirSync(root, { recursive: true });
      const error = await shell.openPath(root);
      return error ? { ok: false, error } : { ok: true, value: root };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler("system:check-updates", async (): Promise<SystemResult<UpdateCheckOutcome>> => {
    try {
      const outcome = await checkForUpdatesNow();
      return outcome ? { ok: true, value: outcome } : { ok: false, error: "Updates are checked only in the installed app." };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler("system:restart", (): SystemResult<null> => {
    const capability = installedOnly();
    if (!capability.supported) return { ok: false, error: capability.reason };
    presence.markQuitting();
    app.relaunch();
    app.quit();
    return { ok: true, value: null };
  });
}
