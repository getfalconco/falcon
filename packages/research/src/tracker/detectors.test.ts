import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TRACKER_CONFIG, mergeTrackerConfig } from "./config.js";
import {
  applyEdgeTransition,
  applySnapshotFire,
  decideEdgeFire,
  decideSnapshotFire,
  evaluateDrift,
  evaluateFilingOverdue,
  evaluateInsiderCluster,
  evaluateNewsBurst,
  evaluateSilence,
  evaluateUnexplainedMove,
  insiderClusterHasNewMember,
  newsBaselineRate,
  newsBurstRearmed,
  volumeTriggered,
} from "./detectors.js";
import { addTradingDays } from "./calendar.js";
import type { EdgeDetectorState, InsiderClusterDetectorState } from "./types.js";

const CONFIG = DEFAULT_TRACKER_CONFIG;

function edgeState(overrides: Partial<EdgeDetectorState> = {}): EdgeDetectorState {
  return {
    active: false,
    lastFiredAt: null,
    lastFiredValue: null,
    falseSinceDay: null,
    ...overrides,
  };
}

function clusterState(
  overrides: Partial<InsiderClusterDetectorState> = {},
): InsiderClusterDetectorState {
  return { ...edgeState(), lastClusterInsiders: [], ...overrides };
}

describe("§5 snapshot firing model", () => {
  it("fires once per trading day", () => {
    let state = { lastFiredDay: null as string | null, lastFiredValue: null as number | null };
    assert.equal(decideSnapshotFire(state, "2026-08-20", 2.4, 1.5).fire, true);
    state = applySnapshotFire("2026-08-20", 2.4);
    assert.equal(decideSnapshotFire(state, "2026-08-20", 2.6, 1.5).fire, false);
  });

  it("escalation overrides the daily cap at > 1.5× the previous value", () => {
    const state = applySnapshotFire("2026-08-20", 2.0);
    assert.equal(decideSnapshotFire(state, "2026-08-20", 2.9, 1.5).fire, false); // 1.45×
    const escalated = decideSnapshotFire(state, "2026-08-20", 3.1, 1.5); // 1.55×
    assert.equal(escalated.fire, true);
    assert.equal(escalated.escalated, true);
  });

  it("escalation compares magnitude, so a sign flip alone does not re-fire", () => {
    const state = applySnapshotFire("2026-08-20", 2.5);
    assert.equal(decideSnapshotFire(state, "2026-08-20", -2.6, 1.5).fire, false);
    assert.equal(decideSnapshotFire(state, "2026-08-20", -4.0, 1.5).fire, true);
  });

  it("a new trading day re-arms the detector", () => {
    const state = applySnapshotFire("2026-08-20", 2.4);
    assert.equal(decideSnapshotFire(state, "2026-08-21", 2.1, 1.5).fire, true);
  });
});

describe("§5 edge-triggered firing model", () => {
  it("fires on the false→true transition only", () => {
    let state = edgeState();
    const first = decideEdgeFire(state, true, 3, 1.5);
    assert.equal(first.fire, true);
    state = applyEdgeTransition(state, true, true, 3, "2026-08-20T20:00:00Z", "2026-08-20");
    assert.equal(state.active, true);
    assert.equal(decideEdgeFire(state, true, 4, 1.5).fire, false); // still true, not escalated
  });

  it("re-fires while true only on > 1.5× escalation", () => {
    let state = edgeState();
    state = applyEdgeTransition(state, true, true, 3, "2026-08-20T20:00:00Z", "2026-08-20");
    assert.equal(decideEdgeFire(state, true, 4, 1.5).fire, false); // 1.33×
    assert.equal(decideEdgeFire(state, true, 5, 1.5).fire, true); // 1.67×
  });

  it("preserves the triggering value across a reset so escalation still works", () => {
    // Clearing lastFiredValue on re-arm silently disables the 1.5x rule for
    // the next episode — the value is the record of what fired.
    let state = edgeState();
    state = applyEdgeTransition(state, true, true, 4, "2026-08-20T20:00:00Z", "2026-08-20");
    assert.equal(state.lastFiredValue, 4);
    state = applyEdgeTransition(state, false, false, null, "2026-08-21T20:00:00Z", "2026-08-21");
    assert.equal(state.active, false);
    assert.equal(state.lastFiredValue, 4, "value must survive the reset");

    // Re-arm fires fresh, and that fire records its own triggering value.
    state = applyEdgeTransition(state, true, true, 9, "2026-08-24T20:00:00Z", "2026-08-24");
    assert.equal(state.lastFiredValue, 9);
    assert.equal(decideEdgeFire(state, true, 10, 1.5).fire, false); // 1.11x
    assert.equal(decideEdgeFire(state, true, 14, 1.5).fire, true); // 1.55x
  });

  it("resets and re-arms when the condition goes false", () => {
    let state = edgeState();
    state = applyEdgeTransition(state, true, true, 3, "2026-08-20T20:00:00Z", "2026-08-20");
    state = applyEdgeTransition(state, false, false, null, "2026-08-21T20:00:00Z", "2026-08-21");
    assert.equal(state.active, false);
    assert.equal(state.falseSinceDay, "2026-08-21");
    assert.equal(decideEdgeFire(state, true, 3, 1.5).fire, true);
  });
});

