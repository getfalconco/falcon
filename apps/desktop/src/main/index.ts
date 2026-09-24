import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import { registerIpcHandler } from "./ipc-register";
import { registerOnboardingHandlers } from "./onboarding/register-onboarding-handlers";
import { ensureBrokerLinksSchema } from "./db/ensure-broker-links-schema";
import { ensureTrackerUniverseSchema } from "./db/ensure-tracker-universe-schema";
import { setRendererSession } from "./session-bridge";
import { configureDataPaths, seedDataRoot } from "./data-root";
import { loadDesktopEnv } from "./load-desktop-env";
import { configureProviderRouting } from "./provider-routing";
import { registerStep1ResearchHandlers } from "./research/register-step1-handlers";
import { registerGraphHandlers } from "./research/register-graph-handlers";
import { registerGlossHandlers } from "./gloss/register-gloss-handlers";
import { registerInsightHandlers } from "./insight/register-insight-handlers";
import { bootstrapNewsEvents, registerEventHandlers } from "./events/register-event-handlers";
import { registerBaseHandlers } from "./base/register-base-handlers";
import {
  bootstrapClassifier,
  registerClassifierHandlers,
} from "./classifier/register-classifier-handlers";
import { bootstrapTracker, registerTrackerHandlers } from "./tracker/register-tracker-handlers";
import { engineHealth, engineRemote, engineUrl } from "./engine/engine-client";
import { registerPortfolioHandlers } from "./portfolio/register-portfolio-handlers";
import { bootstrapAnalyst, registerAnalystHandlers } from "./analyst/register-analyst-handlers";
import {
  bootstrapPropagation,
  registerPropagationRunHandlers,
} from "./propagation/register-propagation-run-handlers";
import { bootstrapRisk, registerRiskHandlers } from "./risk/register-risk-handlers";
import { registerBriefingHandlers } from "./briefing/register-briefing-handlers";
import { registerGaugeHandlers } from "./gauge/register-gauge-handlers";
import { bootstrapScreen, registerScreenHandlers } from "./screen/register-screen-handlers";
import { bootstrapQuantLab, registerQuantLabHandlers } from "./quantlab/register-quantlab-handlers";
import { registerStockHandlers } from "./stock/register-stock-handlers";
import { registerWaitlistHandlers } from "./waitlist/register-waitlist-handlers";
import { registerSnaptradeHandlers } from "./snaptrade/register-snaptrade-handlers";
import { registerUpdateHandlers, startUpdateService } from "./update/update-service";
import { registerDiagnosticsHandlers } from "./diagnostics/register-diagnostics-handlers";
import { animateWindowToWorkspace } from "./window-animation";

// Tell the env loader (electron-free) that this is a packaged build, so it
// reads no .env files — see load-desktop-env.ts.
if (app.isPackaged) process.env.FALCON_PACKAGED = "1";
loadDesktopEnv(true);

// Packaged builds keep user data under the product name, not the package name
// ("desktop"), and never share a dir with a dev instance. Must precede the
// first getPath("userData") call anywhere.
if (app.isPackaged) {
  app.setName("Falcon");
  // FALCON_USER_DATA_DIR: run a packaged build against a throwaway profile
  // (support / verification) without disturbing the real one.
  const userDataOverride = process.env.FALCON_USER_DATA_DIR?.trim();
  app.setPath("userData", userDataOverride || path.join(app.getPath("appData"), "Falcon"));
}

// Must run before any handler registers: engines resolve their data dirs from
// these env vars, and a packaged build has no repo to fall back on.
seedDataRoot(configureDataPaths());

// Packaged builds carry no provider keys: Anthropic + Finnhub go through the
// research-worker with the user's own session (see provider-routing.ts).
configureProviderRouting();

// Classic scrollbars so ::-webkit-scrollbar CSS styling applies on Windows.
if (process.platform === "win32") {
  app.commandLine.appendSwitch(
    "disable-features",
    "OverlayScrollbar,WindowsOverlayScrollbars,FluentOverlayScrollbar",
  );
}

