import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkConflict, checkEventWall, checkFreshness, checkRegime, checkResidual, checkStretch, checkTrend, checkVolume, momentumZ } from "./checks.js";
import { cfg, ctx, detectors, inputs, quant } from "./test-fixtures.js";

const config = cfg();

describe("gauge/checks — 1 trend coherence", () => {
  it("standalone: same-sign 5d/20d → pass", () => {
    const c = checkTrend(inputs({ quant: quant({ momentum_5d: 0.01, momentum_20d: 0.03 }) }), config, null);
    assert.equal(c.status, "pass");
    assert.equal(c.reason, "5d and 20d momentum agree (+1.0% / +3.0%) — price action coherent");
    assert.equal(c.number, 1);
    assert.equal(c.label, "Trend coherence");
  });
  it("standalone: mixed signs → caution", () => {
    const c = checkTrend(inputs({ quant: quant({ momentum_5d: -0.02, momentum_20d: 0.03 }) }), config, null);
    assert.equal(c.status, "caution");
    assert.match(c.reason, /disagree/);
    assert.equal(c.short_label, "momentum split");
  });
  it("standalone: a flat leg counts as agreement", () => {
    assert.equal(checkTrend(inputs({ quant: quant({ momentum_5d: 0, momentum_20d: 0.03 }) }), config, null).status, "pass");
  });
  it("context: hand-computed z = m5/(vol·√5) — aligned → pass", () => {
    const c = checkTrend(inputs({ quant: quant({ momentum_5d: 0.05, daily_vol: 0.02 }) }), config, ctx({ expected_direction: "up" }));
    assert.equal(c.status, "pass");
    assert.equal(momentumZ(0.05, 0.02, 5)!.toFixed(3), "1.118");
    assert.equal(c.reason, "5d momentum +5.0% (z 1.12) aligned with the expected up move");
    assert.equal((c.values.momentum_5d_z as number).toFixed(3), "1.118");
  });
  it("context: opposite and |z| ≤ 1.5 → caution", () => {
    const c = checkTrend(inputs({ quant: quant({ momentum_5d: -0.05, daily_vol: 0.02 }) }), config, ctx({ expected_direction: "up" }));
    assert.equal(c.status, "caution");
    assert.equal(c.reason, "5d momentum −5.0% (z −1.12) mildly against the expected up move");
  });
  it("context: opposite and |z| > 1.5 → fail, 'tape is fighting the thesis'", () => {
    const c = checkTrend(inputs({ quant: quant({ momentum_5d: -0.08, daily_vol: 0.02 }) }), config, ctx({ expected_direction: "up" }));
    assert.equal(c.status, "fail");
    assert.equal(c.reason, "tape is fighting the thesis — 5d momentum −8.0% (z −1.79) against the expected up move");
  });
  it("context: expected down, 5d down → pass", () => {
    assert.equal(checkTrend(inputs({ quant: quant({ momentum_5d: -0.03 }) }), config, ctx({ expected_direction: "down" })).status, "pass");
  });
  it("context: unresolved direction → standalone logic + note", () => {
    const c = checkTrend(inputs({ quant: quant({ momentum_5d: -0.02, momentum_20d: 0.03 }) }), config, ctx({ expected_direction: null }));
    assert.equal(c.status, "caution");
    assert.equal(c.note, "thesis direction unresolved — read as standalone");
  });
  it("null momentum → n_a naming the gap", () => {
    const c = checkTrend(inputs({ quant: quant({ momentum_5d: null }), history_sessions: 12 }), config, null);
    assert.equal(c.status, "n_a");
    assert.equal(c.reason, "momentum unavailable — fresh listing, history window not yet full (12 sessions on file)");
  });
  it("context with null vol → n_a (z not computable)", () => {
    const c = checkTrend(inputs({ quant: quant({ daily_vol: null }) }), config, ctx());
    assert.equal(c.status, "n_a");
    assert.match(c.reason, /momentum z/);
  });
});

