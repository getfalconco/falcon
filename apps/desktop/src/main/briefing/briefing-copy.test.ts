import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { copyProblems } from "../../shared/copy-rules";

/**
 * Some strings written in this folder reach the reader: the reasons a template
 * narrative stands in are shown under it. The rest are log lines, but the scan
 * does not try to tell them apart, because a string that is a log line this
 * week is a reason shown in the panel the next. Every source file here is held
 * to the house rules, the risk-sentence words included.
 */
const DIR = path.dirname(fileURLToPath(import.meta.url));

describe("main/briefing copy", () => {
  const sources = fs
    .readdirSync(DIR)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort();

  it("finds the sources it is meant to scan", () => {
    assert.ok(sources.includes("briefing-store.ts"));
    assert.ok(sources.includes("narrative-service.ts"));
    assert.ok(sources.length >= 8, `only ${sources.length} files found in ${DIR}`);
  });

  for (const name of sources) {
    it(`${name} obeys the copy rules`, () => {
      const src = fs.readFileSync(path.join(DIR, name), "utf8");
      assert.deepEqual(copyProblems(src, { riskWords: true }), []);
    });
  }
});
