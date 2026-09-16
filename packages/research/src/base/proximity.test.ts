/**
 * B8 — user_proximity is an input to every score computation, never a
 * persisted property of the incident. The same incident scored under a
 * different user context must re-derive proximity from the context, and a
 * replay must read it from the snapshot it was given, so equal log + equal
 * snapshot = equal result.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BASE_CONFIG } from "./config.js";
import { buildIncidents, scoreIncident } from "./incident.js";
import { replayBase } from "./replay.js";
import { insiderCluster, seqIds, unexplainedMove } from "./test-fixtures.js";
import { resolveProximity, type UserContext } from "./types.js";

const CONFIG = DEFAULT_BASE_CONFIG;
const AT = "2026-08-21T20:15:00.000Z";
const NOW = "2026-08-21T20:20:00.000Z";
const TRACKED: UserContext = { held: [], watchlist: [] };
const HELD: UserContext = { held: ["NVDA", "MSFT"], watchlist: [] };
const WATCH: UserContext = { held: [], watchlist: ["NVDA"] };

// unexplained_move |z| 3.0 -> severity 25, no tags, neutral freshness 5.
// tracked: 25*1.0+5 = 30 (P2) · watchlist: 25*1.25+5 = 36.25 -> 36 (P2) · held: 25*1.5+5 = 42.5 -> 43 (P1)
const STREAM = [unexplainedMove("u1", AT, { residual_zscore: 3.0 }, { ticker: "NVDA" })];

describe("B8 proximity is read at score time", () => {
  it("resolveProximity is the single pure source, case-insensitive", () => {
    assert.equal(resolveProximity("NVDA", HELD), "held");
    assert.equal(resolveProximity("nvda", HELD), "held");
    assert.equal(resolveProximity("NVDA", { held: ["nvda"], watchlist: [] }), "held");
    assert.equal(resolveProximity("NVDA", WATCH), "watchlist");
    assert.equal(resolveProximity("NVDA", TRACKED), "tracked");
    // held outranks watchlist when a ticker is on both
    assert.equal(resolveProximity("NVDA", { held: ["NVDA"], watchlist: ["NVDA"] }), "held");
  });

  it("1: opened tracked (x1.0), then added to held -> next score applies x1.5 and the band moves", () => {
    const opened = buildIncidents(STREAM, { config: CONFIG, makeIncidentId: seqIds, userContext: TRACKED, now: NOW })[0];
    assert.equal(opened.user_proximity, "tracked");
    assert.equal(opened.priority, 30);
    assert.equal(opened.priority_band, "P2");

    // Same incident state, re-scored after the user adds NVDA to held. The
    // stored user_proximity field must be overwritten, not reused.
    const rescored = scoreIncident(opened, { config: CONFIG, userContext: HELD, now: NOW });
    assert.equal(rescored.user_proximity, "held");
    assert.equal(rescored.priority, 43);
    assert.equal(rescored.priority_band, "P1");
    assert.equal(rescored.incident_id, opened.incident_id, "same incident, not a new one");
  });

  it("2: removed from held -> next score reverts to x1.0", () => {
    const held = buildIncidents(STREAM, { config: CONFIG, makeIncidentId: seqIds, userContext: HELD, now: NOW })[0];
    assert.equal(held.priority, 43);
    const reverted = scoreIncident(held, { config: CONFIG, userContext: TRACKED, now: NOW });
    assert.equal(reverted.user_proximity, "tracked");
    assert.equal(reverted.priority, 30);
    assert.equal(reverted.priority_band, "P2");
  });

  it("watchlist applies x1.25 and also re-derives on change", () => {
    const w = buildIncidents(STREAM, { config: CONFIG, makeIncidentId: seqIds, userContext: WATCH, now: NOW })[0];
    assert.equal(w.user_proximity, "watchlist");
    assert.equal(w.priority, 36);
  });

  it("a stale stored proximity on the state is ignored by the scorer", () => {
    const opened = buildIncidents(STREAM, { config: CONFIG, makeIncidentId: seqIds, userContext: HELD, now: NOW })[0];
    // Simulate a persisted incident whose stored field no longer matches the
    // live context (the exact failure mode B8 guards against).
    const stale = { ...opened, user_proximity: "held" as const, priority: 999 };
    const fresh = scoreIncident(stale, { config: CONFIG, userContext: TRACKED, now: NOW });
    assert.equal(fresh.user_proximity, "tracked");
    assert.equal(fresh.priority, 30);
  });

  it("3: replay reads the snapshot it was given — same log + same snapshot = same result", () => {
    const log = [
      ...STREAM,
      insiderCluster("c1", AT, { insider_count: 3, total_notional: 2_960_110 }, { ticker: "PFE" }),
    ];
    const a1 = replayBase(log, { config: CONFIG, now: NOW, userContext: HELD });
    const a2 = replayBase(log, { config: CONFIG, now: NOW, userContext: HELD });
    assert.deepEqual(
      a1.incidents.map((i) => [i.incident.ticker, i.incident.user_proximity, i.incident.priority]),
      a2.incidents.map((i) => [i.incident.ticker, i.incident.user_proximity, i.incident.priority]),
    );
    // A different snapshot changes the result; the snapshot is the parameter.
    const b = replayBase(log, { config: CONFIG, now: NOW, userContext: TRACKED });
    const nvdaA = a1.incidents.find((i) => i.incident.ticker === "NVDA")!.incident;
    const nvdaB = b.incidents.find((i) => i.incident.ticker === "NVDA")!.incident;
    assert.equal(nvdaA.user_proximity, "held");
    assert.equal(nvdaB.user_proximity, "tracked");
    assert.equal(nvdaA.priority, 43);
    assert.equal(nvdaB.priority, 30);
    // Untouched ticker is identical across snapshots.
    const pfeA = a1.incidents.find((i) => i.incident.ticker === "PFE")!.incident;
    const pfeB = b.incidents.find((i) => i.incident.ticker === "PFE")!.incident;
    assert.equal(pfeA.priority, pfeB.priority);
  });
});