describe("gauge/checks — 2 volatility regime", () => {
  it("≤1.2 stable pass · <0.8 contracting pass with note wording · 1.2–1.5 caution · >1.5 fail · null n_a", () => {
    assert.equal(checkRegime(inputs({ quant: quant({ vol_regime: 1.0 }) }), config).status, "pass");
    assert.equal(checkRegime(inputs({ quant: quant({ vol_regime: 1.2 }) }), config).status, "pass");
    const contracting = checkRegime(inputs({ quant: quant({ vol_regime: 0.7 }) }), config);
    assert.equal(contracting.status, "pass");
    assert.equal(contracting.reason, "vol regime 0.70× its 90d norm — contracting, quieter than usual");
    const expanding = checkRegime(inputs({ quant: quant({ vol_regime: 1.36 }) }), config);
    assert.equal(expanding.status, "caution");
    assert.equal(expanding.reason, "vol regime 1.36× its 90d norm — expanding");
    const unstable = checkRegime(inputs({ quant: quant({ vol_regime: 1.6 }) }), config);
    assert.equal(unstable.status, "fail");
    assert.equal(unstable.reason, "regime unstable — vol 1.60× its 90d norm; reads unreliable");
    const na = checkRegime(inputs({ quant: quant({ vol_regime: null }) }), config);
    assert.equal(na.status, "n_a");
    assert.equal(na.reason, "vol regime unavailable — close-run not yet computed");
  });
});

describe("gauge/checks — 3 residual readability", () => {
  it("r² ≥ floor → pass", () => {
    const c = checkResidual(inputs({ quant: quant({ r2: 0.4, beta: 1.2 }) }), config);
    assert.equal(c.status, "pass");
    assert.equal(c.reason, "r² 0.40, β 1.20 — residual reads usable");
  });
  it("r² < floor → caution with the beta note; never fail", () => {
    const c = checkResidual(inputs({ quant: quant({ r2: 0.09, beta: 1.98 }) }), config);
    assert.equal(c.status, "caution");
    assert.equal(c.reason, "β 1.98, r² 0.09 — the market model explains little of the daily movement; residual reads no cleaner than the raw move");
    assert.equal(c.short_label, "weak residual read");
    assert.equal(checkResidual(inputs(), config).short_label, null);
  });
  it("the floor is the input (Tracker's), not a Gauge constant", () => {
    assert.equal(checkResidual(inputs({ quant: quant({ r2: 0.2 }), r2_floor: 0.25 }), config).status, "caution");
    assert.equal(checkResidual(inputs({ quant: quant({ r2: 0.2 }), r2_floor: 0.15 }), config).status, "pass");
  });
  it("null r² → n_a", () => {
    assert.equal(checkResidual(inputs({ quant: quant({ r2: null }) }), config).status, "n_a");
  });
});

describe("gauge/checks — 4 volume state", () => {
  it("standalone bands: quiet/normal pass, elevated/anomaly caution", () => {
    const quiet = checkVolume(inputs({ quant: quant({ volume_ratio: 0.5 }) }), config, null);
    assert.equal(quiet.status, "pass");
    assert.equal(quiet.reason, "volume 0.50× its average — quiet");
    assert.equal(checkVolume(inputs({ quant: quant({ volume_ratio: 1.4 }) }), config, null).reason, "volume 1.40× its average — normal");
    const elevated = checkVolume(inputs({ quant: quant({ volume_ratio: 2.5 }) }), config, null);
    assert.equal(elevated.status, "caution");
    assert.equal(elevated.reason, "volume 2.50× its average — elevated");
    const anomaly = checkVolume(inputs({ quant: quant({ volume_ratio: 3.5 }) }), config, null);
    assert.equal(anomaly.status, "caution");
    assert.equal(anomaly.reason, "volume 3.50× its average — event-driven tape");
  });
  it("context bands: early pass · normal pass · confirming pass · elevated caution · crowded caution", () => {
    const early = checkVolume(inputs({ quant: quant({ volume_ratio: 0.5 }) }), config, ctx());
    assert.equal(early.status, "pass");
    assert.equal(early.reason, "volume 0.50× its average — early, market not yet looking");
    assert.equal(checkVolume(inputs({ quant: quant({ volume_ratio: 0.85 }) }), config, ctx()).reason, "volume 0.85× its average — normal");
    const confirming = checkVolume(inputs({ quant: quant({ volume_ratio: 1.5 }) }), config, ctx());
    assert.equal(confirming.status, "pass");
    assert.equal(confirming.reason, "volume 1.50× its average — confirming");
    assert.equal(checkVolume(inputs({ quant: quant({ volume_ratio: 2.5 }) }), config, ctx()).status, "caution");
    const crowded = checkVolume(inputs({ quant: quant({ volume_ratio: 3.5 }) }), config, ctx());
    assert.equal(crowded.status, "caution");
    assert.equal(crowded.reason, "volume 3.50× its average — crowded, late");
  });
  it("partial flag → evaluated, labeled intraday-partial", () => {
    const c = checkVolume(inputs({ quant: quant({ volume_ratio: 1.5, volume_ratio_partial: true }) }), config, null);
    assert.equal(c.status, "pass");
    assert.equal(c.note, "intraday-partial — session volume still accumulating");
    assert.equal(c.values.partial, true);
  });
  it("null ratio → n_a", () => {
    assert.equal(checkVolume(inputs({ quant: quant({ volume_ratio: null }) }), config, ctx()).status, "n_a");
  });
});

