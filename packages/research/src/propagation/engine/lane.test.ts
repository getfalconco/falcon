import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  FAST_PATH_DEADLINE_MS,
  LANE_LATENCY_WINDOW,
  classifyLane,
  eligibleForFastPath,
  emptyLaneMetrics,
  eventToRunMs,
  recordLane,
  summarizeLanes,
} from "./lane.js";

const HOUR = 3_600_000;

/** A run shaped just enough for the lane classifier. */
function run(source: string, eventTs: string, producedAt: string) {
  return { event: { source, event_ts: eventTs } as never, produced_at: producedAt };
}

describe("eligibleForFastPath", () => {
  it("admits the two triggers that need no LLM and no budget", () => {
    assert.equal(eligibleForFastPath({ source: "filing_item" }), true);
    assert.equal(eligibleForFastPath({ source: "gap_cause" }), true);
  });

  it("excludes anything that had to wait for a Classifier verdict", () => {
    assert.equal(eligibleForFastPath({ source: "verdict" }), false);
  });
});

describe("eventToRunMs", () => {
  it("measures the event instant to the produced instant", () => {
    assert.equal(
      eventToRunMs(run("filing_item", "2026-08-25T19:58:07.000Z", "2026-08-25T20:00:04.000Z")),
      117_000,
    );
  });

  it("reports a run produced before its own event as unusable", () => {
    // A negative latency is a clock problem. Counting it would quietly drag
    // the median of whichever lane it landed in.
    assert.equal(
      eventToRunMs(run("filing_item", "2026-08-25T20:00:00.000Z", "2026-08-25T19:00:00.000Z")),
      null,
    );
  });

  it("returns null for unparseable timestamps", () => {
    assert.equal(eventToRunMs(run("filing_item", "", "2026-08-25T20:00:00.000Z")), null);
    assert.equal(eventToRunMs(run("filing_item", "2026-08-25T20:00:00.000Z", "nonsense")), null);
  });
});

describe("classifyLane", () => {
  it("counts a real fast-path run as fast, not missed", () => {
    // NVDA earnings_results, 15.1 s — the quickest run in the live store.
    const v = classifyLane(
      run("filing_item", "2026-08-25T19:58:07.000Z", "2026-08-25T19:58:22.100Z"),
      "fast_path",
    );
    assert.equal(v.lane, "fast_path");
    assert.equal(v.eligible, true);
    assert.equal(v.missed, false);
  });

  it("counts an eligible trigger the cycle produced late as a miss", () => {
    // AMD management_governance: a mapped filing that took 43.5 hours.
    const v = classifyLane(
      run("filing_item", "2026-08-24T12:00:00.000Z", "2026-08-26T07:29:00.000Z"),
      "cycle",
    );
    assert.equal(v.eligible, true);
    assert.equal(v.missed, true);
    assert.ok((v.event_to_run_ms ?? 0) > 43 * HOUR);
  });

  it("does not call a news run a miss — it was never eligible", () => {
    // BA's $131B contract came through a verdict: 44.9 h, but the fast lane
    // was never open to it. Blaming the fast path here would hide the real fix.
    const v = classifyLane(
      run("verdict", "2026-08-24T17:25:51.000Z", "2026-08-26T14:21:57.000Z"),
      "cycle",
    );
    assert.equal(v.eligible, false);
    assert.equal(v.missed, false);
  });

  it("does not call a prompt cycle run a miss", () => {
    // The cycle can legitimately win the race when it ticks right after the
    // filing. Inside the deadline that is a fine outcome, not a defect.
    const v = classifyLane(
      run("filing_item", "2026-08-25T19:58:00.000Z", "2026-08-25T20:00:00.000Z"),
      "cycle",
    );
    assert.equal(v.eligible, true);
    assert.equal(v.missed, false);
  });

  it("keeps a slow fast-path run in the fast lane", () => {
    // The producer knows the lane; a slow pass is still the lane it took.
    const v = classifyLane(
      run("filing_item", "2026-08-25T18:00:00.000Z", "2026-08-25T19:00:00.000Z"),
      "fast_path",
    );
    assert.equal(v.lane, "fast_path");
    assert.equal(v.missed, false);
    assert.ok(FAST_PATH_DEADLINE_MS < (v.event_to_run_ms ?? 0));
  });
});

describe("recordLane / summarizeLanes", () => {
  it("reproduces the live 2026-08-26 split", () => {
    let m = emptyLaneMetrics();
    // The five that took the fast path, in seconds.
    for (const s of [15.1, 24.0, 115.3, 117.3, 201.8]) {
      m = recordLane(m, {
        lane: "fast_path",
        eligible: true,
        missed: false,
        event_to_run_ms: s * 1000,
      });
    }
    // The five eligible filings the cycle produced hours later.
    for (const h of [6.87, 6.87, 6.91, 43.48, 79.28]) {
      m = recordLane(m, { lane: "cycle", eligible: true, missed: true, event_to_run_ms: h * HOUR });
    }
    const s = summarizeLanes(m);
    assert.equal(s.fast_path.runs, 5);
    assert.equal(s.cycle.runs, 5);
    assert.equal(s.fast_path_missed, 5);
    // Half of every eligible filing missed its lane — the headline number.
    assert.equal(s.fast_path_miss_rate, 0.5);
    assert.equal(s.fast_path.p50_ms, 115_300);
  });

  it("reports no miss rate when nothing was eligible", () => {
    let m = emptyLaneMetrics();
    m = recordLane(m, { lane: "cycle", eligible: false, missed: false, event_to_run_ms: 40 * HOUR });
    assert.equal(summarizeLanes(m).fast_path_miss_rate, null);
    assert.equal(summarizeLanes(m).cycle.runs, 1);
  });

  it("does not mutate the metrics it is given", () => {
    const before = emptyLaneMetrics();
    recordLane(before, { lane: "fast_path", eligible: true, missed: false, event_to_run_ms: 1000 });
    assert.equal(before.fast_path_runs, 0);
    assert.deepEqual(before.fast_path_latencies_ms, []);
  });

  it("bounds each lane's sample window", () => {
    let m = emptyLaneMetrics();
    for (let i = 0; i < LANE_LATENCY_WINDOW + 50; i++) {
      m = recordLane(m, { lane: "fast_path", eligible: true, missed: false, event_to_run_ms: i });
    }
    assert.equal(m.fast_path_latencies_ms.length, LANE_LATENCY_WINDOW);
    // The window keeps the newest samples, so the oldest 50 are gone.
    assert.equal(m.fast_path_latencies_ms[0], 50);
  });

  it("tolerates metrics written before the lane fields existed", () => {
    const legacy = { fast_path_runs: 0, cycle_runs: 0, fast_path_missed: 0 } as never;
    const next = recordLane(legacy, {
      lane: "cycle",
      eligible: true,
      missed: true,
      event_to_run_ms: 2 * HOUR,
    });
    assert.equal(next.cycle_runs, 1);
    assert.deepEqual(next.cycle_latencies_ms, [2 * HOUR]);
    assert.equal(summarizeLanes(next).fast_path_miss_rate, 1);
  });
});
