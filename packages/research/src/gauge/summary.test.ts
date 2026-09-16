import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { summarize, worstCheck } from "./summary.js";
import { cfg } from "./test-fixtures.js";
import { GAUGE_CHECK_NUMBER, type GaugeCheck, type GaugeCheckKey, type GaugeStatus } from "./types.js";

const config = cfg();

function check(key: GaugeCheckKey, status: GaugeStatus, reason = `${key} ${status}`, short_label: string | null = null): GaugeCheck {
  return { key, number: GAUGE_CHECK_NUMBER[key], label: config.labels[key], status, reason, note: null, short_label, values: {} };
}

describe("gauge/summary — overall state boundaries", () => {
  it("all pass → clear, binding = all-aligned line, no binding check", () => {
    const s = summarize([check("trend", "pass"), check("regime", "pass"), check("residual", "pass")], config);
    assert.equal(s.overall, "clear");
    assert.equal(s.evaluable, 3);
    assert.equal(s.aligned, 3);
    assert.equal(s.binding_check, null);
    assert.equal(s.binding_line, "clear — 3 of 3 aligned");
    assert.equal(s.sentence, "clear — 3 of 3 aligned");
  });
  it("one caution → still clear; sentence 'clear except <check>: <reason>'", () => {
    const s = summarize([check("trend", "pass"), check("volume", "caution", "volume 2.50× its average — elevated"), check("stretch", "pass")], config);
    assert.equal(s.overall, "clear");
    assert.equal(s.cautions, 1);
    assert.equal(s.binding_check, "volume");
    assert.equal(s.binding_line, "volume 2.50× its average — elevated");
    assert.equal(s.sentence, "clear except volume state: volume 2.50× its average — elevated");
  });
  it("two cautions → mixed; G2 binding line names every caution by short label, in check order", () => {
    const s = summarize([check("volume", "caution", "v", "volume elevated"), check("regime", "pass"), check("trend", "caution", "t", "momentum split")], config);
    assert.equal(s.overall, "mixed");
    assert.equal(s.binding_line, "mixed — 2 cautions: momentum split, volume elevated");
    assert.equal(s.sentence, s.binding_line);
    assert.equal(s.binding_check, "trend");
    assert.equal(s.tooltip, "conditions disagree — no clean read");
  });
  it("G2: three cautions (spec example shape) and label fallback when a short label is missing", () => {
    const s = summarize([check("trend", "caution", "t", "momentum split"), check("residual", "caution", "r", "weak residual read"), check("stretch", "caution", "s", "stretched"), check("volume", "pass")], config);
    assert.equal(s.sentence, "mixed — 3 cautions: momentum split, weak residual read, stretched");
    const fb = summarize([check("trend", "caution"), check("volume", "caution")], config);
    assert.equal(fb.sentence, "mixed — 2 cautions: trend coherence, volume state");
  });
  it("G3: tooltips per state", () => {
    assert.equal(summarize([check("trend", "pass")], config).tooltip, "conditions are consistent and readable");
    assert.equal(summarize([check("trend", "fail")], config).tooltip, "at least one condition rules out a clean read");
  });
  it("any fail → blocked, even with zero cautions", () => {
    const s = summarize([check("trend", "pass"), check("event_wall", "fail", "earnings in 1 session — typical move 4.9%")], config);
    assert.equal(s.overall, "blocked");
    assert.equal(s.binding_check, "event_wall");
    assert.equal(s.sentence, "blocked — earnings in 1 session — typical move 4.9%");
  });
});

describe("gauge/summary — binding tie-break", () => {
  it("fail beats caution regardless of number", () => {
    const w = worstCheck([check("trend", "caution"), check("freshness", "fail")]);
    assert.equal(w?.key, "freshness");
  });
  it("among equals the lower check number wins", () => {
    assert.equal(worstCheck([check("stretch", "caution"), check("regime", "caution"), check("volume", "caution")])?.key, "regime");
    assert.equal(worstCheck([check("conflict", "fail"), check("event_wall", "fail")])?.key, "event_wall");
  });
  it("order of the input array does not matter", () => {
    assert.equal(worstCheck([check("volume", "caution"), check("trend", "caution")])?.key, "trend");
    assert.equal(worstCheck([check("trend", "caution"), check("volume", "caution")])?.key, "trend");
  });
  it("nothing caution/fail → null", () => {
    assert.equal(worstCheck([check("trend", "pass"), check("regime", "n_a")]), null);
  });
});

describe("gauge/summary — n_a exclusion and calibrating", () => {
  it("n_a checks are neither aligned nor counted as evaluable", () => {
    const s = summarize([check("trend", "pass"), check("regime", "n_a"), check("residual", "pass"), check("volume", "caution")], config);
    assert.equal(s.evaluable, 3);
    assert.equal(s.aligned, 2);
    assert.equal(s.unavailable, 1);
    assert.equal(s.overall, "clear");
    assert.equal(s.calibrating, false);
  });
  it("all-n_a-but-one pass still reads clear; ≥3 n_a flips calibrating", () => {
    const s = summarize([check("trend", "n_a"), check("regime", "n_a"), check("residual", "n_a"), check("volume", "pass")], config);
    assert.equal(s.overall, "clear");
    assert.equal(s.calibrating, true);
    assert.equal(s.binding_line, "clear — 1 of 1 aligned");
  });
  it("calibratingNaCount is config", () => {
    const s = summarize([check("trend", "n_a"), check("regime", "n_a"), check("volume", "pass")], cfg({ calibratingNaCount: 2 }));
    assert.equal(s.calibrating, true);
  });
});