describe("gauge/checks — 5 stretch", () => {
  it("hand-computed stretch_z = m20/(vol·√20): 0.03/0.02 → 0.335 pass", () => {
    const c = checkStretch(inputs({ quant: quant({ momentum_20d: 0.03, daily_vol: 0.02 }) }), config, null);
    assert.equal(c.status, "pass");
    assert.equal((c.values.stretch_z as number).toFixed(3), "0.335");
    assert.equal(c.reason, "20d move +3.0% is 0.34σ — not stretched");
  });
  it("|z| 1–2 → caution in both modes", () => {
    const q = quant({ momentum_20d: 0.12, daily_vol: 0.02 });
    assert.equal(checkStretch(inputs({ quant: q }), config, null).status, "caution");
    assert.equal(checkStretch(inputs({ quant: q }), config, ctx()).status, "caution");
    assert.equal(checkStretch(inputs({ quant: q }), config, null).reason, "20d move +12.0% is 1.34σ — stretched");
  });
  it("|z| > 2 in the expected direction → fail 'move may be spent'", () => {
    const c = checkStretch(inputs({ quant: quant({ momentum_20d: 0.2, daily_vol: 0.02 }) }), config, ctx({ expected_direction: "up" }));
    assert.equal(c.status, "fail");
    assert.equal(c.reason, "move may be spent — 20d move +20.0% already 2.24σ in the expected up direction");
  });
  it("|z| > 2 against the expected direction → caution (washout)", () => {
    const c = checkStretch(inputs({ quant: quant({ momentum_20d: 0.2, daily_vol: 0.02 }) }), config, ctx({ expected_direction: "down" }));
    assert.equal(c.status, "caution");
    assert.match(c.reason, /potential washout/);
  });
  it("|z| > 2 standalone → caution (heavily stretched), never fail", () => {
    const c = checkStretch(inputs({ quant: quant({ momentum_20d: -0.2, daily_vol: 0.02 }) }), config, null);
    assert.equal(c.status, "caution");
    assert.equal(c.reason, "20d move −20.0% is 2.24σ — heavily stretched");
  });
  it("within 2% of a 52w extreme → note appended, status unchanged", () => {
    const high = checkStretch(inputs({ quant: quant({ pct_from_52w_high: -0.015 }) }), config, null);
    assert.equal(high.status, "pass");
    assert.equal(high.note, "within 1.5% of the 52w high");
    const low = checkStretch(inputs({ quant: quant({ pct_from_52w_low: 0.004 }) }), config, null);
    assert.equal(low.note, "within 0.4% of the 52w low");
    assert.equal(checkStretch(inputs({ quant: quant({ pct_from_52w_high: -0.05 }) }), config, null).note, null);
  });
  it("null m20 / vol → n_a", () => {
    assert.equal(checkStretch(inputs({ quant: quant({ momentum_20d: null }) }), config, null).status, "n_a");
    assert.equal(checkStretch(inputs({ quant: quant({ daily_vol: null }) }), config, null).status, "n_a");
  });
});

