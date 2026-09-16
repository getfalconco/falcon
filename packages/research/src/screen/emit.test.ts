/**
 * S1 — the emit channel gate: `new` emits and `continuing` never does,
 * tracked-only tickers are silent, the daily cap keeps the highest-priority
 * patterns, an emitted finding is never emitted twice, and the flag off means
 * zero emits.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeScreenConfig } from "./config.js";
import { emitDay, emitRank, quantContextFromView, selectEmissions, sinceFirstSession } from "./emit.js";
import { emptyStoreState, findingId } from "./lifecycle.js";
import { SCREEN_SCHEMA_VERSION, type ScreenFinding, type ScreenPattern, type ScreenSeriesView, type ScreenSessionView, type ScreenStoreState } from "./types.js";

const SESSION = "2026-08-21";
const NOW = "2026-08-21T20:30:00.000Z"; // 16:30 ET, after the close
const CONFIG = mergeScreenConfig({ emit: { screenEmitEnabled: true } });

function sessionView(d: string, overrides: Partial<ScreenSessionView> = {}): ScreenSessionView {
  return {
    d,
    close: 100,
    volume: 1_000_000,
    ret: 0.004,
    bench_ret: 0.001,
    volume_ratio: 1.8,
    residual_move: 0.003,
    residual_z: 0.6,
    ...overrides,
  };
}

function view(ticker: string, overrides: Partial<ScreenSeriesView> = {}): ScreenSeriesView {
  return {
    ticker,
    as_of: SESSION,
    history_sessions: 260,
    sessions: ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", SESSION].map((d) => sessionView(d)),
    beta: 1.1,
    r2: 0.32,
    daily_vol: 0.02,
    vol_regime: 0.8,
    momentum_5d: 0.02,
    momentum_20d: 0.05,
    range_10s: 0.06,
    pct_from_52w_high: -0.04,
    pct_from_52w_low: 0.55,
    ...overrides,
  };
}

function finding(ticker: string, pattern: ScreenPattern, overrides: Partial<ScreenFinding> = {}): ScreenFinding {
  const first = overrides.first_session ?? SESSION;
  return {
    id: findingId(ticker, pattern, first),
    schema_version: SCREEN_SCHEMA_VERSION,
    ticker,
    pattern,
    state: "new",
    day_count: 1,
    first_session: first,
    last_evaluated: SESSION,
    sessions: [first],
    values: { volume_ratio_avg: 1.9 },
    modifiers: [],
    qualifying_sessions: [SESSION],
    sessions_view: [],
    read: `${ticker} ${pattern} read`,
    ended_at: null,
    ended_reason: null,
    emitted_at: null,
    ...overrides,
  };
}

function stateOf(findings: ScreenFinding[]): ScreenStoreState {
  return { ...emptyStoreState(), findings };
}

function run(findings: ScreenFinding[], opts: Partial<Parameters<typeof selectEmissions>[0]> = {}) {
  const tickers = [...new Set(findings.map((f) => f.ticker))];
  return selectEmissions({
    state: stateOf(findings),
    views: Object.fromEntries(tickers.map((t) => [t, view(t)])),
    session: SESSION,
    now: NOW,
    held: ["NVDA"],
    watchlist: ["PFE", "CAH", "WMT", "MRK", "COST", "META"],
    config: CONFIG,
    ...opts,
  });
}

describe("emit gate", () => {
  it("a new finding on a held ticker emits one complete message", () => {
    const f = finding("NVDA", "quiet_accumulation");
    const result = run([f]);
    assert.equal(result.messages.length, 1);
    const m = result.messages[0];
    assert.equal(m.type, "tape_structure");
    assert.equal(m.source_engine, "screen");
    assert.equal(m.ticker, "NVDA");
    assert.equal(m.timestamp, NOW);
    assert.equal(m.schema_version, SCREEN_SCHEMA_VERSION);
    assert.equal(m.payload.pattern, "quiet_accumulation");
    assert.equal(m.payload.finding_id, f.id);
    assert.equal(m.payload.first_session, SESSION);
    assert.equal(m.payload.session, SESSION);
    assert.equal(m.payload.day_count, 1);
    assert.deepEqual(m.payload.values, { volume_ratio_avg: 1.9 });
    assert.equal(m.payload.read, "NVDA quiet_accumulation read");
    // The envelope carries a full quant context built from the series view.
    assert.equal(m.quant_context.beta_90d, 1.1);
    assert.equal(m.quant_context.r_squared, 0.32);
    assert.equal(m.quant_context.session, "closed");
    assert.equal(m.quant_context.price_asof, SESSION);
    // …and the finding is marked in the returned state.
    assert.equal(result.state.findings[0].emitted_at, NOW);
    assert.equal(result.eligible, 1);
    assert.equal(result.capped, 0);
  });

  it("continuing never emits, however long it has run", () => {
    const f = finding("NVDA", "quiet_accumulation", { state: "continuing", day_count: 4, first_session: "2026-08-17", sessions: ["2026-08-17", "2026-08-18", "2026-08-19", SESSION] });
    const result = run([f]);
    assert.equal(result.messages.length, 0);
    assert.equal(result.eligible, 0);
    assert.equal(result.candidates[0].reason, "not_new");
  });

  it("an ended finding never emits", () => {
    const f = finding("NVDA", "compression", { state: "ended", ended_at: SESSION, ended_reason: "condition_false" });
    assert.equal(run([f]).messages.length, 0);
  });

  it("a tracked-only ticker is silent — proximity is held or watchlist", () => {
    const result = run([finding("ZLAB", "independent_tape")]);
    assert.equal(result.messages.length, 0);
    assert.equal(result.eligible, 0);
    assert.equal(result.candidates[0].reason, "proximity");
  });

  it("watchlist counts, case-insensitively", () => {
    const result = run([finding("PFE", "independent_tape")], { held: [], watchlist: ["pfe"] });
    assert.equal(result.messages.length, 1);
  });

  it("a finding whose ticker has no series view is skipped, not guessed", () => {
    const result = run([finding("NVDA", "compression")], { views: {} });
    assert.equal(result.messages.length, 0);
    assert.equal(result.candidates[0].reason, "no_view");
  });

  it("the flag off means zero emits and no marks", () => {
    const findings = [finding("NVDA", "quiet_accumulation"), finding("PFE", "insider_divergence")];
    const result = run(findings, { config: mergeScreenConfig(null) });
    assert.equal(result.messages.length, 0);
    assert.equal(result.eligible, 0);
    assert.ok(result.state.findings.every((f) => f.emitted_at == null));
    assert.ok(result.candidates.every((c) => c.reason === "disabled"));
  });
});

describe("daily cap", () => {
  const six: Array<[string, ScreenPattern]> = [
    ["NVDA", "compression"],
    ["PFE", "compression"],
    ["CAH", "quiet_accumulation"],
    ["WMT", "quiet_accumulation"],
    ["MRK", "independent_tape"],
    ["COST", "insider_divergence"],
  ];

  it("the 6th finding hits the cap and the lowest emit priority is the one dropped", () => {
    const result = run(six.map(([t, p]) => finding(t, p)));
    assert.equal(result.eligible, 6);
    assert.equal(result.messages.length, 5);
    assert.equal(result.capped, 1);
    // insider_divergence > independent_tape > quiet_accumulation > compression
    assert.deepEqual(
      result.messages.map((m) => `${m.ticker}:${m.payload.pattern}`),
      ["COST:insider_divergence", "MRK:independent_tape", "CAH:quiet_accumulation", "WMT:quiet_accumulation", "NVDA:compression"],
    );
    const dropped = result.candidates.find((c) => c.reason === "capped");
    assert.equal(dropped?.finding.ticker, "PFE");
    assert.equal(dropped?.finding.pattern, "compression");
    // Only the emitted ones are marked.
    assert.equal(result.state.findings.filter((f) => f.emitted_at != null).length, 5);
  });

  it("emits already on record for the same ET day count against the cap", () => {
    const earlier = finding("META", "compression", { emitted_at: "2026-08-21T13:45:00.000Z" });
    const result = run([earlier, ...six.slice(0, 3).map(([t, p]) => finding(t, p))]);
    assert.equal(result.emitted_today_before, 1);
    assert.equal(result.messages.length, 3, "cap 5 − 1 already emitted leaves 4 slots; only 3 are eligible");
    const capped = run([earlier, ...six.map(([t, p]) => finding(t, p))]);
    assert.equal(capped.messages.length, 4);
    assert.equal(capped.capped, 2);
  });

  it("yesterday's emits do not count against today", () => {
    const yesterday = finding("META", "compression", { emitted_at: "2026-08-20T20:30:00.000Z" });
    const result = run([yesterday, ...six.map(([t, p]) => finding(t, p))]);
    assert.equal(result.emitted_today_before, 0);
    assert.equal(result.messages.length, 5);
  });

  it("a cap of zero emits nothing", () => {
    const result = run([finding("NVDA", "quiet_accumulation")], { config: mergeScreenConfig({ emit: { screenEmitEnabled: true, dailyEmitCap: 0 } }) });
    assert.equal(result.messages.length, 0);
    assert.equal(result.capped, 1);
  });
});

describe("idempotence", () => {
  it("re-running the same scan emits nothing the second time", () => {
    const first = run([finding("NVDA", "quiet_accumulation")]);
    assert.equal(first.messages.length, 1);
    const second = selectEmissions({
      state: first.state,
      views: { NVDA: view("NVDA") },
      session: SESSION,
      now: "2026-08-21T20:45:00.000Z",
      held: ["NVDA"],
      watchlist: [],
      config: CONFIG,
    });
    assert.equal(second.messages.length, 0);
    assert.equal(second.candidates[0].reason, "already_emitted");
    assert.equal(second.state.findings[0].emitted_at, NOW, "the original mark is kept");
  });

  it("the message id is deterministic in (finding, session)", () => {
    const a = run([finding("NVDA", "quiet_accumulation")]).messages[0];
    const b = run([finding("NVDA", "quiet_accumulation")]).messages[0];
    assert.equal(a.id, b.id);
    assert.equal(a.id, "screen:NVDA:quiet_accumulation:2026-08-21:2026-08-21");
  });
});

describe("payload arithmetic", () => {
  it("since_first compounds only the sessions the view covers and reports the coverage", () => {
    const v = view("NVDA", {
      sessions: [
        sessionView("2026-08-17", { ret: 0.01, residual_z: 1 }),
        sessionView("2026-08-18", { ret: 0.02, residual_z: 2 }),
        sessionView("2026-08-19", { ret: -0.01, residual_z: -1 }),
        sessionView("2026-08-20", { ret: 0.03, residual_z: 2 }),
        sessionView(SESSION, { ret: 0.0, residual_z: 0 }),
      ],
    });
    const all = sinceFirstSession(v, "2026-08-17");
    assert.equal(all.sessions, 5);
    assert.equal(all.covered_from, "2026-08-17");
    assert.ok(Math.abs((all.ret ?? 0) - (1.01 * 1.02 * 0.99 * 1.03 - 1)) < 1e-12);
    assert.ok(Math.abs((all.residual_z_cum ?? 0) - 4 / Math.sqrt(5)) < 1e-12);

    // A structure older than the view window reports what it could see.
    const partial = sinceFirstSession(v, "2026-08-01");
    assert.equal(partial.sessions, 5);
    assert.equal(partial.covered_from, "2026-08-17");

    // A structure that started mid-window counts only from there.
    const late = sinceFirstSession(v, "2026-08-20");
    assert.equal(late.sessions, 2);
    assert.equal(late.covered_from, "2026-08-20");
    assert.ok(Math.abs((late.ret ?? 0) - 0.03) < 1e-12);
  });

  it("null returns and z-scores stay null rather than becoming zero", () => {
    const v = view("NVDA", { sessions: [sessionView(SESSION, { ret: null, residual_z: null })] });
    const s = sinceFirstSession(v, SESSION);
    assert.equal(s.ret, null);
    assert.equal(s.residual_z_cum, null);
  });

  it("quantContextFromView derives move_zscore from the view's own vol and leaves the rest honest", () => {
    const q = quantContextFromView(view("NVDA", { daily_vol: 0.02, sessions: [sessionView("2026-08-20", { close: 99 }), sessionView(SESSION, { ret: 0.04, close: 103 })] }));
    assert.ok(Math.abs((q.move_zscore ?? 0) - 2) < 1e-12);
    assert.equal(q.prev_close, 99);
    assert.equal(q.last_price, 103);
    assert.equal(q.momentum_60d, null, "not derivable from the view — null, never zero");
    assert.equal(q.earnings_rhythm, null);
    assert.equal(q.volume_ratio_partial, false);
  });

  it("a null vol leaves move_zscore null", () => {
    assert.equal(quantContextFromView(view("NVDA", { daily_vol: null })).move_zscore, null);
  });
});

describe("helpers", () => {
  it("emitRank follows the configured order and puts unlisted patterns last", () => {
    assert.equal(emitRank("insider_divergence", CONFIG), 0);
    assert.equal(emitRank("compression", CONFIG), 3);
    const partialCfg = mergeScreenConfig({ emit: { priority: ["compression"] } });
    assert.equal(emitRank("compression", partialCfg), 0);
    assert.deepEqual(partialCfg.emit.priority, ["compression", "insider_divergence", "independent_tape", "quiet_accumulation"]);
  });

  it("emitDay is the ET calendar day, so a late-evening UTC instant is still the session day", () => {
    assert.equal(emitDay("2026-08-21T20:30:00.000Z"), "2026-08-21");
    assert.equal(emitDay("2026-08-22T03:00:00.000Z"), "2026-08-21", "23:00 ET the previous day");
  });
});
