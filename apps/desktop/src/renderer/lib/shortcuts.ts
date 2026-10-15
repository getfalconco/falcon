/**
 * Every keyboard shortcut the app answers to, in one list.
 *
 * Two kinds live here. App-wide shortcuts (open a panel, open search) are
 * listened for by `useShortcut` and read their keys from this module at the
 * moment of the press, so a reader can move them in Settings → Shortcuts and
 * the handler follows without remounting. Contextual keys (Esc closes what is
 * open, arrows walk a list, Enter picks) belong to whatever has focus and are
 * listed read-only: they are the same everywhere, and moving one would break
 * the thing it lives in.
 *
 * A binding is kept as a short string ("Shift+T", "Mod+K"). "Mod" is Ctrl on
 * Windows and Linux and ⌘ on a Mac — the press accepts either, as the
 * handlers always have. Letters and digits are matched on the physical key
 * (`code`) with the typed character as a fallback, so a binding survives a
 * keyboard layout change and still works for synthetic input.
 *
 * Only the reader's changes are stored (`falcon.ui.shortcuts.v1`); a binding
 * the reader never touched follows the default if a later build changes it.
 *
 * Nothing here imports React, so the rules can be tested under plain Node;
 * the hooks are in `use-shortcuts.ts`.
 */

/** A key and the modifiers held with it. `key` is canonical — see `keyFromCode`. */
export type KeyCombo = {
  mod: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
};

export type ShortcutGroup = "Navigation" | "Panels" | "Presentation" | "In context";

export type ShortcutId =
  | "search"
  | "open-shortcuts"
  | "graph"
  | "briefing"
  | "demo-mode"
  | "tracker"
  | "base"
  | "analyst"
  | "propagation"
  | "risk"
  | "screen"
  | "gauge"
  | "quantlab"
  | "diagnostics";

export type ContextualShortcutId =
  | "close"
  | "results-move"
  | "results-open"
  | "table-copy"
  | "table-edit"
  | "table-extend"
  | "agents-new"
  | "calendar-today"
  | "calendar-step"
  | "calendar-views";

/*
 * Labels, descriptions, groups and refusal reasons here are English: they are
 * the words tests and logs read. The Shortcuts pane shows them translated, by
 * the shortcut's id, the group's name and the refusal's `problem`.
 */

export type ShortcutDef = {
  id: ShortcutId;
  label: string;
  /** One line under the label, when the label is not enough. */
  description?: string;
  group: ShortcutGroup;
  defaultKeys: string;
};

/** A key that belongs to whatever has focus. Shown, never moved. */
export type ContextualShortcut = {
  id: ContextualShortcutId;
  label: string;
  /** Each entry is one way to press it ("Escape", "ArrowUp"). */
  keys: string[];
  /** Shown in place of a key name, for a press that is half mouse. */
  display?: string;
  group: "In context";
};

/** Rebindable, app-wide. Defaults must be unique — the tests hold that. */
export const SHORTCUTS: readonly ShortcutDef[] = [
  { id: "search", label: "Search anything", description: "Opens at the pointer.", group: "Navigation", defaultKeys: "Mod+K" },
  { id: "open-shortcuts", label: "Open keyboard shortcuts", description: "This page.", group: "Navigation", defaultKeys: "Mod+/" },
  { id: "graph", label: "Relationship graph", description: "Press again to go back to the dashboard.", group: "Navigation", defaultKeys: "Shift+G" },
  { id: "briefing", label: "Morning briefing", group: "Navigation", defaultKeys: "Shift+M" },
  { id: "tracker", label: "Tracker panel", group: "Panels", defaultKeys: "Shift+T" },
  { id: "base", label: "Base panel", description: "Opens on incidents.", group: "Panels", defaultKeys: "Shift+B" },
  { id: "analyst", label: "Analyst", description: "The Base panel, on the analyst tab.", group: "Panels", defaultKeys: "Shift+A" },
  { id: "propagation", label: "Propagation", group: "Panels", defaultKeys: "Shift+P" },
  { id: "risk", label: "Risk panel", group: "Panels", defaultKeys: "Shift+R" },
  { id: "screen", label: "Screen panel", group: "Panels", defaultKeys: "Shift+S" },
  { id: "gauge", label: "Gauge panel", group: "Panels", defaultKeys: "Shift+F" },
  { id: "quantlab", label: "Quant Lab", group: "Panels", defaultKeys: "Shift+Q" },
  { id: "diagnostics", label: "Diagnostics", group: "Panels", defaultKeys: "Shift+H" },
  {
    id: "demo-mode",
    label: "Demo mode",
    description: "A made-up portfolio for presenting. Press again for the real one.",
    group: "Presentation",
    defaultKeys: "Mod+P",
  },
];

