import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { gauge } from "./compute.js";
import { SETUP_BASE_STATE, recognizeSetup } from "./setups.js";
import { cfg, coiledQuant, ctx, detectors, dueIn as due, finding, inputs, news, quant, setupFixtures } from "./test-fixtures.js";
import { GAUGE_SETUPS, type GaugeInputs, type GaugeSetupKey } from "./types.js";

const config = cfg();


function setupOf(i: GaugeInputs, context = null as Parameters<typeof recognizeSetup>[2]) {
  return recognizeSetup(i, config, context);
}
function keyOf(i: GaugeInputs): GaugeSetupKey {
  return setupOf(i).setup.key;
}

// ---------------------------------------------------------------------------
// 22 goldens — every row triggers, and every row declines
// ---------------------------------------------------------------------------

describe("gauge/setups — 1 COILED", () => {
  it("contracted regime, quiet volume, un-extended, no event → COILED / actionable", () => {
    const r = setupOf(inputs({ quant: coiledQuant() }));
    assert.equal(r.setup.key, "coiled");
    assert.equal(r.setup.name, "COILED");
    assert.equal(r.state, "actionable");
    assert.equal(r.missing, null);
    assert.equal(r.setup.direction, null);
    assert.equal(r.setup.read, "Compressed range, quiet volume, no event wall for — sessions");
  });
  it("an expanded regime declines it", () => {
    assert.notEqual(keyOf(inputs({ quant: quant({ vol_regime: 0.9, volume_ratio: 0.6 }) })), "coiled");
  });
  it("a Screen compression finding upgrades the reading with its own numbers", () => {
    const r = setupOf(inputs({ quant: coiledQuant(), next_earnings: due(8), screen: [finding("compression", { day_count: 2 })] }));
    assert.equal(r.setup.key, "coiled");
    assert.equal(r.setup.read, "Compressed for 2 sessions — vol 0.70× its 90d norm, quiet volume, no event wall for 8 sessions");
    assert.deepEqual(r.setup.screen.map((s) => s.pattern), ["compression"]);
  });
});

describe("gauge/setups — 2 COILED · EVENT AHEAD", () => {
  it("compressed with earnings inside the wall → wait, and the event is the missing condition", () => {
    const r = setupOf(inputs({ quant: coiledQuant(), next_earnings: due(2) }));
    assert.equal(r.setup.key, "coiled_event_ahead");
    assert.equal(r.state, "wait");
    assert.equal(r.setup.read, "Compressed, but earnings in 2 sessions — the event resolves it, not the tape");
    assert.equal(r.missing?.label, "earnings in 2 sessions");
    assert.equal(r.missing?.detail, "earnings in 2 sessions on 2026-08-26 — the tape reads through until it prints");
  });
  it("the same structure with the event outside the wall stays COILED", () => {
    assert.equal(keyOf(inputs({ quant: coiledQuant(), next_earnings: due(4) })), "coiled");
  });
});

describe("gauge/setups — 3 QUIET DRIFT", () => {
  it("independent tape with no participation → wait, missing volume with the threshold", () => {
    const r = setupOf(inputs({ quant: quant({ volume_ratio: 0.6 }), screen: [finding("independent_tape")] }));
    assert.equal(r.setup.key, "quiet_drift");
    assert.equal(r.state, "wait");
    assert.equal(r.setup.direction, "up");
    assert.equal(r.setup.read, "Pushing on its own for 4 sessions, market-independent");
    assert.equal(r.missing?.label, "volume confirmation");
    assert.equal(r.missing?.detail, "volume 0.60× average, needs 1.20× — no participation yet");
  });
  it("a down tape reads as sliding", () => {
    const r = setupOf(inputs({ quant: quant({ volume_ratio: 0.6 }), screen: [finding("independent_tape", { direction: "down", values: { direction: "down", sessions_qualifying: 3 } })] }));
    assert.equal(r.setup.read, "Sliding on its own for 3 sessions, market-independent");
    assert.equal(r.setup.direction, "down");
  });
  it("an active news burst declines it — the move is no longer the tape's own", () => {
    const r = setupOf(inputs({ quant: quant({ volume_ratio: 0.6 }), screen: [finding("independent_tape")], news: news({ burst_active: true }) }));
    assert.notEqual(r.setup.key, "quiet_drift");
  });
  it("the gate is the burst, not the article count — a news-saturated name still qualifies", () => {
    const r = setupOf(inputs({ quant: quant({ volume_ratio: 0.6 }), screen: [finding("independent_tape")], news: news({ articles: 162 }) }));
    assert.equal(r.setup.key, "quiet_drift");
  });
});

