import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { activeFindings, applyEvaluations, emptyStoreState, endedFindings, findingId, pruneState } from "./lifecycle.js";
import { cfg } from "./test-fixtures.js";
import type { ScreenEvaluation, ScreenEvalStatus, ScreenPattern, ScreenStoreState } from "./types.js";

const S = ["2026-08-17", "2026-08-18", "2026-08-19", "2026-08-20", "2026-08-21", "2026-08-24", "2026-08-25"];

function ev(ticker: string, pattern: ScreenPattern, session: string, status: ScreenEvalStatus, values: Record<string, number> = {}): ScreenEvaluation {
  return {
    ticker,
    pattern,
    session,
    status,
    na_reason: status === "n_a" ? "history window not yet full" : null,
    values: { ...values, session_marker: Number(session.slice(-2)) },
    modifiers: [],
    qualifying_sessions: status === "present" ? [session] : [],
    sessions_view: [],
    read: status === "present" ? `read for ${session}` : null,
  };
}

function step(state: ScreenStoreState, session: string, evaluations: ScreenEvaluation[], universe = ["MSTR", "NVDA"]) {
  return applyEvaluations({ state, evaluations, session, universe, config: cfg() });
}

describe("screen/lifecycle — new → continuing → ended", () => {
  it("walks the full lifecycle with the day counter and keeps the ended finding", () => {
    let r = step(emptyStoreState(), S[0], [ev("MSTR", "quiet_accumulation", S[0], "present")]);
    assert.equal(r.new, 1);
    let f = r.state.findings[0];
    assert.equal(f.state, "new");
    assert.equal(f.day_count, 1);
    assert.equal(f.first_session, S[0]);
    assert.equal(f.id, findingId("MSTR", "quiet_accumulation", S[0]));
    assert.equal(f.read, `read for ${S[0]}`);

    r = step(r.state, S[1], [ev("MSTR", "quiet_accumulation", S[1], "present", { avg: 2 })]);
    assert.equal(r.continuing, 1);
    f = r.state.findings[0];
    assert.equal(f.state, "continuing");
    assert.equal(f.day_count, 2);
    assert.equal(f.last_evaluated, S[1]);
    assert.equal(f.values.avg, 2);
    assert.deepEqual(f.sessions, [S[0], S[1]]);

    r = step(r.state, S[2], [ev("MSTR", "quiet_accumulation", S[2], "present")]);
    assert.equal(r.state.findings[0].day_count, 3);

    r = step(r.state, S[3], [ev("MSTR", "quiet_accumulation", S[3], "absent")]);
    assert.equal(r.ended, 1);
    f = r.state.findings[0];
    assert.equal(f.state, "ended");
    assert.equal(f.ended_at, S[3]);
    assert.equal(f.ended_reason, "condition_false");
    assert.equal(f.day_count, 3);
    assert.equal(f.last_evaluated, S[3]);
    assert.equal(r.state.findings.length, 1);
    assert.deepEqual(activeFindings(r.state, cfg()), []);
    assert.equal(endedFindings(r.state).length, 1);

    // Present again later → a NEW finding (new id), the ended one is retained.
    r = step(r.state, S[4], [ev("MSTR", "quiet_accumulation", S[4], "present")]);
    assert.equal(r.new, 1);
    assert.equal(r.state.findings.length, 2);
    const open = activeFindings(r.state, cfg());
    assert.equal(open.length, 1);
    assert.equal(open[0].first_session, S[4]);
    assert.equal(open[0].day_count, 1);
  });

  it("absent with no open finding is a no-op; different tickers/patterns are independent", () => {
    let r = step(emptyStoreState(), S[0], [ev("MSTR", "compression", S[0], "absent"), ev("NVDA", "compression", S[0], "present"), ev("NVDA", "independent_tape", S[0], "present")]);
    assert.equal(r.state.findings.length, 2);
    r = step(r.state, S[1], [ev("NVDA", "compression", S[1], "absent"), ev("NVDA", "independent_tape", S[1], "present")]);
    const byKey = Object.fromEntries(r.state.findings.map((f) => [`${f.ticker}:${f.pattern}`, f]));
    assert.equal(byKey["NVDA:compression"].state, "ended");
    assert.equal(byKey["NVDA:independent_tape"].state, "continuing");
    assert.equal(byKey["NVDA:independent_tape"].day_count, 2);
  });
});

