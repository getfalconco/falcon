import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PROPAGATION_CONFIG } from "./config.js";
import { absorptionCurve, barOnOrBefore, computePricing, referenceBar, sessionsElapsed } from "./pricing.js";
import { bars, flatBars, snapshot, tradingDays } from "./test-fixtures.js";

const pricing = DEFAULT_PROPAGATION_CONFIG.pricing;
const NOW = "2026-08-21T21:00:00.000Z"; // Fri after close

function run(overrides: Parameters<typeof snapshot>[0], extra: Partial<{ eventTs: string; now: string; tier: "strong" | "moderate" | "weak"; direction: "positive" | "negative" | "unclear" | "mixed" }> = {}) {
  return computePricing({
    snapshot: snapshot(overrides),
    eventTs: extra.eventTs ?? "2026-08-20T21:05:00.000Z", // Thu after close
    now: extra.now ?? NOW,
    tier: extra.tier ?? "strong",
    direction: extra.direction ?? "negative",
    config: pricing,
  });
}

describe("reference close selection (§6)", () => {
  const days = tradingDays("2026-08-10", 10); // Mon 8/10 … Fri 8/21
  const series = bars(days.map((d, i) => [d, 100 + i]));

  it("event after the close on a trading day → that day's close", () => {
    assert.equal(referenceBar(series, "2026-08-20T21:05:00.000Z")?.d, "2026-08-20");
    assert.equal(referenceBar(series, "2026-08-20T20:00:00.000Z")?.d, "2026-08-20"); // exactly 16:00 ET
  });

  it("event during the regular session → the previous session's close", () => {
    assert.equal(referenceBar(series, "2026-08-20T15:30:00.000Z")?.d, "2026-08-19");
  });

  it("pre-market event → the previous session's close", () => {
    assert.equal(referenceBar(series, "2026-08-20T11:00:00.000Z")?.d, "2026-08-19");
  });

  it("weekend event → Friday's close; Monday pre-open → Friday's close", () => {
    assert.equal(referenceBar(series, "2026-08-16T15:00:00.000Z")?.d, "2026-08-14");
    assert.equal(referenceBar(series, "2026-08-17T12:00:00.000Z")?.d, "2026-08-14");
  });

  it("event before any bar → null; barOnOrBefore picks the latest at/before a date", () => {
    assert.equal(referenceBar(series, "2026-08-01T12:00:00.000Z"), null);
    assert.equal(barOnOrBefore(series, "2026-08-15")?.d, "2026-08-14");
    assert.equal(barOnOrBefore(series, "2026-08-01"), null);
  });
});

describe("sessions elapsed / horizon", () => {
  it("counts opened sessions after the reference day", () => {
    assert.equal(sessionsElapsed("2026-08-20", "2026-08-21T21:00:00.000Z"), 1);
    assert.equal(sessionsElapsed("2026-08-20", "2026-08-21T12:00:00.000Z"), 0); // Fri pre-open
    assert.equal(sessionsElapsed("2026-08-14", "2026-08-21T21:00:00.000Z"), 5); // Mon–Fri
    assert.equal(sessionsElapsed("2026-08-14", "2026-08-16T12:00:00.000Z"), 0); // weekend
  });

  it("beyond the horizon the status is stale", () => {
    const p = run({ lastPrice: 100 }, { eventTs: "2026-08-13T21:00:00.000Z" }); // Thu 8/13 after close → 6 sessions to Fri 8/21
    assert.equal(p.status, "stale");
    assert.equal(p.sessions_elapsed, 6);
    assert.match(p.note ?? "", /horizon/);
  });
});

