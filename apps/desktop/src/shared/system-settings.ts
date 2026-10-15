import type { UpdateStatus } from "./update-types";
import { checkGlobalShortcut } from "./quick-open-shortcut";

/**
 * The System pane's contract with the main process (main/system): what this
 * install is, the machine-level switches, and the storage it uses.
 */

/** Kept in `<data root>/system/settings.json`. Read once at startup, then on every change. */
export type SystemSettings = {
  /** Applies on the next launch: Chromium decides this before any window exists. */
  hardwareAcceleration: boolean;
  /** The quick open shortcut ("Mod+Shift+F"), or null for none. See shared/quick-open-shortcut.ts. */
  quickOpenShortcut: string | null;
  /** Keep running in the tray (menu bar on a Mac) when the window is closed. */
  trayEnabled: boolean;
  /** Keep the machine from sleeping on idle while Falcon runs. */
  keepAwake: boolean;
};

export const DEFAULT_SYSTEM_SETTINGS: SystemSettings = {
  hardwareAcceleration: true,
  quickOpenShortcut: null,
  trayEnabled: false,
  keepAwake: false,
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function normalizeSystemSettings(raw: unknown): SystemSettings {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const shortcut = checkGlobalShortcut(src.quickOpenShortcut);
  return {
    hardwareAcceleration: bool(src.hardwareAcceleration, DEFAULT_SYSTEM_SETTINGS.hardwareAcceleration),
    quickOpenShortcut: shortcut.ok ? shortcut.keys : null,
    trayEnabled: bool(src.trayEnabled, DEFAULT_SYSTEM_SETTINGS.trayEnabled),
    keepAwake: bool(src.keepAwake, DEFAULT_SYSTEM_SETTINGS.keepAwake),
  };
}

/**
 * Why a switch is unavailable, as a code the renderer turns into words in the
 * reader's language. `reason` keeps the English, for logs and older renderers.
 */
export type CapabilityCode =
  | "installed-only"
  | "unsupported-platform"
  | "updates-installed-only"
  | "data-root-env";

/** A switch that only works on some builds says which, rather than pretending. */
export type Capability = { supported: true } | { supported: false; code: CapabilityCode; reason: string };

/** Why the quick open shortcut is not in force although one is saved. */
export type QuickOpenError = "taken" | "invalid";

/** Where the data folder came from: the FALCON_DATA_ROOT env var, a folder the reader chose, or the default. */
export type DataRootSource = "env" | "custom" | "default";

export type DataFolderInfo = {
  /** The folder this run reads and writes. */
  path: string;
  source: DataRootSource;
  /** A folder the data was copied to, used from the next launch. Null when nothing is waiting. */
  pending: string | null;
  /** The folder this run started from when a move is waiting: it is kept, never deleted. */
  previous: string | null;
  /** A chosen folder that could not be found at startup, so the default was used. */
  missing: string | null;
  /** Whether "Change" can be used on this run. */
  change: Capability;
};

export type SystemInfo = {
  version: string;
  packaged: boolean;
  platform: string;
  openAtLogin: Capability & { enabled: boolean };
  hardwareAcceleration: {
    /** What the reader chose; takes effect on the next launch. */
    saved: boolean;
    /** What this run started with. */
    active: boolean;
  };
  quickOpen: {
    /** The saved combination, or null for none. */
    keys: string | null;
    /** True while the OS has it registered to Falcon. */
    registered: boolean;
    error: QuickOpenError | null;
  };
  tray: Capability & { enabled: boolean };
  keepAwake: { enabled: boolean; active: boolean };
  /** Restarting from inside the app; a dev build is run by its dev server instead. */
  restart: Capability;
  updates: Capability & { status: UpdateStatus; lastCheck: UpdateCheckOutcome | null };
  dataRoot: string;
  dataFolder: DataFolderInfo;
};

/** What a manual update check found. */
export type UpdateCheckOutcome =
  | { kind: "current"; checkedAt: string }
  | { kind: "available"; version: string; checkedAt: string }
  | { kind: "error"; error: string; checkedAt: string };

/** Sizes on disk, in bytes; null when a size could not be read. */
export type SystemStorage = {
  dataBytes: number | null;
  cacheBytes: number | null;
};

/**
 * Why a data folder move did not happen, as a code the pane words. Nothing
 * has changed when one of these comes back: the old folder is still in use.
 */
export type DataMoveProblem =
  | "same-folder"
  | "inside-current"
  | "not-empty"
  | "not-writable"
  | "copy-failed"
  | "verify-failed"
  | "unavailable";

export type DataMoveResult =
  | { ok: true; moved: true; info: SystemInfo; files: number }
  | { ok: true; moved: false }
  | { ok: false; problem: DataMoveProblem; error: string };

/** Setting the quick open shortcut: refused with why, and nothing changed, when the OS will not take it. */
export type QuickOpenResult = { ok: true; value: SystemInfo } | { ok: false; error: string; problem?: QuickOpenError };

export type SystemResult<T> = { ok: true; value: T } | { ok: false; error: string };
