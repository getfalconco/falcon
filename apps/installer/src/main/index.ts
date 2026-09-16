import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import type { InstallProgress } from "../shared/install-types";
import { installedFalconPath, launchFalcon, runInstall } from "./installer-flow";

/**
 * The installer is a fixed-size card, not a resizable app window: same
 * frameless/transparent chrome as the desktop app so the two read as one
 * product, just smaller.
 */
const WINDOW_WIDTH = 560;
const WINDOW_HEIGHT = 560;

let installerWindow: BrowserWindow | null = null;

const INSTALL_PROGRESS_CHANNEL = "install:progress";
let currentProgress: InstallProgress = { phase: "idle", value: null, label: "" };

/** Taskbar / dock / shortcut icon (resources/icon.ico|png). */
function resolveAppIcon(): string {
  const fileName = process.platform === "win32" ? "icon.ico" : "icon.png";
  return path.join(__dirname, "../../resources", fileName);
}

function createWindow(): void {
  installerWindow = new BrowserWindow({
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    minWidth: WINDOW_WIDTH,
    minHeight: WINDOW_HEIGHT,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: true,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "Falcon Installer",
    icon: resolveAppIcon(),
    backgroundColor: "#00000000",
    // macOS keeps its native traffic lights, inset to clear the header row.
    // Windows and Linux get the in-app controls instead (see WindowControls).
    ...(process.platform === "darwin"
      ? {
          titleBarStyle: "hiddenInset" as const,
          trafficLightPosition: { x: 18, y: 16 },
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  installerWindow.on("ready-to-show", () => {
    if (!installerWindow) return;
    installerWindow.center();
    installerWindow.show();
    installerWindow.focus();
  });

  installerWindow.on("closed", () => {
    installerWindow = null;
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    installerWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    installerWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(() => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.falcon.installer");
  }
  if (process.platform === "darwin") {
    app.dock?.setIcon(resolveAppIcon());
  }

  ipcMain.handle("window-minimize", () => {
    installerWindow?.minimize();
  });

  ipcMain.handle("window-close", () => {
    installerWindow?.close();
  });

  // The renderer drives nothing: it asks for the run to start, then follows
  // whatever the flow reports.
  ipcMain.handle("install:start", () => {
    void runInstall((progress) => {
      currentProgress = progress;
      const win = installerWindow;
      if (win && !win.isDestroyed()) win.webContents.send(INSTALL_PROGRESS_CHANNEL, progress);
    });
    return { ok: true as const };
  });

  ipcMain.handle("install:get-progress", () => currentProgress);

  ipcMain.handle("install:launch", () => {
    const launched = launchFalcon();
    if (launched) setTimeout(() => app.quit(), 400);
    return { ok: launched, path: installedFalconPath() };
  });

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