describe("gauge/checks — 6 event wall", () => {
  const due = (sessions_until: number) => ({ due_at: "2026-08-26T20:00:00.000Z", sessions_until, fiscal_period: "Q2 2027" });
  it("no due → pass", () => {
    const c = checkEventWall(inputs({ next_earnings: null }), config, null);
    assert.equal(c.status, "pass");
    assert.equal(c.reason, "no scheduled event within 3 sessions");
  });
  it("due in 4 → pass (outside the wall); rhythm 4.9% < 5% → no sizeable note", () => {
    const c = checkEventWall(inputs({ next_earnings: due(4) }), config, null);
    assert.equal(c.status, "pass");
    assert.equal(c.reason, "earnings in 4 sessions — outside the 3-session wall");
    assert.equal(c.note, null);
  });
  it("G1: AVGO fixture — due in 8 sessions, rhythm 9.55% → pass + sizeable-event note", () => {
    const c = checkEventWall(inputs({ next_earnings: due(8), quant: quant({ earnings_rhythm: 0.0955 }) }), config, null);
    assert.equal(c.status, "pass");
    assert.equal(c.reason, "earnings in 8 sessions — outside the 3-session wall");
    assert.equal(c.note, "earnings in 8 sessions, typical move 9.6% — sizeable event on the horizon");
    assert.equal(c.short_label, null);
  });
  it("G1: AMD fixture — due in 50 sessions → plain pass; 10 sessions is the inclusive edge; 2 sessions stays caution", () => {
    assert.equal(checkEventWall(inputs({ next_earnings: due(50), quant: quant({ earnings_rhythm: 0.12 }) }), config, null).note, null);
    assert.match(checkEventWall(inputs({ next_earnings: due(10), quant: quant({ earnings_rhythm: 0.05 }) }), config, null).note ?? "", /sizeable event/);
    assert.equal(checkEventWall(inputs({ next_earnings: due(11), quant: quant({ earnings_rhythm: 0.12 }) }), config, null).note, null);
    const two = checkEventWall(inputs({ next_earnings: due(2), quant: quant({ earnings_rhythm: 0.12 }) }), config, null);
    assert.equal(two.status, "caution");
    assert.equal(two.reason, "earnings in 2 sessions — typical move 12.0%");
    assert.equal(two.short_label, "earnings near");
  });
  it("G1: thresholds are config", () => {
    const tight = cfg({ thresholds: { eventWall: { noteSessionsMax: 6, noteRhythmMin: 0.05 } } });
    assert.equal(checkEventWall(inputs({ next_earnings: due(8), quant: quant({ earnings_rhythm: 0.0955 }) }), tight, null).note, null);
  });
  it("due ≤3 → caution; ≤1 → fail with the typical move", () => {
    assert.equal(checkEventWall(inputs({ next_earnings: due(3) }), config, null).status, "caution");
    const two = checkEventWall(inputs({ next_earnings: due(2) }), config, null);
    assert.equal(two.status, "caution");
    assert.equal(two.reason, "earnings in 2 sessions — typical move 4.9%");
    const one = checkEventWall(inputs({ next_earnings: due(1) }), config, null);
    assert.equal(one.status, "fail");
    assert.equal(one.reason, "earnings in 1 session — typical move 4.9%");
    assert.equal(checkEventWall(inputs({ next_earnings: due(0) }), config, null).status, "fail");
  });
  it("rhythm unavailable → still evaluated, named", () => {
    const c = checkEventWall(inputs({ next_earnings: due(1), quant: quant({ earnings_rhythm: null }) }), config, null);
    assert.equal(c.status, "fail");
    assert.equal(c.reason, "earnings in 1 session — typical move unavailable");
  });
  it("context where the thesis IS the event → n_a", () => {
    const c = checkEventWall(inputs({ next_earnings: due(1) }), config, ctx({ thesis_is_scheduled_event: true }));
    assert.equal(c.status, "n_a");
    assert.equal(c.reason, "event is the thesis");
  });
  it("context without that flag behaves like standalone", () => {
    assert.equal(checkEventWall(inputs({ next_earnings: due(1) }), config, ctx()).status, "fail");
  });
});

