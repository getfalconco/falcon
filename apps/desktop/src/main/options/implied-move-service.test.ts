import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { OptionChainRead, OptionContractRead } from "../stock/market-data-service";
import { createImpliedMoveService } from "./implied-move-service";

const EXPIRIES = ["2026-10-16", "2026-10-19", "2026-10-21", "2026-10-23", "2026-10-26"];

function legs(straddle: number): OptionContractRead[] {
  return [920, 930, 940].map((strike) => ({ strike, bid: straddle / 2 - 0.1, ask: straddle / 2 + 0.1, last: null, lastTradeSec: null }));
}

/** A chain whose at the money straddle grows with the expiry: 1% a session before the report, 6% on it. */
function fakeChains() {
  const calls: string[] = [];
  const straddleFor: Record<string, number> = {
    "2026-10-16": 20,
    "2026-10-19": 26,
    "2026-10-21": 30,
    "2026-10-23": 60,
    "2026-10-26": 62,
  };
  const fetchChain = async (symbol: string, expiry?: string): Promise<OptionChainRead | null> => {
    calls.push(`${symbol}|${expiry ?? ""}`);
    if (symbol === "NOPE") return null;
    const e = expiry ?? EXPIRIES[0]!;
    const s = straddleFor[e] ?? 0;
    return { symbol, spot: 930, expirations: EXPIRIES, expiry: e, calls: legs(s), puts: legs(s) };
  };
  return { calls, fetchChain };
}

const PAST = [0.02, -0.07, 0.03, -0.09, 0.05, 0.01, -0.04, 0.08].map((move, i) => ({ date: `2025-0${i + 1}-20`, move }));

describe("implied move service", () => {
  it("reads the covering expiry and the next one, and sets the stock's record against the figure", async () => {
    const { calls, fetchChain } = fakeChains();
    let now = Date.parse("2026-10-15T16:00:00Z");
    const svc = createImpliedMoveService({ fetchChain, reportMoves: async () => PAST, now: () => now });
    const v = await svc.one({ ticker: "MU", date: "2026-10-22", time: "amc" });
    assert.ok(v);
    assert.equal(v.reactionDay, "2026-10-23");
    assert.equal(v.expiry, "2026-10-23");
    assert.equal(v.nextExpiry, "2026-10-26");
    assert.equal(v.adjusted, true);
    assert.equal(v.strike, 930);
    assert.ok(v.move < v.raw && v.raw > 0.06);
    assert.equal(v.history.n, 8);
    // 6.45% to the Oct 23 expiry less six ordinary sessions read from Oct 26: about 4.9%.
    assert.ok(Math.abs(v.move - 0.0494) < 0.001, String(v.move));
    assert.equal(v.history.above, PAST.filter((m) => Math.abs(m.move) > v.move).length);
    assert.equal(v.history.above, 4);
    assert.equal(v.history.median, 0.045);
    assert.deepEqual(calls, ["MU|", "MU|2026-10-23", "MU|2026-10-26"]);

    // Within the open session's few minutes, nothing is read again.
    now += 2 * 60_000;
    await svc.one({ ticker: "MU", date: "2026-10-22", time: "amc" });
    assert.equal(calls.length, 3);
    // After them, the snapshots are read again.
    now += 4 * 60_000;
    await svc.one({ ticker: "MU", date: "2026-10-22", time: "amc" });
    assert.equal(calls.length, 6);
  });

  it("asks a closed market once, until the next open", async () => {
    const { calls, fetchChain } = fakeChains();
    let now = Date.parse("2026-10-17T15:00:00Z"); // Saturday
    const svc = createImpliedMoveService({ fetchChain, reportMoves: async () => PAST, now: () => now });
    await svc.one({ ticker: "MU", date: "2026-10-22", time: "amc" });
    const first = calls.length;
    now += 20 * 3_600_000; // Sunday
    await svc.one({ ticker: "MU", date: "2026-10-22", time: "amc" });
    assert.equal(calls.length, first);
    now = Date.parse("2026-10-19T13:31:00Z"); // Monday, after the open
    await svc.one({ ticker: "MU", date: "2026-10-22", time: "amc" });
    assert.ok(calls.length > first);
  });

  it("holds a failed read the same way, and answers null", async () => {
    let n = 0;
    const svc = createImpliedMoveService({
      fetchChain: async () => {
        n++;
        throw new Error("down");
      },
      reportMoves: async () => PAST,
      now: () => Date.parse("2026-10-17T15:00:00Z"),
    });
    assert.equal(await svc.one({ ticker: "MU", date: "2026-10-22", time: "amc" }), null);
    assert.equal(await svc.one({ ticker: "MU", date: "2026-10-22", time: "amc" }), null);
    assert.equal(n, 1);
  });

  it("answers null for a name without options and for a past report", async () => {
    const { fetchChain } = fakeChains();
    const svc = createImpliedMoveService({ fetchChain, reportMoves: async () => PAST, now: () => Date.parse("2026-10-15T16:00:00Z") });
    const out = await svc.many([
      { ticker: "NOPE", date: "2026-10-22", time: "amc" },
      { ticker: "MU", date: "2026-10-01", time: "amc" },
    ]);
    assert.deepEqual(out, { NOPE: null, MU: null });
  });

  it("shows the sample but no comparison under four reports", async () => {
    const { fetchChain } = fakeChains();
    const svc = createImpliedMoveService({ fetchChain, reportMoves: async () => PAST.slice(0, 3), now: () => Date.parse("2026-10-15T16:00:00Z") });
    const v = await svc.one({ ticker: "MU", date: "2026-10-22", time: "amc" });
    assert.deepEqual([v?.history.n, v?.history.above, v?.history.median], [3, null, null]);
  });
});