describe("gauge/setups — 4 CONFIRMED DRIFT", () => {
  it("independent tape with volume building → actionable", () => {
    const r = setupOf(inputs({ quant: quant({ volume_ratio: 1.5 }), screen: [finding("independent_tape")] }));
    assert.equal(r.setup.key, "confirmed_drift");
    assert.equal(r.state, "actionable");
    assert.equal(r.missing, null);
    assert.equal(r.setup.read, "Independent move higher with volume building — 4 sessions, 1.50× average");
  });
  it("volume past the crowded bound declines it", () => {
    assert.notEqual(keyOf(inputs({ quant: quant({ volume_ratio: 3.5 }), screen: [finding("independent_tape")] })), "confirmed_drift");
  });
});

describe("gauge/setups — 5 ACCUMULATION", () => {
  it("volume arriving while price stays flat → actionable", () => {
    const r = setupOf(inputs({ quant: quant({ momentum_5d: 0.005 }), screen: [finding("quiet_accumulation")] }));
    assert.equal(r.setup.key, "accumulation");
    assert.equal(r.state, "actionable");
    assert.equal(r.setup.read, "Volume arriving for 4 sessions, price flat — someone is building");
    assert.equal(r.setup.direction, null);
  });
  it("a moving price declines it", () => {
    assert.notEqual(keyOf(inputs({ quant: quant({ momentum_5d: 0.06 }), screen: [finding("quiet_accumulation")] })), "accumulation");
  });
});

describe("gauge/setups — 6 MOVE SPENT", () => {
  it("stretched, on participation, after an event → nothing_here", () => {
    const r = setupOf(inputs({ quant: quant({ momentum_20d: 0.2, volume_ratio: 2.5 }), news: news({ event_in_window: true }) }));
    assert.equal(r.setup.key, "move_spent");
    assert.equal(r.state, "nothing_here");
    assert.equal(r.setup.read, "2.24σ move already delivered on 2.50× volume");
    assert.equal(r.setup.values.move_direction, "up");
    // The delivered direction is not tape pressure, so it never contradicts a thesis.
    assert.equal(r.setup.direction, null);
  });
  it("without a news burst or an event in the window it declines", () => {
    assert.notEqual(keyOf(inputs({ quant: quant({ momentum_20d: 0.2, volume_ratio: 2.5 }) })), "move_spent");
  });
  it("stretched but unattended declines too", () => {
    assert.notEqual(keyOf(inputs({ quant: quant({ momentum_20d: 0.2, volume_ratio: 1.1 }), news: news({ event_in_window: true }) })), "move_spent");
  });
});

describe("gauge/setups — 7 DIVERGENCE", () => {
  it("Screen's insider divergence → actionable, direction from the insider side", () => {
    const r = setupOf(inputs({ screen: [finding("insider_divergence")] }));
    assert.equal(r.setup.key, "divergence");
    assert.equal(r.state, "actionable");
    assert.equal(r.setup.direction, "up");
    assert.equal(r.setup.read, "Insiders accumulating against a falling tape (−9.0% over 20 sessions)");
  });
  it("a selling cluster reads the other way", () => {
    const r = setupOf(inputs({ screen: [finding("insider_divergence", { direction: "sell", values: { direction: "sell", momentum_20d: 0.11 } })] }));
    assert.equal(r.setup.direction, "down");
    assert.equal(r.setup.read, "Insiders distributing against a rising tape (+11.0% over 20 sessions)");
  });
  it("a live cluster detector alone is not the setup — Screen owns the multi-session test", () => {
    const r = setupOf(inputs({ detectors: detectors({ insider_cluster: { active: true, direction: "sell" } }) }));
    assert.notEqual(r.setup.key, "divergence");
  });
});

describe("gauge/setups — 8 REGIME BREAK", () => {
  it("vol past its own norm → unreadable", () => {
    const r = setupOf(inputs({ quant: quant({ vol_regime: 1.7 }) }));
    assert.equal(r.setup.key, "regime_break");
    assert.equal(r.state, "unreadable");
    assert.equal(r.setup.read, "Volatility 1.70× its own norm — structure unreliable");
    assert.equal(r.readable, false);
    // The reading already says it; no second caveat.
    assert.equal(r.readability_note, null);
  });
  it("an expanding but intact regime declines it", () => {
    assert.notEqual(keyOf(inputs({ quant: quant({ vol_regime: 1.4 }) })), "regime_break");
  });
});

