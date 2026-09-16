import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { cardTargets, isLiveRun, orderRuns, pickRun, runBadge } from "./second-order-card.js";
import type {
  PropagationRun,
  PropagationRunListItem,
  PropagationRunSummary,
  PropagationTarget,
} from "../../shared/propagation-run-types.js";

/**
 * The list/badge contract. One rule decides what the rail shows and what each
 * run is called, so the ripple list, the dashboard card and the calendar can
 * never disagree — and a status added to the engine (P3's `contradicted`)
 * can never fall through the old enum and vanish from the UI.
 */

function summary(over: Partial<PropagationRunSummary> = {}): PropagationRunSummary {
  const s: PropagationRunSummary = {
    targets: 0,
    open: 0,
    partial: 0,
    priced: 0,
    contradicted: 0,
    stale: 0,
    untracked: 0,
    vetoed: 0,
    no_edge: true,
    ...over,
  };
  // Mirror the engine: no_edge is open === 0 && partial === 0 unless the
  // caller pinned it deliberately.
  return over.no_edge === undefined ? { ...s, no_edge: s.open === 0 && s.partial === 0 } : s;
}

function item(over: Partial<PropagationRunListItem> = {}): PropagationRunListItem {
  return {
    run_id: "run-1",
    incident_id: "inc-1",
    root_ticker: "NVDA",
    event_label: "event",
    event_type: "contract_partnership",
    event_direction: "positive",
    event_materiality: "standard",
    produced_at: "2026-08-24T20:00:00.000Z",
    event_ts: "2026-08-23T16:25:23.000Z",
    status: "ok",
    summary: summary(),
    superseded: false,
    update: false,
    stage2_state: "ok",
    synthetic: false,
    ...over,
  };
}

describe("run visibility", () => {
  it("the Cloverleaf case: a contradicted-only run is live, not hidden", () => {
    // run-36f56070… — 2 contradicted (TSM supplier, INTC partner), 3 priced,
    // 8 untracked, 2 vetoed. The engine's own no_edge is true.
    const s = summary({ targets: 13, priced: 3, contradicted: 2, untracked: 8, vetoed: 2 });
    assert.equal(s.no_edge, true, "the engine still calls it no-edge");
    assert.equal(isLiveRun(s), true, "…but the list must show it");
  });

  it("open and partial keep a run live; nothing else does", () => {
    assert.equal(isLiveRun(summary({ open: 1 })), true);
    assert.equal(isLiveRun(summary({ partial: 2 })), true);
    assert.equal(isLiveRun(summary({ contradicted: 1 })), true);
    // Fully absorbed, or nothing that transmits, or only ghosts: resolved.
    assert.equal(isLiveRun(summary({ priced: 4 })), false);
    assert.equal(isLiveRun(summary({ untracked: 9 })), false);
    assert.equal(isLiveRun(summary({ stale: 3 })), false);
    assert.equal(isLiveRun(summary()), false);
  });

  it("a list item written before P3 (no contradicted field) still reads", () => {
    const legacy = { open: 0, partial: 1, priced: 2 } as unknown as PropagationRunSummary;
    assert.equal(isLiveRun(legacy), true);
    assert.equal(runBadge(legacy).word, "1 PARTIAL");
  });

  it("only live runs are offered to the dashboard card", () => {
    const live = item({ run_id: "live", summary: summary({ contradicted: 1 }) });
    const done = item({ run_id: "done", summary: summary({ priced: 3 }) });
    assert.deepEqual(orderRuns([done, live]).map((r) => r.run_id), ["live"]);
    assert.equal(pickRun([done]), null);
  });
});

describe("run badge priority — open > contradicted > partial > priced > no edge", () => {
  it("open wins over everything", () => {
    const b = runBadge(summary({ open: 2, contradicted: 3, partial: 4, priced: 5 }));
    assert.deepEqual(b, { word: "2 OPEN", tone: "open" });
  });

  it("contradicted wins over partial and priced", () => {
    assert.deepEqual(runBadge(summary({ contradicted: 2, partial: 4, priced: 5 })), {
      word: "2 CONTRADICTED",
      tone: "against",
    });
  });

  it("partial wins over priced", () => {
    assert.deepEqual(runBadge(summary({ partial: 1, priced: 5 })), { word: "1 PARTIAL", tone: "partial" });
  });

  it("priced when the move is fully in", () => {
    assert.deepEqual(runBadge(summary({ priced: 3 })), { word: "3 PRICED", tone: "priced" });
  });

  it("NO EDGE only when nothing transmitted or nothing is tracked", () => {
    assert.deepEqual(runBadge(summary()), { word: "NO EDGE", tone: "none" });
    assert.deepEqual(runBadge(summary({ targets: 8, untracked: 8 })), { word: "NO EDGE", tone: "none" });
    // …and never for a run that has a contradicted target.
    assert.notEqual(runBadge(summary({ contradicted: 1, untracked: 8 })).word, "NO EDGE");
  });

  it("the badge never contradicts the visibility rule", () => {
    const cases: PropagationRunSummary[] = [
      summary({ open: 1 }),
      summary({ partial: 1 }),
      summary({ contradicted: 1 }),
      summary({ priced: 1 }),
      summary({ untracked: 2 }),
      summary(),
    ];
    for (const s of cases) {
      const live = isLiveRun(s);
      const badge = runBadge(s);
      const resolved = badge.tone === "priced" || badge.tone === "none";
      assert.equal(live, !resolved, `${badge.word} vs live=${live}`);
    }
  });
});

