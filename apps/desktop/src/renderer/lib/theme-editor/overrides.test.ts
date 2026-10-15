import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  OVERRIDES_KEY,
  diffOverrides,
  exportBlock,
  importBlock,
  overridesCss,
  readOverrides,
  sanitizeOverrides,
  writeOverrides,
} from "./overrides";
import { parseDarkTokens } from "./tokens";

const CSS = `
  [data-theme="dark"] {
    --surface-1: #131312;
    --text-secondary: #9a9994;
    --border-subtle: rgba(255, 255, 255, 0.055);
    --positive: #4fbf87;
    --background: 60 5% 4%;
  }
  [data-theme="dark"] { --positive-soft: color-mix(in srgb, var(--positive) 14%, transparent); }
`;
const tokens = parseDarkTokens(CSS);
const date = new Date(2026, 9, 15, 14, 32);

function memoryStore() {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
    removeItem: (k: string) => void data.delete(k),
  };
}

describe("diff and sanitize", () => {
  it("keeps only what differs from the stylesheet, case and spacing aside", () => {
    const diff = diffOverrides(tokens, {
      "--surface-1": "#151514",
      "--text-secondary": "#9A9994",
      "--border-subtle": "rgba(255,  255, 255, 0.055)",
      "--not-a-token": "#fff",
    });
    assert.deepEqual(diff, { "--surface-1": "#151514" });
  });

  it("drops names and values that could break out of the block", () => {
    assert.deepEqual(
      sanitizeOverrides({
        "--ok": " #fff ",
        "--bad": "#fff; } body { display: none",
        "not-a-name": "#000",
        "--comment": "#000 /* x */",
        "--tag": "</style>",
        "--number": 4,
      }),
      { "--ok": "#fff" },
    );
  });

  it("injects scoped to dark, one notch stronger than globals.css", () => {
    assert.equal(overridesCss({}), "");
    assert.equal(overridesCss({ "--surface-1": "#151514" }), ':root[data-theme="dark"] {\n  --surface-1: #151514;\n}\n');
  });
});

describe("export", () => {
  const overrides = { "--surface-1": "#151514", "--positive-soft": "rgba(79, 191, 135, 0.2)", "--text-secondary": "#9a9994" };

  it("copies only the changed tokens, with a dated header", () => {
    const block = exportBlock(tokens, overrides, { all: false, date, appVersion: "0.2.0" });
    assert.equal(
      block,
      [
        "/* Falcon dark theme colors. Exported 2026-10-15 14:32, app 0.2.0. 2 changed of 6. */",
        '[data-theme="dark"] {',
        "  --surface-1: #151514;",
        "  --positive-soft: rgba(79, 191, 135, 0.2);",
        "}",
        "",
      ].join("\n"),
    );
  });

  it("copies every token with Copy all, changed ones at their new value", () => {
    const block = exportBlock(tokens, overrides, { all: true, date, appVersion: "0.2.0" });
    assert.match(block, /All 6 tokens, 2 changed\./);
    assert.match(block, /--surface-1: #151514;/);
    assert.match(block, /--text-secondary: #9a9994;/);
    assert.match(block, /--background: 60 5% 4%;/);
    assert.match(block, /--positive-soft: rgba\(79, 191, 135, 0.2\);/);
    assert.equal(block.match(/^ {2}--/gm)?.length, 6);
  });

  it("has an empty block when nothing changed", () => {
    const block = exportBlock(tokens, {}, { all: false, date, appVersion: "dev" });
    assert.match(block, /0 changed of 6/);
    assert.match(block, /\[data-theme="dark"\] \{\n\}\n$/);
  });

  it("follows the house copy rules", () => {
    const block = exportBlock(tokens, overrides, { all: true, date, appVersion: "0.2.0" });
    assert.ok(!/[–—!]/.test(block));
  });
});

describe("import", () => {
  it("round-trips a diff-only export", () => {
    const overrides = { "--surface-1": "#151514", "--background": "60 5% 6%" };
    const block = exportBlock(tokens, overrides, { all: false, date, appVersion: "0.2.0" });
    const back = importBlock(tokens, block);
    assert.deepEqual(back.overrides, overrides);
    assert.equal(back.read, 2);
    assert.deepEqual(back.skipped, []);
  });

  it("round-trips a full export to the same changes", () => {
    const overrides = { "--positive": "#55cc90" };
    const block = exportBlock(tokens, overrides, { all: true, date, appVersion: "0.2.0" });
    const back = importBlock(tokens, block);
    assert.deepEqual(back.overrides, overrides);
    assert.equal(back.read, 6);
  });

  it("reads bare declarations, skips unknown names and unsafe values", () => {
    const back = importBlock(tokens, "--surface-1: #000;\n--nope: #fff;\n--text-secondary: </style>;");
    assert.deepEqual(back.overrides, { "--surface-1": "#000" });
    assert.deepEqual(back.skipped.sort(), ["--nope", "--text-secondary"]);
  });

  it("reads nothing from text that holds no declarations", () => {
    assert.equal(importBlock(tokens, "hello").read, 0);
  });
});

describe("storage", () => {
  it("keeps, reads back, and clears", () => {
    const store = memoryStore();
    writeOverrides(store, { "--surface-1": "#151514" });
    assert.deepEqual(JSON.parse(store.data.get(OVERRIDES_KEY)!), { v: 1, tokens: { "--surface-1": "#151514" } });
    assert.deepEqual(readOverrides(store), { "--surface-1": "#151514" });
    writeOverrides(store, {});
    assert.equal(store.data.has(OVERRIDES_KEY), false);
  });

  it("survives junk and a missing store", () => {
    const store = memoryStore();
    store.setItem(OVERRIDES_KEY, "{not json");
    assert.deepEqual(readOverrides(store), {});
    assert.deepEqual(readOverrides(null), {});
    writeOverrides(null, { "--a": "#fff" });
  });
});
