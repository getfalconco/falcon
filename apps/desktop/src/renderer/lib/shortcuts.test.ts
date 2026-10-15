import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SHORTCUTS,
  SHORTCUTS_KEY,
  checkBinding,
  comboFromEvent,
  comboLabels,
  defaultBindings,
  formatKeys,
  matchesCombo,
  normalizeKeys,
  parseCombo,
  readOverrides,
  resolveBindings,
  writeOverrides,
  yieldsToTyping,
  type KeyPress,
} from "./shortcuts";

function press(over: Partial<KeyPress>): KeyPress {
  return { key: "", code: "", shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...over };
}

function memory(initial?: string) {
  const data = new Map<string, string>();
  if (initial !== undefined) data.set(SHORTCUTS_KEY, initial);
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    raw: () => data.get(SHORTCUTS_KEY),
  };
}

describe("shortcut registry", () => {
  it("gives every shortcut a unique id and unique, valid default keys", () => {
    const ids = new Set(SHORTCUTS.map((s) => s.id));
    assert.equal(ids.size, SHORTCUTS.length);
    const defaults = defaultBindings();
    const keys = Object.values(defaults);
    assert.equal(new Set(keys).size, keys.length);
    for (const s of SHORTCUTS) {
      assert.ok(parseCombo(s.defaultKeys), s.id);
      assert.ok(checkBinding(s.id, defaults[s.id], defaults).ok, s.id);
    }
  });

  it("includes the shortcuts the app has always had", () => {
    const d = defaultBindings();
    assert.equal(d.tracker, "Shift+T");
    assert.equal(d.base, "Shift+B");
    assert.equal(d.analyst, "Shift+A");
    assert.equal(d.search, "Mod+K");
    assert.equal(d["demo-mode"], "Mod+P");
    assert.equal(d["open-shortcuts"], "Mod+/");
  });
});

describe("parsing and printing", () => {
  it("normalizes modifier order and letter case", () => {
    assert.equal(normalizeKeys("shift+t"), null); // modifiers are case-sensitive names
    assert.equal(normalizeKeys("Shift+Mod+k"), "Mod+Shift+K");
    assert.equal(normalizeKeys("Alt+Shift+Mod+F5"), "Mod+Alt+Shift+F5");
  });

  it("treats + as a key of its own", () => {
    assert.deepEqual(parseCombo("Mod++"), { mod: true, alt: false, shift: false, key: "+" });
    assert.equal(parseCombo("Mod+"), null);
    assert.equal(parseCombo("Shift"), null);
    assert.equal(parseCombo(""), null);
  });

  it("prints Ctrl on Windows and symbols on a Mac", () => {
    assert.deepEqual(comboLabels("Mod+Shift+K", "other"), ["Ctrl", "Shift", "K"]);
    assert.deepEqual(comboLabels("Mod+Shift+K", "mac"), ["⌘", "⇧", "K"]);
    assert.equal(formatKeys("Mod+/", "other"), "Ctrl+/");
    assert.equal(formatKeys("Mod+/", "mac"), "⌘/");
    assert.deepEqual(comboLabels("ArrowUp", "other"), ["↑"]);
    assert.deepEqual(comboLabels("Escape", "other"), ["Esc"]);
  });
});

describe("reading a press", () => {
  it("matches on the physical key or the typed character", () => {
    assert.ok(matchesCombo("Shift+T", press({ key: "T", code: "KeyT", shiftKey: true })));
    // Synthetic input with no code still matches on the character.
    assert.ok(matchesCombo("Shift+T", press({ key: "T", shiftKey: true })));
    // Another layout: the key labelled T sits elsewhere, the character still counts.
    assert.ok(matchesCombo("Shift+T", press({ key: "T", code: "KeyY", shiftKey: true })));
  });

  it("requires exactly the bound modifiers", () => {
    assert.ok(!matchesCombo("Shift+T", press({ key: "t", code: "KeyT" })));
    assert.ok(!matchesCombo("Shift+T", press({ key: "T", code: "KeyT", shiftKey: true, ctrlKey: true })));
    assert.ok(matchesCombo("Mod+K", press({ key: "k", code: "KeyK", ctrlKey: true })));
    assert.ok(matchesCombo("Mod+K", press({ key: "k", code: "KeyK", metaKey: true })));
    assert.ok(!matchesCombo("Mod+K", press({ key: "K", code: "KeyK", ctrlKey: true, shiftKey: true })));
  });

  it("matches Ctrl+/ on the slash key", () => {
    assert.ok(matchesCombo("Mod+/", press({ key: "/", code: "Slash", ctrlKey: true })));
  });

  it("records the physical key and ignores a modifier on its own", () => {
    assert.equal(comboFromEvent(press({ key: "Shift", code: "ShiftLeft", shiftKey: true })), null);
    assert.deepEqual(comboFromEvent(press({ key: "?", code: "Slash", shiftKey: true })), {
      mod: false,
      alt: false,
      shift: true,
      key: "/",
    });
    assert.deepEqual(comboFromEvent(press({ key: "j", code: "KeyJ", ctrlKey: true })), {
      mod: true,
      alt: false,
      shift: false,
      key: "J",
    });
  });

  it("lets Shift-only bindings stand down while typing, but not Ctrl/⌘ or Alt ones", () => {
    assert.equal(yieldsToTyping("Shift+T"), true);
    assert.equal(yieldsToTyping("Mod+K"), false);
    assert.equal(yieldsToTyping("Alt+K"), false);
  });
});