/**
 * The COP case: one Chevron event reached ConocoPhillips twice — as an
 * important JV partner (transmits positive) and as a marginal E&P competitor
 * (transmits negative) — and the card put a long and a short on the same
 * ticker one line apart. The engine collapses those at the source now; runs
 * produced before that fix must still show one row.
 */
function target(
  ticker: string,
  role: "partner" | "competitor" | "supplier",
  tier: "critical" | "important" | "marginal",
  direction: "positive" | "negative",
): PropagationTarget {
  return {
    target: ticker,
    ticker,
    label: ticker,
    tracked: true,
    relationship: {
      role,
      subtype: "joint_venture",
      tier,
      confidence: 0.9,
      evidence_quote: "q",
      source_url: "u",
      filing_date: null,
      via: "forward",
      evidence_via: "forward",
      edge_ids: [`${ticker}:${role}`],
      merged_evidence: [],
    },
    transmission: { tier: "moderate", direction, matrix_cell: `c:${role}`, transmits: "yes", rule: "same" },
    pricing: {
      status: "priced",
      realized_resid_pct: -0.0192,
      expected_pct: 0.0033,
      basis: "residual",
      reference_close_ts: null,
      reference_close: null,
      last_price: null,
      last_price_ts: null,
      realized_raw_pct: -0.0192,
      bench_move_pct: null,
      beta: null,
      ratio: 5.86,
      sessions_elapsed: 2,
      anchor: "close",
      since_event_pct: null,
      first_30m_pct: null,
      note: null,
    },
    mechanism: "m",
    stage2: null,
  };
}

function runOf(targets: PropagationTarget[]): PropagationRun {
  return {
    schema_version: 1,
    run_id: "run-1",
    incident_id: "inc-1",
    request_id: "req-1",
    update_of: null,
    graph_version: { generatedAt: "2026-08-14T00:00:00.000Z", pipelineVersion: 5 },
    root_ticker: "CVX",
    event: {
      type: "contract_partnership",
      direction: "positive",
      materiality: "standard",
      label: "Libya signs production-sharing agreement with Chevron",
      source_msg_ids: [],
      event_ts: "2026-08-24T09:20:38.000Z",
      source: "verdict",
      evidence_lines: [],
    },
    targets,
    summary: summary({ targets: targets.length, priced: targets.length }),
    status: "stage1_only",
    stage2: null,
    overflow: 0,
    non_transmitting: 0,
    reachable: targets.length,
    trigger: { rules: [], priority_band: "P2" },
    produced_at: "2026-08-25T17:17:18.971Z",
    superseded_by: null,
    update: false,
    failure_reason: null,
    synthetic: false,
  };
}

describe("cardTargets — one row per name", () => {
  it("a ticker reached through two roles appears once", () => {
    const rows = cardTargets(
      runOf([target("COP", "partner", "important", "positive"), target("COP", "competitor", "marginal", "negative")]),
      8,
    );
    assert.equal(rows.length, 1);
  });

  it("the strongest relationship is the one shown", () => {
    const rows = cardTargets(
      runOf([target("COP", "competitor", "marginal", "negative"), target("COP", "partner", "important", "positive")]),
      8,
    );
    assert.equal(rows[0].relationship.role, "partner");
    assert.equal(rows[0].relationship.tier, "important");
  });

  it("never shows the same ticker pointing both ways", () => {
    const rows = cardTargets(
      runOf([target("COP", "partner", "important", "positive"), target("COP", "competitor", "marginal", "negative")]),
      8,
    );
    const directions = new Set(rows.map((r) => r.transmission.direction));
    assert.equal(directions.size, 1);
  });

  it("distinct tickers are untouched and stay in rank order", () => {
    const rows = cardTargets(
      runOf([target("XOM", "competitor", "marginal", "negative"), target("COP", "partner", "critical", "positive")]),
      8,
    );
    assert.deepEqual(rows.map((r) => r.ticker), ["COP", "XOM"]);
  });

  it("the limit is applied after the collapse, so a duplicate never eats a slot", () => {
    const rows = cardTargets(
      runOf([
        target("COP", "partner", "important", "positive"),
        target("COP", "competitor", "marginal", "negative"),
        target("XOM", "competitor", "important", "negative"),
      ]),
      2,
    );
    assert.deepEqual(rows.map((r) => r.ticker), ["COP", "XOM"]);
  });
});
