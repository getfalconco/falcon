import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  RETURN_STOPS,
  compactSignedUsd,
  contrast,
  defaultPeriod,
  heldClasses,
  isCryptoSymbol,
  joinClasses,
  luminance,
  periodReturn,
  periodStart,
  returnDirection,
  returnPercent,
  returnTone,
  valueAt,
} from "./portfolio-return";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date(2026, 9, 25, 15, 0).getTime();

describe("portfolio return math", () => {
  it("is the plain change when no money moved", () => {
    const r = periodReturn({ startValue: 20_000, endValue: 48_480, startAt: NOW - 1000 * DAY, endAt: NOW });
    assert.equal(r.gain, 28_480);
    assert.ok(Math.abs(r.ratio! - 1.424) < 1e-12);
  });

  it("takes deposits out of the gain and weights them by time held (Modified Dietz)", () => {
    const startAt = 0;
    const endAt = 100 * DAY;
    // 10k start, 5k deposited half way, 16k at the end: 1k made.
    const r = periodReturn({ startValue: 10_000, endValue: 16_000, startAt, endAt, flows: [{ t: 50 * DAY, amount: 5_000 }] });
    assert.equal(r.gain, 1_000);
    assert.ok(Math.abs(r.ratio! - 1_000 / 12_500) < 1e-12);
  });

  it("treats a withdrawal as money that left, not as a loss", () => {
    const r = periodReturn({ startValue: 10_000, endValue: 7_000, startAt: 0, endAt: 10, flows: [{ t: 0, amount: -4_000 }] });
    assert.equal(r.gain, 1_000);
    assert.ok(Math.abs(r.ratio! - 1_000 / 6_000) < 1e-12);
  });

  it("ignores flows outside the window and has no ratio over a non-positive base", () => {
    const r = periodReturn({ startValue: 100, endValue: 110, startAt: 10, endAt: 20, flows: [{ t: 5, amount: 1_000 }] });
    assert.equal(r.gain, 10);
    assert.equal(periodReturn({ startValue: 0, endValue: 50, startAt: 0, endAt: 1 }).ratio, null);
  });

  it("reads the value at a moment from the record, or the first record after it", () => {
    const pts = [
      { t: 10, value: 1 },
      { t: 20, value: 2 },
      { t: 30, value: 3 },
    ];
    assert.equal(valueAt(pts, 25)?.value, 2);
    assert.equal(valueAt(pts, 20)?.value, 2);
    assert.equal(valueAt(pts, 5)?.value, 1);
    assert.equal(valueAt(pts, 99)?.value, 3);
    assert.equal(valueAt([], 5), null);
  });

  it("opens each window on the calendar", () => {
    const at = (p: Parameters<typeof periodStart>[0]) => new Date(periodStart(p, NOW, null));
    assert.equal(at("1M").getMonth(), 8);
    assert.equal(at("1M").getDate(), 25);
    assert.equal(at("3M").getMonth(), 6);
    assert.equal(at("YTD").getTime(), new Date(2026, 0, 1).getTime());
    assert.equal(at("1Y").getFullYear(), 2025);
    assert.equal(at("3Y").getFullYear(), 2023);
    assert.equal(periodStart("All", NOW, 1234), 1234);
    // 31 March less a month is the last day of February, not 3 March.
    const march31 = new Date(2026, 2, 31, 12).getTime();
    assert.equal(new Date(periodStart("1M", march31, null)).getDate(), 28);
  });

  it("starts at three years when the record is that long, otherwise all of it", () => {
    assert.equal(defaultPeriod(NOW - 4 * 365 * DAY, NOW), "3Y");
    assert.equal(defaultPeriod(NOW - 200 * DAY, NOW), "All");
    assert.equal(defaultPeriod(null, NOW), "All");
  });
});

