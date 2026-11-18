import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  binomialP,
  buildEarningsMatchup,
  buildForecastMatchup,
  firstForecasts,
  lastClosedSession,
  calendarDays,
  expectedAbsMovePct,
  horizonExit,
  interpolateIv,
  interpolatedImpliedMove,
  meanCi,
  movePct,
  recordAbsPct,
  scoreMatchup,
  sessionsBetween,
  straddleMovePct,
  summarize,
  t975,
  trailingReactionAbsPct,
  wilson,
  type Matchup,
} from "../src/study/scoreboard.ts";

const close = (a: number, b: number, tol: number, msg = "") => assert.ok(Math.abs(a - b) <= tol, `${msg} ${a} vs ${b} (tol ${tol})`);

describe("horizon and term-structure interpolation", () => {
  it("horizonExit counts NYSE sessions after the snapshot (Thanksgiving 2026-11-26 skipped)", () => {
    assert.equal(horizonExit("2026-11-13", 1), "2026-11-16");
    assert.equal(horizonExit("2026-11-13", 5), "2026-11-20");
    assert.equal(horizonExit("2026-11-20", 5), "2026-11-30");
    assert.equal(horizonExit("2026-11-13", 0), null);
    assert.equal(calendarDays("2026-11-13", "2026-11-20"), 7);
    assert.equal(sessionsBetween("2026-11-13", "2026-11-13"), 0);
    assert.equal(sessionsBetween("2026-11-13", "2026-11-16"), 1);
  });

  it("interpolates linearly in total variance, flat outside the curve", () => {
    const term = [
      { expiration: "2026-11-20", days: 7, iv: 0.5 },
      { expiration: "2026-12-18", days: 35, iv: 0.3 },
    ];
    // Midpoint in days: w = (0.25*7 + 0.09*35)/2 = 2.45; iv = sqrt(2.45/21).
    close(interpolateIv(term, 21)!.iv, Math.sqrt(2.45 / 21), 1e-12);
    assert.equal(interpolateIv(term, 21)!.method, "interp");
    assert.deepEqual(interpolateIv(term, 3), { iv: 0.5, method: "front", lo: null, hi: term[0] });
    assert.equal(interpolateIv(term, 90)!.iv, 0.3);
    assert.equal(interpolateIv(term, 35)!.method, "exact");
    assert.equal(interpolateIv([], 10), null);
    assert.equal(interpolateIv([{ expiration: "x", days: 7, iv: Number.NaN }], 10), null);
  });

  it("a flat curve gives iv x sqrt(L/252) x sqrt(2/pi), and the market part comes out of the variance", () => {
    const t = { date: "2026-11-13", term: [{ expiration: "2026-11-20", days: 7, iv: 0.4 }, { expiration: "2027-01-15", days: 63, iv: 0.4 }], beta: 1, vix: 0.2 };
    const mv = interpolatedImpliedMove(t, 20)!;
    close(mv.rawPct, 0.4 * Math.sqrt(20 / 252) * Math.sqrt(2 / Math.PI) * 100, 1e-9);
    close(mv.adjPct!, expectedAbsMovePct(Math.sqrt(0.16 - 0.04), 20), 1e-9);
    assert.equal(mv.exitDate, horizonExit("2026-11-13", 20));
    // Market part bigger than the whole variance: no move beyond the market.
    assert.equal(interpolatedImpliedMove({ ...t, beta: 3 }, 20)!.adjPct, null);
    assert.equal(interpolatedImpliedMove({ ...t, beta: null }, 20)!.adjPct, null);
  });
});

describe("earnings straddle", () => {
  const s = { implied_move: 0.06, expiry: "2026-11-20", strike: 100, call_mid: 3.1, put_mid: 2.9, spot: 100, as_of: "2026-11-17T20:45:00Z", dte: 3 };
  it("reads (call + put) / spot as percent", () => close(straddleMovePct(s, "2026-11-18")!, 6, 1e-9));
  it("refuses an expiry before the reaction day, inconsistent mids or missing fields", () => {
    assert.equal(straddleMovePct(s, "2026-11-23"), null);
    assert.equal(straddleMovePct({ ...s, implied_move: 0.09 }, "2026-11-18"), null);
    assert.equal(straddleMovePct({ ...s, put_mid: 0 }, "2026-11-18"), null);
    assert.equal(straddleMovePct(null, "2026-11-18"), null);
  });
});

