import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_GAUGE_CONFIG } from "./config.js";
import { gauge } from "./compute.js";
import { cfg, ctx, detectors, inputs, quant, setupFixtures } from "./test-fixtures.js";

/**
 * §5 language guardrails — the brand line enforced in CI: no advice vocabulary
 * in any template or label. Word-boundary match plus the common inflections
 * so "sells", "entering", "targets", "stopped" are caught too.
 */
export function bannedHits(text: string, banned: string[]): string[] {
  const hits: string[] = [];
  for (const word of banned) {
    const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`\\b${escaped}(s|es|ed|ing|ped|ping)?\\b`, "i");
    if (re.test(text)) hits.push(word);
  }
  return hits;
}

describe("gauge/language — §5 banned vocabulary", () => {
  const banned = DEFAULT_GAUGE_CONFIG.bannedWords;

  it("the banned list is the spec's", () => {
    assert.deepEqual(banned, ["buy", "sell", "enter", "exit", "long", "short", "add", "trim", "target", "stop", "take profit", "signal", "prediction", "recommend", "opportunity", "edge", "high probability", "likely", "good setup", "bad setup"]);
  });

  it("the matcher catches the obvious offenders (sanity)", () => {
    assert.deepEqual(bannedHits("buy the dip", banned), ["buy"]);
    assert.deepEqual(bannedHits("insiders are selling", banned), ["sell"]);
    assert.deepEqual(bannedHits("price target raised", banned), ["target"]);
    assert.deepEqual(bannedHits("a strong signal", banned), ["signal"]);
    assert.deepEqual(bannedHits("stopped out", banned), ["stop"]);
    assert.deepEqual(bannedHits("take profit here", banned), ["take profit"]);
    // And does not false-positive on condition language that merely contains the letters.
    assert.deepEqual(bannedHits("stable, expanding, shorter-than-usual, longer windows — contradicting, existing", banned), []);
  });

  it("no default template contains a banned word", () => {
    const offenders: string[] = [];
    for (const [key, template] of Object.entries(DEFAULT_GAUGE_CONFIG.templates)) {
      const hits = bannedHits(template, banned);
      if (hits.length) offenders.push(`${key}: ${hits.join(", ")}`);
    }
    assert.deepEqual(offenders, []);
  });

  it("no check label contains a banned word", () => {
    const offenders: string[] = [];
    for (const [key, label] of Object.entries(DEFAULT_GAUGE_CONFIG.labels)) {
      const hits = bannedHits(label, banned);
      if (hits.length) offenders.push(`${key}: ${hits.join(", ")}`);
    }
    assert.deepEqual(offenders, []);
  });

  it("v2: no setup name, reading, missing line or state tooltip carries a banned word", () => {
    const config = cfg();
    const offenders: string[] = [];
    for (const [key, i] of Object.entries(setupFixtures())) {
      // Standalone and against a thesis, so the contradiction line renders too.
      for (const context of [null, ctx({ expected_direction: "down" })] as const) {
        const r = gauge(i, config, context);
        const texts = [
          r.setup.name,
          r.setup.read,
          r.missing?.label ?? "",
          r.missing?.detail ?? "",
          r.state_line ?? "",
          r.readability_note ?? "",
        ];
        for (const text of texts) {
          const hits = bannedHits(text, banned);
          if (hits.length) offenders.push(`${key}: "${text}" → ${hits.join(", ")}`);
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it("v2: setup names are descriptive, never judgements", () => {
    const config = cfg();
    for (const key of Object.keys(setupFixtures())) {
      const name = config.templates[`setup_name_${key}`];
      assert.ok(name, `${key} needs a name`);
      assert.doesNotMatch(name, /\b(good|bad|strong|weak|best|worst)\b/i, `${key} name is a judgement`);
      assert.equal(name, name.toUpperCase(), `${key} name should read as a label`);
    }
  });

  it("v2: `actionable` is the one decision word, and its definition is fixed", () => {
    const config = cfg();
    assert.equal(config.templates.tooltip_state_actionable, "conditions are consistent enough to test a thesis");
    // It must never leak into a setup reading — the state carries it, not the prose.
    for (const [key, i] of Object.entries(setupFixtures())) {
      const r = gauge(i, cfg());
      assert.doesNotMatch(r.setup.read, /\bactionable\b/i, `${key} reading`);
    }
  });

  it("rendered readouts (every status path exercised) stay clean", () => {
    const config = cfg();
    const readouts = [
      gauge(inputs(), config),
      gauge(inputs({ quant: quant({ momentum_5d: -0.08, vol_regime: 1.7, r2: 0.05, volume_ratio: 3.5, momentum_20d: 0.2, pct_from_52w_high: -0.01 }), next_earnings: { due_at: "x", sessions_until: 1, fiscal_period: null } }), config, ctx()),
      gauge(
        inputs({
          detectors: detectors({ insider_cluster: { active: true, direction: "sell" }, drift: { active: true, direction: "down" }, unexplained_move: { active: true, direction: "down" }, filing_overdue: true }),
          incidents: [{ incident_id: "i", band: "P1", tags: ["disclosure_risk"] }],
        }),
        config,
        ctx({ pricing_status: "priced", sessions_since_event: 4 }),
      ),
      gauge(inputs({ quant: null, detectors: null }), config, ctx({ expected_direction: null, event_ts: "bad" })),
      gauge(inputs({ tracked: false }), config),
    ];
    const offenders: string[] = [];
    for (const r of readouts) {
      for (const c of r.checks) {
        // G2: every caution/fail row must carry a short label (a missing short_<template> key would silently fall back).
        if ((c.status === "caution" || c.status === "fail") && !c.short_label) offenders.push(`${c.key}: missing short_label for "${c.reason}"`);
        for (const text of [c.reason, c.note ?? "", c.label, c.short_label ?? ""]) {
          const hits = bannedHits(text, banned);
          if (hits.length) offenders.push(`${c.key}: "${text}" → ${hits.join(", ")}`);
        }
      }
      for (const text of [r.summary.binding_line, r.summary.sentence, r.summary.tooltip]) {
        const hits = bannedHits(text, banned);
        if (hits.length) offenders.push(`summary: "${text}" → ${hits.join(", ")}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
});