registerStockHandlers();
registerStep1ResearchHandlers();
registerGraphHandlers();
registerEventHandlers();
registerSnaptradeHandlers();
registerOnboardingHandlers();
registerWaitlistHandlers();
registerTrackerHandlers();
registerPortfolioHandlers();
registerBaseHandlers();
registerClassifierHandlers();
registerAnalystHandlers();
registerPropagationRunHandlers();
registerGlossHandlers();
registerInsightHandlers();
registerRiskHandlers();
registerBriefingHandlers();
registerGaugeHandlers();
registerScreenHandlers();
registerQuantLabHandlers();
registerDiagnosticsHandlers();

// Renderer → main session bridge: the public anon key + the user's own JWT,
// so main can act on the user's behalf without ever holding a privileged key.
registerIpcHandler(
  "auth:session",
  (
    _event,
    payload: { supabaseUrl?: string | null; anonKey?: string | null; accessToken?: string | null },
  ) => {
    const session = setRendererSession(payload ?? {});
    return { ok: true as const, hasToken: session.accessToken != null };
  },
);

let mainWindow: BrowserWindow | null = null;

/** App icon for taskbar / dock / Windows shortcut (resources/icon.ico|png). */
function resolveAppIcon(): string {
  const fileName = process.platform === "win32" ? "icon.ico" : "icon.png";
  const base = app.isPackaged ? process.resourcesPath : path.join(__dirname, "../../resources");
  return path.join(base, fileName);
}

function createWindow(): void {
  const icon = resolveAppIcon();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 680,
    minWidth: 1200,
    minHeight: 680,
    show: false,
    frame: false,
    // Opaque window: Chromium's backdrop-filter (frosted-glass blur) is
    // broken inside transparent windows, and Win11's DWM already rounds
    // frameless windows natively — so transparency costs blur for nothing.
    transparent: false,
    hasShadow: true,
    resizable: false,
    title: "Falcon",
    icon,
    backgroundColor: "#EAEAE6",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    if (!mainWindow) return;
    mainWindow.center();
    mainWindow.show();
    mainWindow.focus();
    if (process.platform === "win32") {
      mainWindow.setAlwaysOnTop(true);
      mainWindow.setAlwaysOnTop(false);
    }
  });

  mainWindow.on("close", () => console.info("[app] main window closing"));
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.webContents.on("render-process-gone", (_event, details) => {
    console.error("[app] renderer gone:", details.reason, details.exitCode);
  });
  mainWindow.webContents.on("unresponsive", () => console.warn("[app] renderer unresponsive"));

  // The window must only ever display the bundled renderer. Any popup or
  // navigation that escaped it would run a remote page with the preload
  // bridge (the whole `meridian` IPC surface) attached. External links are
  // handed to the OS browser instead, and only when they are http(s).
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL;
    const allowed = devServer ? url.startsWith(devServer) : url.startsWith("file:");
    if (!allowed) event.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
}

