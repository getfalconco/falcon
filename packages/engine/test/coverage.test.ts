import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { COVERAGE_TTL_MS, readCoverageCache, writeCoverageCache, yahooCoverage } from "../src/yahoo.ts";

describe("coverage cache on disk", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-coverage-"));

  it("writes and reads a count with its age", () => {
    writeCoverageCache(dir, "NVMI", { analysts: 8, marketCapUsd: 1.06e10 }, 1_000);
    assert.deepEqual(readCoverageCache(dir, "NVMI", 1_000 + 5_000), { value: { analysts: 8, marketCapUsd: 1.06e10 }, ageMs: 5_000 });
    assert.equal(readCoverageCache(dir, "NOPE"), null);
  });

  it("answers from a fresh cached copy without reading Yahoo", async () => {
    writeCoverageCache(dir, "ZZCACHED", { analysts: 4, marketCapUsd: null });
    assert.deepEqual(await yahooCoverage("zzcached", dir), { analysts: 4, marketCapUsd: null });
    assert.ok(COVERAGE_TTL_MS >= 2 * 24 * 3_600_000, "kept for days, not hours");
  });
});
