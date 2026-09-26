import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, withoutComments } from "../../../shared/copy-rules";

/**
 * The Add Module menu lists the dashboard's cards by hand, beside the union
 * of card kinds the page knows. A card added to the union and forgotten here
 * could be removed from the dashboard and never brought back until the next
 * launch; this test is what notices.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PAGE = withoutComments(fs.readFileSync(path.join(HERE, "..", "..", "pages", "HomePage.tsx"), "utf8"));
const BUTTON = fs.readFileSync(path.join(HERE, "AddModuleButton.tsx"), "utf8");

function cardKinds(): string[] {
  const union = /type CardBase = ([^;]+);/.exec(PAGE);
  assert.ok(union, "type CardBase is not where this test looks");
  return [...union[1]!.matchAll(/"([a-z]+)"/g)].map((m) => m[1]!);
}

function menuIds(): string[] {
  const list = /const MODULES[^=]*= \[([\s\S]*?)\];/.exec(PAGE);
  assert.ok(list, "MODULES is not where this test looks");
  return [...list[1]!.matchAll(/id: "([a-z]+)"/g)].map((m) => m[1]!);
}

describe("add module", () => {
  it("offers every kind of card the dashboard knows, once", () => {
    const kinds = cardKinds();
    const ids = menuIds();
    assert.deepEqual([...ids].sort(), [...kinds].sort());
    assert.equal(new Set(ids).size, ids.length);
  });

  // "add" is on the advice list because "add to the position" is advice. Here
  // it is the name of a dashboard command the reader asked for, about cards
  // and not about holdings, so it is the one word let through; every other
  // word and the dash rule still apply.
  it("follows the copy rules and still says what it does", () => {
    const problems = copyProblems(BUTTON, { riskWords: true, jsxText: true }).filter((p) => !p.startsWith('banned word "add":'));
    assert.deepEqual(problems, []);
    for (const phrase of ["Add Module", "MODULES", "Add a copy"]) assert.ok(BUTTON.includes(phrase), `missing: ${phrase}`);
  });
});