describe("gauge/setups — 9 UNREADABLE", () => {
  it("r² under Tracker's floor with no structure above it → unreadable", () => {
    const r = setupOf(inputs({ quant: quant({ r2: 0.03, beta: 1.1 }) }));
    assert.equal(r.setup.key, "unreadable");
    assert.equal(r.state, "unreadable");
    assert.equal(r.setup.read, "The market model explains little of the movement (β 1.10, r² 0.03) — residual reads no cleaner than the raw move");
    assert.equal(r.readable, false);
  });
  it("a fittable market model declines it", () => {
    assert.notEqual(keyOf(inputs({ quant: quant({ r2: 0.4 }) })), "unreadable");
  });
  it("a contracting regime with no structure lands here (the v1.0 table's dead zone)", () => {
    // Under the v1.0 table, `regime 0.8–1.5` on #9 plus `r² ≥ 0.15` on #1 left
    // low-r² contracting names falling through every row into "no structure".
    const r = setupOf(inputs({ quant: quant({ r2: 0.01, vol_regime: 0.74, volume_ratio: 2.5 }) }));
    assert.equal(r.setup.key, "unreadable");
  });
  it("…and the same dead zone with structure now surfaces the structure, qualified", () => {
    // AZN on 2026-08-24: r² 0.01, regime 0.74, volume 0.69× — genuinely coiled,
    // just not measurable on residuals.
    const r = setupOf(inputs({ quant: quant({ r2: 0.01, vol_regime: 0.74, volume_ratio: 0.69, momentum_20d: -0.02 }) }));
    assert.equal(r.setup.key, "coiled");
    assert.equal(r.state, "actionable");
    assert.equal(r.readable, false);
    assert.match(r.readability_note ?? "", /residual reads weak/);
  });
  it("null r² names the gap instead of pretending", () => {
    const r = setupOf(inputs({ quant: quant({ r2: null, beta: null }) }));
    assert.equal(r.setup.key, "unreadable");
    assert.equal(r.setup.read, "Not enough history to fit the market model — residual reads unavailable");
  });
});

describe("gauge/setups — 10 EVENT WALL", () => {
  it("earnings inside the wall → wait, with the typical move", () => {
    const r = setupOf(inputs({ next_earnings: due(1) }));
    assert.equal(r.setup.key, "event_wall");
    assert.equal(r.state, "wait");
    assert.equal(r.setup.read, "Earnings in 1 session, typical move 4.9% — everything else is noise until then");
    assert.equal(r.missing?.label, "earnings in 1 session");
  });
  it("fires at the wait horizon, not only when imminent (the v1.0 table left 2 sessions homeless)", () => {
    const r = setupOf(inputs({ next_earnings: due(2) }));
    assert.equal(r.setup.key, "event_wall");
    assert.equal(r.state, "wait");
  });
  it("outside the wall it declines", () => {
    assert.notEqual(keyOf(inputs({ next_earnings: due(4) })), "event_wall");
  });
});

describe("gauge/setups — 11 NO SETUP", () => {
  it("nothing recognizable → the honest empty answer", () => {
    const r = setupOf(inputs());
    assert.equal(r.setup.key, "no_setup");
    assert.equal(r.state, "nothing_here");
    assert.equal(r.setup.read, "No recognizable structure — normal tape");
    assert.equal(r.missing, null);
  });
  it("a recognized structure never lands here", () => {
    assert.notEqual(keyOf(inputs({ quant: coiledQuant() })), "no_setup");
  });
});

// ---------------------------------------------------------------------------
// Priority
// ---------------------------------------------------------------------------