/** What the app does with keys it does not let a reader move. */
export const CONTEXTUAL_SHORTCUTS: readonly ContextualShortcut[] = [
  { id: "close", label: "Close the open dialog, panel or menu", keys: ["Escape"], group: "In context" },
  { id: "results-move", label: "Move through search results", keys: ["ArrowUp", "ArrowDown"], group: "In context" },
  { id: "results-open", label: "Open the selected result, or the ticker typed", keys: ["Enter"], group: "In context" },
  { id: "table-copy", label: "Copy the selected cells in a data table", keys: ["Mod+C"], group: "In context" },
  { id: "table-edit", label: "Save or cancel a cell edit", keys: ["Enter", "Escape"], group: "In context" },
  { id: "table-extend", label: "Extend a table selection", keys: [], display: "Shift + click", group: "In context" },
  { id: "agents-new", label: "New agent, on the Agents tab", keys: ["N"], group: "In context" },
  { id: "calendar-today", label: "Go to today, on the Calendar tab", keys: ["T"], group: "In context" },
  { id: "calendar-step", label: "Previous or next day, week or month, on the Calendar tab", keys: ["ArrowLeft", "ArrowRight"], group: "In context" },
  { id: "calendar-views", label: "Day, week or month view, on the Calendar tab", keys: ["D", "W", "M"], group: "In context" },
];

/**
 * Presses a binding may not take, with what they already do. Contextual keys
 * first, then what Electron's default window menu answers to.
 */
/** What a reserved press already does, by a stable id the pane words in the reader's language. */
export type ReservedUse =
  | "close"
  | "pick"
  | "focus"
  | "lists"
  | "caret"
  | "select-text"
  | "copy"
  | "paste"
  | "cut"
  | "select-all"
  | "undo"
  | "redo"
  | "reload"
  | "devtools"
  | "close-window"
  | "quit"
  | "minimize"
  | "zoom-reset"
  | "zoom-in"
  | "zoom-out"
  | "full-screen";

const RESERVED_WHAT: Readonly<Record<ReservedUse, string>> = {
  close: "closing what is open",
  pick: "picking the selected item",
  focus: "moving focus",
  lists: "moving through lists",
  caret: "moving the caret",
  "select-text": "selecting text",
  copy: "copy",
  paste: "paste",
  cut: "cut",
  "select-all": "select all",
  undo: "undo",
  redo: "redo",
  reload: "reloading the window",
  devtools: "the developer tools",
  "close-window": "closing the window",
  quit: "quitting the app",
  minimize: "minimizing the window",
  "zoom-reset": "resetting the zoom",
  "zoom-in": "zooming in",
  "zoom-out": "zooming out",
  "full-screen": "full screen",
};

const RESERVED: ReadonlyArray<{ keys: string; use: ReservedUse }> = [
  { keys: "Escape", use: "close" },
  { keys: "Enter", use: "pick" },
  { keys: "Tab", use: "focus" },
  { keys: "Shift+Tab", use: "focus" },
  { keys: "ArrowUp", use: "lists" },
  { keys: "ArrowDown", use: "lists" },
  { keys: "ArrowLeft", use: "caret" },
  { keys: "ArrowRight", use: "caret" },
  { keys: "Shift+ArrowUp", use: "select-text" },
  { keys: "Shift+ArrowDown", use: "select-text" },
  { keys: "Shift+ArrowLeft", use: "select-text" },
  { keys: "Shift+ArrowRight", use: "select-text" },
  { keys: "Mod+C", use: "copy" },
  { keys: "Mod+V", use: "paste" },
  { keys: "Mod+X", use: "cut" },
  { keys: "Mod+A", use: "select-all" },
  { keys: "Mod+Z", use: "undo" },
  { keys: "Mod+Shift+Z", use: "redo" },
  { keys: "Mod+Y", use: "redo" },
  { keys: "Mod+R", use: "reload" },
  { keys: "Mod+Shift+R", use: "reload" },
  { keys: "Mod+Shift+I", use: "devtools" },
  { keys: "Mod+W", use: "close-window" },
  { keys: "Mod+Q", use: "quit" },
  { keys: "Mod+M", use: "minimize" },
  { keys: "Mod+0", use: "zoom-reset" },
  { keys: "Mod+=", use: "zoom-in" },
  { keys: "Mod+Shift+=", use: "zoom-in" },
  { keys: "Mod+-", use: "zoom-out" },
  { keys: "F11", use: "full-screen" },
];