describe("§5.2 volume anomaly", () => {
  it("never evaluates a partial (pre-close) ratio", () => {
    assert.equal(volumeTriggered(5.0, true, CONFIG), false);
    assert.equal(volumeTriggered(5.0, false, CONFIG), true);
  });

  it("null ratio (not computable) never triggers", () => {
    assert.equal(volumeTriggered(null, false, CONFIG), false);
  });
});

describe("§5.3 silence + news baseline", () => {
  function countsFor(day: string, perDay: number, days = 35): Record<string, number> {
    const counts: Record<string, number> = {};
    let d = addTradingDays(day, -1);
    for (let i = 0; i < days; i++) {
      counts[d] = perDay;
      d = addTradingDays(d, -1);
    }
    return counts;
  }

  it("baseline is null when the 30-day window is not fully covered (§3.11)", () => {
    assert.equal(newsBaselineRate(countsFor("2026-08-20", 2, 10), "2026-08-20", CONFIG), null);
  });

  it("baseline is the mean article count per trading day", () => {
    assert.equal(newsBaselineRate(countsFor("2026-08-20", 2), "2026-08-20", CONFIG), 2);
  });

  it("fires after 3 silent trading days with a ≥ 1/day baseline", () => {
    const counts = countsFor("2026-08-20", 2);
    for (const d of [
      "2026-08-20",
      addTradingDays("2026-08-20", -1),
      addTradingDays("2026-08-20", -2),
    ]) {
      counts[d] = 0;
    }
    const result = evaluateSilence(counts, "2026-08-20", CONFIG);
    assert.equal(result.conditionTrue, true);
    assert.equal(result.tradingDaysSilent, 3);
  });

  it("does not fire on a low-baseline ticker even when silent", () => {
    const counts = countsFor("2026-08-20", 0);
    assert.equal(evaluateSilence(counts, "2026-08-20", CONFIG).conditionTrue, false);
  });

  it("is disabled entirely when the baseline is not computable", () => {
    const result = evaluateSilence(countsFor("2026-08-20", 3, 5), "2026-08-20", CONFIG);
    assert.equal(result.conditionTrue, false);
    assert.equal(result.baselineRate, null);
  });
});

describe("§5.4 filing overdue", () => {
  const history = [
    { form: "10-Q", filedAt: "2025-05-05", reportDate: "2025-03-31" }, // 35d
    { form: "10-Q", filedAt: "2025-08-04", reportDate: "2025-06-30" }, // 35d
    { form: "10-Q", filedAt: "2025-11-04", reportDate: "2025-09-30" }, // 35d
    { form: "10-K", filedAt: "2026-02-04", reportDate: "2025-12-31" }, // 35d
  ];

  it("requires ≥ 4 lag observations (§3.11)", () => {
    const result = evaluateFilingOverdue(history.slice(0, 3), "2026-08-20", CONFIG);
    assert.equal(result.medianLagDays, null);
    assert.equal(result.conditionTrue, false);
  });

  it("computes the median lag and the expected filing date", () => {
    const result = evaluateFilingOverdue(history, "2026-04-10", CONFIG);
    assert.equal(result.medianLagDays, 35);
    assert.equal(result.expectedByDate, "2026-05-05"); // Mar 31 + 35d
    assert.equal(result.conditionTrue, false); // not yet past due
  });

  it("fires only past 10 business days beyond the median lag", () => {
    // Expected 2026-05-05; 10 business days later ≈ 2026-05-19.
    assert.equal(evaluateFilingOverdue(history, "2026-05-18", CONFIG).conditionTrue, false);
    const late = evaluateFilingOverdue(history, "2026-05-26", CONFIG);
    assert.equal(late.conditionTrue, true);
    assert.ok(late.businessDaysOverdue > 10);
  });

  it("nothing is overdue before the period itself has ended", () => {
    assert.equal(evaluateFilingOverdue(history, "2026-03-01", CONFIG).conditionTrue, false);
  });
});