describe("gauge/setups — evaluation order", () => {
  it("compressed AND an event inside the wall → the compressed reading wins over the generic wall", () => {
    assert.equal(keyOf(inputs({ quant: coiledQuant(), next_earnings: due(2) })), "coiled_event_ahead");
  });
  it("a broken regime AND an imminent event → the event wins (it resolves the tape)", () => {
    assert.equal(keyOf(inputs({ quant: quant({ vol_regime: 1.7 }), next_earnings: due(1) })), "event_wall");
  });
  it("spent move AND an independent tape → spent wins (the move already happened)", () => {
    const i = inputs({
      quant: quant({ momentum_20d: 0.2, volume_ratio: 2.5 }),
      screen: [finding("independent_tape")],
      news: news({ event_in_window: true }),
    });
    assert.equal(keyOf(i), "move_spent");
  });
  it("insider divergence outranks accumulation and both drifts", () => {
    const i = inputs({
      quant: quant({ volume_ratio: 1.5, momentum_5d: 0.005 }),
      screen: [finding("independent_tape"), finding("quiet_accumulation"), finding("insider_divergence")],
    });
    assert.equal(keyOf(i), "divergence");
  });
  it("a low r² no longer outranks structure — COILED survives, qualified (§B4b)", () => {
    const r = setupOf(inputs({ quant: quant({ vol_regime: 0.7, volume_ratio: 0.6, momentum_20d: 0.03, r2: 0.03, beta: 2.3 }) }));
    assert.equal(r.setup.key, "coiled");
    assert.equal(r.state, "actionable");
    assert.equal(r.readable, false);
    assert.equal(
      r.readability_note,
      "residual reads weak — the market model explains little (β 2.30, r² 0.03); the structure is measured on price and volume, not residuals",
    );
  });
  it("the order is config — moving unreadable back to the top restores the v1.0 behaviour", () => {
    const strict = cfg({ setups: { order: ["unreadable", "coiled"] } });
    const i = inputs({ quant: quant({ vol_regime: 0.7, volume_ratio: 0.6, momentum_20d: 0.03, r2: 0.03 }) });
    assert.equal(recognizeSetup(i, strict, null).setup.key, "unreadable");
  });
  it("a truncated stored order still evaluates every row", () => {
    const partial = cfg({ setups: { order: ["coiled"] } });
    assert.equal(recognizeSetup(inputs({ next_earnings: due(1) }), partial, null).setup.key, "event_wall");
  });
});

// ---------------------------------------------------------------------------
// State / missing consistency (§3)
// ---------------------------------------------------------------------------

describe("gauge/setups — state and missing", () => {
  const byKey = setupFixtures() as Record<GaugeSetupKey, GaugeInputs>;

  it("every setup key has a fixture that actually reaches it", () => {
    for (const key of GAUGE_SETUPS) assert.equal(keyOf(byKey[key]), key, `fixture for ${key}`);
  });

  it("missing is filled exactly on `wait`, and always names a measured value", () => {
    for (const key of GAUGE_SETUPS) {
      const r = setupOf(byKey[key]);
      assert.equal(r.state, SETUP_BASE_STATE[key], `${key} base state`);
      if (r.state === "wait") {
        assert.ok(r.missing, `${key} must say what is missing`);
        assert.match(r.missing!.detail, /\d/, `${key} missing detail must carry a number`);
      } else {
        assert.equal(r.missing, null, `${key} must not carry a missing line`);
      }
    }
  });

  it("every reading is a sentence with content", () => {
    for (const key of GAUGE_SETUPS) {
      const r = setupOf(byKey[key]);
      assert.ok(r.setup.read.length > 10, `${key} reading`);
      assert.doesNotMatch(r.setup.read, /\{\w+\}/, `${key} left an unfilled placeholder`);
      assert.doesNotMatch(r.setup.name, /\{\w+\}/, `${key} name placeholder`);
    }
  });
});

// ---------------------------------------------------------------------------
// §4 Screen dependency
// ---------------------------------------------------------------------------

describe("gauge/setups — Screen dependency", () => {
  it("the same ticker narrows to the instantaneous pool when Screen has nothing", () => {
    const withScreen = inputs({ quant: quant({ volume_ratio: 1.5 }), screen: [finding("independent_tape")] });
    assert.equal(keyOf(withScreen), "confirmed_drift");
    assert.equal(keyOf(inputs({ quant: quant({ volume_ratio: 1.5 }), screen: [] })), "no_setup");
  });
  it("Screen-fed rows never fire without a finding, instantaneous rows still do", () => {
    const noScreen = inputs({ quant: coiledQuant(), screen: [], screen_available: false });
    assert.equal(keyOf(noScreen), "coiled");
    for (const key of ["quiet_drift", "confirmed_drift", "accumulation", "divergence"] as GaugeSetupKey[]) {
      assert.notEqual(keyOf(inputs({ screen: [], screen_available: false })), key);
    }
  });
  it("findings are carried as provenance with Screen's own read", () => {
    const r = setupOf(inputs({ quant: quant({ volume_ratio: 1.5 }), screen: [finding("independent_tape", { day_count: 6 })] }));
    assert.deepEqual(r.setup.screen, [{ pattern: "independent_tape", day_count: 6, read: "screen: independent_tape" }]);
  });
});

