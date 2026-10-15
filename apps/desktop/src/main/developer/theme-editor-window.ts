import { BrowserWindow, screen, shell } from "electron";
import path from "node:path";
import { registerIpcHandler } from "../ipc-register";
import { mt } from "../i18n";

/**
 * Settings, Developer, Testing, "Dark theme colors": a small window of its own
 * where every dark token can be tuned while the app shows the result.
 *
 * Main only opens it (one at a time; a second click focuses the open one) and
 * pins it on top. The colours never pass through here: the editor writes them
 * to localStorage, which the app window shares with it (same origin, same
 * session), and the app window applies them on the `storage` event (see
 * renderer/lib/theme-editor/live.ts). The page is its own renderer entry,
 * `theme-editor.html`, built beside `index.html` (electron.vite.config.ts).
 *
 *   developer:open-theme-editor   open or focus the editor
 *   developer:theme-editor-on-top keep the asking window above others, or not
 */

let editor: BrowserWindow | null = null;

function loadEditor(win: BrowserWindow): void {
  const devServer = process.env.ELECTRON_RENDERER_URL;
  if (devServer) void win.loadURL(`${devServer.replace(/\/$/, "")}/theme-editor.html`);
  else void win.loadFile(path.join(__dirname, "../renderer/theme-editor.html"));
}

export function openThemeEditor(opener: BrowserWindow | null): void {
  if (editor && !editor.isDestroyed()) {
    if (editor.isMinimized()) editor.restore();
    editor.show();
    editor.focus();
    return;
  }
  const win = new BrowserWindow({
    width: 420,
    height: 720,
    minWidth: 360,
    minHeight: 420,
    show: false,
    resizable: true,
    title: mt("window.themeEditor.title"),
    // The editor is drawn dark (it is the dark palette being edited).
    backgroundColor: "#0b0b0a",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  editor = win;
  win.removeMenu();
  // Keep the translated title rather than the page's <title>.
  win.on("page-title-updated", (event) => event.preventDefault());
  win.once("ready-to-show", () => {
    if (opener && !opener.isDestroyed()) {
      // Beside the app window when the screen has room, so neither covers the other;
      // otherwise over its right edge.
      const app = opener.getBounds();
      const area = screen.getDisplayMatching(app).workArea;
      const own = win.getBounds();
      const gap = 12;
      let x = app.x + app.width - own.width - 24;
      if (app.x + app.width + gap + own.width <= area.x + area.width) x = app.x + app.width + gap;
      else if (app.x - gap - own.width >= area.x) x = app.x - gap - own.width;
      const y = Math.min(Math.max(area.y, app.y), area.y + Math.max(0, area.height - own.height));
      win.setPosition(Math.round(x), Math.round(y));
    }
    win.show();
  });
  win.on("closed", () => {
    if (editor === win) editor = null;
  });

  // Same rule as the app window: only the bundled renderer, never a remote page with the bridge.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (event, url) => {
    const devServer = process.env.ELECTRON_RENDERER_URL;
    const allowed = devServer ? url.startsWith(devServer) : url.startsWith("file:");
    if (!allowed) event.preventDefault();
  });

  // The editor belongs to the app window that opened it.
  if (opener && !opener.isDestroyed()) {
    opener.once("closed", () => {
      if (!win.isDestroyed()) win.close();
    });
  }

  loadEditor(win);
}

export function registerThemeEditorHandlers(): void {
  registerIpcHandler("developer:open-theme-editor", (event) => {
    const opener = event ? BrowserWindow.fromWebContents(event.sender) : null;
    openThemeEditor(opener);
    return { ok: true as const };
  });

  registerIpcHandler("developer:theme-editor-on-top", (event, on: unknown) => {
    const win = event ? BrowserWindow.fromWebContents(event.sender) : null;
    // Only the editor may pin itself; the app window keeps its own rules.
    if (!win || win !== editor) return { ok: false as const };
    win.setAlwaysOnTop(on === true, "floating");
    return { ok: true as const, onTop: win.isAlwaysOnTop() };
  });
}
