import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  LOGIN_LAUNCH_ARG,
  openedAtLogin,
  startInTray,
  SystemPresence,
  traySupported,
  type PresenceDeps,
} from "./presence";

/** Fakes for the OS: which accelerators another app holds, what is registered, what is up. */
function fakeOs(platform: NodeJS.Platform = "win32", takenElsewhere: string[] = []) {
  const registered = new Map<string, () => void>();
  const trays: Array<{ destroyed: boolean }> = [];
  const blockers = new Set<number>();
  let nextBlocker = 1;
  let shown = 0;
  const deps: PresenceDeps = {
    platform,
    registerShortcut: (accelerator, onPress) => {
      if (takenElsewhere.includes(accelerator) || registered.has(accelerator)) return false;
      registered.set(accelerator, onPress);
      return true;
    },
    unregisterShortcut: (accelerator) => {
      registered.delete(accelerator);
    },
    createTray: () => {
      const tray = { destroyed: false };
      trays.push(tray);
      return {
        destroy: () => {
          tray.destroyed = true;
        },
      };
    },
    startKeepAwake: () => {
      const id = nextBlocker++;
      blockers.add(id);
      return id;
    },
    stopKeepAwake: (id) => {
      blockers.delete(id);
    },
    showWindow: () => {
      shown += 1;
    },
  };
  return { deps, registered, trays, blockers, shown: () => shown };
}

describe("quick open shortcut", () => {
  it("registers the saved combination at startup and brings the window forward on press", () => {
    const os = fakeOs();
    const presence = new SystemPresence(os.deps);
    assert.deepEqual(presence.loadShortcut("Mod+Shift+F"), { keys: "Mod+Shift+F", registered: true, error: null });
    os.registered.get("CommandOrControl+Shift+F")!();
    assert.equal(os.shown(), 1);
  });

  it("keeps a saved combination another app holds, and reports it", () => {
    const os = fakeOs("win32", ["CommandOrControl+Shift+F"]);
    const presence = new SystemPresence(os.deps);
    assert.deepEqual(presence.loadShortcut("Mod+Shift+F"), { keys: "Mod+Shift+F", registered: false, error: "taken" });
  });

  it("starts with nothing registered when nothing is saved", () => {
    const os = fakeOs();
    const presence = new SystemPresence(os.deps);
    assert.deepEqual(presence.loadShortcut(null), { keys: null, registered: false, error: null });
    assert.equal(os.registered.size, 0);
  });

  it("swaps to a new combination, and frees the old one", () => {
    const os = fakeOs();
    const presence = new SystemPresence(os.deps);
    presence.loadShortcut("Mod+Shift+F");
    const change = presence.changeShortcut("Alt+Shift+K");
    assert.ok(change.ok);
    assert.deepEqual([...os.registered.keys()], ["Alt+Shift+K"]);
  });

  it("puts the old combination back when the OS refuses the new one", () => {
    const os = fakeOs("win32", ["Alt+Shift+K"]);
    const presence = new SystemPresence(os.deps);
    presence.loadShortcut("Mod+Shift+F");
    const change = presence.changeShortcut("Alt+Shift+K");
    assert.deepEqual(change, {
      ok: false,
      error: "taken",
      state: { keys: "Mod+Shift+F", registered: true, error: null },
    });
    assert.deepEqual([...os.registered.keys()], ["CommandOrControl+Shift+F"]);
  });

  it("refuses an invalid combination without touching the current one, and clears on null", () => {
    const os = fakeOs();
    const presence = new SystemPresence(os.deps);
    presence.loadShortcut("Mod+Shift+F");
    assert.equal(presence.changeShortcut("Mod+C").ok, false);
    assert.deepEqual([...os.registered.keys()], ["CommandOrControl+Shift+F"]);
    assert.deepEqual(presence.changeShortcut(null), { ok: true, state: { keys: null, registered: false, error: null } });
    assert.equal(os.registered.size, 0);
  });

  it("treats setting the same combination again as done", () => {
    const os = fakeOs();
    const presence = new SystemPresence(os.deps);
    presence.loadShortcut("Mod+Shift+F");
    assert.ok(presence.changeShortcut("Mod+Shift+F").ok);
    assert.equal(os.registered.size, 1);
  });

  it("reports an accelerator Electron throws on as invalid", () => {
    const os = fakeOs();
    const presence = new SystemPresence({
      ...os.deps,
      registerShortcut: () => {
        throw new Error("bad accelerator");
      },
    });
    assert.deepEqual(presence.changeShortcut("Mod+Shift+F"), {
      ok: false,
      error: "invalid",
      state: { keys: null, registered: false, error: null },
    });
  });
});

