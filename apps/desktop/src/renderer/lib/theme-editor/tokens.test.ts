import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyValue, groupTokens, isDarkSelector, parseDarkTokens, styleRules } from "./tokens";

const here = path.dirname(fileURLToPath(import.meta.url));
const GLOBALS = fs.readFileSync(path.join(here, "..", "..", "globals.css"), "utf8");

/** The value a selector-exact block in the file gives a name, read with a plain regex, independent of the parser. */
function rawDark(name: string): string | undefined {
  const blocks = [...GLOBALS.matchAll(/(^|\n)\[data-theme="dark"\] \{([^}]*)\}/g)].map((m) => m[2]!);
  let found: string | undefined;
  for (const block of blocks) {
    const m = new RegExp(`${name.replace(/-/g, "\\-")}:\\s*([^;]+);`).exec(block);
    if (m) found = m[1]!.trim();
  }
  return found;
}

describe("parseDarkTokens on a small sheet", () => {
  const css = `
    @tailwind base;
    @layer base { :root, [data-theme="dark"] { --ds-gray-100: hsla(0, 0%, 14%, 1); } }
    :root, [data-theme="dark"] {
      --font-sans: "Urbanist Variable", system-ui; /* not a colour */
      --font-alias: var(--font-sans);
      --radius: 0.375rem;
      --background: 0 0% 3.5%;
      --cta-bg: #ffffff;
    }
    [data-theme="light"] { --surface-1: rgba(255, 255, 255, 0.4); }
    [data-theme="dark"] {
      --surface-1: #131312;
      --cta-bg: #f4f3ef;
      --positive: #4fbf87;
      --ink-rgb: 232 231 227;
      --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.35);
    }
    :root, [data-theme="light"], [data-theme="dark"] {
      --positive-soft: color-mix(in srgb, var(--positive) 14%, transparent);
    }
    [data-theme="dark"] .bg-white { background-color: var(--surface-3); }
    @media (min-width: 10px) { [data-theme="dark"] { --surface-2: #ff0000; } }
  `;
  const tokens = parseDarkTokens(css);
  const byName = new Map(tokens.map((t) => [t.name, t]));

  it("takes every rule that names dark on its own, later rules winning", () => {
    assert.equal(byName.get("--surface-1")?.value, "#131312");
    assert.equal(byName.get("--cta-bg")?.value, "#f4f3ef");
    assert.equal(byName.get("--ds-gray-100")?.value, "hsla(0, 0%, 14%, 1)");
  });

  it("skips light-only rules, rules reaching into dark, media queries and non-colours", () => {
    assert.ok(!byName.has("--surface-2"));
    assert.ok(!byName.has("--font-sans"));
    assert.ok(!byName.has("--font-alias"));
    assert.ok(!byName.has("--radius"));
  });

  it("classifies each value by how it is written", () => {
    assert.equal(byName.get("--surface-1")?.kind, "color");
    assert.equal(byName.get("--positive-soft")?.kind, "derived");
    assert.equal(byName.get("--background")?.kind, "hsl-channels");
    assert.equal(byName.get("--ink-rgb")?.kind, "rgb-channels");
    assert.equal(byName.get("--shadow-card")?.kind, "shadow");
  });

  it("orders by the documented groups", () => {
    assert.deepEqual(
      groupTokens(tokens).map((g) => g.group),
      ["surfaces", "text", "tones", "cta", "shadows", "legacy"],
    );
    assert.deepEqual(
      tokens.map((t) => t.name),
      ["--surface-1", "--ink-rgb", "--positive", "--positive-soft", "--cta-bg", "--shadow-card", "--ds-gray-100", "--background"],
    );
  });
});

describe("parseDarkTokens on globals.css", () => {
  const tokens = parseDarkTokens(GLOBALS);
  const byName = new Map(tokens.map((t) => [t.name, t]));

  it("finds every documented token, with the file's dark value", () => {
    const documented = [
      "--surface-0", "--surface-1", "--surface-2", "--surface-3", "--surface-4", "--surface-sunken",
      "--fill-hover", "--fill-press", "--fill-selected", "--fill-strong",
      "--border-subtle", "--border-default", "--border-strong", "--highlight", "--focus-ring",
      "--text-primary", "--text-body", "--text-secondary", "--text-tertiary", "--text-disabled",
      "--positive", "--negative", "--warning", "--info", "--teal", "--violet", "--pink",
      "--cta-bg", "--cta-fg", "--primary-bg", "--primary-fg", "--switch-on", "--switch-off",
      "--backdrop", "--shadow-card", "--shadow-popover", "--shadow-modal", "--chart-ink",
    ];
    for (const name of documented) {
      const token = byName.get(name);
      assert.ok(token, `${name} missing`);
      const raw = rawDark(name);
      if (raw !== undefined) assert.equal(token.value, raw.replace(/\s+/g, " "), name);
    }
  });

  it("lists each tone's -muted, -soft and -line as separate, derived tokens", () => {
    for (const tone of ["positive", "negative", "warning", "info", "teal", "violet", "pink"]) {
      for (const role of ["muted", "soft", "line"]) {
        const token = byName.get(`--${tone}-${role}`);
        assert.equal(token?.kind, "derived", `--${tone}-${role}`);
        assert.equal(token?.group, "tones");
      }
    }
  });

  it("puts each token in exactly one group, the documented ones never in the legacy group", () => {
    const names = tokens.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of ["--surface-1", "--text-primary", "--cta-bg", "--switch-on", "--backdrop", "--chart-ink"]) {
      assert.notEqual(byName.get(name)?.group, "legacy", name);
    }
  });
});

describe("helpers", () => {
  it("recognises a dark selector only on its own", () => {
    assert.ok(isDarkSelector('[data-theme="dark"]'));
    assert.ok(isDarkSelector(':root, [data-theme="dark"]'));
    assert.ok(isDarkSelector("[data-theme=dark]"));
    assert.ok(!isDarkSelector('[data-theme="dark"] .bg-white'));
    assert.ok(!isDarkSelector('[data-theme="light"]'));
  });

  it("flattens @layer blocks and skips statements", () => {
    const rules = styleRules("@tailwind base; @layer x { .a { color: red; } } .b { color: blue; }");
    assert.deepEqual(rules.map((r) => r.selector), [".a", ".b"]);
  });

  it("classifies", () => {
    assert.equal(classifyValue("transparent"), "color");
    assert.equal(classifyValue("2px"), null);
    assert.equal(classifyValue('"Urbanist Variable", sans-serif'), null);
  });
});
