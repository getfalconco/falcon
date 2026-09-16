/**
 * S2 — Screen's `tape_structure` message inside Base: it joins the incident,
 * carries its tag, scores from the per-pattern table, extends the window as a
 * measurement message, and reaches Analyst only when the channel flag is on
 * and the incident clears the P2 band. With the flag off Base behaves exactly
 * as it did before the channel existed.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BASE_CONFIG, mergeBaseConfig } from "./config.js";
import { buildIncidents, isWindowExtending } from "./incident.js";
import { messageSeverity } from "./priority.js";
import { replayBase } from "./replay.js";
import { routeIncident } from "./routing.js";
import { deriveCompositeTags } from "./tags.js";
import { gapEvent, newsItem, plusHours, plusMinutes, quant, seqIds, tapeStructure, TICKER } from "./test-fixtures.js";
import { MEASUREMENT_MESSAGE_TYPES } from "./types.js";

const AT = "2026-08-21T20:15:00.000Z";
const OFF = DEFAULT_BASE_CONFIG;
const ON = mergeBaseConfig({ routing: { ...DEFAULT_BASE_CONFIG.routing, screenToAnalystEnabled: true } });

describe("message class", () => {
  it("is measurement class, so it extends an open window", () => {
    assert.ok((MEASUREMENT_MESSAGE_TYPES as readonly string[]).includes("tape_structure"));
    assert.equal(isWindowExtending("tape_structure", OFF), true);
    assert.ok(OFF.window.extendingTypes.includes("tape_structure"));
  });

  it("scores from the per-pattern table, not the information base severity", () => {
    const sev = (pattern: string) =>
      messageSeverity(tapeStructure("t", AT, { pattern: pattern as never }), OFF).value;
    assert.equal(sev("insider_divergence"), 15);
    assert.equal(sev("independent_tape"), 12);
    assert.equal(sev("quiet_accumulation"), 10);
    assert.equal(sev("compression"), 8);
  });

  it("an unknown pattern falls back to the base severity rather than scoring zero", () => {
    assert.equal(messageSeverity(tapeStructure("t", AT, { pattern: "unheard_of" as never }), OFF).value, OFF.priority.severity.base);
  });

  it("the severity table is configuration", () => {
    const cfg = mergeBaseConfig({ tags: { ...DEFAULT_BASE_CONFIG.tags, tapeStructureSeverity: { compression: 30 } } });
    assert.equal(messageSeverity(tapeStructure("t", AT, { pattern: "compression" }), cfg).value, 30);
  });
});

describe("incident + tag", () => {
  it("joins the incident and carries the tape_structure tag", () => {
    const messages = [
      newsItem("n1", AT),
      tapeStructure("t1", plusMinutes(AT, 5), { pattern: "quiet_accumulation" }),
    ];
    const states = buildIncidents(messages, { config: OFF, now: plusHours(AT, 12), makeIncidentId: seqIds });
    assert.equal(states.length, 1);
    const incident = states[0];
    assert.equal(incident.messages.length, 2);
    assert.ok(incident.messages.some((m) => m.type === "tape_structure"));
    assert.ok(incident.composite_tags.includes("tape_structure"));
    // The structure is a measurement, so the window anchors on it.
    assert.equal(incident.last_measurement_at, plusMinutes(AT, 5));
  });

  it("the tag is worth its configured weight and nothing else changes", () => {
    const withStructure = deriveCompositeTags(
      { messages: [tapeStructure("t1", AT)], windowStart: AT, quantContext: quant() },
      OFF,
    );
    assert.deepEqual(withStructure, ["tape_structure"]);
    assert.equal(OFF.tags.weights.tape_structure, 8);
    const without = deriveCompositeTags({ messages: [newsItem("n1", AT)], windowStart: AT, quantContext: quant() }, OFF);
    assert.deepEqual(without, []);
  });

  it("a lone structure opens its own incident on its own ticker", () => {
    const states = buildIncidents(
      [tapeStructure("t1", AT, {}, { ticker: "PFE" }), gapEvent("g1", AT, {}, { ticker: TICKER })],
      { config: OFF, now: plusHours(AT, 12), makeIncidentId: seqIds },
    );
    assert.equal(states.length, 2);
    const pfe = states.find((s) => s.ticker === "PFE");
    assert.ok(pfe);
    assert.deepEqual(pfe.composite_tags, ["tape_structure"]);
  });
});

describe("routing gate", () => {
  /** A P2-or-better incident carrying one structure message. */
  function structureIncident(config = OFF) {
    const messages = [
      tapeStructure("t1", AT, { pattern: "insider_divergence" }),
      gapEvent("g1", plusMinutes(AT, 1), { gap_z: 3.5 }),
    ];
    const states = buildIncidents(messages, { config, now: plusHours(AT, 12), makeIncidentId: seqIds });
    return states[0];
  }

  it("routes to Analyst when the flag is on and the band clears P2", () => {
    const incident = structureIncident(ON);
    assert.ok(["P0", "P1", "P2"].includes(incident.priority_band), `band ${incident.priority_band}`);
    const routing = routeIncident(incident, ON);
    const analyst = routing.destinations.find((d) => d.destination === "analyst");
    assert.ok(analyst, "structure should reach Analyst");
    assert.ok(analyst.rules.includes("tape_structure.analyst"));
  });

  it("does not dispatch while the flag is off, even at P0", () => {
    const incident = { ...structureIncident(OFF), priority_band: "P0" as const };
    const routing = routeIncident(incident, OFF);
    const perMessage = routing.per_message.find((p) => p.message_id === "t1");
    assert.deepEqual(perMessage?.outcome, { action: "store_only", rule: "tape_structure.store" });
  });

  it("does not dispatch below P2 even with the flag on", () => {
    const incident = { ...structureIncident(ON), priority_band: "P3" as const };
    const routing = routeIncident(incident, ON);
    const perMessage = routing.per_message.find((p) => p.message_id === "t1");
    assert.deepEqual(perMessage?.outcome, { action: "store_only", rule: "tape_structure.store" });
  });

  it("the band is configuration", () => {
    const strict = mergeBaseConfig({ routing: { ...ON.routing, tapeStructureMinBand: "P0" } });
    const incident = { ...structureIncident(strict), priority_band: "P1" as const };
    assert.equal(
      routeIncident(incident, strict).per_message.find((p) => p.message_id === "t1")?.outcome.action,
      "store_only",
    );
  });
});