describe("§5.5 unexplained move", () => {
  const base = {
    residualZ: 2.6,
    moveZ: 3.0,
    r2: 0.6,
    burstActive: false,
    inEarningsWindow: false,
  };

  it("fires on |residual_z| > threshold with no active burst, outside the earnings window", () => {
    const result = evaluateUnexplainedMove(base, CONFIG);
    assert.equal(result.conditionTrue, true);
    assert.equal(result.measureUsed, "residual_zscore");
  });

  it("is suppressed while a news_burst is active (T6), not by mere coverage", () => {
    // Spec test: |resid_z| 2.6 on a ticker that has news flow but no burst → fires;
    // the same reading under an active burst → does not.
    assert.equal(evaluateUnexplainedMove({ ...base, burstActive: false }, CONFIG).conditionTrue, true);
    assert.equal(evaluateUnexplainedMove({ ...base, burstActive: true }, CONFIG).conditionTrue, false);
  });

  it("T8: the residual threshold is 2.5 — 2.4 no longer fires", () => {
    assert.equal(CONFIG.thresholds.unexplainedZ, 2.5);
    assert.equal(evaluateUnexplainedMove({ ...base, residualZ: 2.4 }, CONFIG).conditionTrue, false);
    assert.equal(evaluateUnexplainedMove({ ...base, residualZ: 2.6 }, CONFIG).conditionTrue, true);
  });

  it("is suppressed inside the earnings window", () => {
    assert.equal(
      evaluateUnexplainedMove({ ...base, inEarningsWindow: true }, CONFIG).conditionTrue,
      false,
    );
  });

  it("low-R² fallback switches to move_zscore and marks the measure", () => {
    const result = evaluateUnexplainedMove({ ...base, r2: 0.1, residualZ: 0.5 }, CONFIG);
    assert.equal(result.measureUsed, "move_zscore");
    assert.equal(result.value, 3.0);
    assert.equal(result.conditionTrue, true);
  });

  it("null measure (not computable) never fires", () => {
    assert.equal(
      evaluateUnexplainedMove({ ...base, residualZ: null }, CONFIG).conditionTrue,
      false,
    );
  });
});

describe("§5.6 drift", () => {
  it("fires above the z threshold with zero news in the window", () => {
    // Second arg: a news_burst fired within the drift window (T6).
    assert.equal(evaluateDrift(2.4, false, CONFIG), true);
    assert.equal(evaluateDrift(2.4, true, CONFIG), false);
    assert.equal(evaluateDrift(1.8, false, CONFIG), false);
    assert.equal(evaluateDrift(null, false, CONFIG), false);
  });
});

describe("§5.7 news burst", () => {
  it("requires both the multiple and the 5-article floor", () => {
    assert.equal(evaluateNewsBurst(12, 2, CONFIG).conditionTrue, true); // 6× ≥ 5 articles
    assert.equal(evaluateNewsBurst(4, 0.5, CONFIG).conditionTrue, false); // 8× but < 5 articles
    assert.equal(evaluateNewsBurst(12, 4, CONFIG).conditionTrue, false); // 3× only
  });

  it("is disabled when the baseline is not computable", () => {
    assert.equal(evaluateNewsBurst(20, null, CONFIG).conditionTrue, false);
  });

  it("re-arm hysteresis requires one full trading day of false", () => {
    const justWentFalse = edgeState({ falseSinceDay: "2026-08-20" });
    assert.equal(newsBurstRearmed(justWentFalse, "2026-08-20"), false);
    assert.equal(newsBurstRearmed(justWentFalse, "2026-08-21"), true);
    assert.equal(newsBurstRearmed(edgeState({ active: true }), "2026-08-20"), true);
  });
});