describe("tray", () => {
  it("is only offered where there is one", () => {
    assert.ok(traySupported("win32"));
    assert.ok(traySupported("darwin"));
    assert.ok(!traySupported("linux"));
    const presence = new SystemPresence(fakeOs("linux").deps);
    assert.equal(presence.setTray(true), false);
  });

  it("goes up once, comes down, and decides what a close does", () => {
    const os = fakeOs();
    const presence = new SystemPresence(os.deps);
    assert.equal(presence.hideOnClose(), false);
    assert.equal(presence.setTray(true), true);
    presence.setTray(true);
    assert.equal(os.trays.length, 1);
    assert.equal(presence.hideOnClose(), true);
    presence.setTray(false);
    assert.equal(os.trays[0]!.destroyed, true);
    assert.equal(presence.hideOnClose(), false);
  });

  it("lets the window close for real once the app is quitting", () => {
    const presence = new SystemPresence(fakeOs().deps);
    presence.setTray(true);
    presence.markQuitting();
    assert.equal(presence.hideOnClose(), false);
  });
});

describe("keep awake", () => {
  it("holds one blocker while on and releases it when turned off", () => {
    const os = fakeOs();
    const presence = new SystemPresence(os.deps);
    assert.equal(presence.setKeepAwake(true), true);
    presence.setKeepAwake(true);
    assert.equal(os.blockers.size, 1);
    assert.equal(presence.setKeepAwake(false), false);
    assert.equal(os.blockers.size, 0);
  });
});

describe("dispose", () => {
  it("hands back the shortcut, the tray and the blocker on quit", () => {
    const os = fakeOs();
    const presence = new SystemPresence(os.deps);
    presence.loadShortcut("Mod+Shift+F");
    presence.setTray(true);
    presence.setKeepAwake(true);
    presence.dispose();
    assert.equal(os.registered.size, 0);
    assert.equal(os.trays[0]!.destroyed, true);
    assert.equal(os.blockers.size, 0);
    assert.equal(presence.hideOnClose(), false);
  });
});

describe("launch at login", () => {
  it("knows a Windows login launch by the login item's argument", () => {
    const never = () => true;
    assert.equal(openedAtLogin("win32", ["Falcon.exe", LOGIN_LAUNCH_ARG], never), true);
    assert.equal(openedAtLogin("win32", ["Falcon.exe"], never), false);
  });

  it("asks a Mac, and treats a failed answer as an ordinary launch", () => {
    assert.equal(openedAtLogin("darwin", [], () => true), true);
    assert.equal(openedAtLogin("darwin", [LOGIN_LAUNCH_ARG], () => false), false);
    assert.equal(
      openedAtLogin("darwin", [], () => {
        throw new Error("unavailable");
      }),
      false,
    );
    assert.equal(openedAtLogin("linux", [LOGIN_LAUNCH_ARG], () => true), false);
  });

  it("waits in the tray only when launched at login with the tray up", () => {
    assert.equal(startInTray(true, true), true);
    assert.equal(startInTray(true, false), false);
    assert.equal(startInTray(false, true), false);
    assert.equal(startInTray(false, false), false);
  });
});
