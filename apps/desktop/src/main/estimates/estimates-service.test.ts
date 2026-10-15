import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { FAILED_TTL_MS, createEstimatesService } from "./estimates-service";

const n = (raw: number) => ({ raw });

function reply(now: number, ago30: number, revenue = 10e9) {
  return {
    earningsTrend: {
      trend: [
        {
          period: "0q",
          endDate: "2026-12-31",
          earningsEstimate: { numberOfAnalysts: n(12) },
          revenueEstimate: { avg: n(revenue), numberOfAnalysts: n(10) },
          epsTrend: { current: n(now), "7daysAgo": n(now), "30daysAgo": n(ago30), "90daysAgo": n(ago30) },
          epsRevisions: { upLast7days: n(1), upLast30days: n(6), downLast30days: n(0), downLast7Days: n(0) },
        },
      ],
    },
  };
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falcon-estimates-"));
}

describe("estimates service", () => {
  it("reads a name once while the reading is fresh, and again after", async () => {
    let clock = Date.parse("2026-10-15T15:00:00Z");
    let calls = 0;
    const svc = createEstimatesService({
      dir: tmpDir(),
      now: () => clock,
      fetchTrend: async () => {
        calls++;
        return reply(1.1, 1);
      },
    });
    const first = await svc.one("MU");
    assert.equal(first?.periods[0]?.change30?.value, 0.1);
    await svc.many(["MU", "MU"]);
    assert.equal(calls, 1);
    clock += 31 * 60_000;
    await svc.one("MU");
    assert.equal(calls, 2);
    await svc.flush();
  });

  it("shares one read between callers asking at the same time", async () => {
    let calls = 0;
    const svc = createEstimatesService({
      dir: tmpDir(),
      fetchTrend: async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 5));
        return reply(1, 1);
      },
    });
    await Promise.all([svc.one("IBM"), svc.one("IBM"), svc.many(["IBM"])]);
    assert.equal(calls, 1);
    await svc.flush();
  });

  it("holds a failure for a few minutes and keeps the last figures", async () => {
    let clock = Date.parse("2026-10-15T15:00:00Z");
    let fail = false;
    let calls = 0;
    const svc = createEstimatesService({
      dir: tmpDir(),
      now: () => clock,
      fetchTrend: async () => {
        calls++;
        if (fail) throw new Error("Market data request timed out");
        return reply(1.1, 1);
      },
    });
    await svc.one("NFLX");
    fail = true;
    clock += 31 * 60_000;
    const kept = await svc.one("NFLX");
    assert.equal(kept?.ticker, "NFLX");
    await svc.one("NFLX");
    assert.equal(calls, 2);
    clock += FAILED_TTL_MS + 1;
    await svc.one("NFLX");
    assert.equal(calls, 3);
    await svc.flush();
  });

  it("answers null for a name the provider has nothing on", async () => {
    const svc = createEstimatesService({ dir: tmpDir(), fetchTrend: async () => null });
    assert.deepEqual(await svc.many(["ZZZZ"]), { ZZZZ: null });
  });

  it("records the revenue estimate a day at a time and compares with a month back", async () => {
    const dir = tmpDir();
    let clock = Date.parse("2026-09-15T15:00:00Z");
    let revenue = 10e9;
    const make = () => createEstimatesService({ dir, now: () => clock, fetchTrend: async () => reply(1, 1, revenue) });
    const a = make();
    assert.equal((await a.one("TSLA"))?.periods[0]?.revenue?.change30, null);
    await a.flush();
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "revenue-history.json"), "utf8"));
    assert.deepEqual(saved.TSLA, [{ d: "2026-09-15", p: "0q", e: "2026-12-31", v: 10e9 }]);

    clock = Date.parse("2026-10-15T15:00:00Z");
    revenue = 10.5e9;
    const b = make();
    const change = (await b.one("TSLA"))?.periods[0]?.revenue?.change30;
    assert.equal(change?.fromDate, "2026-09-15");
    assert.ok(Math.abs(change!.pct - 0.05) < 1e-9);
    await b.flush();
  });
});