// ---------------------------------------------------------------------------
// §2 context mode
// ---------------------------------------------------------------------------

describe("gauge/setups — context mode", () => {
  it("a directional setup against the thesis → contradicted_setup", () => {
    const i = inputs({ quant: quant({ volume_ratio: 1.5 }), screen: [finding("independent_tape")] });
    const r = setupOf(i, ctx({ expected_direction: "down" }));
    assert.equal(r.setup.key, "confirmed_drift");
    assert.equal(r.state, "contradicted_setup");
    assert.equal(r.missing, null);
    assert.equal(r.state_line, "The tape is set up in the opposite direction of the thesis — CONFIRMED DRIFT reads up, the thesis expects down");
  });
  it("a directional setup aligned with the thesis keeps its own state", () => {
    const i = inputs({ quant: quant({ volume_ratio: 1.5 }), screen: [finding("independent_tape")] });
    const r = setupOf(i, ctx({ expected_direction: "up" }));
    assert.equal(r.state, "actionable");
    assert.equal(r.state_line, null);
  });
  it("a direction-symmetric setup is never contradicted", () => {
    const r = setupOf(inputs({ quant: coiledQuant() }), ctx({ expected_direction: "down" }));
    assert.equal(r.state, "actionable");
    assert.equal(r.state_line, null);
  });
  it("an unresolved thesis direction cannot contradict anything", () => {
    const i = inputs({ quant: quant({ volume_ratio: 1.5 }), screen: [finding("independent_tape")] });
    assert.equal(setupOf(i, ctx({ expected_direction: null })).state, "actionable");
  });
  it("a wait setup that contradicts loses its missing line — the contradiction is the point", () => {
    const i = inputs({ quant: quant({ volume_ratio: 0.6 }), screen: [finding("independent_tape")] });
    const r = setupOf(i, ctx({ expected_direction: "down" }));
    assert.equal(r.setup.key, "quiet_drift");
    assert.equal(r.state, "contradicted_setup");
    assert.equal(r.missing, null);
  });
});

// ---------------------------------------------------------------------------
// Degraded (§7.5) + the v1 evidence layer (§7.7)
// ---------------------------------------------------------------------------

describe("gauge/setups — degraded and evidence", () => {
  it("no close-run at all → recognition still runs and lands on unreadable", () => {
    const r = setupOf(inputs({ quant: null }));
    assert.equal(r.setup.key, "unreadable");
    assert.equal(r.state, "unreadable");
    assert.equal(r.readable, false);
  });
  it("a null vol keeps the event wall readable — recognition is never skipped wholesale", () => {
    const r = setupOf(inputs({ quant: quant({ daily_vol: null, r2: null }), next_earnings: due(1) }));
    assert.equal(r.setup.key, "event_wall");
    assert.equal(r.state, "wait");
  });
  it("the untracked readout still carries a setup shape", () => {
    const r = gauge(inputs({ tracked: false, quant: null }), config);
    assert.equal(r.setup.key, "no_setup");
    assert.equal(r.setup.read, "Not tracked — no gauge.");
    assert.equal(r.state, "nothing_here");
    assert.equal(r.readable, false);
  });
  it("the v1 checks are untouched by the setup layer — same statuses, same raw values", () => {
    const i = inputs({ quant: coiledQuant() });
    const r = gauge(i, config);
    assert.deepEqual(r.checks.map((c) => c.key), ["trend", "regime", "residual", "volume", "stretch", "event_wall"]);
    assert.equal(r.checks[1].reason, "vol regime 0.70× its 90d norm — contracting, quieter than usual");
    assert.equal(r.checks[4].values.stretch_z, 0.03 / (0.02 * Math.sqrt(20)));
    assert.equal(r.summary.overall, "clear");
    // …and the hero is now the setup, not the checks.
    assert.equal(r.setup.key, "coiled");
    assert.equal(r.state, "actionable");
  });
});
