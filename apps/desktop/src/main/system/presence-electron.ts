import path from "node:path";
import {
  app,
  globalShortcut,
  Menu,
  nativeImage,
  powerMonitor,
  powerSaveBlocker,
  Tray,
  type BrowserWindow,
} from "electron";
import { mt } from "../i18n";
import { resolveDataRoot } from "../data-root";
import { openedAtLogin, startInTray, SystemPresence } from "./presence";
import { readSystemSettings } from "./system-settings-store";

/**
 * The Electron side of system/presence.ts: the real global shortcut, tray and
 * power save blocker, and the window it brings forward. `bootstrapSystemPresence`
 * runs once the app is ready and the main window exists.
 */

type WindowAccess = {
  getWindow: () => BrowserWindow | null;
  /** Makes the main window again when there is none (a Mac keeps running with every window closed). */
  createWindow: () => void;
};

let access: WindowAccess | null = null;

/** The tray icon: the app's own (resources/icon.ico on Windows, icon.png scaled for the Mac menu bar). */
function trayImage(): Electron.NativeImage {
  const fileName = process.platform === "win32" ? "icon.ico" : "icon.png";
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../resources");
  const image = nativeImage.createFromPath(path.join(base, fileName));
  return process.platform === "darwin" ? image.resize({ width: 18, height: 18 }) : image;
}

function showWindow(): void {
  if (!access) return;
  let win = access.getWindow();
  if (!win || win.isDestroyed()) {
    access.createWindow();
    win = access.getWindow();
    if (!win) return;
  }
  if (win.isMinimized()) win.restore();
  if (!win.isVisible()) win.show();
  if (process.platform === "darwin") app.focus({ steal: true });
  win.focus();
  if (process.platform === "win32") {
    // Windows only raises a window above the app in front when it is briefly on top.
    win.setAlwaysOnTop(true);
    win.setAlwaysOnTop(false);
  }
}

function quitFromTray(): void {
  presence.markQuitting();
  app.quit();
}

function createTray(): Tray {
  const tray = new Tray(trayImage());
  tray.setToolTip("Falcon");
  // Built on every open, so the labels follow a language change.
  const menu = () =>
    Menu.buildFromTemplate([
      { label: mt("tray.open"), click: () => showWindow() },
      { type: "separator" },
      { label: mt("tray.quit"), click: () => quitFromTray() },
    ]);
  if (process.platform === "darwin") {
    tray.on("click", () => tray.popUpContextMenu(menu()));
    tray.on("right-click", () => tray.popUpContextMenu(menu()));
  } else {
    tray.on("click", () => showWindow());
    tray.on("right-click", () => tray.popUpContextMenu(menu()));
  }
  return tray;
}

export const presence = new SystemPresence({
  platform: process.platform,
  registerShortcut: (accelerator, onPress) =>
    globalShortcut.register(accelerator, onPress) && globalShortcut.isRegistered(accelerator),
  unregisterShortcut: (accelerator) => globalShortcut.unregister(accelerator),
  createTray,
  startKeepAwake: () => powerSaveBlocker.start("prevent-app-suspension"),
  stopKeepAwake: (id) => {
    if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
  },
  showWindow,
});

let firstShowAsked = false;

/**
 * Asked by the main window's ready-to-show, once per run: true when the OS
 * started Falcon at login and the tray is up, so the window waits there
 * (shown from the tray, the quick open shortcut or a second launch) instead
 * of opening over whatever the reader signed in to do. Every later window
 * shows as usual.
 */
export function takeStartInTray(): boolean {
  if (firstShowAsked) return false;
  firstShowAsked = true;
  const atLogin = openedAtLogin(process.platform, process.argv, () => app.getLoginItemSettings().wasOpenedAtLogin);
  const hidden = startInTray(atLogin, presence.trayActive());
  if (atLogin) console.info(`[system] opened at login${hidden ? ", waiting in the tray" : ""}`);
  return hidden;
}

/** True once bootstrap has run: the shortcut can only be registered when the app is ready. */
export function presenceReady(): boolean {
  return access != null;
}

/** Closing the main window hides it while the tray is up; any other close goes ahead. */
function watchWindow(win: BrowserWindow): void {
  win.on("close", (event) => {
    if (win !== access?.getWindow() || !presence.hideOnClose()) return;
    event.preventDefault();
    win.hide();
  });
  // Windows signing out or shutting down: let the window close so it does not hold the session up.
  win.on("session-end", () => presence.markQuitting());
}

export function bootstrapSystemPresence(windows: WindowAccess): void {
  access = windows;
  const settings = readSystemSettings(resolveDataRoot());
  const shortcut = presence.loadShortcut(settings.quickOpenShortcut);
  if (shortcut.error) console.warn(`[system] quick open shortcut ${settings.quickOpenShortcut} not registered: ${shortcut.error}`);
  presence.setTray(settings.trayEnabled);
  presence.setKeepAwake(settings.keepAwake);

  const current = windows.getWindow();
  if (current) watchWindow(current);
  app.on("browser-window-created", (_event, win) => watchWindow(win));

  // A Mac's dock icon, and a second launch of an installed Falcon, bring the window back.
  app.on("activate", () => {
    const win = windows.getWindow();
    if (win && !win.isDestroyed() && !win.isVisible()) showWindow();
  });
  app.on("second-instance", () => showWindow());

  app.on("before-quit", () => presence.markQuitting());
  powerMonitor.on("shutdown", () => presence.markQuitting());
  app.on("will-quit", () => presence.dispose());
}