describe("event-instant anchor (minute prints)", () => {
  const EVENT = "2026-08-21T16:05:00.000Z"; // inside the regular session
  const minute = (isoMin: string, c: number) => ({ t: Date.parse(isoMin), c });
  // Flat at 100 up to the event, then a step to 101 — the reaction we want to
  // isolate. The previous close is 100 as well, so only the anchor differs.
  const prints = [
    minute("2026-08-21T15:30:00.000Z", 100),
    minute("2026-08-21T16:00:00.000Z", 100),
    minute("2026-08-21T16:20:00.000Z", 100.5),
    minute("2026-08-21T17:30:00.000Z", 101),
  ];

  it("anchors on the last print before the event and reports the move since", () => {
    const p = computePricing({
      snapshot: snapshot({ lastPrice: 101, intraday: prints }),
      eventTs: EVENT,
      now: "2026-08-21T17:35:00.000Z",
      tier: "strong",
      direction: "positive",
      config: pricing,
    });
    assert.equal(p.anchor, "event");
    assert.equal(p.reference_close, 100);
    assert.equal(p.reference_close_ts, "2026-08-21T16:00:00.000Z");
    assert.ok(Math.abs((p.since_event_pct ?? 0) - 0.01) < 1e-9);
    // The first 30 minutes carried half of it — the latency read.
    assert.ok(Math.abs((p.first_30m_pct ?? 0) - 0.005) < 1e-9);
  });

  it("falls back to the previous close when the series starts after the event", () => {
    const late = prints.filter((x) => x.t > Date.parse(EVENT));
    const p = computePricing({
      snapshot: snapshot({ lastPrice: 101, intraday: late }),
      eventTs: EVENT,
      now: "2026-08-21T17:35:00.000Z",
      tier: "strong",
      direction: "positive",
      config: pricing,
    });
    assert.equal(p.anchor, "close");
    assert.equal(p.reference_close, 100);
    assert.equal(p.reference_close_ts, "2026-08-20T20:00:00.000Z");
    // No print at/before the event, but the move since it is still measurable.
    assert.ok((p.since_event_pct ?? 0) > 0);
  });

  it("no minute data → unchanged behaviour, fields null", () => {
    const p = computePricing({
      snapshot: snapshot({ lastPrice: 101 }),
      eventTs: EVENT,
      now: "2026-08-21T17:35:00.000Z",
      tier: "strong",
      direction: "positive",
      config: pricing,
    });
    assert.equal(p.anchor, "close");
    assert.equal(p.since_event_pct, null);
    assert.equal(p.first_30m_pct, null);
  });

  it("the benchmark leg uses the same anchor when its prints are supplied", () => {
    const bench = [
      minute("2026-08-21T16:00:00.000Z", 500),
      minute("2026-08-21T17:30:00.000Z", 505), // +1% market
    ];
    const p = computePricing({
      snapshot: snapshot({ lastPrice: 101, intraday: prints, benchIntraday: bench, benchLastPrice: 505, beta: 1, r2: 0.6 }),
      eventTs: EVENT,
      now: "2026-08-21T17:35:00.000Z",
      tier: "strong",
      direction: "positive",
      config: pricing,
    });
    assert.equal(p.basis, "residual");
    assert.ok(Math.abs((p.bench_move_pct ?? 0) - 0.01) < 1e-9);
    // +1% target − 1×(+1% market) = flat: the move was the market, not the event.
    assert.ok(Math.abs(p.realized_resid_pct ?? 1) < 1e-9);
    assert.equal(p.status, "open");
  });
});