// ---------------------------------------------------------------------------
// Parsing and printing
// ---------------------------------------------------------------------------

const CODE_KEYS: Record<string, string> = {
  Slash: "/",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Semicolon: ";",
  Quote: "'",
  BracketLeft: "[",
  BracketRight: "]",
  Minus: "-",
  Equal: "=",
  Backquote: "`",
  Space: "Space",
  Enter: "Enter",
  NumpadEnter: "Enter",
  Escape: "Escape",
  Tab: "Tab",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowLeft: "ArrowLeft",
  ArrowRight: "ArrowRight",
};

const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta", "AltGraph", "CapsLock", "OS", "Fn"]);

/** The canonical key for a physical key, or null for one with no name here. */
export function keyFromCode(code: string): string | null {
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  return CODE_KEYS[code] ?? null;
}

/** The canonical key for a typed character (`KeyboardEvent.key`). */
export function keyFromKey(key: string): string | null {
  if (!key || MODIFIER_KEYS.has(key)) return null;
  if (key === " ") return "Space";
  if (key === "Esc") return "Escape";
  if (key.length === 1) return key.toUpperCase();
  return key;
}

/** "Mod+Shift+K" → combo. Null for anything that is not one key plus modifiers. */
export function parseCombo(text: string): KeyCombo | null {
  if (typeof text !== "string" || !text) return null;
  // "+" is a key too: "Mod++" splits to ["Mod", "", ""], the last two being it.
  let parts = text.split("+");
  if (text.endsWith("+")) {
    // "Mod+" (a modifier and nothing) splits to ["Mod", ""] and is not a combo.
    if (parts.length < 2 || parts[parts.length - 2] !== "") return null;
    parts = [...parts.slice(0, -2), "+"];
  }
  const combo: KeyCombo = { mod: false, alt: false, shift: false, key: "" };
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part) return null;
    const last = i === parts.length - 1;
    if (!last) {
      if (part === "Mod") combo.mod = true;
      else if (part === "Alt") combo.alt = true;
      else if (part === "Shift") combo.shift = true;
      else return null;
      continue;
    }
    if (part === "Mod" || part === "Alt" || part === "Shift") return null;
    combo.key = part.length === 1 ? part.toUpperCase() : part;
  }
  return combo.key ? combo : null;
}

/** Combo → its stored string, modifiers always in the same order. */
export function comboToString(combo: KeyCombo): string {
  return [combo.mod && "Mod", combo.alt && "Alt", combo.shift && "Shift", combo.key].filter(Boolean).join("+");
}

/** The same combo, whatever order it was written in. */
export function normalizeKeys(text: string): string | null {
  const combo = parseCombo(text);
  return combo ? comboToString(combo) : null;
}

export type Platform = "mac" | "other";

/** Which modifier names to print. Read once; the machine does not change. */
export function detectPlatform(): Platform {
  if (typeof navigator === "undefined") return "other";
  const hint = `${navigator.platform ?? ""} ${navigator.userAgent ?? ""}`.toUpperCase();
  return hint.includes("MAC") ? "mac" : "other";
}

const KEY_LABELS: Record<string, string> = {
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Escape: "Esc",
  Backspace: "⌫",
  Delete: "Del",
  PageUp: "PgUp",
  PageDown: "PgDn",
};

/** One label per keycap, in the order they are held. */
export function comboLabels(keys: string, platform: Platform = detectPlatform()): string[] {
  const combo = parseCombo(keys);
  if (!combo) return [];
  const mac = platform === "mac";
  const out: string[] = [];
  if (combo.mod) out.push(mac ? "⌘" : "Ctrl");
  if (combo.alt) out.push(mac ? "⌥" : "Alt");
  if (combo.shift) out.push(mac ? "⇧" : "Shift");
  out.push(KEY_LABELS[combo.key] ?? combo.key);
  return out;
}

/** The combo as running text: "Ctrl+K" here, "⌘K" on a Mac. */
export function formatKeys(keys: string, platform: Platform = detectPlatform()): string {
  return comboLabels(keys, platform).join(platform === "mac" ? "" : "+");
}