describe("portfolio return wording", () => {
  it("formats the gain compact and signed, in the reader's locale", () => {
    assert.equal(compactSignedUsd(28_480, "en-US"), "+$28K");
    assert.equal(compactSignedUsd(-1_240_000, "en-US"), "-$1.2M");
    assert.equal(compactSignedUsd(512, "en-US"), "+$512");
    assert.match(compactSignedUsd(28_480, "tr-TR"), /^\+\$?28\sB(\s\$)?$/);
  });

  it("prints the percentage unsigned, the arrow carries the direction", () => {
    assert.equal(returnPercent(1.424, "en-US"), "142.4%");
    assert.equal(returnPercent(-0.0512, "en-US"), "5.1%");
    assert.equal(returnPercent(1.424, "tr-TR"), "%142,4");
    assert.equal(returnDirection(0.0004), "flat");
    assert.equal(returnDirection(-0.0006), "down");
    assert.equal(returnDirection(0.2), "up");
  });

  it("names the classes held, in order, cash only when it is a real share", () => {
    const pos = (symbol: string, value: number) => ({ symbol, value });
    assert.deepEqual(heldClasses({ cash: 100, positions: [pos("NVDA", 9_000), pos("BTC-USD", 4_000)], brokerage: false }), ["stocks", "crypto"]);
    assert.deepEqual(heldClasses({ cash: 5_000, positions: [pos("SPY", 5_000)], brokerage: true }), ["funds", "cash", "brokerage"]);
    assert.deepEqual(heldClasses({ cash: 10_000, positions: [], brokerage: false }), ["cash"]);
    assert.ok(isCryptoSymbol("X:ETHUSD") && isCryptoSymbol("SOL") && !isCryptoSymbol("SOLV") && !isCryptoSymbol("AAPL"));
    assert.equal(joinClasses(["stocks", "crypto"], "en-US"), "Stocks + crypto");
    assert.equal(joinClasses(["işlem"], "tr-TR"), "İşlem");
  });
});

describe("portfolio return colour", () => {
  const hue = (ratio: number) => returnTone(ratio).edge;

  it("moves continuously with the return, not in two states", () => {
    const seen = new Set<string>();
    for (let r = -0.6; r <= 0.6; r += 0.02) seen.add(hue(r).join(","));
    assert.ok(seen.size > 40, `only ${seen.size} distinct colours`);
    // No jump between neighbouring tenths of a percent anywhere on the scale.
    for (let r = -0.55; r < 0.55; r += 0.001) {
      const a = hue(r);
      const b = hue(r + 0.001);
      assert.ok(Math.max(...a.map((v, i) => Math.abs(v - b[i]!))) <= 3, `jump at ${r.toFixed(3)}`);
    }
  });

  it("holds the ends beyond the outer stops", () => {
    assert.deepEqual(hue(3), hue(RETURN_STOPS[RETURN_STOPS.length - 1]!.at));
    assert.deepEqual(hue(-0.95), hue(RETURN_STOPS[0]!.at));
    assert.deepEqual(returnTone(null).edge, hue(0));
  });

  it("is green for gains, grey near zero, amber then red for losses", () => {
    const [gr, gg, gb] = hue(0.5);
    assert.ok(gg > gr && gg > gb, "a strong gain is green");
    const [zr, zg, zb] = hue(0);
    assert.ok(Math.max(zr, zg, zb) - Math.min(zr, zg, zb) < 16, "zero is a neutral grey");
    const [ar, ag, ab] = hue(-0.06);
    assert.ok(ar > ag && ag > ab, "a small loss is amber");
    const [rr, rg, rb] = hue(-0.5);
    assert.ok(rr > 2 * rg && rr > 2 * rb, "a deep loss is red");
    assert.ok(hue(-0.06)[1] - hue(-0.06)[2] > hue(-0.5)[1] - hue(-0.5)[2], "red has less yellow in it than amber");
  });

  it("keeps the text readable on every background, in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      for (let r = -0.7; r <= 0.7; r += 0.01) {
        const tone = returnTone(r, theme);
        // The figure on the dark oval; the masthead and scope line where the light comes in.
        assert.ok(contrast(tone.text, tone.coreSurface) >= 4.5, `${theme} ${r.toFixed(2)} figure`);
        assert.ok(contrast(tone.muted, tone.edgeSurface) >= 3, `${theme} ${r.toFixed(2)} small text`);
      }
    }
  });

  it("keeps the same structure for every hue: bright edges, dark centre", () => {
    for (let r = -0.6; r <= 0.6; r += 0.05) {
      const tone = returnTone(r);
      assert.ok(luminance(tone.glow) > luminance(tone.edge) && luminance(tone.edge) > luminance(tone.core), `${r.toFixed(2)}`);
      assert.match(tone.background, /^radial-gradient\(ellipse/);
      assert.doesNotMatch(tone.background, /linear-gradient/);
    }
  });

  it("draws the dark theme a little deeper than the light one", () => {
    const l = returnTone(0.3, "light").edge;
    const d = returnTone(0.3, "dark").edge;
    assert.ok(d.reduce((s, v) => s + v, 0) < l.reduce((s, v) => s + v, 0));
  });
});