describe("flags off — Base behaves exactly as before", () => {
  const stream = [
    newsItem("n1", AT),
    gapEvent("g1", plusMinutes(AT, 30), { gap_z: 3.2 }),
    newsItem("n2", plusMinutes(AT, 45)),
  ];

  it("a stream with no structure message replays identically with the channel on or off", () => {
    const off = replayBase(stream, { config: OFF, now: plusHours(AT, 12) });
    const on = replayBase(stream, { config: ON, now: plusHours(AT, 12) });
    assert.deepEqual(on.summary, off.summary);
    assert.deepEqual(
      on.incidents.map((i) => i.routing),
      off.incidents.map((i) => i.routing),
    );
  });

  it("with the flag off a structure message still joins and tags, but adds no destination", () => {
    const withStructure = [...stream, tapeStructure("t1", plusMinutes(AT, 50))];
    const replay = replayBase(withStructure, { config: OFF, now: plusHours(AT, 12) });
    const incident = replay.incidents[0].incident;
    assert.ok(incident.messages.some((m) => m.type === "tape_structure"));
    assert.ok(incident.composite_tags.includes("tape_structure"));
    // The gap in this stream reaches Analyst on its own row; what must never
    // appear is the structure row.
    const rules = replay.incidents.flatMap((i) => i.routing.destinations.flatMap((d) => d.rules));
    assert.ok(!rules.includes("tape_structure.analyst"));
    assert.deepEqual(
      replay.incidents[0].routing.per_message.find((p) => p.message_id === "t1")?.outcome,
      { action: "store_only", rule: "tape_structure.store" },
    );
    assert.equal(replay.summary.by_tag.tape_structure, 1);
  });
});