describe("gauge/checks — 7 conflict scan (context only)", () => {
  it("insider cluster opposite the thesis → fail, named", () => {
    const c = checkConflict(inputs({ detectors: detectors({ insider_cluster: { active: true, direction: "sell" } }) }), config, ctx({ expected_direction: "up" }));
    assert.equal(c.status, "fail");
    assert.equal(c.reason, "insider cluster distributing — contradicting the expected up move");
  });
  it("insider cluster aligned → no conflict (pass)", () => {
    const c = checkConflict(inputs({ detectors: detectors({ insider_cluster: { active: true, direction: "buy" } }) }), config, ctx({ expected_direction: "up" }));
    assert.equal(c.status, "pass");
    assert.equal(c.reason, "nothing live contradicting the thesis");
  });
  it("unexplained move / drift opposite sign → caution", () => {
    const u = checkConflict(inputs({ detectors: detectors({ unexplained_move: { active: true, direction: "down" } }) }), config, ctx({ expected_direction: "up" }));
    assert.equal(u.status, "caution");
    assert.equal(u.reason, "unexplained move down against the expected up move");
    const d = checkConflict(inputs({ detectors: detectors({ drift: { active: true, direction: "up" } }) }), config, ctx({ expected_direction: "down" }));
    assert.equal(d.status, "caution");
    assert.equal(d.reason, "drift up against the expected down move");
    assert.equal(checkConflict(inputs({ detectors: detectors({ drift: { active: true, direction: "up" } }) }), config, ctx({ expected_direction: "up" })).status, "pass");
  });
  it("disclosure_risk tag / filing_overdue → caution", () => {
    const t = checkConflict(inputs({ incidents: [{ incident_id: "i1", band: "P2", tags: ["disclosure_risk", "explained_move"] }] }), config, ctx());
    assert.equal(t.status, "caution");
    assert.equal(t.reason, "disclosure risk open on the name");
    const f = checkConflict(inputs({ detectors: detectors({ filing_overdue: true }) }), config, ctx());
    assert.equal(f.status, "caution");
    assert.equal(f.reason, "filing overdue on the name");
  });
  it("multiple conflicts: worst leads, the rest land in the note", () => {
    const c = checkConflict(
      inputs({ detectors: detectors({ insider_cluster: { active: true, direction: "sell" }, drift: { active: true, direction: "down" }, filing_overdue: true }) }),
      config,
      ctx({ expected_direction: "up" }),
    );
    assert.equal(c.status, "fail");
    assert.equal(c.note, "drift down against the expected up move · filing overdue on the name");
    assert.equal(c.values.conflicts, 3);
  });
  it("unresolved direction → only disclosure conflicts scanned", () => {
    const c = checkConflict(inputs({ detectors: detectors({ insider_cluster: { active: true, direction: "sell" } }) }), config, ctx({ expected_direction: null }));
    assert.equal(c.status, "pass");
    assert.match(c.reason, /direction unresolved/);
  });
  it("no detector state → n_a", () => {
    assert.equal(checkConflict(inputs({ detectors: null }), config, ctx()).status, "n_a");
  });
});

describe("gauge/checks — 8 window freshness (context only)", () => {
  it("0–1 sessions pass · 2 caution · ≥3 fail", () => {
    assert.equal(checkFreshness(config, ctx(), 0).reason, "0 sessions since the event — fresh");
    assert.equal(checkFreshness(config, ctx(), 1).reason, "1 session since the event — fresh");
    const aging = checkFreshness(config, ctx(), 2);
    assert.equal(aging.status, "caution");
    assert.equal(aging.reason, "2 sessions since the event — aging");
    const closed = checkFreshness(config, ctx(), 3);
    assert.equal(closed.status, "fail");
    assert.equal(closed.reason, "window closed — 3 sessions since the event; pricing status frozen");
  });
  it("source already priced → fail regardless of sessions", () => {
    const c = checkFreshness(config, ctx({ pricing_status: "priced" }), 0);
    assert.equal(c.status, "fail");
    assert.equal(c.reason, "window closed — already priced at the source");
  });
  it("no usable session count → n_a", () => {
    assert.equal(checkFreshness(config, ctx(), null).status, "n_a");
  });
});