// ---------------------------------------------------------------------------
// Reading a press
// ---------------------------------------------------------------------------

/** The part of a KeyboardEvent this module reads — real events and test stubs alike. */
export type KeyPress = Pick<KeyboardEvent, "key" | "code" | "shiftKey" | "ctrlKey" | "metaKey" | "altKey">;

/** True for a press of nothing but modifiers — still waiting for the key. */
export function isModifierOnly(e: KeyPress): boolean {
  return MODIFIER_KEYS.has(e.key);
}

/**
 * The combo a press spells, physical key first. Used when a reader records a
 * new binding; null for a modifier on its own or a key with no name here.
 */
export function comboFromEvent(e: KeyPress): KeyCombo | null {
  if (isModifierOnly(e)) return null;
  const key = keyFromCode(e.code ?? "") ?? keyFromKey(e.key ?? "");
  if (!key) return null;
  return { mod: e.ctrlKey || e.metaKey, alt: e.altKey, shift: e.shiftKey, key };
}

/** Whether a press is this binding. The typed character counts as well as the key. */
export function matchesCombo(keys: string, e: KeyPress): boolean {
  const combo = parseCombo(keys);
  if (!combo) return false;
  if (combo.mod !== (e.ctrlKey || e.metaKey)) return false;
  if (combo.alt !== e.altKey || combo.shift !== e.shiftKey) return false;
  const physical = keyFromCode(e.code ?? "");
  const typed = keyFromKey(e.key ?? "");
  return combo.key === physical || combo.key === typed;
}

/**
 * A binding with no Ctrl/⌘ or Alt would type a character into a field, so it
 * stands down while one has focus. Ctrl/⌘ and Alt bindings fire anywhere —
 * how Search (⌘K) and demo mode (⌘P) have always behaved.
 */
export function yieldsToTyping(keys: string): boolean {
  const combo = parseCombo(keys);
  return !combo || (!combo.mod && !combo.alt);
}

/** True when the press landed in something the reader is typing into. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.tagName !== "string") return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

// ---------------------------------------------------------------------------
// Checking a new binding
// ---------------------------------------------------------------------------

/**
 * Why a binding was refused, as data: `shown` is the press as printed on this
 * platform, so the pane can word the refusal in the reader's language.
 */
export type BindingProblem =
  | { code: "unusable" }
  | { code: "bare-key"; shown: string; mod: string }
  | { code: "reserved"; shown: string; use: ReservedUse }
  | { code: "taken"; shown: string; by: ShortcutId };

/** `reason` is the refusal in English, for tests and logs. */
export type BindingCheck = { ok: true; keys: string } | { ok: false; reason: string; problem: BindingProblem };

