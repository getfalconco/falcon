import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { directionFromEvent, gauge, sessionsSinceEvent } from "./compute.js";
import { contextHash, GaugeCounters, GaugeMemo, memoKey } from "./memo.js";
import { cfg, ctx, inputs, NOW, quant } from "./test-fixtures.js";
import { GAUGE_SCHEMA_VERSION } from "./types.js";

const config = cfg();

describe("gauge/compute — modes", () => {
  it("standalone: six checks, no context", () => {
    const r = gauge(inputs(), config);
    assert.equal(r.schema_version, GAUGE_SCHEMA_VERSION);
    assert.equal(r.mode, "standalone");
    assert.equal(r.context, null);
    assert.deepEqual(
      r.checks.map((c) => c.key),
      ["trend", "regime", "residual", "volume", "stretch", "event_wall"],
    );
    assert.equal(r.summary.overall, "clear");
    assert.equal(r.summary.sentence, "clear — 6 of 6 aligned");
    assert.equal(r.quant_as_of, "2026-08-21");
    assert.equal(r.computed_at, NOW);
  });
  it("context: eight checks with the contextual pair last", () => {
    const r = gauge(inputs(), config, ctx());
    assert.equal(r.mode, "context");
    assert.equal(r.checks.length, 8);
    assert.deepEqual(r.checks.slice(6).map((c) => c.key), ["conflict", "freshness"]);
    assert.equal(r.summary.sentence, "clear — 8 of 8 aligned");
  });
  it("untracked ticker → the single honest state", () => {
    const r = gauge(inputs({ tracked: false, quant: null }), config, ctx());
    assert.equal(r.tracked, false);
    assert.deepEqual(r.checks, []);
    assert.equal(r.summary.overall, null);
    assert.equal(r.summary.sentence, "Not tracked — no gauge.");
    assert.equal(r.ticker, "NVDA");
  });
  it("spec example: blocked — earnings in 1 session binds the sentence over a caution", () => {
    const r = gauge(inputs({ quant: quant({ volume_ratio: 2.5 }), next_earnings: { due_at: "2026-08-24T20:00:00.000Z", sessions_until: 1, fiscal_period: "Q2" } }), config);
    assert.equal(r.summary.overall, "blocked");
    assert.equal(r.summary.sentence, "blocked — earnings in 1 session — typical move 4.9%");
  });
  it("spec example: clear except volume — market not yet looking", () => {
    const r = gauge(inputs({ quant: quant({ volume_ratio: 2.5 }) }), config, ctx());
    assert.equal(r.summary.overall, "clear");
    assert.equal(r.summary.binding_check, "volume");
    const early = gauge(inputs({ quant: quant({ volume_ratio: 0.5 }) }), config, ctx());
    assert.equal(early.summary.overall, "clear");
    assert.equal(early.checks[3].reason, "volume 0.50× its average — early, market not yet looking");
  });
  it("context normalisation: bad direction/source fall back, flag coerced", () => {
    const r = gauge(inputs(), config, { expected_direction: "sideways" as never, event_ts: "2026-08-21T21:00:00.000Z", source: "weird" as never });
    assert.equal(r.context?.expected_direction, null);
    assert.equal(r.context?.source, "manual");
    assert.equal(r.context?.thesis_is_scheduled_event, false);
  });
});

describe("gauge/compute — degraded fixtures (§6)", () => {
  it("fresh listing: null quant fields → n_a set, calibrating banner, summary excludes them", () => {
    const fresh = quant({ beta: null, r2: null, daily_vol: null, vol_regime: null, momentum_5d: null, momentum_20d: null, volume_ratio: 1.1, pct_from_52w_high: null, pct_from_52w_low: null, earnings_rhythm: null });
    const r = gauge(inputs({ ticker: "NEWCO", quant: fresh, history_sessions: 14 }), config);
    const statuses = Object.fromEntries(r.checks.map((c) => [c.key, c.status]));
    assert.deepEqual(statuses, { trend: "n_a", regime: "n_a", residual: "n_a", volume: "pass", stretch: "n_a", event_wall: "pass" });
    assert.equal(r.checks[0].reason, "momentum unavailable — fresh listing, history window not yet full (14 sessions on file)");
    assert.equal(r.summary.unavailable, 4);
    assert.equal(r.summary.evaluable, 2);
    assert.equal(r.summary.aligned, 2);
    assert.equal(r.summary.overall, "clear");
    assert.equal(r.summary.calibrating, true);
  });
  it("no close-run yet (quant null) → every quant check n_a, event wall still evaluable", () => {
    const r = gauge(inputs({ quant: null, next_earnings: { due_at: "x", sessions_until: 2, fiscal_period: null } }), config, ctx());
    const na = r.checks.filter((c) => c.status === "n_a").map((c) => c.key);
    assert.deepEqual(na, ["trend", "regime", "residual", "volume", "stretch"]);
    assert.equal(r.checks.find((c) => c.key === "event_wall")?.status, "caution");
    assert.equal(r.checks.find((c) => c.key === "event_wall")?.reason, "earnings in 2 sessions — typical move unavailable");
    assert.equal(r.summary.calibrating, true);
    assert.equal(r.summary.overall, "clear");
  });
  it("null r² / vol only → those checks n_a, the rest evaluate; not calibrating", () => {
    const r = gauge(inputs({ quant: quant({ r2: null, daily_vol: null, vol_regime: null }) }), config);
    const statuses = Object.fromEntries(r.checks.map((c) => [c.key, c.status]));
    assert.equal(statuses.residual, "n_a");
    assert.equal(statuses.regime, "n_a");
    assert.equal(statuses.stretch, "n_a");
    assert.equal(statuses.trend, "pass");
    assert.equal(r.summary.unavailable, 3);
    assert.equal(r.summary.calibrating, true);
    const partial = gauge(inputs({ quant: quant({ r2: null, vol_regime: null }) }), config);
    assert.equal(partial.summary.unavailable, 2);
    assert.equal(partial.summary.calibrating, false);
  });
});

