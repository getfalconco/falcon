import React from "react";
import ReactDOM from "react-dom/client";
import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-mono/400.css";
import "./globals.css";
// The stylesheet's source, read for its dark token blocks (lib/theme-editor/tokens.ts),
// so the editor lists whatever globals.css defines today.
import globalsSource from "./globals.css?raw";
import ThemeEditor from "./components/theme-editor/ThemeEditor";
import { applyTheme } from "./lib/theme";
import { applyLanguage } from "./lib/i18n";

/**
 * Entry for the dark theme colour editor window (Settings, Developer,
 * Testing; main/developer/theme-editor-window.ts). Built beside index.html
 * (electron.vite.config.ts). The window is always drawn dark: it is the dark
 * palette being tuned, and the stylesheet's own dark, never the overrides.
 */

applyTheme("dark");
applyLanguage();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeEditor cssSource={globalsSource} />
  </React.StrictMode>,
);
