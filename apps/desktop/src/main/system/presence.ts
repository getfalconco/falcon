import { checkGlobalShortcut, toAccelerator } from "../../shared/quick-open-shortcut";
import type { QuickOpenError } from "../../shared/system-settings";

/**
 * What Falcon does on the machine beyond its window: the quick open shortcut,
 * the tray icon (menu bar on a Mac) that keeps it running with the window
 * closed, and keeping the machine awake so agents check on schedule.
 *
 * The OS calls go through `PresenceDeps`, so the rules (what is registered
 * when, what a close does, what is released on quit) are tested with fakes;
 * presence-electron.ts hands it the real `globalShortcut`, `Tray` and
 * `powerSaveBlocker`.
 */

export type TrayHandle = { destroy(): void };

export type PresenceDeps = {
  platform: NodeJS.Platform;
  /** True only when the OS gave the accelerator to Falcon (false when another app holds it). */
  registerShortcut(accelerator: string, onPress: () => void): boolean;
  unregisterShortcut(accelerator: string): void;
  createTray(): TrayHandle;
  startKeepAwake(): number;
  stopKeepAwake(id: number): void;
  /** Brings the window forward: shown if hidden, restored if minimized, focused. */
  showWindow(): void;
};

/** The tray needs a tray: Windows' notification area or the Mac menu bar. Linux varies by desktop. */
export function traySupported(platform: NodeJS.Platform): boolean {
  return platform === "win32" || platform === "darwin";
}

/**
 * Passed by the Windows login item (Settings, General, Startup), so
 * a launch at sign-in can be told from one the reader started. A Mac says so
 * itself (`wasOpenedAtLogin`).
 */
export const LOGIN_LAUNCH_ARG = "--opened-at-login";

/** Whether the OS started this run as a login item. */
export function openedAtLogin(
  platform: NodeJS.Platform,
  argv: readonly string[],
  macWasOpenedAtLogin: () => boolean,
): boolean {
  if (platform === "win32") return argv.includes(LOGIN_LAUNCH_ARG);
  if (platform === "darwin") {
    try {
      return macWasOpenedAtLogin();
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * A launch at login waits in the tray instead of opening its window, but only
 * while the tray is up: without it there would be no way back to the window
 * short of starting Falcon again.
 */
export function startInTray(launchedAtLogin: boolean, trayActive: boolean): boolean {
  return launchedAtLogin && trayActive;
}

export type QuickOpenState = { keys: string | null; registered: boolean; error: QuickOpenError | null };

export type ShortcutChange = { ok: true; state: QuickOpenState } | { ok: false; error: QuickOpenError; state: QuickOpenState };

export class SystemPresence {
  private keys: string | null = null;
  private accelerator: string | null = null;
  private error: QuickOpenError | null = null;
  private tray: TrayHandle | null = null;
  private blocker: number | null = null;
  private quitting = false;

  constructor(private readonly deps: PresenceDeps) {}

  quickOpen(): QuickOpenState {
    return { keys: this.keys, registered: this.accelerator != null, error: this.error };
  }

  /** Whether the tray icon is up. */
  trayActive(): boolean {
    return this.tray != null;
  }

  keepAwakeActive(): boolean {
    return this.blocker != null;
  }

  private register(keys: string): QuickOpenError | null {
    const check = checkGlobalShortcut(keys);
    const accelerator = check.ok ? toAccelerator(check.keys) : null;
    if (!check.ok || !accelerator) return "invalid";
    let ok = false;
    try {
      ok = this.deps.registerShortcut(accelerator, () => this.deps.showWindow());
    } catch {
      return "invalid";
    }
    if (!ok) return "taken";
    this.accelerator = accelerator;
    return null;
  }

  private unregister(): void {
    if (!this.accelerator) return;
    try {
      this.deps.unregisterShortcut(this.accelerator);
    } catch {
      /* already gone */
    }
    this.accelerator = null;
  }

  /**
   * At startup: register what was saved. A combination another app holds is
   * kept as the saved one and reported, so the pane can say why it does nothing.
   */
  loadShortcut(keys: string | null): QuickOpenState {
    this.unregister();
    this.keys = keys;
    this.error = keys ? this.register(keys) : null;
    return this.quickOpen();
  }

  /**
   * From Settings: try the new combination; if the OS refuses it, the old one
   * is put back and nothing changes. Null clears it.
   */
  changeShortcut(keys: string | null): ShortcutChange {
    if (keys == null) {
      this.unregister();
      this.keys = null;
      this.error = null;
      return { ok: true, state: this.quickOpen() };
    }
    const check = checkGlobalShortcut(keys);
    if (!check.ok) return { ok: false, error: "invalid", state: this.quickOpen() };
    if (check.keys === this.keys && this.accelerator) return { ok: true, state: this.quickOpen() };

    const previous = this.keys;
    const hadPrevious = this.accelerator != null;
    this.unregister();
    const error = this.register(check.keys);
    if (error) {
      if (previous && hadPrevious) this.register(previous);
      return { ok: false, error, state: this.quickOpen() };
    }
    this.keys = check.keys;
    this.error = null;
    return { ok: true, state: this.quickOpen() };
  }

  /** Puts the tray icon up or takes it down. False when this platform has no tray. */
  setTray(enabled: boolean): boolean {
    if (enabled && !traySupported(this.deps.platform)) return false;
    if (enabled && !this.tray) this.tray = this.deps.createTray();
    if (!enabled && this.tray) {
      this.tray.destroy();
      this.tray = null;
    }
    return this.tray != null;
  }

  setKeepAwake(enabled: boolean): boolean {
    if (enabled && this.blocker == null) this.blocker = this.deps.startKeepAwake();
    if (!enabled && this.blocker != null) {
      this.deps.stopKeepAwake(this.blocker);
      this.blocker = null;
    }
    return this.blocker != null;
  }

  /** The app is on its way out (Quit, restart, update, shutdown): a close then really closes. */
  markQuitting(): void {
    this.quitting = true;
  }

  /** What closing the main window does: hide to the tray while the tray is up, else close. */
  hideOnClose(): boolean {
    return this.tray != null && !this.quitting;
  }

  /** On quit: hand back the shortcut, the tray icon and the keep awake request. */
  dispose(): void {
    this.markQuitting();
    this.unregister();
    this.setTray(false);
    this.setKeepAwake(false);
  }
}
