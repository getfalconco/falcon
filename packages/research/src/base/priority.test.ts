/**
 * §9 layer 2 — priority scoring golden vectors.
 *
 *   priority = max(0, severity + composite_bonus) x proximity_multiplier + freshness
 *
 * Every expected number below was computed by hand off the §3 anchor tables
 * and pinned; none of it is derived from the implementation.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BASE_CONFIG, mergeBaseConfig } from "./config.js";
import {
  bandAtLeast,
  bandOf,
  computeDegradedContext,
  computePriority,
  freshnessOf,
  interpolateCurve,
  messageSeverity,
  multiplierFor,
  severityOf,
} from "./priority.js";
import {
  filingItem,
  gapEvent,
  insiderCluster,
  newsBurst,
  newsItem,
  quant,
  unexplainedMove,
  volumeAnomaly,
} from "./test-fixtures.js";
import type { CompositeTag, UserProximity } from "./types.js";

const CONFIG = DEFAULT_BASE_CONFIG;
const AT = "2026-08-21T20:15:00.000Z";

function score(
  messages: Parameters<typeof severityOf>[0],
  tags: CompositeTag[],
  proximity: UserProximity,
  now = AT,
) {
  return computePriority({
    messages,
    composite_tags: tags,
    user_proximity: proximity,
    now,
    config: CONFIG,
  });
}

// ---------------------------------------------------------------------------
// §3 severity anchors and interpolation
// ---------------------------------------------------------------------------

describe("§3 severity anchor points", () => {
  const ANCHORS: Array<[string, number, number]> = [
    ["zscore", 2.0, 10],
    ["zscore", 3.0, 25],
    ["zscore", 4.0, 40],
    ["volume", 3, 8],
    ["volume", 5, 15],
    ["volume", 10, 25],
    ["insiderCount", 3, 20],
    ["insiderCount", 5, 30],
  ];

  for (const [curve, x, expected] of ANCHORS) {
    it(`${curve}(${x}) = ${expected}`, () => {
      assert.equal(interpolateCurve(CONFIG.priority.severity.curves[curve], x, true), expected);
    });
  }
});

describe("§3 severity is linearly interpolated between anchors", () => {
  const BETWEEN: Array<[string, number, number]> = [
    // 2.0->10, 3.0->25: halfway is 17.5, not a step to either anchor.
    ["zscore", 2.5, 17.5],
    ["zscore", 2.2, 13],
    ["zscore", 3.5, 32.5],
    // 3->8, 5->15: 4 is halfway -> 11.5. 5->15, 10->25: 7.5 is halfway -> 20.
    ["volume", 4, 11.5],
    ["volume", 7.5, 20],
    // 3->20, 5->30: 4 is halfway -> 25.
    ["insiderCount", 4, 25],
  ];

  for (const [curve, x, expected] of BETWEEN) {
    it(`${curve}(${x}) = ${expected}`, () => {
      assert.equal(interpolateCurve(CONFIG.priority.severity.curves[curve], x, true), expected);
    });
  }

  it("clamps above the top anchor", () => {
    assert.equal(interpolateCurve(CONFIG.priority.severity.curves.zscore, 6.0, true), 40);
    assert.equal(interpolateCurve(CONFIG.priority.severity.curves.volume, 20, true), 25);
    assert.equal(interpolateCurve(CONFIG.priority.severity.curves.insiderCount, 9, true), 30);
  });

  it("clamps below the first anchor, or interpolates toward the origin when configured", () => {
    assert.equal(interpolateCurve(CONFIG.priority.severity.curves.zscore, 1.0, true), 10);
    assert.equal(interpolateCurve(CONFIG.priority.severity.curves.zscore, 1.0, false), 5);
  });

  it("scores a message through its configured source and curve", () => {
    assert.deepEqual(messageSeverity(unexplainedMove("u1", AT, { residual_zscore: 2.5 }), CONFIG), {
      value: 17.5,
      nullComponent: false,
    });
    assert.deepEqual(messageSeverity(gapEvent("g1", AT, { gap_z: -3.5 }), CONFIG), {
      value: 32.5, // |gap_z|
      nullComponent: false,
    });
    assert.deepEqual(messageSeverity(volumeAnomaly("v1", AT, { volume_ratio: 4 }), CONFIG), {
      value: 11.5,
      nullComponent: false,
    });
    assert.deepEqual(messageSeverity(insiderCluster("c1", AT, { insider_count: 4 }), CONFIG), {
      value: 25,
      nullComponent: false,
    });
  });
});

describe("§3 severity across a message set", () => {
  it("takes the strongest trigger, never the sum", () => {
    const messages = [
      unexplainedMove("u1", AT, { residual_zscore: 3.0 }), // 25
      volumeAnomaly("v1", AT, { volume_ratio: 6 }), // 17
      insiderCluster("c1", AT, { insider_count: 5 }), // 30
    ];
    const result = severityOf(messages, CONFIG);
    assert.equal(result.severity, 30);
    assert.equal(result.driver?.id, "c1");
  });

  it("gives information-only messages base severity 5, which does not stack", () => {
    assert.equal(severityOf([newsItem("n1", AT)], CONFIG).severity, 5);
    assert.equal(
      severityOf([newsItem("n1", AT), newsItem("n2", AT), filingItem("f1", AT)], CONFIG).severity,
      5,
    );
  });

  it("a null component contributes nothing and is never read as zero", () => {
    const nulled = unexplainedMove("u1", AT, {
      residual_zscore: null as unknown as number,
    });
    assert.deepEqual(messageSeverity(nulled, CONFIG), { value: null, nullComponent: true });

    const result = severityOf([nulled, volumeAnomaly("v1", AT, { volume_ratio: 6 })], CONFIG);
    assert.equal(result.severity, 17);
    assert.equal(result.driver?.id, "v1");
    assert.equal(result.hasNullComponent, true);
  });
});

// ---------------------------------------------------------------------------
// §1 degraded context
// ---------------------------------------------------------------------------

describe("§1 degraded_context", () => {
  it("is set when a component the scorer needed was null", () => {
    const nulled = unexplainedMove("u1", AT, { residual_zscore: null as unknown as number });
    assert.equal(computeDegradedContext([nulled], quant(), CONFIG), true);
    assert.equal(
      computeDegradedContext([unexplainedMove("u1", AT)], quant(), CONFIG),
      false,
    );
  });

  it("is set when volume_without_price cannot be evaluated", () => {
    const volume = [volumeAnomaly("v1", AT)];
    assert.equal(computeDegradedContext(volume, quant({ move_zscore: null }), CONFIG), true);
    assert.equal(computeDegradedContext(volume, quant({ move_zscore: 1.4 }), CONFIG), false);
  });

  it("is set when the incident has no quant context at all", () => {
    assert.equal(computeDegradedContext([newsItem("n1", AT)], null, CONFIG), true);
    assert.equal(computeDegradedContext([], null, CONFIG), false);
  });

  it("can be widened to any null quant field by config", () => {
    const strict = mergeBaseConfig({ degraded: { onAnyNullQuantField: true } });
    const partial = quant({ momentum_60d: null });
    assert.equal(computeDegradedContext([newsItem("n1", AT)], partial, CONFIG), false);
    assert.equal(computeDegradedContext([newsItem("n1", AT)], partial, strict), true);
  });
});

// ---------------------------------------------------------------------------
// §3 freshness
// ---------------------------------------------------------------------------

describe("§3 freshness", () => {
  it("gives close-computed detectors a neutral 5 whatever their age", () => {
    for (const message of [
      volumeAnomaly("v1", AT),
      unexplainedMove("u1", AT),
      newsBurst("b1", AT),
    ]) {
      const neutral = ["volume_anomaly", "unexplained_move"].includes(message.type);
      const expected = neutral ? 5 : 10; // news_burst has no close-batch anchor
      assert.equal(freshnessOf(message, AT, CONFIG), expected, message.type);
    }
    // 10 days later the close-computed detectors are still neutral.
    assert.equal(freshnessOf(volumeAnomaly("v1", AT), "2026-08-31T20:15:00.000Z", CONFIG), 5);
  });

  it("decays a news_item linearly from its published_at", () => {
    const now = "2026-08-22T00:00:00.000Z";
    // <= 1h old -> 10
    assert.equal(freshnessOf(newsItem("n1", now, { published_at: now }), now, CONFIG), 10);
    assert.equal(
      freshnessOf(newsItem("n1", now, { published_at: "2026-08-21T23:00:00.000Z" }), now, CONFIG),
      10,
    );
    // 12.5h old -> 10 * (24 - 12.5) / (24 - 1) = 5
    assert.equal(
      freshnessOf(newsItem("n1", now, { published_at: "2026-08-21T11:30:00.000Z" }), now, CONFIG),
      5,
    );
    // >= 24h old -> 0
    assert.equal(
      freshnessOf(newsItem("n1", now, { published_at: "2026-08-21T00:00:00.000Z" }), now, CONFIG),
      0,
    );
    assert.equal(
      freshnessOf(newsItem("n1", now, { published_at: "2026-08-20T00:00:00.000Z" }), now, CONFIG),
      0,
    );
  });

  it("anchors a gap_event on the market open, not on its own timestamp", () => {
    // 2026-08-21 opens at 13:30Z. The message is emitted at 13:35Z; 12.5h after
    // the open is 2026-08-22T02:00Z -> freshness 5.
    const gap = gapEvent("g1", "2026-08-21T13:35:00.000Z");
    assert.equal(freshnessOf(gap, "2026-08-21T13:40:00.000Z", CONFIG), 10);
    assert.equal(freshnessOf(gap, "2026-08-22T02:00:00.000Z", CONFIG), 5);
  });

  it("anchors a filing_item on filed_at", () => {
    const filing = filingItem("f1", "2026-08-21T20:00:00.000Z", {
      filed_at: "2026-08-21T12:00:00.000Z",
    });
    // 12.5h after filed_at.
    assert.equal(freshnessOf(filing, "2026-08-22T00:30:00.000Z", CONFIG), 5);
  });
});

// ---------------------------------------------------------------------------
// §3 bands
// ---------------------------------------------------------------------------

describe("§3 priority bands", () => {
  const CASES: Array<[number, string]> = [
    [100, "P0"],
    [70, "P0"],
    [69, "P1"],
    [40, "P1"],
    [39, "P2"],
    [15, "P2"],
    [14, "P3"],
    [0, "P3"],
  ];
  for (const [score_, band] of CASES) {
    it(`${score_} -> ${band}`, () => assert.equal(bandOf(score_, CONFIG), band));
  }

  it("orders bands for the priority-gated routing rows", () => {
    assert.equal(bandAtLeast("P0", "P1"), true);
    assert.equal(bandAtLeast("P1", "P1"), true);
    assert.equal(bandAtLeast("P2", "P1"), false);
    assert.equal(bandAtLeast("P3", "P1"), false);
  });
});

// ---------------------------------------------------------------------------
// §3 proximity multiplier
// ---------------------------------------------------------------------------

describe("§3 proximity multiplier", () => {
  // severity 25 (|z| 3.0), no tags, neutral freshness 5.
  const messages = [unexplainedMove("u1", AT, { residual_zscore: 3.0 })];
  const EXPECTED: Array<[UserProximity, number, string]> = [
    ["tracked", 30, "P2"], // 25 * 1.00 + 5
    ["watchlist", 36, "P2"], // 25 * 1.25 + 5 = 36.25 -> 36
    ["held", 43, "P1"], // 25 * 1.50 + 5 = 42.5  -> 43
  ];

  for (const [proximity, priority, band] of EXPECTED) {
    it(`${proximity} -> ${priority} (${band})`, () => {
      const result = score(messages, [], proximity);
      assert.equal(result.priority, priority);
      assert.equal(result.band, band);
    });
  }

  it("unclassified news on a held position cannot reach P1", () => {
    // Best case for news: published this instant, held. 5 * 1.5 + 10 = 17.5 -> 18.
    const fresh = newsItem("n1", AT, { published_at: AT });
    const result = score([fresh], [], "held");
    assert.equal(result.severity, 5);
    assert.equal(result.freshness, 10);
    assert.equal(result.priority, 18);
    assert.equal(result.band, "P2");
    assert.ok(result.priority < CONFIG.priority.bands.P1);

    // More unclassified news does not stack severity, so it stays P2.
    const many = [fresh, newsItem("n2", AT, { published_at: AT }), newsItem("n3", AT, { published_at: AT })];
    assert.equal(score(many, [], "held").priority, 18);
  });
});

// ---------------------------------------------------------------------------
// §3 composite bonus applied to the score
// ---------------------------------------------------------------------------

describe("§3 explained_move downgrade", () => {
  const messages = [unexplainedMove("u1", AT, { residual_zscore: 3.0 })];

  it("drops a held unexplained move out of P1", () => {
    // Undowngraded: 25 * 1.5 + 5 = 42.5 -> 43 (P1).
    const before = score(messages, [], "held");
    assert.equal(before.priority, 43);
    assert.equal(before.band, "P1");

    // With explained_move: max(0, 25 - 15) * 1.5 + 5 = 20 (P2).
    const after = score(messages, ["explained_move"], "held");
    assert.equal(after.composite_bonus, -15);
    assert.equal(after.priority, 20);
    assert.equal(after.band, "P2");
  });
});

describe("§3 clamp at zero", () => {
  it("clamps severity + bonus at 0 before the multiplier", () => {
    // severity 10 (|z| 2.0) - 15 = -5 -> 0. 0 * 1.5 + 5 = 5.
    const weak = [unexplainedMove("u1", AT, { residual_zscore: 2.0 })];
    const result = score(weak, ["explained_move"], "held");
    assert.equal(result.severity, 10);
    assert.equal(result.composite_bonus, -15);
    assert.equal(result.priority, 5);
    assert.equal(result.band, "P3");
  });

  it("clamps with stacked negative tags, and the multiplier cannot revive it", () => {
    const stackedNegatives = mergeBaseConfig({
      tags: {
        ...CONFIG.tags,
        weights: { ...CONFIG.tags.weights, unexplained_activity: -15 },
      },
    });
    // severity 25; bonus = min(0, 30) + (-15 - 15) = -30; max(0, -5) = 0.
    const result = computePriority({
      messages: [unexplainedMove("u1", AT, { residual_zscore: 3.0 })],
      composite_tags: ["unexplained_activity", "explained_move"],
      user_proximity: "held",
      now: AT,
      config: stackedNegatives,
    });
    assert.equal(result.composite_bonus, -30);
    assert.equal(result.priority, 5); // 0 * 1.5 + neutral freshness 5
    assert.equal(result.band, "P3");
  });

  it("scores an empty message set at zero", () => {
    const result = score([], [], "held");
    assert.equal(result.priority, 0);
    assert.equal(result.freshness, 0);
    assert.equal(result.driver_message_id, null);
  });
});

// ---------------------------------------------------------------------------
// Notional multiplier on insider_cluster severity
// ---------------------------------------------------------------------------

describe("insider_cluster notional multiplier", () => {
  // insider_count 3 sits on the first anchor -> 20, before the multiplier.
  const TIERS: Array<[number, number, string]> = [
    [100_000, 16, "under $250k -> x0.8"],
    [249_999, 16, "just under the first bound"],
    [250_000, 20, "$250k-1M -> x1.0"],
    [999_999, 20, "just under $1M"],
    [1_000_000, 26, "$1M-5M -> x1.3"],
    [2_960_110, 26, "the PFE cluster"],
    [5_000_000, 30, "over $5M -> x1.5"],
    [50_000_000, 30, "far over"],
  ];

  for (const [notional, expected, label] of TIERS) {
    it(`${label}: $${notional.toLocaleString()} -> ${expected}`, () => {
      const message = insiderCluster("c1", AT, { insider_count: 3, total_notional: notional });
      assert.equal(messageSeverity(message, CONFIG).value, expected);
    });
  }

  it("three insiders at $1M each do not score the same as three at $60k", () => {
    const rich = insiderCluster("c1", AT, { insider_count: 3, total_notional: 3_000_000 });
    const thin = insiderCluster("c2", AT, { insider_count: 3, total_notional: 180_000 });
    assert.equal(messageSeverity(rich, CONFIG).value, 26);
    assert.equal(messageSeverity(thin, CONFIG).value, 16);
  });

  it("still clamps at the severity ceiling", () => {
    // 5 insiders -> 30, x1.5 = 45, clamped to max 40.
    const message = insiderCluster("c1", AT, { insider_count: 5, total_notional: 20_000_000 });
    assert.equal(messageSeverity(message, CONFIG).value, 30 * 1.5 > 40 ? 40 : 45);
  });

  it("a null magnitude leaves the curve untouched rather than assuming the bottom tier", () => {
    const message = insiderCluster("c1", AT, {
      insider_count: 3,
      total_notional: null as unknown as number,
    });
    assert.equal(multiplierFor(message, CONFIG), 1);
    assert.equal(messageSeverity(message, CONFIG).value, 20);
  });

  it("leaves message types with no multiplier alone", () => {
    assert.equal(multiplierFor(unexplainedMove("u1", AT), CONFIG), 1);
  });
});

// ---------------------------------------------------------------------------
// Discovery floor
// ---------------------------------------------------------------------------

describe("discovery floor", () => {
  // insider_cluster, 3 insiders, $2.96M: severity 20 x 1.3 = 26,
  // + standalone_insider_cluster 8 = combined 34.
  const pfe = [insiderCluster("c1", AT, { insider_count: 3, total_notional: 2_960_110 })];

  it("promotes an untracked-but-strong incident to the floor band", () => {
    // Stale: freshness 0 -> 34 * 1.0 = 34, which is P2 on its own.
    const stale = score(pfe, ["standalone_insider_cluster"], "tracked", "2026-08-25T20:15:00.000Z");
    assert.equal(stale.combined, 34);
    assert.equal(stale.freshness, 0);
    assert.equal(stale.discovery_floor_applied, true);
    assert.equal(stale.priority, 40);
    assert.equal(stale.band, "P1");
  });

  it("does not fire when the score already clears the band on its own", () => {
    // Fresh: 34 + freshness 10 = 44, above the P1 threshold unaided.
    const fresh = score(pfe, ["standalone_insider_cluster"], "tracked");
    assert.equal(fresh.priority, 44);
    assert.equal(fresh.band, "P1");
    assert.equal(fresh.discovery_floor_applied, false);
  });

  it("never lowers a score", () => {
    const held = score(pfe, ["standalone_insider_cluster"], "held");
    assert.equal(held.priority, 61); // 34 * 1.5 + 10
    assert.equal(held.discovery_floor_applied, false);
  });

  it("leaves anything below the combined threshold alone", () => {
    // severity 25, no tags -> combined 25 < 30.
    const weak = [unexplainedMove("u1", AT, { residual_zscore: 3.0 })];
    const result = score(weak, [], "tracked");
    assert.equal(result.combined, 25);
    assert.equal(result.discovery_floor_applied, false);
    assert.equal(result.band, "P2");
  });

  it("measures strength before the proximity multiplier, not after", () => {
    // combined 34 either way; proximity must not change whether the floor applies.
    for (const proximity of ["tracked", "watchlist", "held"] as UserProximity[]) {
      const result = computePriority({
        messages: pfe,
        composite_tags: ["standalone_insider_cluster"],
        user_proximity: proximity,
        now: "2026-08-25T20:15:00.000Z",
        config: CONFIG,
      });
      assert.equal(result.combined, 34, proximity);
      assert.ok(result.priority >= 40, proximity);
      assert.equal(result.band, "P1", proximity);
    }
  });

  it("keeps band = f(priority) so the §5 queue stays ordered", () => {
    // A floored incident and an unfloored one must not invert: the floored
    // score is raised to the threshold, never left below a lower band's score.
    const floored = score(pfe, ["standalone_insider_cluster"], "tracked", "2026-08-25T20:15:00.000Z");
    const unfloored = score(
      [unexplainedMove("u1", AT, { residual_zscore: 3.4 })],
      [],
      "tracked",
    );
    assert.equal(bandOf(floored.priority, CONFIG), floored.band);
    assert.equal(bandOf(unfloored.priority, CONFIG), unfloored.band);
    assert.ok(floored.priority >= unfloored.priority || floored.band === unfloored.band);
  });

  it("can be disabled entirely", () => {
    const off = mergeBaseConfig({
      priority: {
        ...CONFIG.priority,
        discoveryFloor: { ...CONFIG.priority.discoveryFloor, enabled: false },
      },
    });
    const result = computePriority({
      messages: pfe,
      composite_tags: ["standalone_insider_cluster"],
      user_proximity: "tracked",
      now: "2026-08-25T20:15:00.000Z",
      config: off,
    });
    assert.equal(result.priority, 34);
    assert.equal(result.band, "P2");
    assert.equal(result.discovery_floor_applied, false);
  });

  it("the threshold is configuration", () => {
    const strict = mergeBaseConfig({
      priority: {
        ...CONFIG.priority,
        discoveryFloor: { ...CONFIG.priority.discoveryFloor, minCombined: 40 },
      },
    });
    const result = computePriority({
      messages: pfe,
      composite_tags: ["standalone_insider_cluster"],
      user_proximity: "tracked",
      now: "2026-08-25T20:15:00.000Z",
      config: strict,
    });
    assert.equal(result.discovery_floor_applied, false); // combined 34 < 40
    assert.equal(result.band, "P2");
  });
});

describe("§8 determinism", () => {
  it("is a pure function of (messages, user context, config, now)", () => {
    const messages = [
      unexplainedMove("u1", AT, { residual_zscore: 3.2 }),
      volumeAnomaly("v1", AT, { volume_ratio: 6 }),
    ];
    const once = score(messages, ["unexplained_activity"], "watchlist");
    const twice = score(messages, ["unexplained_activity"], "watchlist");
    assert.deepEqual(once, twice);
    // 3.2 -> 25 + 0.2 * 15 = 28; (28 + 8) * 1.25 + 5 = 50.
    assert.equal(once.severity, 28);
    assert.equal(once.priority, 50);
    assert.equal(once.band, "P1");
  });
});