describe("gauge/compute — sessions since event", () => {
  it("caller-supplied count wins", () => {
    assert.equal(sessionsSinceEvent(ctx({ sessions_since_event: 2 }), NOW), 2);
    assert.equal(sessionsSinceEvent(ctx({ sessions_since_event: -1 }), NOW), 0);
  });
  it("derived: post-close event Thu 08-20 → Fri 08-21 opened → 1 session by Saturday", () => {
    assert.equal(sessionsSinceEvent(ctx({ sessions_since_event: null, event_ts: "2026-08-20T21:30:00.000Z" }), NOW), 1);
  });
  it("derived: intraday event Fri 08-21 (ref close Thu) → Fri counts → 1; Saturday event → 0", () => {
    assert.equal(sessionsSinceEvent(ctx({ sessions_since_event: null, event_ts: "2026-08-21T15:00:00.000Z" }), NOW), 1);
    assert.equal(sessionsSinceEvent(ctx({ sessions_since_event: null, event_ts: "2026-08-22T15:00:00.000Z" }), NOW), 0);
  });
  it("derived: event Mon 08-17 after close → Tue..Fri = 4 sessions → closed", () => {
    const r = gauge(inputs(), config, ctx({ sessions_since_event: null, event_ts: "2026-08-17T21:00:00.000Z" }));
    assert.equal(r.checks[7].status, "fail");
    assert.equal(r.checks[7].values.sessions_since_event, 4);
  });
  it("unparseable event_ts → n_a", () => {
    assert.equal(sessionsSinceEvent(ctx({ sessions_since_event: null, event_ts: "nope" }), NOW), null);
  });
});

describe("gauge/compute — direction mapping, memo, counters", () => {
  it("directionFromEvent maps positive/negative, everything else null", () => {
    assert.equal(directionFromEvent("positive"), "up");
    assert.equal(directionFromEvent("negative"), "down");
    assert.equal(directionFromEvent("mixed"), null);
    assert.equal(directionFromEvent("unclear"), null);
    assert.equal(directionFromEvent(undefined), null);
  });
  it("memo key is (ticker, context-hash); TTL evicts", () => {
    assert.equal(memoKey("nvda", null), "NVDA|standalone");
    assert.notEqual(contextHash(ctx()), contextHash(ctx({ expected_direction: "down" })));
    const memo = new GaugeMemo(1000);
    const r = gauge(inputs(), config);
    memo.set(memoKey("NVDA", null), r, 0);
    assert.equal(memo.get(memoKey("NVDA", null), 500), r);
    assert.equal(memo.get(memoKey("NVDA", null), 1500), null);
  });
  it("daily counter tallies by surface and state and closes out on day rollover", () => {
    const counters = new GaugeCounters("2026-08-22");
    const r = gauge(inputs(), config);
    assert.equal(counters.record("2026-08-22", "panel", r, false), null);
    assert.equal(counters.record("2026-08-22", "drawer", r, true), null);
    assert.equal(counters.record("2026-08-22", "drawer", gauge(inputs({ tracked: false }), config), false), null);
    const snap = counters.snapshot();
    assert.deepEqual(snap.by_surface, { panel: 1, drawer: 2 });
    assert.deepEqual(snap.by_state, { clear: 2, untracked: 1 });
    assert.equal(snap.memo_hits, 1);
    const closed = counters.record("2026-08-23", "panel", r, false);
    assert.equal(closed?.day, "2026-08-22");
    assert.equal(closed?.total, 3);
    assert.equal(counters.snapshot().total, 1);
  });
});
