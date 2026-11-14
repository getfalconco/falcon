import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { nyseSessions } from "../src/study/abnormal.ts";
import { seededRandom } from "../src/study/stats.ts";
import type { QuietRow } from "../src/options/flow.ts";
import {
  benjaminiHochberg,
  clusteredDiffTest,
  confirms,
  dedupHits,
  deOverlap,
  emptyFlowDay,
  fillSessions,
  flowPass,
  flowSum,
  h1Events,
  h1Primary,
  outcomeAfter,
  ownEventNear,
  permuteWithin,
  quantile,
  quietPass,
  shuffledSignals,
  splitHalves,
  summarize,
  thetaOf,
  type HitCandidate,
  type Outcome,
} from "../src/options/study-flow.ts";

const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} vs ${b}`);

function row(date: string, over: Partial<QuietRow> = {}): QuietRow {
  return { date, windowDays: 5, netSignedDollar: 1e6, imbalance: 0.2, positiveDays: 3, ret: 0, sigma: 0.02, zMove: 0.1, quiet: true, score: 0.18, ...over };
}

describe("helpers", () => {
  it("quantile interpolates and ignores non-finite values", () => {
    close(quantile([1, 2, 3, 4, 5], 0.5), 3);
    close(quantile([1, 2, 3, 4], 0.8), 3.4);
    close(quantile([NaN, 10], 0.3), 10);
    assert.ok(Number.isNaN(quantile([], 0.5)));
  });

  it("deOverlap keeps events at least gap sessions apart", () => {
    assert.deepEqual(deOverlap([1, 2, 5, 11, 12, 21, 40], 10), [1, 11, 21, 40]);
    assert.deepEqual(deOverlap([], 10), []);
  });

  it("Benjamini-Hochberg step-up over two tests", () => {
    assert.deepEqual(benjaminiHochberg([0.02, 0.04]), [true, true]);
    assert.deepEqual(benjaminiHochberg([0.03, 0.2]), [false, false]);
    assert.deepEqual(benjaminiHochberg([0.2, 0.01]), [false, true]);
    assert.deepEqual(benjaminiHochberg([0.049, 0.05]), [true, true]);
  });

  it("fillSessions puts an empty day on every session with no data", () => {
    const s = ["2024-01-02", "2024-01-03", "2024-01-04"];
    const f = fillSessions([{ ...emptyFlowDay("2024-01-03"), trades: 5, signedShare: 0.5 }], s);
    assert.deepEqual(f.map((d) => d.date), s);
    assert.equal(f[1]!.trades, 5);
    assert.equal(f[0]!.signedShare, 0);
  });

  it("splitHalves splits by date", () => {
    const { early, late } = splitHalves([{ date: "2024-03-01" }, { date: "2024-01-01" }, { date: "2024-02-01" }]);
    assert.deepEqual(early.map((x) => x.date), ["2024-01-01"]);
    assert.deepEqual(late.map((x) => x.date), ["2024-02-01", "2024-03-01"]);
  });
});

describe("clusteredDiffTest", () => {
  it("gives the group means and, with one obs per cluster, the HC0 x small-sample SE", () => {
    const ys = [1, 2, 3, 10, 12, 14];
    const g = [false, false, false, true, true, true];
    const keys = ys.map((_, i) => String(i));
    const r = clusteredDiffTest(ys, g, keys);
    close(r.mean0, 2);
    close(r.mean1, 12);
    close(r.diff, 10);
    // HC0: sum u^2 / n^2 per group = 2/9 + 8/9 = 10/9; CR1 factor 6/5 * 5/4.
    close(r.se, Math.sqrt((10 / 9) * (6 / 5) * (5 / 4)));
    assert.equal(r.df, 5);
    assert.ok(r.pOneSided < 0.01);
  });

  it("a shock shared by both groups in a cluster does not inflate the SE much", () => {
    const rnd = seededRandom(7);
    const ys: number[] = [];
    const g: boolean[] = [];
    const keys: string[] = [];
    for (let c = 0; c < 20; c++) {
      const shock = rnd() * 4 - 2;
      for (let k = 0; k < 5; k++) {
        ys.push(shock + rnd());
        g.push(k % 2 === 0);
        keys.push(`c${c}`);
      }
    }
    const one = clusteredDiffTest(ys, g, ys.map((_, i) => String(i)));
    const cl = clusteredDiffTest(ys, g, keys);
    close(one.diff, cl.diff);
    assert.equal(cl.clusters, 20);
    assert.equal(cl.df, 19);
    // A shock shared by both groups within a cluster cancels in the difference.
    assert.ok(cl.se < one.se * 1.5);
  });

  it("p is one-sided: a negative difference gives p > 0.5", () => {
    const r = clusteredDiffTest([5, 6, 7, 1, 2, 3], [false, false, false, true, true, true], ["a", "b", "c", "d", "e", "f"]);
    assert.ok(r.diff < 0 && r.pOneSided > 0.5);
  });
});

describe("summarize", () => {
  it("date-clustered mean, hit rate and one-sided p", () => {
    const s = summarize([1, 2, -1, 3, NaN], ["d1", "d1", "d2", "d3", "d4"])!;
    assert.equal(s.n, 4);
    assert.equal(s.g, 3);
    close(s.mean, 1.25);
    close(s.hitRate, 0.75);
    assert.ok(s.p > 0 && s.p < 0.5);
    assert.equal(summarize([], []), null);
  });
});

describe("H1 rules", () => {
  it("theta is the name's own 80th percentile, floored at 0", () => {
    const rows = [0.1, 0.2, 0.3, 0.4, 0.5].map((x, i) => row(`d${i}`, { imbalance: x }));
    close(thetaOf(rows, 5, 0.8, "buy"), 0.42);
    const neg = [-0.5, -0.4, -0.3, -0.2, -0.1].map((x, i) => row(`d${i}`, { imbalance: x }));
    assert.equal(thetaOf(neg, 5, 0.8, "buy"), 0);
    close(thetaOf(neg, 5, 0.8, "sell"), -0.42);
    // Partial windows do not count: no full window, no threshold (no signal can pass).
    assert.ok(Number.isNaN(thetaOf([row("x", { windowDays: 4, imbalance: 0.9 })], 5, 0.8, "buy")));
  });

  it("flow pass needs a full window, the right sign and the threshold; quiet needs zMove <= 0.5", () => {
    assert.equal(flowPass(row("a"), 5, 0.1, "buy"), true);
    assert.equal(flowPass(row("a", { imbalance: 0.05 }), 5, 0.1, "buy"), false);
    assert.equal(flowPass(row("a", { netSignedDollar: -1 }), 5, 0, "buy"), false);
    assert.equal(flowPass(row("a", { windowDays: 4 }), 5, 0.1, "buy"), false);
    assert.equal(flowPass(row("a", { netSignedDollar: -1, imbalance: -0.3 }), 5, -0.2, "sell"), true);
    assert.equal(quietPass(row("a", { zMove: 0.5 })), true);
    assert.equal(quietPass(row("a", { zMove: 0.51 })), false);
    assert.equal(quietPass(row("a", { zMove: null })), false);
  });

  it("events are de-overlapped per name and measured against same-date non-signal names", () => {
    const sessions = nyseSessions("2024-01-02", "2024-03-29");
    const d = (i: number) => sessions[i]!;
    const outcomes = new Map<string, Map<string, Outcome>>();
    const eligible = new Map<string, string[]>();
    for (const [t, base] of [["A", 0.05], ["B", 0.01], ["C", -0.01]] as const) {
      const m = new Map<string, Outcome>();
      for (let i = 0; i < 40; i++) m.set(d(i), { car10: base, car5: base / 2 });
      outcomes.set(t, m);
      eligible.set(t, sessions.slice(0, 40));
    }
    // A signals on 0, 3 (overlaps), 12; B on 3.
    const signals = new Map([["A", new Set([d(0), d(3), d(12)])], ["B", new Set([d(3)])]]);
    const ev = h1Events({ sessions, outcomes, signals, eligible, gap: 10 });
    assert.deepEqual(ev.map((e) => `${e.ticker}@${sessions.indexOf(e.date)}`), ["A@0", "B@3", "A@12"]);
    const a0 = ev.find((e) => e.ticker === "A" && e.date === d(0))!;
    // Control on day 0: B and C (no signal) -> mean 0.
    close(a0.control10, 0);
    close(h1Primary(a0), 5);
    const b3 = ev.find((e) => e.ticker === "B")!;
    // Day 3: A and B both signalled; control = C alone.
    close(b3.control10, -0.01);
    // Same name's non-signal mean for B is its constant 0.01.
    close(b3.sameName10, 0.01);
  });

  it("the placebo keeps the number of flow flags per date and each name's quiet flag", () => {
    const perDate = new Map([
      ["d1", [{ ticker: "A", flow: true, quiet: true }, { ticker: "B", flow: false, quiet: true }, { ticker: "C", flow: false, quiet: false }]],
      ["d2", [{ ticker: "A", flow: true, quiet: false }, { ticker: "B", flow: true, quiet: true }]],
    ]);
    const rnd = seededRandom(3);
    for (let k = 0; k < 50; k++) {
      const s = shuffledSignals(perDate, rnd);
      let d1 = 0;
      for (const [t, set] of s) {
        assert.notEqual(t, "C");
        if (set.has("d1")) d1++;
      }
      assert.ok(d1 <= 1);
      assert.equal(s.get("A")?.has("d2") ?? false, false);
    }
  });
});

describe("H3 rules", () => {
  it("dedupHits keeps one hit per ticker-day and drops conflicting directions", () => {
    const c = (hit: string, day0: number, direction: 1 | -1, supplyChain = false): HitCandidate => ({ hit, day0, direction, event: `${hit}${direction}`, relation: "competitor", supplyChain });
    const out = dedupHits([c("X", 5, 1), c("X", 5, 1, true), c("Y", 5, 1), c("Y", 5, -1), c("Z", 7, -1)]);
    assert.deepEqual(out.map((h) => `${h.hit}${h.day0}`), ["X5", "Z7"]);
    assert.equal(out[0]!.supplyChain, true);
  });

  it("flowSum and confirms read the signed dollars the implied way", () => {
    const day = (buy: number, sell: number) => ({ ...emptyFlowDay("x"), buyDollar: buy, sellDollar: sell });
    const arr = [day(10, 5), undefined, day(0, 0), day(1, 8)];
    const f = flowSum(arr, 0, 3);
    assert.deepEqual(f, { net: -2, buy: 11, sell: 13, days: 2 });
    assert.equal(confirms(f, -1), true);
    assert.equal(confirms(f, 1), false);
    assert.equal(confirms(flowSum(arr, 1, 2), 1), null);
    // De-biased: the name's usual imbalance is subtracted first.
    assert.equal(confirms(f, 1, -0.2), true);
  });

  it("ownEventNear looks in [day0 - before, day0 + after]", () => {
    assert.equal(ownEventNear([10], 11, 1, 12), true);
    assert.equal(ownEventNear([23], 11, 1, 12), true);
    assert.equal(ownEventNear([24], 11, 1, 12), false);
    assert.equal(ownEventNear([9], 11, 1, 12), false);
    assert.equal(ownEventNear(undefined, 11, 1, 12), false);
  });

  it("permuteWithin shuffles labels only inside each key", () => {
    const labels = [true, false, false, true, true, false];
    const keys = ["a", "a", "a", "b", "b", "c"];
    const rnd = seededRandom(11);
    for (let k = 0; k < 20; k++) {
      const p = permuteWithin(labels, keys, rnd);
      assert.equal(p.slice(0, 3).filter(Boolean).length, 1);
      assert.deepEqual(p.slice(3, 5), [true, true]);
      assert.equal(p[5], false);
    }
  });
});

describe("outcomeAfter", () => {
  it("measures the CAR from the next open with the market model", () => {
    const sessions = nyseSessions("2022-01-03", "2023-06-30");
    const n = sessions.length;
    const rnd = seededRandom(5);
    const m: number[] = [];
    const s: number[] = [];
    let pm = 100;
    let ps = 50;
    for (let i = 0; i < n; i++) {
      const r = (rnd() - 0.5) * 0.02;
      const e = (rnd() - 0.5) * 0.002;
      if (i > 0) {
        pm *= 1 + r;
        // Beta 1.5, no alpha, plus a +1% a day abnormal return after session n - 30.
        ps *= 1 + 1.5 * r + e + (i > n - 30 ? 0.01 : 0);
      }
      m.push(pm);
      s.push(ps);
    }
    const series = (c: number[]) => ({ close: c, open: c.map((x, i) => (i === 0 ? x : c[i - 1]!)) });
    const o = outcomeAfter(sessions, series(s), series(m), n - 30);
    assert.ok(o.car10 > 0.08 && o.car10 < 0.12, `car10 ${o.car10}`);
    assert.ok(o.car5 > 0.03 && o.car5 < 0.07, `car5 ${o.car5}`);
    const late = outcomeAfter(sessions, series(s), series(m), n - 3);
    assert.ok(Number.isNaN(late.car10));
  });
});
