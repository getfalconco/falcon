/**
 * §9 replay — the aggregate view the shadow-mode panel reads.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BASE_CONFIG } from "./config.js";
import { replayBase } from "./replay.js";
import {
  filingItem,
  gapEvent,
  insiderFiling,
  newsItem,
  unexplainedMove,
  volumeAnomaly,
} from "./test-fixtures.js";

const CONFIG = DEFAULT_BASE_CONFIG;

describe("§9 replayBase", () => {
  // NVDA: an 8-K at 15:45 ET plus the close-computed anomaly it caused ->
  // one incident, tagged unexplained_activity, 38 (P2) when tracked-only.
  // AMD:  a lone insider_filing -> one store-only incident.
  const messages = [
    filingItem("f1", "2026-08-21T19:45:00.000Z", { item_codes: ["2.02"] }),
    unexplainedMove("u1", "2026-08-21T20:15:00.000Z", { residual_zscore: 3.0 }),
    volumeAnomaly("v1", "2026-08-21T20:15:00.000Z", { volume_ratio: 6 }),
    insiderFiling("i1", "2026-08-21T21:00:00.000Z", {}, { ticker: "AMD" }),
  ];
  const NOW = "2026-08-22T06:00:00.000Z";

  it("summarises incidents by band, destination, tag and ticker", () => {
    const { summary } = replayBase(messages, { config: CONFIG, now: NOW });
    assert.equal(summary.message_count, 4);
    assert.equal(summary.incident_count, 2);
    assert.equal(summary.ticker_count, 2);
    assert.equal(summary.first_message_at, "2026-08-21T19:45:00.000Z");
    assert.equal(summary.last_message_at, "2026-08-21T21:00:00.000Z");
    assert.equal(summary.open_incidents, 0);
    assert.equal(summary.closed_incidents, 2);
    assert.equal(summary.degraded_incidents, 0);
    // NVDA: combined 33 >= 30, so the discovery floor lifts it to P1 (40).
    // AMD insider_filing = base 5 + freshness 10 = 15, the P2 floor.
    assert.deepEqual(summary.by_band, { P0: 0, P1: 1, P2: 1, P3: 0 });
    assert.equal(summary.by_tag.unexplained_activity, 1);
    assert.equal(summary.by_tag.explained_move, 0);
    // NVDA reaches Propagation via the mapped 8-K, and the Analyst too now
    // that the floor puts it at P1. AMD.s insider_filing routes nowhere.
    assert.deepEqual(summary.by_destination, {
      classifier: 0,
      propagation: 1,
      extraction: 0,
      analyst: 1,
      scheduler: 0,
      store_only: 1,
    });
    assert.deepEqual(summary.by_ticker, [
      { ticker: "AMD", incidents: 1, messages: 1 },
      { ticker: "NVDA", incidents: 1, messages: 3 },
    ]);
  });

  it("returns wire-shaped incidents with their routing", () => {
    const { incidents } = replayBase(messages, { config: CONFIG, now: NOW });
    const nvda = incidents.find((i) => i.incident.ticker === "NVDA");
    assert.ok(nvda);
    assert.equal(nvda.incident.priority, 40);
    assert.equal(nvda.incident.discovery_floor_applied, true);
    // item 2.02 -> earnings absorption to the session close + grace.
    assert.equal(nvda.incident.window_end, "2026-08-22T02:00:00.000Z");
    assert.deepEqual(nvda.incident.composite_tags, ["unexplained_activity"]);
    assert.deepEqual(
      nvda.routing.destinations.map((d) => d.destination),
      ["propagation", "analyst"],
    );
    // Internal bookkeeping never reaches the wire (§6).
    assert.ok(!("last_measurement_at" in nvda.incident));
    assert.ok(!("trigger_identities" in nvda.incident));
  });

  it("reflects user proximity in the replayed priorities", () => {
    const held = replayBase(messages, {
      config: CONFIG,
      now: NOW,
      userContext: { held: ["NVDA"], watchlist: [] },
    });
    const nvda = held.incidents.find((i) => i.incident.ticker === "NVDA");
    assert.equal(nvda?.incident.priority, 55); // (25 + 8) * 1.5 + 5 = 54.5 -> 55
    assert.equal(nvda?.incident.priority_band, "P1");
    assert.deepEqual(held.summary.by_band, { P0: 0, P1: 1, P2: 1, P3: 0 });
    // At P1 the unexplained_move now reaches the Analyst too.
    assert.deepEqual(
      nvda?.routing.destinations.map((d) => d.destination),
      ["propagation", "analyst"],
    );
  });

  it("handles an empty stream", () => {
    const { summary, incidents } = replayBase([], { config: CONFIG });
    assert.deepEqual(incidents, []);
    assert.equal(summary.incident_count, 0);
    assert.equal(summary.first_message_at, null);
    assert.deepEqual(summary.by_band, { P0: 0, P1: 0, P2: 0, P3: 0 });
  });

  it("counts a classifier-only incident correctly", () => {
    const newsOnly = [newsItem("n1", "2026-08-21T13:00:00.000Z")];
    const { summary } = replayBase(newsOnly, { config: CONFIG, now: NOW });
    assert.equal(summary.by_destination.classifier, 1);
    assert.equal(summary.by_destination.store_only, 0);
    // base severity 5 * 1.0 + freshness 10 = 15, exactly the P2 floor.
    assert.deepEqual(summary.by_band, { P0: 0, P1: 0, P2: 1, P3: 0 });
  });

  it("counts an incident that reaches two destinations once for each", () => {
    const stream = [
      gapEvent("g1", "2026-08-21T13:35:00.000Z"),
      newsItem("n1", "2026-08-21T13:40:00.000Z"),
    ];
    const { summary } = replayBase(stream, { config: CONFIG, now: NOW });
    assert.equal(summary.incident_count, 1);
    assert.equal(summary.by_destination.analyst, 1); // gap without event_gap
    assert.equal(summary.by_destination.classifier, 1);
  });
});
