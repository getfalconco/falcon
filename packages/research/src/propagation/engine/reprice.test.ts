import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_PROPAGATION_CONFIG } from "./config.js";
import { computePricing } from "./pricing.js";
import { repriceRun, shouldReprice } from "./reprice.js";
import { bars, quantSource, snapshot } from "./test-fixtures.js";
import type { QuantSource } from "./stage1.js";
import type { Pricing, PropagationRun, PropagationTarget } from "./types.js";

/**
 * The bug these cover: a stored run is served from cache and never repriced, so
 * its realized move, its last price and its session count stay frozen at
 * creation while the card draws a live quote beside them.
 */

const CONFIG = DEFAULT_PROPAGATION_CONFIG;
const EVENT_TS = "2026-08-12T13:00:00.000Z";
/** Two sessions after the event — inside the 3-session horizon. */
const NOW = "2026-08-14T20:30:00.000Z";

/** Flat 100 through 2026-08-13, so a later last price is a real move. */
const TAPE = bars([
  ["2026-08-10", 100],
  ["2026-08-11", 100],
  ["2026-08-12", 100],
  ["2026-08-13", 100],
]);

const STORED: Pricing = {
  status: "partial",
  realized_resid_pct: 0.006,
  realized_raw_pct: 0.006,
  expected_pct: 0.01,
  basis: "residual",
  reference_close_ts: "2026-08-12T20:00:00.000Z",
  reference_close: 100,
  last_price: 100.6,
  last_price_ts: "2026-08-12T20:00:00.000Z",
  sessions_elapsed: 0,
  ratio: 0.6,
  bench_move_pct: null,
  beta: null,
  anchor: "close",
  since_event_pct: null,
  first_30m_pct: null,
  note: null,
};

function target(over: Partial<PropagationTarget> = {}): PropagationTarget {
  return {
    target: "TSM",
    ticker: "TSM",
    label: "TSMC",
    tracked: true,
    relationship: { role: "supplier", tier: "important", subtype: null, evidence_via: "filing" },
    transmission: { tier: "weak", direction: "unclear" },
    mechanism: "",
    stage2: null,
    pricing: STORED,
    ...over,
  } as PropagationTarget;
}

function run(targets: PropagationTarget[]): PropagationRun {
  return {
    run_id: "run-test",
    request_id: "req-test",
    incident_id: "inc-test",
    root_ticker: "NVDA",
    event: { event_ts: EVENT_TS, label: "8-K", headline: "" },
    targets,
    summary: {
      targets: targets.length,
      open: 0,
      partial: targets.length,
      priced: 0,
      contradicted: 0,
      stale: 0,
      untracked: 0,
      vetoed: 0,
    },
    status: "ok",
    produced_at: "2026-08-12T13:05:00.000Z",
    superseded_by: null,
    synthetic: false,
  } as unknown as PropagationRun;
}

/** The tape as it looks two sessions later, with the name up ~3%. */
function movedTape(): QuantSource {
  return quantSource({
    TSM: snapshot({
      bars: TAPE,
      benchBars: bars([
        ["2026-08-10", 500],
        ["2026-08-11", 500],
        ["2026-08-12", 500],
        ["2026-08-13", 500],
      ]),
      lastPrice: 103,
      lastPriceTs: "2026-08-14T20:00:00.000Z",
      benchLastPrice: 500,
      beta: 1,
      r2: 0.9,
      vol30: 0.02,
    }),
  });
}

describe("repriceRun", () => {
  it("moves a figure that was frozen at creation", async () => {
    const result = await repriceRun({ run: run([target()]), config: CONFIG, quant: movedTape(), now: NOW });

    assert.equal(result.repriced, 1);
    assert.equal(result.changed, 1);
    const after = result.run.targets[0].pricing;
    assert.equal(after.last_price, 103, "the new last price is used");
    assert.notEqual(after.last_price, STORED.last_price);
    assert.ok(
      (after.sessions_elapsed ?? 0) > (STORED.sessions_elapsed ?? 0),
      "the session count advances with the calendar",
    );
    // Flat benchmark, beta 1 -> the residual is the raw move.
    assert.ok(Math.abs((after.realized_resid_pct ?? 0) - 0.03) < 1e-9);
  });

  it("rebuilds the summary from the new statuses", async () => {
    const result = await repriceRun({ run: run([target()]), config: CONFIG, quant: movedTape(), now: NOW });
    const s = result.run.summary;
    // 3% realized against a 0.5% expected is well past the priced threshold.
    assert.equal(s.priced, 1, "the new status is reflected");
    assert.equal(s.partial, 0, "the stored partial count must not survive");
    assert.equal(s.targets, result.run.targets.length);
  });

  it("leaves a stale target alone — the horizon is one-way", async () => {
    const frozen = target({ pricing: { ...STORED, status: "stale" } } as Partial<PropagationTarget>);
    assert.equal(shouldReprice(frozen), false);

    const result = await repriceRun({ run: run([frozen]), config: CONFIG, quant: movedTape(), now: NOW });
    assert.equal(result.repriced, 0);
    assert.equal(result.run.targets[0].pricing.last_price, STORED.last_price);
  });

  it("keeps the last good reading when the snapshot fails", async () => {
    const result = await repriceRun({
      run: run([target()]),
      config: CONFIG,
      quant: { isTracked: () => true, snapshot: async () => null },
      now: NOW,
    });
    assert.equal(result.repriced, 0);
    // A failed request is not evidence about the price.
    assert.equal(result.run.targets[0].pricing.status, "partial");
    assert.equal(result.run.targets[0].pricing.last_price, STORED.last_price);
  });

  it("never replaces a real reading with an unknown", async () => {
    // A cold tracker answers with a snapshot that has no usable history. That
    // is a failure to look, not a measurement, and it must not erase one.
    const empty = quantSource({ TSM: snapshot({ bars: [], benchBars: [], lastPrice: null }) });
    const result = await repriceRun({ run: run([target()]), config: CONFIG, quant: empty, now: NOW });

    assert.equal(result.repriced, 0, "an unusable snapshot is not a repricing");
    assert.equal(result.changed, 0);
    assert.equal(result.run.targets[0].pricing.status, "partial");
    assert.equal(result.run.targets[0].pricing.last_price, STORED.last_price);
  });

  it("skips untracked and vetoed targets", () => {
    assert.equal(shouldReprice(target({ tracked: false })), false);
    assert.equal(
      shouldReprice(target({ stage2: { verdict: "vetoed" } } as Partial<PropagationTarget>)),
      false,
    );
  });

  it("returns the very same run object when nothing changed", async () => {
    // Round-trip against the engine itself rather than a hand-written Pricing:
    // the store holds whatever computePricing produced, so "unchanged" only
    // means anything if the stored reading came from the same function.
    const snap = snapshot({
      bars: TAPE,
      lastPrice: 101,
      lastPriceTs: "2026-08-13T20:00:00.000Z",
      beta: 1,
      r2: 0.9,
      vol30: 0.02,
    });
    const at = "2026-08-13T20:30:00.000Z";
    const first = computePricing({
      snapshot: snap,
      eventTs: EVENT_TS,
      now: at,
      tier: "weak",
      direction: "unclear",
      config: CONFIG.pricing,
    });
    const original = run([target({ pricing: first })]);

    const result = await repriceRun({
      run: original,
      config: CONFIG,
      quant: quantSource({ TSM: snap }),
      now: at,
    });
    assert.equal(result.repriced, 1, "it did ask the tape");
    assert.equal(result.changed, 0, "but the tape said the same thing");
    assert.equal(result.run, original, "no pointless rewrite of the store");
  });
});