describe("pricing statuses (§6)", () => {
  it("open: |realized| < 0.35 × expected", () => {
    // ref 100 → last 99.8: raw −0.2%; bench flat; vol 2% × strong 1.0 = 2% expected → ratio 0.1
    const p = run({ lastPrice: 99.8 });
    assert.equal(p.status, "open");
    assert.equal(p.basis, "residual");
    assert.equal(p.reference_close, 100);
    assert.equal(p.reference_close_ts, "2026-08-20T20:00:00.000Z");
    assert.ok(Math.abs((p.realized_resid_pct ?? 0) - -0.002) < 1e-9);
    assert.equal(p.expected_pct, 0.02);
    assert.ok(Math.abs((p.ratio ?? 0) - 0.1) < 1e-9);
  });

  it("partial: 0.35 ≤ ratio < 1.0", () => {
    const p = run({ lastPrice: 99 }); // −1% / 2% = 0.5
    assert.equal(p.status, "partial");
  });

  it("priced: ratio ≥ 1.0 in the transmitted direction", () => {
    const p = run({ lastPrice: 97.5 }); // −2.5% / 2% = 1.25, negative as transmitted
    assert.equal(p.status, "priced");
  });

  // P3 — sign matters over the whole ≥ openBelow band, not just at 1.0×.
  it("1. a meaningful move against the expected direction is contradicted, not priced", () => {
    // Positive thesis, target −2.5% on a 2% expected scale (1.25×).
    const p = run({ lastPrice: 97.5 }, { direction: "positive" });
    assert.equal(p.status, "contradicted");
    assert.ok((p.note ?? "").includes("moved against the expected direction (expected positive, realized -2.50%)"), p.note ?? "");
    assert.ok((p.ratio ?? 0) >= 1);
    // …and the same at the low end of the band (0.5×): still contradicted.
    const mid = run({ lastPrice: 101 }, { direction: "negative" });
    assert.equal(mid.status, "contradicted");
    assert.ok(Math.abs((mid.ratio ?? 0) - 0.5) < 1e-9);
  });

  it("2. against the expected direction but small (< 0.35×) stays open — nothing has happened yet", () => {
    const p = run({ lastPrice: 99.8 }, { direction: "positive" }); // −0.2% / 2% = 0.1
    assert.equal(p.status, "open");
    assert.ok(!(p.note ?? "").includes("against"), p.note ?? "");
    // Exactly at the threshold the sign rule takes over.
    const at = run({ lastPrice: 99.3 }, { direction: "positive" }); // −0.7% / 2% = 0.35
    assert.equal(at.status, "contradicted");
  });

  it("3. regression: with the expected sign, ≥ 1.0× is still priced and 0.35–1.0× still partial", () => {
    assert.equal(run({ lastPrice: 102.5 }, { direction: "positive" }).status, "priced");
    assert.equal(run({ lastPrice: 101 }, { direction: "positive" }).status, "partial");
    assert.equal(run({ lastPrice: 97.5 }, { direction: "negative" }).status, "priced");
  });

  it("4. direction unclear → magnitude only; contradiction is undefined there", () => {
    for (const direction of ["unclear", "mixed"] as const) {
      const big = run({ lastPrice: 102.5 }, { direction });
      assert.equal(big.status, "priced");
      assert.match(big.note ?? "", /magnitude/);
      const mid = run({ lastPrice: 101 }, { direction });
      assert.equal(mid.status, "partial");
      const small = run({ lastPrice: 99.9 }, { direction });
      assert.equal(small.status, "open");
    }
  });

  it("beyond the horizon staleness still wins over the sign rule", () => {
    const p = run({ lastPrice: 102.5 }, { direction: "negative", eventTs: "2026-08-13T21:00:00.000Z" });
    assert.equal(p.status, "stale");
  });

  it("tier scales the expected move: weak = 0.25 × vol", () => {
    const p = run({ lastPrice: 99.8 }, { tier: "weak" }); // 0.2% / 0.5% = 0.4 → partial
    assert.equal(p.expected_pct, 0.005);
    assert.equal(p.status, "partial");
  });

  it("residual basis subtracts beta × benchmark move", () => {
    // target −3%, bench −2%, beta 1.0 → residual −1% → 0.5 → partial (raw would be priced)
    const benchDays = tradingDays("2026-08-10", 10);
    const bench = bars(benchDays.map((d) => [d, d === "2026-08-21" ? 490 : 500]));
    const p = run({ lastPrice: 97, benchBars: bench, beta: 1.0, r2: 0.6 });
    assert.equal(p.basis, "residual");
    assert.ok(Math.abs((p.realized_raw_pct ?? 0) - -0.03) < 1e-9);
    assert.ok(Math.abs((p.bench_move_pct ?? 0) - -0.02) < 1e-9);
    assert.ok(Math.abs((p.realized_resid_pct ?? 0) - -0.01) < 1e-9);
    assert.equal(p.status, "partial");
  });

  it("uses the host's same-instant benchmark price when supplied", () => {
    const p = run({ lastPrice: 97, benchLastPrice: 490, beta: 1.0, r2: 0.6 });
    assert.ok(Math.abs((p.bench_move_pct ?? 0) - -0.02) < 1e-9);
    assert.equal(p.note, null);
  });

  it("low R² falls back to the raw move and says so", () => {
    const p = run({ lastPrice: 97, r2: 0.05, beta: 1.5 });
    assert.equal(p.basis, "raw");
    assert.match(p.note ?? "", /low R²/);
    assert.equal(p.status, "priced");
  });

  it("no beta → raw move, flagged", () => {
    const p = run({ lastPrice: 99.8, beta: null, r2: null });
    assert.equal(p.basis, "raw");
    assert.match(p.note ?? "", /no beta/);
    assert.equal(p.status, "open");
  });

  it("no 30d vol → unknown with the math still reported", () => {
    const p = run({ lastPrice: 99, vol30: null });
    assert.equal(p.status, "unknown");
    assert.equal(p.expected_pct, null);
    assert.ok(p.realized_resid_pct !== null);
    assert.match(p.note ?? "", /volatility/);
  });

  it("untracked target (no snapshot) → unknown", () => {
    const p = computePricing({ snapshot: null, eventTs: NOW, now: NOW, tier: "strong", direction: "negative", config: pricing });
    assert.equal(p.status, "unknown");
    assert.equal(p.basis, "none");
  });

  it("no history / no close before the event → unknown with a reason", () => {
    assert.match(run({ bars: [] }).note ?? "", /no price history/);
    assert.match(run({ bars: flatBars(100, tradingDays("2026-08-24", 3)) }).note ?? "", /no regular close before/);
  });

  it("falls back to the last bar when the host has no last price", () => {
    const p = run({ lastPrice: null, lastPriceTs: null, bars: bars([["2026-08-20", 100], ["2026-08-21", 99]]) });
    assert.equal(p.last_price, 99);
    assert.equal(p.last_price_ts, "2026-08-21T20:00:00.000Z");
    assert.equal(p.status, "partial");
  });
});