describe("checking a new binding", () => {
  const current = defaultBindings();

  it("accepts a free combination", () => {
    assert.deepEqual(checkBinding("tracker", "Shift+Y", current, "other"), { ok: true, keys: "Shift+Y" });
  });

  it("refuses keys another shortcut has, naming it", () => {
    const r = checkBinding("tracker", "Shift+B", current, "other");
    assert.equal(r.ok, false);
    assert.match(!r.ok ? r.reason : "", /Shift\+B is already used by "Base panel"/);
  });

  it("allows a shortcut to keep its own keys", () => {
    assert.ok(checkBinding("tracker", "Shift+T", current, "other").ok);
  });

  it("refuses a bare key, but allows a function key", () => {
    assert.equal(checkBinding("tracker", "T", current, "other").ok, false);
    assert.ok(checkBinding("tracker", "F2", current, "other").ok);
  });

  it("refuses keys kept for text editing, focus and the window", () => {
    for (const keys of ["Mod+C", "Mod+V", "Escape", "Tab", "Shift+ArrowLeft", "Mod+R", "Mod+W"]) {
      assert.equal(checkBinding("tracker", keys, current, "other").ok, false, keys);
    }
  });
});

describe("stored changes", () => {
  it("reads nothing from empty, broken or foreign storage", () => {
    assert.deepEqual(readOverrides(null), {});
    assert.deepEqual(readOverrides(memory()), {});
    assert.deepEqual(readOverrides(memory("not json")), {});
    assert.deepEqual(readOverrides(memory("[1,2]")), {});
    assert.deepEqual(readOverrides(memory('{"tracker":5,"base":"Shift+N"}')), { base: "Shift+N" });
  });

  it("survives storage that throws", () => {
    const hostile = {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("denied");
      },
    };
    assert.deepEqual(readOverrides(hostile), {});
    assert.doesNotThrow(() => writeOverrides(hostile, defaultBindings()));
  });

  it("writes only what differs from the defaults", () => {
    const store = memory();
    writeOverrides(store, { ...defaultBindings(), tracker: "Shift+Y" });
    assert.deepEqual(JSON.parse(store.raw() ?? "null"), { tracker: "Shift+Y" });
  });

  it("lays the reader's changes over the defaults", () => {
    const b = resolveBindings({ tracker: "Shift+Y", unknown: "Shift+Z" });
    assert.equal(b.tracker, "Shift+Y");
    assert.equal(b.base, "Shift+B");
  });

  it("drops a change that collides, putting that shortcut back to its default", () => {
    // Two changes onto the same keys: neither can be trusted.
    const both = resolveBindings({ tracker: "Shift+Y", base: "Shift+Y" });
    assert.equal(both.tracker, "Shift+T");
    assert.equal(both.base, "Shift+B");
    // A change onto another shortcut's default.
    const onDefault = resolveBindings({ tracker: "Shift+B" });
    assert.equal(onDefault.tracker, "Shift+T");
    // A change onto reserved or unparsable keys.
    assert.equal(resolveBindings({ tracker: "Mod+C" }).tracker, "Shift+T");
    assert.equal(resolveBindings({ tracker: "Shift+" }).tracker, "Shift+T");
  });

  it("keeps a swap the reader made", () => {
    const b = resolveBindings({ tracker: "Shift+B", base: "Shift+T" });
    assert.equal(b.tracker, "Shift+B");
    assert.equal(b.base, "Shift+T");
  });
});
