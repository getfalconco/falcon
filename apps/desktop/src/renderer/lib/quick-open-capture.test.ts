import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { comboFromEvent, comboToString, type KeyPress } from "./shortcuts";
import { checkGlobalShortcut, parseGlobalCombo, toAccelerator } from "../../shared/quick-open-shortcut";

/**
 * The System pane records the quick open shortcut with this module's capture,
 * and main registers it through shared/quick-open-shortcut.ts: the two have to
 * agree on how a press is written.
 */

const press = (code: string, key: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  code,
  key,
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  ...mods,
});

describe("quick open shortcut capture", () => {
  it("is read exactly as the Shortcuts capture writes it", () => {
    const cases: Array<[KeyPress, string]> = [
      [press("KeyF", "F", { ctrlKey: true, shiftKey: true }), "CommandOrControl+Shift+F"],
      [press("Space", " ", { altKey: true, shiftKey: true }), "Alt+Shift+Space"],
      [press("Digit5", "%", { metaKey: true, shiftKey: true }), "CommandOrControl+Shift+5"],
      [press("Slash", "/", { ctrlKey: true, altKey: true }), "CommandOrControl+Alt+/"],
    ];
    for (const [event, accelerator] of cases) {
      const written = comboToString(comboFromEvent(event)!);
      const check = checkGlobalShortcut(written);
      assert.ok(check.ok, written);
      assert.equal(toAccelerator(check.keys), accelerator);
      assert.ok(parseGlobalCombo(written));
    }
  });
});
