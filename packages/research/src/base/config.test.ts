/**
 * §8 "config over code" / §10 open calibration parameters.
 *
 * These pin the shipped defaults against the values §10 lists as open, and
 * check that a persisted partial config overrides them without dropping the
 * siblings it does not mention.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { DEFAULT_BASE_CONFIG, mergeBaseConfig } from "./config.js";
import { BaseConfigStore } from "./store.js";

const HOUR = 60 * 60_000;

describe("§10 pilot defaults", () => {
  it("matches the calibration parameters listed in the spec", () => {
    const c = DEFAULT_BASE_CONFIG;
    assert.deepEqual(c.tags.weights, {
      earnings_surprise: 15,
      insider_confirmation: 15,
      silent_accumulation: 15,
      insider_divergence: 15,
      insider_distribution: 15,
      standalone_insider_cluster: 8,
      disclosure_risk: 15,
      unexplained_activity: 8,
      pre_earnings_silence: 8,
      volume_without_price: 8,
      event_gap: 0,
      explained_move: -15,
      // S2: the Screen structure channel.
      tape_structure: 8,
    });
    assert.equal(c.tags.positiveBonusCap, 30);
    assert.deepEqual(c.priority.bands, { P0: 70, P1: 40, P2: 15 });
    assert.deepEqual(c.priority.proximityMultipliers, { held: 1.5, watchlist: 1.25, tracked: 1.0 });
    assert.equal(c.window.measurementSilenceMs, 6 * HOUR);
    assert.equal(c.window.hardCapMs, 8 * HOUR);
    assert.equal(c.window.relatedLookbackMs, 24 * HOUR);
    assert.deepEqual(c.priority.severity.curves.zscore, [
      [2.0, 10],
      [3.0, 25],
      [4.0, 40],
    ]);
    assert.deepEqual(c.priority.severity.curves.volume, [
      [3, 8],
      [5, 15],
      [10, 25],
    ]);
    assert.deepEqual(c.priority.severity.curves.insiderCount, [
      [3, 20],
      [5, 30],
    ]);
    assert.equal(c.priority.severity.base, 5);
    assert.equal(c.priority.severity.max, 40);
    assert.equal(c.priority.freshness.max, 10);
    assert.equal(c.priority.freshness.neutral, 5);
  });

  it("only measurement-class messages extend a window", () => {
    assert.deepEqual(DEFAULT_BASE_CONFIG.window.extendingTypes, [
      "gap_event",
      "volume_anomaly",
      "unexplained_move",
      "drift_event",
      "news_burst",
      "silence_anomaly",
      "filing_overdue",
      "insider_cluster",
      // S2: a multi-session structure is a measurement of the tape.
      "tape_structure",
    ]);
    for (const informational of ["news_item", "filing_item", "insider_filing", "scheduled_event"]) {
      assert.ok(!DEFAULT_BASE_CONFIG.window.extendingTypes.includes(informational as never));
    }
  });
});

describe("mergeBaseConfig", () => {
  it("returns a deep copy of the defaults for a null partial", () => {
    const merged = mergeBaseConfig(null);
    assert.deepEqual(merged, DEFAULT_BASE_CONFIG);
    merged.priority.bands.P0 = 99;
    assert.equal(DEFAULT_BASE_CONFIG.priority.bands.P0, 70);
  });

  it("overrides one nested value without dropping its siblings", () => {
    const merged = mergeBaseConfig({
      priority: { ...DEFAULT_BASE_CONFIG.priority, bands: { P0: 60, P1: 35, P2: 10 } },
      tags: { ...DEFAULT_BASE_CONFIG.tags, weights: { explained_move: -25 } as never },
    });
    assert.deepEqual(merged.priority.bands, { P0: 60, P1: 35, P2: 10 });
    assert.equal(merged.tags.weights.explained_move, -25);
    assert.equal(merged.tags.weights.insider_confirmation, 15); // untouched sibling
    assert.deepEqual(merged.priority.severity, DEFAULT_BASE_CONFIG.priority.severity);
  });
});

describe("BaseConfigStore", () => {
  it("writes the defaults on first load and reads overrides back", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "meridian-base-config-"));
    try {
      const store = new BaseConfigStore(dir);
      assert.deepEqual(store.load(), DEFAULT_BASE_CONFIG);
      assert.ok(fs.existsSync(path.join(dir, "config.json")));

      const tuned = mergeBaseConfig({
        priority: { ...DEFAULT_BASE_CONFIG.priority, bands: { P0: 65, P1: 38, P2: 12 } },
      });
      store.save(tuned);
      assert.deepEqual(new BaseConfigStore(dir).load().priority.bands, { P0: 65, P1: 38, P2: 12 });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