describe("realized moves and Falcon's sizes", () => {
  it("movePct and missing closes", () => {
    const c = new Map([["2026-11-13", 100], ["2026-11-20", 105]]);
    close(movePct(c, "2026-11-13", "2026-11-20")!, 5, 1e-9);
    assert.equal(movePct(c, "2026-11-13", "2026-11-27"), null);
  });
  it("recordAbsPct needs 6 events", () => {
    const ev = [1, -2, 3, -4, 5, -6].map((d) => ({ movePct: d + 1, benchmarkPct: 1 }));
    close(recordAbsPct(ev)!, 3.5, 1e-12);
    assert.equal(recordAbsPct(ev.slice(0, 5)), null);
  });
  it("trailing reactions use only earlier releases, newest max first", () => {
    const past = [
      { date: "2025-01-30", pct: 10 },
      { date: "2025-04-30", pct: -2 },
      { date: "2025-07-30", pct: 4 },
      { date: "2025-10-30", pct: -6 },
      { date: "2026-01-30", pct: 8 },
      { date: "2026-04-30", pct: null },
    ];
    assert.deepEqual(trailingReactionAbsPct(past, "2026-01-30", 4, 8), { pct: 5.5, n: 4 });
    assert.deepEqual(trailingReactionAbsPct(past, "2026-05-30", 4, 4), { pct: 5, n: 4 });
    assert.equal(trailingReactionAbsPct(past, "2025-10-30", 4, 8), null);
  });
});

const mk = (o: Partial<Matchup>): Matchup => ({
  kind: "forecast",
  key: "k",
  ticker: "AAA",
  createdAt: "2026-11-14T12:00:00Z",
  horizonSessions: 5,
  baseDate: "2026-11-13",
  exitDate: "2026-11-20",
  falconSign: 1,
  falconAbsPct: 3,
  marketMethod: "term_interp",
  marketRawPct: 5,
  marketAdjPct: 4,
  units: "abnormal",
  realizedRawPct: null,
  realizedAbnPct: null,
  ...o,
});

describe("scoreMatchup", () => {
  it("pending matchups score nothing", () => {
    const s = scoreMatchup(mk({}));
    assert.equal(s.matured, false);
    assert.equal(s.dirHit, null);
    assert.equal(s.ratio, null);
  });
  it("direction on the abnormal move, size in abnormal units, ratio and straddle in raw units", () => {
    const s = scoreMatchup(mk({ realizedRawPct: 7, realizedAbnPct: 2 }));
    assert.equal(s.dirHit, true);
    assert.equal(s.falconErr, 1); // |2 - 3|
    assert.equal(s.marketErr, 2); // |2 - 4|
    close(s.ratio!, 7 / 5, 1e-12);
    close(s.straddle!, 0.4, 1e-12);
    close(s.pnlDir!, 2 / 4, 1e-12);
    // Falcon expects less than the market (3 < 4): short the straddle.
    close(s.pnlVol!, -0.4, 1e-12);
  });
  it("an unclear forecast has no direction or directional P&L; a down call on a fall is a hit", () => {
    const u = scoreMatchup(mk({ falconSign: 0, realizedRawPct: -3, realizedAbnPct: -1 }));
    assert.equal(u.dirHit, null);
    assert.equal(u.pnlDir, null);
    const d = scoreMatchup(mk({ falconSign: -1, realizedRawPct: -3, realizedAbnPct: -1 }));
    assert.equal(d.dirHit, true);
    close(d.pnlDir!, 0.25, 1e-12);
  });
  it("earnings matchups compare in raw units against the straddle", () => {
    const s = scoreMatchup(mk({ kind: "earnings", units: "raw", falconSign: 0, falconAbsPct: 6, marketMethod: "earnings_straddle", marketRawPct: 5, marketAdjPct: 5, realizedRawPct: -8, realizedAbnPct: -7 }));
    assert.equal(s.falconErr, 2);
    assert.equal(s.marketErr, 3);
    close(s.pnlVol!, 0.6, 1e-12);
  });
});

describe("intervals", () => {
  it("wilson matches the textbook value for 8 of 10", () => {
    const w = wilson(8, 10)!;
    close(w.lo, 0.4902, 1e-3);
    close(w.hi, 0.9433, 1e-3);
    assert.equal(wilson(0, 0), null);
  });
  it("exact binomial p", () => {
    close(binomialP(8, 10), 0.109375, 1e-9);
    close(binomialP(5, 10), 1, 1e-9);
    assert.ok(binomialP(600, 1000) < 1e-8);
  });
  it("t975", () => {
    close(t975(1), 12.706, 2e-3);
    close(t975(10), 2.228, 2e-3);
    close(t975(Infinity), 1.96, 1e-3);
  });
  it("meanCi has no interval with one cluster", () => {
    const one = meanCi([1, 2, 3], ["a", "a", "a"])!;
    assert.equal(one.lo, null);
    const two = meanCi([1, 2, 3, 4], ["a", "a", "b", "b"])!;
    assert.ok(two.lo! < 2.5 && two.hi! > 2.5);
  });
});

