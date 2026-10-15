import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { resolveDataRoot } from "./data-root";
import { registerIpcHandler } from "./ipc-register";
import { getMainLanguage, isMainLanguage, resolveMainLanguage, setMainLanguage, setMainLanguageFallback } from "./i18n";

/**
 * Keeps the reader's language for the main process (see i18n.ts): read from
 * `<data root>/ui-language.json` at startup, so a notification that fires
 * before the window has loaded reads in the last language chosen, and
 * replaced whenever the renderer sends `i18n:set-language` (on startup and on
 * every change in Settings).
 */

const FILE = "ui-language.json";

function filePath(): string {
  return path.join(resolveDataRoot(), FILE);
}

function readKept(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath(), "utf8")) as { language?: unknown };
    setMainLanguage(raw.language);
  } catch {
    /* nothing kept yet, or unreadable: the machine's language stands in */
  }
}

function keep(language: string): void {
  try {
    fs.mkdirSync(path.dirname(filePath()), { recursive: true });
    fs.writeFileSync(filePath(), `${JSON.stringify({ language }, null, 2)}\n`, "utf8");
  } catch (err) {
    console.warn("[i18n] could not keep the language:", err instanceof Error ? err.message : err);
  }
}

/** The machine's languages, once Electron can say (after `ready`). */
function machineLanguage() {
  if (!app.isReady()) return null;
  const tags = typeof app.getPreferredSystemLanguages === "function" ? app.getPreferredSystemLanguages() : [];
  return resolveMainLanguage([...tags, app.getLocale()]);
}

export function registerI18nHandlers(): void {
  setMainLanguageFallback(machineLanguage);
  readKept();
  registerIpcHandler("i18n:set-language", (_event, code: unknown): { ok: boolean } => {
    if (!isMainLanguage(code)) return { ok: false };
    const changed = getMainLanguage() !== code;
    setMainLanguage(code);
    if (changed || !fs.existsSync(filePath())) keep(code);
    return { ok: true };
  });
}
