import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_SYSTEM_SETTINGS } from "../../shared/system-settings";
import { directorySize, readSystemSettings, systemSettingsFile, writeSystemSettings } from "./system-settings-store";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falcon-system-"));
}

describe("system settings store", () => {
  it("defaults, persists, and ignores a corrupt or wrongly typed file", () => {
    const root = tempRoot();
    assert.deepEqual(readSystemSettings(root), DEFAULT_SYSTEM_SETTINGS);
    writeSystemSettings(root, { hardwareAcceleration: false });
    assert.equal(readSystemSettings(root).hardwareAcceleration, false);
    fs.writeFileSync(systemSettingsFile(root), JSON.stringify({ hardwareAcceleration: "off" }));
    assert.equal(readSystemSettings(root).hardwareAcceleration, true);
    fs.writeFileSync(systemSettingsFile(root), "{");
    assert.deepEqual(readSystemSettings(root), DEFAULT_SYSTEM_SETTINGS);
  });

  it("starts with no shortcut, no tray and no keep awake", () => {
    const root = tempRoot();
    const settings = readSystemSettings(root);
    assert.equal(settings.quickOpenShortcut, null);
    assert.equal(settings.trayEnabled, false);
    assert.equal(settings.keepAwake, false);
  });

  it("keeps the tray, keep awake and shortcut across a merge of another field", () => {
    const root = tempRoot();
    writeSystemSettings(root, { trayEnabled: true, keepAwake: true, quickOpenShortcut: "Mod+Shift+F" });
    writeSystemSettings(root, { hardwareAcceleration: false });
    assert.deepEqual(readSystemSettings(root), {
      hardwareAcceleration: false,
      trayEnabled: true,
      keepAwake: true,
      quickOpenShortcut: "Mod+Shift+F",
    });
    writeSystemSettings(root, { quickOpenShortcut: null });
    assert.equal(readSystemSettings(root).quickOpenShortcut, null);
  });

  it("normalizes the stored shortcut and drops one that could never be global", () => {
    const root = tempRoot();
    fs.mkdirSync(path.dirname(systemSettingsFile(root)), { recursive: true });
    fs.writeFileSync(systemSettingsFile(root), JSON.stringify({ quickOpenShortcut: "Shift+Mod+f" }));
    assert.equal(readSystemSettings(root).quickOpenShortcut, "Mod+Shift+F");
    for (const bad of ["Shift+F", "F", "Mod+C", 42, "", "Mod+"]) {
      fs.writeFileSync(systemSettingsFile(root), JSON.stringify({ quickOpenShortcut: bad, trayEnabled: "yes" }));
      const read = readSystemSettings(root);
      assert.equal(read.quickOpenShortcut, null, String(bad));
      assert.equal(read.trayEnabled, false);
    }
  });
});

describe("directorySize", () => {
  it("sums nested files and reads a missing root as zero", async () => {
    const root = tempRoot();
    fs.mkdirSync(path.join(root, "a", "b"), { recursive: true });
    fs.writeFileSync(path.join(root, "one.txt"), "12345");
    fs.writeFileSync(path.join(root, "a", "b", "two.txt"), "123");
    assert.equal(await directorySize(root), 8);
    assert.equal(await directorySize(path.join(root, "nope")), 0);
  });
});