describe("§5.8 insider cluster", () => {
  /** Defaults to a notional comfortably over the §5.8 floor. */
  const txn = (
    name: string,
    code: string,
    day: string,
    plan = false,
    value: number | null = 250_000,
  ) => ({
    insiderName: name,
    transactionCode: code,
    is10b51Plan: plan,
    filedAt: `${day}T00:00:00.000Z`,
    direction: code === "P" ? ("buy" as const) : ("sell" as const),
    value,
  });

  it("fires on 3 distinct insiders, same direction, open-market codes", () => {
    const result = evaluateInsiderCluster(
      [
        txn("Alice", "P", "2026-08-18"),
        txn("Bob", "P", "2026-08-19"),
        txn("Carol", "P", "2026-08-20"),
      ],
      "2026-08-20",
      CONFIG,
    );
    assert.equal(result.conditionTrue, true);
    assert.equal(result.direction, "buy");
    assert.equal(result.insiders.length, 3);
  });

  it("excludes 10b5-1 plan transactions", () => {
    const result = evaluateInsiderCluster(
      [
        txn("Alice", "S", "2026-08-18"),
        txn("Bob", "S", "2026-08-19", true),
        txn("Carol", "S", "2026-08-20"),
      ],
      "2026-08-20",
      CONFIG,
    );
    assert.equal(result.conditionTrue, false);
  });

  it("excludes non-open-market codes F, M, A", () => {
    const result = evaluateInsiderCluster(
      [
        txn("Alice", "F", "2026-08-18"),
        txn("Bob", "M", "2026-08-19"),
        txn("Carol", "A", "2026-08-20"),
      ],
      "2026-08-20",
      CONFIG,
    );
    assert.equal(result.conditionTrue, false);
  });

  it("does not mix directions", () => {
    const result = evaluateInsiderCluster(
      [
        txn("Alice", "P", "2026-08-18"),
        txn("Bob", "S", "2026-08-19"),
        txn("Carol", "P", "2026-08-20"),
      ],
      "2026-08-20",
      CONFIG,
    );
    assert.equal(result.conditionTrue, false);
  });

  it("drops transactions older than the 10-business-day window", () => {
    const old = addTradingDays("2026-08-20", -15);
    const result = evaluateInsiderCluster(
      [txn("Alice", "P", old), txn("Bob", "P", "2026-08-19"), txn("Carol", "P", "2026-08-20")],
      "2026-08-20",
      CONFIG,
    );
    assert.equal(result.conditionTrue, false);
  });

  it("anchors the window on the transaction date, not the filing date (T2)", () => {
    // Monday trades, filed Wednesday — Form 4s may lag execution by two
    // business days, and the window must not stretch because of the lag.
    const monday = "2026-08-10";
    const wednesday = "2026-08-12";
    const lagged = (name: string) => ({
      ...txn(name, "P", wednesday),
      transactionDate: monday,
    });
    const group = [lagged("Alice"), lagged("Bob"), lagged("Carol")];

    // 9 business days after Monday: Monday is still inside the window → fires.
    const inWindow = evaluateInsiderCluster(group, addTradingDays(monday, 9), CONFIG);
    assert.equal(inWindow.conditionTrue, true);

    // 11 business days after Monday: Monday has aged out. Filing-date
    // anchoring would still count these (Wednesday is only 9 days back) —
    // execution-date anchoring must not.
    const aged = evaluateInsiderCluster(group, addTradingDays(monday, 11), CONFIG);
    assert.equal(aged.conditionTrue, false);
  });

  it("falls back to the filing date when the XML carried no transaction date", () => {
    const group = [
      txn("Alice", "P", "2026-08-18"),
      txn("Bob", "P", "2026-08-19"),
      txn("Carol", "P", "2026-08-20"),
    ];
    assert.equal(evaluateInsiderCluster(group, "2026-08-20", CONFIG).conditionTrue, true);
  });

  it("re-fires only when a new insider joins", () => {
    const state = clusterState({ active: true, lastClusterInsiders: ["Alice", "Bob", "Carol"] });
    assert.equal(insiderClusterHasNewMember(state, ["Alice", "Bob", "Carol"]), false);
    assert.equal(insiderClusterHasNewMember(state, ["Alice", "Bob", "Carol", "Dave"]), true);
  });

  // §5.8 per-transaction notional floor (default $50,000).
  describe("minimum notional", () => {
    it("does not count transactions below the floor", () => {
      const result = evaluateInsiderCluster(
        [
          txn("Alice", "P", "2026-08-18", false, 49_999),
          txn("Bob", "P", "2026-08-19", false, 250_000),
          txn("Carol", "P", "2026-08-20", false, 250_000),
        ],
        "2026-08-20",
        CONFIG,
      );
      assert.equal(result.conditionTrue, false);
      assert.deepEqual(
        result.excluded.map((e) => [e.insiderName, e.reason]),
        [["Alice", "below_min_notional"]],
      );
    });

    it("counts a transaction exactly at the floor", () => {
      const result = evaluateInsiderCluster(
        [
          txn("Alice", "P", "2026-08-18", false, 50_000),
          txn("Bob", "P", "2026-08-19"),
          txn("Carol", "P", "2026-08-20"),
        ],
        "2026-08-20",
        CONFIG,
      );
      assert.equal(result.conditionTrue, true);
      assert.equal(result.insiders.length, 3);
      assert.deepEqual(result.excluded, []);
    });

    it("never reads a null notional as zero — it is excluded and reported", () => {
      const result = evaluateInsiderCluster(
        [
          txn("Alice", "P", "2026-08-18", false, null),
          txn("Bob", "P", "2026-08-19"),
          txn("Carol", "P", "2026-08-20"),
        ],
        "2026-08-20",
        CONFIG,
      );
      assert.equal(result.conditionTrue, false);
      assert.deepEqual(
        result.excluded.map((e) => [e.insiderName, e.reason, e.value]),
        [["Alice", "value_unknown", null]],
      );
    });
  });

  // §5.8 same-day bulk guard (default: > 8 insiders and a de minimis median).
  describe("same-day bulk guard", () => {
    /** n insiders all buying `value` on one date — a share-plan settlement. */
    const bulkDay = (n: number, day: string, value: number) =>
      Array.from({ length: n }, (_, i) => txn(`Plan${i}`, "P", day, false, value));

    it("suppresses a 30-insider same-day filing at de minimis size", () => {
      const result = evaluateInsiderCluster(bulkDay(30, "2026-08-20", 3_700), "2026-08-20", CONFIG);
      assert.equal(result.conditionTrue, false);
      assert.equal(result.excluded.length, 30);
      assert.ok(result.excluded.every((e) => e.reason === "bulk_plan_event"));
    });

    it("does not suppress a same-day group whose median clears the floor", () => {
      const result = evaluateInsiderCluster(
        bulkDay(30, "2026-08-20", 400_000),
        "2026-08-20",
        CONFIG,
      );
      assert.equal(result.conditionTrue, true);
      assert.equal(result.insiders.length, 30);
      assert.deepEqual(result.excluded, []);
    });

    it("does not suppress at or below the insider-count threshold", () => {
      // 8 insiders is not "more than 8", so the guard does not apply; the
      // per-transaction floor still removes them all.
      const result = evaluateInsiderCluster(bulkDay(8, "2026-08-20", 3_700), "2026-08-20", CONFIG);
      assert.equal(result.conditionTrue, false);
      assert.ok(result.excluded.every((e) => e.reason === "below_min_notional"));
    });

    it("drops only the bulk group, leaving a genuine cluster on other dates", () => {
      const result = evaluateInsiderCluster(
        [
          ...bulkDay(30, "2026-08-20", 3_700),
          txn("Bourla", "P", "2026-08-12", false, 1_000_920),
          txn("Blaylock", "P", "2026-08-14", false, 998_821),
          txn("Buckley", "P", "2026-08-14", false, 960_368),
        ],
        "2026-08-20",
        CONFIG,
      );
      assert.equal(result.conditionTrue, true);
      assert.equal(result.direction, "buy");
      assert.deepEqual(result.insiders.sort(), ["Blaylock", "Bourla", "Buckley"]);
      assert.equal(result.excluded.length, 30);
    });

    it("separates the two directions on the same date", () => {
      // A bulk buy settlement must not suppress a real sell cluster that day.
      const result = evaluateInsiderCluster(
        [
          ...bulkDay(30, "2026-08-20", 3_700),
          txn("Alice", "S", "2026-08-20", false, 500_000),
          txn("Bob", "S", "2026-08-20", false, 500_000),
          txn("Carol", "S", "2026-08-20", false, 500_000),
        ],
        "2026-08-20",
        CONFIG,
      );
      assert.equal(result.conditionTrue, true);
      assert.equal(result.direction, "sell");
      assert.equal(result.insiders.length, 3);
    });

    it("both thresholds are configuration", () => {
      const loose = mergeTrackerConfig({
        thresholds: {
          ...CONFIG.thresholds,
          insiderClusterMinNotionalUsd: 1_000,
          insiderClusterBulkInsiderCount: 50,
        },
      });
      const result = evaluateInsiderCluster(bulkDay(30, "2026-08-20", 3_700), "2026-08-20", loose);
      assert.equal(result.conditionTrue, true);
      assert.equal(result.insiders.length, 30);
    });
  });
});
