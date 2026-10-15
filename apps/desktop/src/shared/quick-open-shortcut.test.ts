import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkGlobalShortcut, toAccelerator } from "./quick-open-shortcut";

describe("quick open shortcut", () => {
  it("accepts a combination with Ctrl/Command or Alt, in any written order", () => {
    assert.deepEqual(checkGlobalShortcut("Mod+Shift+F"), { ok: true, keys: "Mod+Shift+F" });
    assert.deepEqual(checkGlobalShortcut("Shift+Alt+Space"), { ok: true, keys: "Alt+Shift+Space" });
    assert.deepEqual(checkGlobalShortcut("Mod+Alt+1"), { ok: true, keys: "Mod+Alt+1" });
    assert.deepEqual(checkGlobalShortcut("Alt+F9"), { ok: true, keys: "Alt+F9" });
  });

  it("refuses presses that would swallow typing in other apps", () => {
    for (const keys of ["F", "Shift+F", "F9", "Shift+F9", "Space"]) {
      assert.deepEqual(checkGlobalShortcut(keys), { ok: false, problem: "needs-modifier" }, keys);
    }
  });

  it("refuses what every app answers to", () => {
    for (const keys of ["Mod+C", "Mod+V", "Mod+S", "Mod+W", "Mod+Q", "Alt+Tab", "Alt+F4", "Mod+Shift+Z"]) {
      assert.deepEqual(checkGlobalShortcut(keys), { ok: false, problem: "reserved" }, keys);
    }
  });

  it("refuses what is not one key plus modifiers, or a key an accelerator cannot name", () => {
    for (const keys of ["", "Mod+", "Mod+Shift", "Ctrl+F", "Mod+Escape", "Mod+F25", null, 7]) {
      assert.deepEqual(checkGlobalShortcut(keys), { ok: false, problem: "unusable" }, String(keys));
    }
  });

  it("turns a stored combination into an Electron accelerator", () => {
    assert.equal(toAccelerator("Mod+Shift+F"), "CommandOrControl+Shift+F");
    assert.equal(toAccelerator("Alt+ArrowUp"), "Alt+Up");
    assert.equal(toAccelerator("Mod++"), "CommandOrControl+Plus");
    assert.equal(toAccelerator("Mod+/"), "CommandOrControl+/");
    assert.equal(toAccelerator("Mod+Alt+Space"), "CommandOrControl+Alt+Space");
    assert.equal(toAccelerator("nonsense"), null);
  });
});