describe("summarize", () => {
  it("empty and all-pending samples say so", () => {
    assert.match(summarize([]).warnings[0]!, /No matchups/);
    const s = summarize([mk({ key: "a" }), mk({ key: "b", exitDate: "2026-12-14" })]);
    assert.equal(s.pending, 2);
    assert.equal(s.matured, 0);
    assert.equal(s.nextMaturity, "2026-11-20");
    assert.match(s.warnings[0]!, /No matchup has matured yet: 2 waiting, the first on 2026-11-20/);
  });

  it("counts hits, compares sizes, groups by label and warns on small samples", () => {
    const rows: Matchup[] = [];
    for (let i = 0; i < 10; i++) {
      const base = ["2026-11-13", "2026-11-16", "2026-11-17", "2026-11-18", "2026-11-19"][i % 5]!;
      rows.push(mk({ key: `m${i}`, baseDate: base, tier: i < 4 ? "documented" : "watch", confidence: "medium", realizedRawPct: i < 7 ? 6 : -6, realizedAbnPct: i < 7 ? 3.5 : -2 }));
    }
    rows.push(mk({ key: "nomarket", marketRawPct: null, marketAdjPct: null, realizedRawPct: 1, realizedAbnPct: 1 }));
    const s = summarize(rows);
    assert.equal(s.total, 11);
    assert.equal(s.withMarket, 10);
    assert.equal(s.matured, 10);
    assert.equal(s.direction.k, 7);
    assert.equal(s.direction.n, 10);
    assert.equal(s.direction.majoritySign, 1);
    close(s.direction.majorityBaseline!, 0.7, 1e-12);
    // Falcon 3 vs market 4: |3.5| -> 0.5 vs 0.5; |2| -> 1 vs 2.
    close(s.magnitude.falconMae!, (7 * 0.5 + 3 * 1) / 10, 1e-12);
    close(s.magnitude.marketMae!, (7 * 0.5 + 3 * 2) / 10, 1e-12);
    assert.equal(s.magnitude.falconCloser.k, 3);
    close(s.ratio!.mean, 1.2, 1e-12);
    assert.equal(s.exceeded.k, 10);
    assert.deepEqual(s.byTier.map((g) => [g.label, g.n]), [["watch", 6], ["documented", 4]]);
    assert.ok(s.warnings.some((w) => /Direction rests on 10/.test(w)));
    assert.ok(s.direction.ci!.lo < 0.7 && s.direction.ci!.hi > 0.7);
  });
});