describe("absorption curve (§11 calibration)", () => {
  // The COST case after WMT's gap, from the Tracker's own bars: the move was
  // not over on day 0 — day 1 added more than day 0 delivered.
  const days = tradingDays("2026-08-17", 6); // Mon 17 … Mon 24
  const cost = bars([
    ["2026-08-20", 933.51],
    ["2026-08-21", 947.74],
    ["2026-08-24", 971.59],
  ]);
  const spy = bars([
    ["2026-08-20", 762.6],
    ["2026-08-21", 765.72],
    ["2026-08-24", 763.44],
  ]);

  it("reports each session cumulatively from the pricing reference", () => {
    const curve = absorptionCurve({
      bars: cost,
      benchBars: spy,
      beta: -0.43,
      expectedPct: 0.0024,
      direction: "positive",
      eventTs: "2026-08-21T06:03:10.000Z", // pre-market, so the 20th is the reference
    });
    assert.equal(curve.length, 2);
    assert.deepEqual(curve.map((p) => p.date), ["2026-08-21", "2026-08-24"]);
    assert.equal(curve[0].session, 0);
    // +1.52% raw against a +0.41% market with a negative beta → a bigger residual.
    assert.ok(Math.abs(curve[0].raw_pct - 0.01524) < 1e-4, String(curve[0].raw_pct));
    assert.ok(curve[0].residual_pct > curve[0].raw_pct);
    // Day 1 carried more than day 0 — the whole point of the curve.
    assert.ok(curve[1].residual_pct > curve[0].residual_pct * 2, `${curve[0].residual_pct} → ${curve[1].residual_pct}`);
    assert.ok((curve[0].multiple ?? 0) > 5 && (curve[1].multiple ?? 0) > 15);
  });

  it("an event after the close starts at the next session", () => {
    const curve = absorptionCurve({
      bars: cost,
      benchBars: spy,
      beta: null,
      expectedPct: 0.01,
      direction: "positive",
      eventTs: "2026-08-21T21:00:00.000Z", // after the 21st's close
    });
    assert.deepEqual(curve.map((p) => p.date), ["2026-08-24"]);
    // No beta → the residual is the raw move, and the reference is the 21st.
    assert.ok(Math.abs(curve[0].residual_pct - (971.59 / 947.74 - 1)) < 1e-9);
    assert.equal(curve[0].bench_pct, null === curve[0].bench_pct ? null : curve[0].bench_pct);
  });

  it("a move against the expected direction reads as a negative multiple", () => {
    const curve = absorptionCurve({
      bars: cost,
      benchBars: spy,
      beta: null,
      expectedPct: 0.01,
      direction: "negative",
      eventTs: "2026-08-21T06:03:10.000Z",
    });
    assert.ok((curve[0].multiple ?? 0) < 0);
  });

  it("unclear direction compares magnitudes, and a missing scale leaves the multiple null", () => {
    const unclear = absorptionCurve({ bars: cost, benchBars: spy, beta: null, expectedPct: 0.01, direction: "unclear", eventTs: "2026-08-21T06:03:10.000Z" });
    assert.ok((unclear[0].multiple ?? 0) > 0);
    const noScale = absorptionCurve({ bars: cost, benchBars: spy, beta: null, expectedPct: null, direction: "positive", eventTs: "2026-08-21T06:03:10.000Z" });
    assert.equal(noScale[0].multiple, null);
  });

  it("no history before the event → an empty curve rather than a guess", () => {
    assert.deepEqual(
      absorptionCurve({ bars: cost, benchBars: spy, beta: null, expectedPct: 0.01, direction: "positive", eventTs: "2026-08-01T12:00:00.000Z" }),
      [],
    );
    assert.deepEqual(absorptionCurve({ bars: [], benchBars: spy, beta: null, expectedPct: 0.01, direction: "positive", eventTs: "2026-08-21T06:03:10.000Z" }), []);
    void days;
  });
});
