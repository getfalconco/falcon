import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeHorizonReturn, resolveWindow, sectorMedianReturn, windowReturn } from "./returns.js";
import { contextFrom, flatSeries, seriesFrom, tradingDays } from "./test-fixtures.js";

const close = (a: number | null, b: number, tol = 1e-9) => {
  assert.ok(a != null, "expected a number, got null");
  assert.ok(Math.abs(a - b) <= tol, `${a} != ${b}`);
};

const days = tradingDays(30);

describe("quantlab/returns — exposure windows", () => {
  const { calendar } = contextFrom({ series: [flatSeries("SPY", days)] });

  it("signal_close runs close(S) → close(S+h)", () => {
    const w = resolveWindow(calendar, days[10], "signal_close", 5)!;
    assert.equal(w.entry, days[10]);
    assert.equal(w.exit, days[15]);
  });

  it("next_open runs open(S+1) → close(S+h), which is also h sessions", () => {
    const w = resolveWindow(calendar, days[10], "next_open", 5)!;
    assert.equal(w.entry, days[11]);
    // open of 11 through close of 15 is sessions 11,12,13,14,15
    assert.equal(w.exit, days[15]);
  });

  it("both conventions give the same exposure length", () => {
    for (const h of [1, 3, 5, 10]) {
      const a = resolveWindow(calendar, days[5], "signal_close", h)!;
      const b = resolveWindow(calendar, days[5], "next_open", h)!;
      assert.equal(calendar.between(a.entry, a.exit!), h);
      assert.equal(calendar.between(b.entry, b.exit!), h - 1);
    }
  });

  it("a window running off the end of history has no exit rather than a truncated one", () => {
    assert.equal(resolveWindow(calendar, days[28], "signal_close", 5)!.exit, null);
    assert.equal(resolveWindow(calendar, days[29], "next_open", 1), null);
  });

  it("refuses a signal date that is not a session", () => {
    assert.equal(resolveWindow(calendar, "2026-01-01", "signal_close", 5), null);
  });
});

describe("quantlab/returns — raw return goldens", () => {
  it("a constant 1% series returns 1.01^h − 1 over h sessions", () => {
    const ticker = seriesFrom({ ticker: "AAA", days, returns: new Array(29).fill(0.01) });
    const { calendar } = contextFrom({ series: [flatSeries("SPY", days), ticker] });
    for (const h of [1, 3, 5, 10]) {
      const w = resolveWindow(calendar, days[10], "signal_close", h)!;
      close(windowReturn(ticker, w), Math.pow(1.01, h) - 1, 1e-12);
    }
  });

  it("next_open prices the entry at the open, not the prior close", () => {
    // Every open is 2% above its own close, so entering at the open of S+1 and
    // exiting at the close of S+5 costs exactly that 2% premium.
    const ticker = seriesFrom({ ticker: "AAA", days, returns: new Array(29).fill(0.01), openFactor: 1.02 });
    const { calendar } = contextFrom({ series: [flatSeries("SPY", days), ticker] });
    const w = resolveWindow(calendar, days[10], "next_open", 5)!;
    // open(11) = close(11) * 1.02 ; close(15) = close(11) * 1.01^4
    close(windowReturn(ticker, w), Math.pow(1.01, 4) / 1.02 - 1, 1e-12);
  });
});

