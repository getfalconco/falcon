import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { repairPairHistory, repairRun, repairRunList, repairRunListItem } from "./display-text";
import type { PropagationPairHistory } from "./propagation-pair";
import type { PropagationRun, PropagationRunListItem } from "./propagation-run-types";

/**
 * Old propagation rows mirrored from the server carry provider mojibake in
 * their event labels ("weekâ€™s", or "weekâs" once the C1 bytes were stripped).
 * The renderer repairs the display text it reads and nothing else.
 */

const row = (over: Partial<PropagationRunListItem> = {}): PropagationRunListItem =>
  ({
    run_id: "run-â€™1",
    incident_id: "inc-1",
    root_ticker: "NVDA",
    event_label: "Nvidia beats this weekâ€™s estimates â€” guidance raised",
    event_type: "earnings_results",
    event_direction: "positive",
    event_materiality: "high",
    produced_at: "2026-10-14T12:00:00Z",
    event_ts: "2026-10-14T11:00:00Z",
    status: "ok",
    summary: { targets: 1, open: 1, partial: 0, priced: 0, contradicted: 0, stale: 0, untracked: 0, vetoed: 0, no_edge: false },
    superseded: false,
    update: false,
    stage2_state: "ok",
    synthetic: false,
    ...over,
  }) as PropagationRunListItem;

describe("display-text repair", () => {
  it("repairs a run list row's event label and keeps its ids", () => {
    const fixed = repairRunListItem(row());
    assert.equal(fixed.event_label, "Nvidia beats this week’s estimates — guidance raised");
    assert.equal(fixed.run_id, "run-â€™1");
    assert.equal(fixed.root_ticker, "NVDA");
  });

  it("repairs a label whose C1 bytes were stripped", () => {
    assert.equal(repairRunListItem(row({ event_label: "TSMC says this weekâs orders slipped" })).event_label, "TSMC says this week’s orders slipped");
  });

  it("returns the same object for clean text, and leaves real accents alone", () => {
    const clean = row({ event_label: "Société Générale cuts café chain to sell" });
    assert.equal(repairRunListItem(clean), clean);
    const list = [clean, row()];
    const fixed = repairRunList(list);
    assert.equal(fixed[0], clean);
    assert.notEqual(fixed[1], list[1]);
  });

  it("repairs a full run's event label and evidence lines, not its targets or ids", () => {
    const run = {
      run_id: "r1",
      incident_id: "i1",
      root_ticker: "AAPL",
      event: {
        type: "other",
        direction: "negative",
        materiality: "standard",
        label: "Apple donât expect a recovery",
        source_msg_ids: ["msg-â€™x"],
        event_ts: "2026-10-14T11:00:00Z",
        source: "verdict",
        evidence_lines: ["Supplier warns of â€œsoftâ€ demand", "clean line"],
      },
      targets: [{ target: "TSM", label: "Taiwan Semi" }],
    } as unknown as PropagationRun;
    const fixed = repairRun(run);
    assert.equal(fixed.event.label, "Apple don’t expect a recovery");
    assert.deepEqual(fixed.event.evidence_lines, ["Supplier warns of “soft” demand", "clean line"]);
    assert.deepEqual(fixed.event.source_msg_ids, ["msg-â€™x"]);
    assert.equal(fixed.targets, run.targets);
    assert.equal(run.event.label, "Apple donât expect a recovery", "the input is not mutated");
    const clean = { ...run, event: { ...run.event, label: "ok", evidence_lines: ["ok"] } } as PropagationRun;
    assert.equal(repairRun(clean), clean);
  });

  it("repairs each event label in a pair history", () => {
    const history = {
      root: "NVDA",
      target: "TSM",
      label: null,
      events: [{ run_id: "a", event_label: "Q3 â€“ record quarter" }, { run_id: "b", event_label: "clean" }],
    } as unknown as PropagationPairHistory;
    const fixed = repairPairHistory(history);
    assert.equal(fixed.events[0].event_label, "Q3 – record quarter");
    assert.equal(fixed.events[1], history.events[1]);
    assert.equal(fixed.root, "NVDA");
  });
});