function isFunctionKey(key: string): boolean {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

/**
 * Whether `keys` may be given to `id`, against everything else's current
 * keys. The reason is written to be shown as is.
 */
export function checkBinding(
  id: ShortcutId,
  keys: string,
  current: Readonly<Record<ShortcutId, string>>,
  platform: Platform = detectPlatform(),
): BindingCheck {
  const combo = parseCombo(keys);
  if (!combo) return { ok: false, reason: "That key cannot be used for a shortcut.", problem: { code: "unusable" } };
  const normal = comboToString(combo);
  const shown = formatKeys(normal, platform);

  if (!combo.mod && !combo.alt && !combo.shift && !isFunctionKey(combo.key)) {
    const mod = platform === "mac" ? "⌘" : "Ctrl";
    return {
      ok: false,
      reason: `Hold Shift, ${mod} or Alt with ${shown}. A single key would fire while you type.`,
      problem: { code: "bare-key", shown, mod },
    };
  }
  const reserved = RESERVED.find((r) => normalizeKeys(r.keys) === normal);
  if (reserved) {
    return {
      ok: false,
      reason: `${shown} is kept for ${RESERVED_WHAT[reserved.use]}.`,
      problem: { code: "reserved", shown, use: reserved.use },
    };
  }

  const taken = SHORTCUTS.find((s) => s.id !== id && current[s.id] === normal);
  if (taken) {
    return {
      ok: false,
      reason: `${shown} is already used by "${taken.label}". Change that one first.`,
      problem: { code: "taken", shown, by: taken.id },
    };
  }

  return { ok: true, keys: normal };
}

// ---------------------------------------------------------------------------
// Stored changes
// ---------------------------------------------------------------------------

export const SHORTCUTS_KEY = "falcon.ui.shortcuts.v1";

/** The slice of `Storage` this module uses, so tests can pass a Map. */
export type KeyValueStore = Pick<Storage, "getItem" | "setItem">;

export function defaultBindings(): Record<ShortcutId, string> {
  const out = {} as Record<ShortcutId, string>;
  for (const s of SHORTCUTS) out[s.id] = normalizeKeys(s.defaultKeys) ?? s.defaultKeys;
  return out;
}

/**
 * Defaults with the reader's changes laid over them. A change that no longer
 * parses, names a shortcut that is gone, or collides with another binding
 * (a later build may have given its keys to something new) is dropped and
 * that shortcut goes back to its default — repeated until nothing collides,
 * which ends because the defaults are unique.
 */
export function resolveBindings(overrides: Readonly<Record<string, unknown>>): Record<ShortcutId, string> {
  const defaults = defaultBindings();
  const kept: Partial<Record<ShortcutId, string>> = {};
  for (const s of SHORTCUTS) {
    const raw = overrides[s.id];
    if (typeof raw !== "string") continue;
    const normal = normalizeKeys(raw);
    if (normal && normal !== defaults[s.id]) kept[s.id] = normal;
  }
  for (let pass = 0; pass <= SHORTCUTS.length; pass++) {
    const out = { ...defaults, ...kept } as Record<ShortcutId, string>;
    const dropped = (Object.keys(kept) as ShortcutId[]).filter(
      (id) => !checkBinding(id, out[id], out).ok,
    );
    if (dropped.length === 0) return out;
    for (const id of dropped) delete kept[id];
  }
  return defaults;
}

/** The reader's changes, read safely. Anything unreadable reads as none. */
export function readOverrides(store: KeyValueStore | null): Record<string, string> {
  if (!store) return {};
  try {
    const raw = store.getItem(SHORTCUTS_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** Keeps only what differs from the default. Storage that refuses is not an error. */
export function writeOverrides(store: KeyValueStore | null, bindings: Readonly<Record<ShortcutId, string>>): void {
  if (!store) return;
  const defaults = defaultBindings();
  const changed: Record<string, string> = {};
  for (const s of SHORTCUTS) {
    if (bindings[s.id] !== defaults[s.id]) changed[s.id] = bindings[s.id];
  }
  try {
    store.setItem(SHORTCUTS_KEY, JSON.stringify(changed));
  } catch {
    /* the change still holds for this session */
  }
}

// ---------------------------------------------------------------------------
// The live bindings
// ---------------------------------------------------------------------------

function browserStore(): KeyValueStore | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

let bindings: Record<ShortcutId, string> | null = null;
const listeners = new Set<() => void>();

function live(): Record<ShortcutId, string> {
  if (!bindings) bindings = resolveBindings(readOverrides(browserStore()));
  return bindings;
}

function commit(next: Record<ShortcutId, string>): void {
  bindings = next;
  writeOverrides(browserStore(), next);
  for (const fn of listeners) fn();
}

/** Every rebindable shortcut's keys right now. Same object until something changes. */
export function getBindings(): Readonly<Record<ShortcutId, string>> {
  return live();
}

export function getBinding(id: ShortcutId): string {
  return live()[id];
}

/** The current keys of a shortcut as running text, for a hint in the UI. */
export function shortcutText(id: ShortcutId): string {
  return formatKeys(getBinding(id));
}

export function isDefaultBinding(id: ShortcutId): boolean {
  return live()[id] === defaultBindings()[id];
}

/** Give a shortcut new keys, if they are free. Nothing changes on a refusal. */
export function setBinding(id: ShortcutId, keys: string): BindingCheck {
  const check = checkBinding(id, keys, live());
  if (check.ok && check.keys !== live()[id]) commit({ ...live(), [id]: check.keys });
  return check;
}

/**
 * Put one shortcut back. Refused when its default has since been given to
 * another shortcut — the reason names which.
 */
export function resetBinding(id: ShortcutId): BindingCheck {
  return setBinding(id, defaultBindings()[id]);
}

export function resetAllBindings(): void {
  commit(defaultBindings());
}

export function subscribeBindings(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function shortcutDef(id: ShortcutId): ShortcutDef {
  const def = SHORTCUTS.find((s) => s.id === id);
  if (!def) throw new Error(`unknown shortcut: ${id}`);
  return def;
}