describe("building matchups", () => {
  const f = { id: 7, created_at: "2026-11-14T12:17:45Z", event_id: "e1", card_id: "c1", ticker: "FUN", tier: "documented", family: "F7", sign_pred: 1, window_days: 20, published: true, covariates: { confidence: "medium" } };
  const opt = { session: "2026-11-13", asOf: "2026-11-13T20:45:00Z", spot: 27, iv: 0.4, skew: null, beta: 1, vix: 0.2, term: [["2026-11-20", 7, 0.4], ["2027-01-15", 63, 0.4]] as Array<[string, number, number]> };

  it("lastClosedSession: weekend and intraday creations measure from the last completed close", () => {
    assert.equal(lastClosedSession(Date.parse("2026-11-14T12:00:00Z")), "2026-11-13");
    assert.equal(lastClosedSession(Date.parse("2026-11-16T15:00:00Z")), "2026-11-13"); // Monday 10:00 New York
    assert.equal(lastClosedSession(Date.parse("2026-11-16T21:30:00Z")), "2026-11-16");
  });

  it("a weekend forecast pairs with Friday's snapshot over the same 20 sessions", () => {
    const m = buildForecastMatchup(f, null, opt);
    assert.equal(m.baseDate, "2026-11-13");
    assert.equal(m.exitDate, horizonExit("2026-11-13", 20));
    assert.equal(m.optionsLagSessions, 0);
    close(m.marketRawPct!, expectedAbsMovePct(0.4, 20), 1e-9);
    assert.equal(m.tier, "documented");
    assert.equal(m.confidence, "medium");
    assert.equal(m.falconAbsPct, null);
    assert.equal(m.realizedRawPct, null);
  });

  it("an older snapshot is shifted to the base date and its lag counted; a newer one is never used", () => {
    const m = buildForecastMatchup({ ...f, created_at: "2026-11-18T22:00:00Z" }, null, opt);
    assert.equal(m.baseDate, "2026-11-18");
    assert.equal(m.optionsLagSessions, 3);
    assert.ok(m.marketRawPct! > 0);
    const early = buildForecastMatchup({ ...f, created_at: "2026-11-12T22:00:00Z" }, null, opt);
    assert.equal(early.marketRawPct, null);
  });

  it("falls back to the card block for 5 / 20 sessions and takes Falcon's size from the record", () => {
    const events = [1, -2, 3, -4, 5, -6].map((d) => ({ movePct: d, benchmarkPct: 0 }));
    const hit = { history: { avgMovePct: 1.2, windowDays: 20, sample: 6, events }, options: { asOf: "2026-11-13T20:45:00Z", impliedMove20: { rawPct: 25.25, marketAdjustedPct: null } } };
    const m = buildForecastMatchup(f, hit, null, { rawPct: 10, benchPct: 2, benchmark: "XLY" });
    assert.equal(m.marketMethod, "card_block");
    assert.equal(m.marketRawPct, 25.25);
    assert.equal(m.optionsLagSessions, 0);
    close(m.falconAbsPct!, 3.5, 1e-12);
    assert.equal(m.falconSignedPct, 1.2);
    assert.equal(m.realizedAbnPct, 8);
    assert.equal(buildForecastMatchup({ ...f, window_days: 63 }, hit, null).marketRawPct, null);
  });

  it("firstForecasts keeps the first row per event, ticker and horizon, published if any was", () => {
    const rows = [
      { ...f, id: 2, created_at: "2026-11-15T12:00:00Z", published: true, sign_pred: -1 },
      { ...f, id: 1, published: false },
      { ...f, id: 3, window_days: 5 },
    ];
    const out = firstForecasts(rows);
    assert.deepEqual(out.map((r) => [r.id, r.sign_pred, r.published]), [[1, 1, true], [3, 1, true]]);
  });

  it("earnings: the straddle against the trailing reaction, d0 window", () => {
    const st = { implied_move: 0.06, expiry: "2026-11-20", strike: 100, call_mid: 3, put_mid: 3, spot: 100, as_of: "2026-11-17T20:45:00Z", dte: 3 };
    const past = ["2025-11-18", "2026-02-18", "2026-05-18", "2026-08-18"].map((date, i) => ({ date, pct: [4, -5, 6, -7][i]! }));
    const m = buildEarningsMatchup({ ticker: "NVDA", eventDate: "2026-11-18", realizedRawPct: -3, realizedAbnPct: -2.5, window: "d0" }, st, past)!;
    assert.equal(m.baseDate, "2026-11-17");
    assert.equal(m.exitDate, "2026-11-18");
    close(m.marketRawPct!, 6, 1e-9);
    close(m.falconAbsPct!, 5.5, 1e-12);
    const s = scoreMatchup(m);
    close(s.falconErr!, 2.5, 1e-12);
    close(s.marketErr!, 3, 1e-12);
    assert.equal(buildEarningsMatchup({ ticker: "NVDA", eventDate: "2026-11-18", realizedRawPct: null, realizedAbnPct: null, window: "d0" }, null, past), null);
  });
});

describe("forecast_matchups rows", () => {
  it("creation and outcome columns round-trip through matchupFromRow; pending rows have no outcome", async () => {
    const { creationRow, outcomeRow, matchupFromRow } = await import("../src/study/scoreboard-store.ts");
    const straddle = { implied_move: 0.06, expiry: "2026-11-20", strike: 100, call_mid: 3.1, put_mid: 2.9, spot: 100, as_of: "2026-11-17T20:45:00.000Z", dte: 3 };
    const past = [4, 6, 5, 7, 8].map((p, i) => ({ date: `2025-0${i + 1}-15`, pct: p }));
    const pending = buildEarningsMatchup({ ticker: "ABC", eventDate: "2026-11-18", realizedRawPct: null, realizedAbnPct: null, window: "d0" }, straddle, past)!;
    const row = creationRow(pending, { eventId: "0000-1", spot: 100, optionsSession: "2026-11-17", straddle });
    assert.equal(row.key, "earn:ABC:2026-11-18");
    assert.equal(row.market_method, "earnings_straddle");
    assert.equal(row.units, "raw");
    assert.equal(row.straddle, JSON.stringify(straddle));
    assert.equal(outcomeRow(pending), null);
    const back = matchupFromRow({ ...row, created_at: new Date(String(row.created_at)), base_date: new Date(`${row.base_date}T00:00:00Z`) }, { rawPct: -9, abnPct: -8, benchmark: "XLK" });
    assert.equal(back.baseDate, "2026-11-17");
    const o = outcomeRow(back, "yahoo")!;
    close(o.realized_raw_pct as number, -9, 1e-12);
    close(o.benchmark_pct as number, -1, 1e-12);
    close(o.ratio as number, 1.5, 1e-9);
    close(o.market_err as number, 3, 1e-9);
    close(o.falcon_err as number, 3, 1e-9); // trailing mean of |4,6,5,7,8| = 6
    assert.equal(o.dir_hit, null);
  });
});
