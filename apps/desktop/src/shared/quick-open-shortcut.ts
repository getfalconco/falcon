/**
 * The quick open shortcut: one key combination, registered with the OS
 * (Electron `globalShortcut`), that brings the Falcon window forward from any
 * app. Kept as the same short string the in-app shortcuts use ("Mod+Shift+F",
 * where Mod is Ctrl on Windows and Linux and Command on a Mac) and turned into
 * an Electron accelerator only when it is registered.
 *
 * A global shortcut is taken from every other app on the machine while
 * Falcon runs, so the rules are stricter than the in-app ones: it has to hold
 * Ctrl/Command or Alt (Shift alone would swallow capital letters everywhere),
 * and the presses every app relies on (copy, paste, save, close, switch
 * window) are refused.
 *
 * Pure: the renderer checks with it before saving, main checks again before
 * registering.
 */

export type GlobalCombo = { mod: boolean; alt: boolean; shift: boolean; key: string };

/** Why a combination cannot be the quick open shortcut, as a code the pane words. */
export type GlobalShortcutProblem = "unusable" | "needs-modifier" | "reserved";

export type GlobalShortcutCheck = { ok: true; keys: string } | { ok: false; problem: GlobalShortcutProblem };

/** Keys an accelerator can name, in the canonical form of renderer/lib/shortcuts.ts. */
const ACCELERATOR_KEYS: Readonly<Record<string, string>> = {
  "/": "/",
  "\\": "\\",
  ",": ",",
  ".": ".",
  ";": ";",
  "'": "'",
  "[": "[",
  "]": "]",
  "-": "-",
  "=": "=",
  "`": "`",
  "+": "Plus",
  Space: "Space",
  Enter: "Enter",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "Up",
  ArrowDown: "Down",
  ArrowLeft: "Left",
  ArrowRight: "Right",
};

function acceleratorKey(key: string): string | null {
  if (/^[A-Z0-9]$/.test(key)) return key;
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(key)) return key;
  return ACCELERATOR_KEYS[key] ?? null;
}

/** "Mod+Shift+K" → combo; null for anything that is not one key plus modifiers. */
export function parseGlobalCombo(text: unknown): GlobalCombo | null {
  if (typeof text !== "string" || !text) return null;
  let parts = text.split("+");
  if (text.endsWith("+")) {
    if (parts.length < 2 || parts[parts.length - 2] !== "") return null;
    parts = [...parts.slice(0, -2), "+"];
  }
  const combo: GlobalCombo = { mod: false, alt: false, shift: false, key: "" };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]!;
    if (!part) return null;
    if (i < parts.length - 1) {
      if (part === "Mod") combo.mod = true;
      else if (part === "Alt") combo.alt = true;
      else if (part === "Shift") combo.shift = true;
      else return null;
      continue;
    }
    if (part === "Mod" || part === "Alt" || part === "Shift") return null;
    combo.key = part.length === 1 ? part.toUpperCase() : part;
  }
  return combo.key && acceleratorKey(combo.key) ? combo : null;
}

export function globalComboToString(combo: GlobalCombo): string {
  return [combo.mod && "Mod", combo.alt && "Alt", combo.shift && "Shift", combo.key].filter(Boolean).join("+");
}

/**
 * What every app on the machine answers to. Taking one of these system wide
 * would break it in every other window while Falcon runs.
 */
const RESERVED_GLOBAL: readonly string[] = [
  "Mod+C",
  "Mod+V",
  "Mod+X",
  "Mod+A",
  "Mod+Z",
  "Mod+Shift+Z",
  "Mod+Y",
  "Mod+S",
  "Mod+F",
  "Mod+P",
  "Mod+N",
  "Mod+O",
  "Mod+T",
  "Mod+W",
  "Mod+Q",
  "Mod+R",
  "Mod+Tab",
  "Mod+Shift+Tab",
  "Alt+Tab",
  "Alt+Shift+Tab",
  "Alt+F4",
  "Mod+Space",
  "Mod+Backspace",
  "Mod+Delete",
  "Mod+Alt+Delete",
  "Mod+Enter",
  "Alt+Enter",
  "Alt+Space",
];

export function checkGlobalShortcut(keys: unknown): GlobalShortcutCheck {
  const combo = parseGlobalCombo(keys);
  if (!combo) return { ok: false, problem: "unusable" };
  if (!combo.mod && !combo.alt) return { ok: false, problem: "needs-modifier" };
  const normal = globalComboToString(combo);
  if (RESERVED_GLOBAL.includes(normal)) return { ok: false, problem: "reserved" };
  return { ok: true, keys: normal };
}

/** The Electron accelerator for a stored combination: "Mod+Shift+K" → "CommandOrControl+Shift+K". */
export function toAccelerator(keys: unknown): string | null {
  const combo = parseGlobalCombo(keys);
  if (!combo) return null;
  const key = acceleratorKey(combo.key);
  if (!key) return null;
  return [combo.mod && "CommandOrControl", combo.alt && "Alt", combo.shift && "Shift", key].filter(Boolean).join("+");
}