app.whenReady().then(async () => {
  if (process.platform === "win32") {
    app.setAppUserModelId("com.falcon.desktop");
  }
  if (process.platform === "darwin") {
    app.dock?.setIcon(resolveAppIcon());
  }

  await ensureBrokerLinksSchema();
  // Server-side tracker universe (dev machines create the table via
  // DATABASE_URL; packaged installs rely on it already existing).
  await ensureTrackerUniverseSchema();

  // The deterministic chain — Tracker, Classifier, Base, Propagation — runs on
  // the always-on engine service when one is configured. Starting it here too
  // would double the Finnhub quota and the Anthropic budget, and produce a
  // second message stream that drifts from the server’s: the same event would
  // end up with two incident ids and two runs. So the app either owns the
  // chain or reads it, never both.
  if (engineRemote()) {
    const health = await engineHealth();
    if (health.ok) {
      console.info(
        `[engine] remote at ${engineUrl()} — v${health.value.version}, ` +
          `${health.value.tracker} tickers, ${health.value.propagation_runs} runs, ` +
          `loop ${health.value.loop ? "on" : "off"}.`,
      );
    } else {
      // Deliberately not a fallback. Starting the chain here would double the
      // Finnhub quota and the Anthropic spend, and give the same event two
      // incident ids in two divergent streams — and this install keeps no
      // history to run one from, so it would re-learn the world at full cost
      // just to answer panels that are about to read the server again. The
      // panels surface the outage instead.
      console.error(
        `[engine] ${engineUrl()} unreachable (${health.error}) — panels will show ` +
          "the error. Nothing is analysed or tracked locally.",
      );
    }
  } else if (process.env.FALCON_LOCAL_CHAIN?.trim() !== "1") {
    // No service configured and no explicit opt-in. Running the chain here is
    // not free to everyone else: it polls the SAME shared Finnhub free tier the
    // production engine depends on, and a single boot spent 112 rate-limited
    // requests in two minutes — every one of them a request the always-on
    // service then could not make. It also gives one event two incident ids in
    // two divergent streams.
    //
    // So opening the app on a dev machine no longer starts a competing chain by
    // accident. Set FALCON_ENGINE_URL to read the service (what you almost
    // always want), or FALCON_LOCAL_CHAIN=1 to deliberately own the chain here.
    console.warn(
      "[engine] no FALCON_ENGINE_URL — the chain is NOT running. Set FALCON_ENGINE_URL " +
        "to point at the service, or FALCON_LOCAL_CHAIN=1 to run it locally (this spends " +
        "the shared Finnhub and Anthropic quotas the production engine relies on).",
    );
  } else {
    // Deliberately opted in: this process owns the whole chain, exactly as it
    // did before the split.
    console.info("[engine] FALCON_LOCAL_CHAIN=1 — running the chain in-process.");
    bootstrapNewsEvents();
    bootstrapTracker();
    bootstrapClassifier();
    bootstrapPropagation();
    // Risk, Analyst and Screen all read the Tracker, so they belong to
    // whichever process is polling it. Started here against a server-owned
    // chain they would work off this machine's stale state and write results
    // nobody reads, while the panels answer from the service.
    bootstrapRisk();
    bootstrapAnalyst();
    bootstrapScreen();
  }
  // Local either way: a developer surface, on demand, no provider calls.
  bootstrapQuantLab();

  ipcMain.handle("open-external", (_event, url: string) => {
    // The renderer forwards URLs straight from backend data (news items, event
    // and signal source links). The main process is the security boundary, so
    // enforce the scheme here: a poisoned row must not be able to launch
    // file:, smb:, or arbitrary app-scheme handlers on the user's machine.
    const value = typeof url === "string" ? url.trim() : "";
    if (!/^https?:\/\//i.test(value)) return Promise.resolve();
    return shell.openExternal(value);
  });

  ipcMain.handle("window-minimize", () => {
    mainWindow?.minimize();
  });

  ipcMain.handle("window-close", () => {
    console.info("[app] window-close requested by renderer");
    mainWindow?.close();
  });

  ipcMain.handle("window-toggle-maximize", () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });

  ipcMain.handle("window-enter-workspace", () => {
    if (!mainWindow) return;
    return animateWindowToWorkspace(mainWindow);
  });

  registerUpdateHandlers();
  createWindow();
  startUpdateService(() => mainWindow);

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  console.info("[app] window-all-closed");
  if (process.platform !== "darwin") {
    app.quit();
  }
});

// Lifecycle diagnostics. A packaged build has no devtools open, so when it
// stops, the log is all there is. An unhandled rejection in an engine loop must
// not take the whole app down: log it and keep going.
app.on("before-quit", () => console.info("[app] before-quit"));
app.on("child-process-gone", (_event, details) => {
  console.warn("[app] child process gone:", details.type, details.reason, details.exitCode ?? "");
});
process.on("unhandledRejection", (reason) => {
  console.error("[app] unhandled rejection:", reason instanceof Error ? reason.stack ?? reason.message : reason);
});
process.on("uncaughtException", (err) => {
  console.error("[app] uncaught exception:", err.stack ?? err.message);
});