describe("screen/lifecycle — idempotent re-runs", () => {
  it("re-running the same session does not double count", () => {
    let r = step(emptyStoreState(), S[0], [ev("MSTR", "compression", S[0], "present")]);
    r = step(r.state, S[1], [ev("MSTR", "compression", S[1], "present")]);
    const before = JSON.stringify(r.state.findings);
    const again = step(r.state, S[1], [ev("MSTR", "compression", S[1], "present")]);
    assert.equal(again.new, 0);
    assert.equal(again.continuing, 0);
    assert.equal(JSON.stringify(again.state.findings), before);
    assert.equal(again.state.findings[0].day_count, 2);
  });

  it("a re-run that flips today's result to absent on a 1-day finding removes it; on a longer one ends it", () => {
    let r = step(emptyStoreState(), S[0], [ev("MSTR", "compression", S[0], "present")]);
    r = step(r.state, S[0], [ev("MSTR", "compression", S[0], "absent")]);
    assert.equal(r.state.findings.length, 0);

    r = step(emptyStoreState(), S[0], [ev("MSTR", "compression", S[0], "present")]);
    r = step(r.state, S[1], [ev("MSTR", "compression", S[1], "present")]);
    r = step(r.state, S[1], [ev("MSTR", "compression", S[1], "absent")]);
    const f = r.state.findings[0];
    assert.equal(f.state, "ended");
    assert.equal(f.day_count, 1);
    assert.equal(f.ended_at, S[1]);
    // …and a third re-run reading present again re-opens rather than duplicating.
    r = step(r.state, S[1], [ev("MSTR", "compression", S[1], "present")]);
    assert.equal(r.state.findings.length, 1);
    assert.equal(r.state.findings[0].state, "continuing");
    assert.equal(r.state.findings[0].day_count, 2);
    assert.equal(r.state.findings[0].ended_at, null);
  });
});

describe("screen/lifecycle — n_a, stale, untracked, retention", () => {
  it("n_a leaves an open finding untouched (no advance, no end)", () => {
    let r = step(emptyStoreState(), S[0], [ev("MSTR", "independent_tape", S[0], "present")]);
    r = step(r.state, S[1], [ev("MSTR", "independent_tape", S[1], "n_a")]);
    const f = r.state.findings[0];
    assert.equal(f.state, "new");
    assert.equal(f.day_count, 1);
    assert.equal(f.last_evaluated, S[0]);
    assert.equal(f.ended_at, null);
  });

  it("an open finding unevaluable for staleEndSessions sessions ends as not_evaluable", () => {
    let r = step(emptyStoreState(), S[0], [ev("MSTR", "independent_tape", S[0], "present")]);
    for (const s of S.slice(1, 5)) r = step(r.state, s, [ev("MSTR", "independent_tape", s, "n_a")]);
    assert.equal(r.state.findings[0].ended_at, null, "4 sessions behind — still open");
    r = step(r.state, S[5], [ev("MSTR", "independent_tape", S[5], "n_a")]);
    assert.equal(r.state.findings[0].state, "ended");
    assert.equal(r.state.findings[0].ended_reason, "not_evaluable");
    assert.equal(r.state.findings[0].ended_at, S[5]);
  });

  it("a ticker leaving the universe ends its open findings as untracked", () => {
    let r = step(emptyStoreState(), S[0], [ev("MSTR", "compression", S[0], "present")]);
    r = step(r.state, S[1], [], ["NVDA"]);
    assert.equal(r.state.findings[0].ended_reason, "untracked");
    assert.equal(r.ended, 1);
  });

  it("retention prunes ended findings and scans older than the window, keeps open ones", () => {
    let r = step(emptyStoreState(), "2026-01-05", [ev("MSTR", "compression", "2026-01-05", "present"), ev("NVDA", "compression", "2026-01-05", "present")]);
    r = step(r.state, "2026-01-06", [ev("MSTR", "compression", "2026-01-06", "absent"), ev("NVDA", "compression", "2026-01-06", "present")]);
    const withScans: ScreenStoreState = {
      ...r.state,
      scans: [
        { schema_version: 1, session: "2026-01-06", scanned_at: "x", trigger: "manual", tickers_scanned: 2, tickers_total: 2, evaluations: 2, new: 0, continuing: 1, ended: 1, degraded: [], errors: [] },
        { schema_version: 1, session: "2026-08-20", scanned_at: "x", trigger: "manual", tickers_scanned: 2, tickers_total: 2, evaluations: 2, new: 0, continuing: 0, ended: 0, degraded: [], errors: [] },
      ],
    };
    const pruned = pruneState(withScans, "2026-08-24", 180);
    assert.deepEqual(pruned.findings.map((f) => f.ticker), ["NVDA"]);
    assert.deepEqual(pruned.scans.map((s) => s.session), ["2026-08-20"]);
    // Inside the window nothing is dropped.
    assert.equal(pruneState(withScans, "2026-03-01", 180).findings.length, 2);
  });

  it("activeFindings sorts by day_count desc, then pattern priority, then ticker", () => {
    let r = step(emptyStoreState(), S[0], [ev("NVDA", "compression", S[0], "present"), ev("MSTR", "compression", S[0], "present")]);
    r = step(r.state, S[1], [ev("NVDA", "compression", S[1], "present"), ev("MSTR", "compression", S[1], "present"), ev("MSTR", "quiet_accumulation", S[1], "present"), ev("NVDA", "insider_divergence", S[1], "present")]);
    const order = activeFindings(r.state, cfg()).map((f) => `${f.ticker}:${f.pattern}:${f.day_count}`);
    assert.deepEqual(order, ["MSTR:compression:2", "NVDA:compression:2", "MSTR:quiet_accumulation:1", "NVDA:insider_divergence:1"]);
  });
});
