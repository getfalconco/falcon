import { customProperties, stripComments, type DarkToken } from "./tokens";

/**
 * Local overrides of the dark theme's tokens, made in the theme editor window.
 *
 * A plain map of token name to CSS value. It lives in localStorage under one
 * key, which both the editor window and the app's main window can read
 * (Electron gives every window of the app the same origin and the same
 * storage), and a write in one window fires a `storage` event in the other:
 * that event is the live channel, in Electron and between two browser tabs
 * alike (see live.ts). Nothing here is sent anywhere or kept on a server.
 *
 * The export is a CSS block ready to paste into globals.css; the import reads
 * one back. Pure, apart from the storage helpers, which take the storage as an
 * argument so a test can hand them a fake.
 */

export type ThemeOverrides = Record<string, string>;

export const OVERRIDES_KEY = "falcon.dev.themeOverrides.dark";

const NAME = /^--[A-Za-z0-9_-]+$/;

/**
 * A value safe to drop into a declaration block: no way out of the block
 * (`;`, braces), out of the style element (`<`), or into a comment. Anything
 * else is left to the browser, which ignores a value it cannot read.
 */
export function isSafeValue(value: string): boolean {
  const v = value.trim();
  return v.length > 0 && v.length <= 400 && !/[;{}<>\\]|\/\*|\*\//.test(v);
}

export function isTokenName(name: string): boolean {
  return NAME.test(name);
}

/** Only well-formed, safe entries, values trimmed. */
export function sanitizeOverrides(input: unknown): ThemeOverrides {
  const out: ThemeOverrides = {};
  if (!input || typeof input !== "object") return out;
  for (const [name, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isTokenName(name) || typeof value !== "string" || !isSafeValue(value)) continue;
    out[name] = value.trim().replace(/\s+/g, " ");
  }
  return out;
}

const normalize = (value: string) => value.trim().replace(/\s+/g, " ").toLowerCase();

/** The overrides that actually differ from the stylesheet's value; the rest are noise. */
export function diffOverrides(tokens: readonly DarkToken[], overrides: ThemeOverrides): ThemeOverrides {
  const out: ThemeOverrides = {};
  for (const token of tokens) {
    const value = overrides[token.name];
    if (value === undefined) continue;
    if (normalize(value) !== normalize(token.value)) out[token.name] = value;
  }
  return out;
}

/** What the app's main window injects: scoped to dark, and one notch stronger than globals.css. */
export function overridesCss(overrides: ThemeOverrides): string {
  const safe = sanitizeOverrides(overrides);
  const lines = Object.entries(safe).map(([name, value]) => `  ${name}: ${value};`);
  if (lines.length === 0) return "";
  return `:root[data-theme="dark"] {\n${lines.join("\n")}\n}\n`;
}

export type ExportOptions = {
  /** Every token (true) or only those that differ from the stylesheet (false). */
  all: boolean;
  /** When the block was made. */
  date: Date;
  /** The app's version, for the header. */
  appVersion: string;
};

function stamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

/**
 * The block the reader copies, shaped like the dark token block in
 * globals.css so it can be pasted over it:
 *
 *   /* Falcon dark theme colors. Exported 2026-10-15 14:32, app 0.2.0. 2 changed of 124. *\/
 *   [data-theme="dark"] {
 *     --surface-1: #151514;
 *     --text-secondary: #a09f9a;
 *   }
 */
export function exportBlock(tokens: readonly DarkToken[], overrides: ThemeOverrides, opts: ExportOptions): string {
  const changed = diffOverrides(tokens, sanitizeOverrides(overrides));
  const count = Object.keys(changed).length;
  const entries = opts.all
    ? tokens.map((t) => [t.name, changed[t.name] ?? t.value] as const)
    : tokens.filter((t) => t.name in changed).map((t) => [t.name, changed[t.name]!] as const);
  const scope = opts.all ? `All ${tokens.length} tokens, ${count} changed` : `${count} changed of ${tokens.length}`;
  const header = `/* Falcon dark theme colors. Exported ${stamp(opts.date)}, app ${opts.appVersion}. ${scope}. */`;
  const body = entries.map(([name, value]) => `  ${name}: ${value};`).join("\n");
  return `${header}\n[data-theme="dark"] {\n${body}${body ? "\n" : ""}}\n`;
}

export type ImportResult = {
  /** The overrides the block comes to: only what differs from the stylesheet. */
  overrides: ThemeOverrides;
  /** Declarations read for tokens the editor knows. */
  read: number;
  /** Declarations for names the stylesheet does not define, or with values that are not safe. */
  skipped: string[];
};

/**
 * Reads a pasted block (an export from here, or any run of `--name: value;`
 * declarations, with or without the selector around them). The result stands
 * for the whole set: a token the block does not mention is back at its
 * default, so pasting an export restores exactly what was exported.
 */
export function importBlock(tokens: readonly DarkToken[], text: string): ImportResult {
  const known = new Map(tokens.map((t) => [t.name, t]));
  const raw: ThemeOverrides = {};
  const skipped: string[] = [];
  let read = 0;
  for (const [name, value] of customProperties(stripComments(text))) {
    if (!known.has(name) || !isSafeValue(value)) {
      skipped.push(name);
      continue;
    }
    raw[name] = value;
    read += 1;
  }
  return { overrides: diffOverrides(tokens, sanitizeOverrides(raw)), read, skipped };
}

/* --- Storage ----------------------------------------------------------- */

type ReadStore = Pick<Storage, "getItem"> | null | undefined;
type WriteStore = Pick<Storage, "setItem" | "removeItem"> | null | undefined;

export function readOverrides(store: ReadStore): ThemeOverrides {
  try {
    const raw = store?.getItem(OVERRIDES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as { tokens?: unknown } | null;
    return sanitizeOverrides(parsed?.tokens);
  } catch {
    return {};
  }
}

export function writeOverrides(store: WriteStore, overrides: ThemeOverrides): void {
  try {
    const safe = sanitizeOverrides(overrides);
    if (Object.keys(safe).length === 0) store?.removeItem(OVERRIDES_KEY);
    else store?.setItem(OVERRIDES_KEY, JSON.stringify({ v: 1, tokens: safe }));
  } catch {
    /* storage is not always there; the edit still shows in this window */
  }
}