describe("quantlab/returns — the three layers", () => {
  // Ticker +1%/session, benchmark +0.5%/session, beta 2.
  const ticker = seriesFrom({ ticker: "AAA", days, returns: new Array(29).fill(0.01), beta: 2 });
  const bench = seriesFrom({ ticker: "SPY", days, returns: new Array(29).fill(0.005) });

  it("market-adjusted subtracts beta × benchmark over the same window", () => {
    const { ctx, calendar } = contextFrom({ series: [bench, ticker] });
    const w = resolveWindow(calendar, days[10], "signal_close", 5)!;
    const ret = computeHorizonReturn(ctx, { ticker: "AAA", window: w, holdSessions: 5, sign: 1, beta: 2 });
    const raw = Math.pow(1.01, 5) - 1;
    const benchRet = Math.pow(1.005, 5) - 1;
    close(ret.raw, raw, 1e-12);
    close(ret.market_adjusted, raw - 2 * benchRet, 1e-12);
  });

  it("beta comes from the signal session, so it is not refitted over the hold", () => {
    const { ctx, calendar } = contextFrom({ series: [bench, ticker] });
    const w = resolveWindow(calendar, days[10], "signal_close", 5)!;
    const a = computeHorizonReturn(ctx, { ticker: "AAA", window: w, holdSessions: 5, sign: 1, beta: 1 });
    const b = computeHorizonReturn(ctx, { ticker: "AAA", window: w, holdSessions: 5, sign: 1, beta: 2 });
    assert.notEqual(a.market_adjusted, b.market_adjusted);
  });

  it("a null beta degrades rather than silently assuming beta = 1", () => {
    const { ctx, calendar } = contextFrom({ series: [bench, ticker] });
    const w = resolveWindow(calendar, days[10], "signal_close", 5)!;
    const ret = computeHorizonReturn(ctx, { ticker: "AAA", window: w, holdSessions: 5, sign: 1, beta: null });
    assert.equal(ret.market_adjusted, null);
    assert.ok(ret.degraded.includes("beta_unavailable"));
  });

  it("sector-relative subtracts the peer median and excludes the subject", () => {
    // Three peers at +0.5%, +1%, +1.5% -> median +1%. Subject also +1%.
    const peers = [
      seriesFrom({ ticker: "P1", days, returns: new Array(29).fill(0.005) }),
      seriesFrom({ ticker: "P2", days, returns: new Array(29).fill(0.01) }),
      seriesFrom({ ticker: "P3", days, returns: new Array(29).fill(0.015) }),
    ];
    const { ctx, calendar } = contextFrom({
      series: [bench, ticker, ...peers],
      sectors: { AAA: "Chips", P1: "Chips", P2: "Chips", P3: "Chips" },
      minSectorPeers: 3,
    });
    const w = resolveWindow(calendar, days[10], "signal_close", 5)!;
    const ret = computeHorizonReturn(ctx, { ticker: "AAA", window: w, holdSessions: 5, sign: 1, beta: 2 });
    // Median of the three PEERS (subject excluded) is P2's +1% path.
    close(ret.sector_relative, Math.pow(1.01, 5) - 1 - (Math.pow(1.01, 5) - 1), 1e-12);

    // And the subject really is excluded: the peer median ignores it entirely.
    const peerMedian = sectorMedianReturn(ctx, "AAA", w);
    assert.equal(peerMedian.peers, 3);
    close(peerMedian.value, Math.pow(1.01, 5) - 1, 1e-12);
  });

  it("a sector with too few peers degrades instead of returning a fake zero", () => {
    const { ctx, calendar } = contextFrom({
      series: [bench, ticker],
      sectors: { AAA: "Solo" },
      minSectorPeers: 3,
    });
    const w = resolveWindow(calendar, days[10], "signal_close", 5)!;
    const ret = computeHorizonReturn(ctx, { ticker: "AAA", window: w, holdSessions: 5, sign: 1, beta: 2 });
    assert.equal(ret.sector_relative, null, "a one-member sector must not score 0.00%");
    assert.ok(ret.degraded.includes("sector_peers_thin"));
  });

  it("an unmapped ticker degrades with its own reason", () => {
    const { ctx, calendar } = contextFrom({ series: [bench, ticker], sectors: {} });
    const w = resolveWindow(calendar, days[10], "signal_close", 5)!;
    const ret = computeHorizonReturn(ctx, { ticker: "AAA", window: w, holdSessions: 5, sign: 1, beta: 2 });
    assert.ok(ret.degraded.includes("sector_unknown"));
  });
});

describe("quantlab/returns — direction signing", () => {
  const falling = seriesFrom({ ticker: "AAA", days, returns: new Array(29).fill(-0.01) });
  const bench = flatSeries("SPY", days);

  it("a correct short counts as a positive return in every layer", () => {
    const { ctx, calendar } = contextFrom({ series: [bench, falling], sectors: {} });
    const w = resolveWindow(calendar, days[10], "signal_close", 5)!;
    const short = computeHorizonReturn(ctx, { ticker: "AAA", window: w, holdSessions: 5, sign: -1, beta: 1 });
    const long = computeHorizonReturn(ctx, { ticker: "AAA", window: w, holdSessions: 5, sign: 1, beta: 1 });
    close(short.raw, -(Math.pow(0.99, 5) - 1), 1e-12);
    assert.ok(short.raw! > 0, "a short on a falling name is positive");
    assert.ok(long.raw! < 0);
    close(short.market_adjusted, -long.market_adjusted!, 1e-12);
  });
});

describe("quantlab/returns — missing data", () => {
  it("a ticker that did not trade the exit session yields no return", () => {
    const gapped = seriesFrom({
      ticker: "AAA",
      days: days.filter((_d, i) => i !== 15),
      returns: new Array(days.length - 2).fill(0.01),
    });
    const { ctx, calendar } = contextFrom({ series: [flatSeries("SPY", days), gapped], sectors: {} });
    const w = resolveWindow(calendar, days[10], "signal_close", 5)!;
    assert.equal(w.exit, days[15]);
    const ret = computeHorizonReturn(ctx, { ticker: "AAA", window: w, holdSessions: 5, sign: 1, beta: 1 });
    assert.equal(ret.raw, null, "a halted exit session is not forward-filled");
    assert.ok(ret.degraded.includes("window_incomplete"));
  });
});
