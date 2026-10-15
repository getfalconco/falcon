import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { SECTOR_FAILURE_TTL_MS, SECTOR_TTL_MS, createSectorCache, type SectorRead } from "./sector-cache";

let dir: string;
let nowMs = Date.parse("2026-10-10T09:00:00.000Z");
let calls: string[] = [];
let answer: (symbol: string) => Promise<SectorRead>;

function makeCache() {
  return createSectorCache({
    file: path.join(dir, "sectors.json"),
    now: () => nowMs,
    fetch: (symbol) => {
      calls.push(symbol);
      return answer(symbol);
    },
  });
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-sector-"));
  nowMs = Date.parse("2026-10-10T09:00:00.000Z");
  calls = [];
  answer = async () => ({ sector: "Technology", industry: "Semiconductors", quoteType: "EQUITY" });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("sector cache", () => {
  it("asks once per symbol while the answer is fresh, and again after a month", async () => {
    const cache = makeCache();
    assert.equal(await cache.get("nvda"), "Technology");
    assert.equal(await cache.get("NVDA"), "Technology");
    assert.deepEqual(calls, ["NVDA"]);
    nowMs += SECTOR_TTL_MS + 1;
    await cache.get("NVDA");
    assert.deepEqual(calls, ["NVDA", "NVDA"]);
  });

  it("remembers a failure for an hour instead of retrying", async () => {
    answer = async () => {
      throw new Error("provider down");
    };
    const cache = makeCache();
    await assert.rejects(cache.get("JPM"));
    await assert.rejects(cache.get("JPM"));
    assert.deepEqual(calls, ["JPM"]);
    nowMs += SECTOR_FAILURE_TTL_MS + 1;
    answer = async () => ({ sector: "Financial Services", industry: null, quoteType: "EQUITY" });
    assert.equal(await cache.get("JPM"), "Financials");
  });

  it("survives a restart through the file", async () => {
    const first = makeCache();
    await first.get("XOM");
    first.flush();
    const second = makeCache();
    assert.equal(await second.get("XOM"), "Technology");
    assert.deepEqual(calls, ["XOM"]);
  });

  it("joins concurrent asks for the same symbol", async () => {
    const cache = makeCache();
    await Promise.all([cache.get("AAPL"), cache.get("AAPL"), cache.get("aapl")]);
    assert.deepEqual(calls, ["AAPL"]);
  });
});
