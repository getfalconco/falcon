/**
 * §9 layer 3 — routing table tests, one case per §4 row (including the
 * unmapped 8-K codes and every store-only path).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BaseMessage, BaseMessageType } from "./types.js";
import { DEFAULT_BASE_CONFIG, mergeBaseConfig } from "./config.js";
import { ROUTING_TABLE, routeIncident, routeMessage } from "./routing.js";
import {
  driftEvent,
  filingItem,
  filingOverdue,
  gapEvent,
  insiderCluster,
  insiderFiling,
  newsBurst,
  newsItem,
  scheduledEvent,
  silenceAnomaly,
  tapeStructure,
  unexplainedMove,
  volumeAnomaly,
} from "./test-fixtures.js";
import type { CompositeTag, PriorityBand, RoutingOutcome, TriggerType } from "./types.js";

const CONFIG = DEFAULT_BASE_CONFIG;
const AT = "2026-08-21T20:15:00.000Z";

function incidentCtx(
  band: PriorityBand = "P2",
  tags: CompositeTag[] = [],
  trigger: TriggerType = "organic",
) {
  return { composite_tags: tags, priority_band: band, trigger_type: trigger };
}

const ENABLED = mergeBaseConfig({ routing: { ...DEFAULT_BASE_CONFIG.routing, screenToAnalystEnabled: true } });

type Case = {
  name: string;
  message: BaseMessage;
  band?: PriorityBand;
  config?: typeof CONFIG;
  tags?: CompositeTag[];
  expected: RoutingOutcome;
};

const CASES: Case[] = [
  // news_item — always Classifier
  {
    name: "news_item -> Classifier",
    message: newsItem("n1", AT),
    expected: { action: "route", destination: "classifier", rule: "news_item" },
  },

  // filing_item 8-K, mapped item codes -> Propagation
  ...["2.02", "1.01", "5.02", "1.05", "8.01"].map(
    (code): Case => ({
      name: `8-K item ${code} -> Propagation`,
      message: filingItem(`f-${code}`, AT, { item_codes: [code] }),
      expected: { action: "route", destination: "propagation", rule: "filing_item.8k.mapped" },
    }),
  ),
  {
    name: "8-K with one mapped code among unmapped ones -> Propagation",
    message: filingItem("f1", AT, { item_codes: ["3.01", "2.02", "9.01"] }),
    expected: { action: "route", destination: "propagation", rule: "filing_item.8k.mapped" },
  },

  // filing_item 8-K, unmapped item codes -> Classifier
  {
    name: "8-K item 3.01 (unmapped) -> Classifier",
    message: filingItem("f1", AT, { item_codes: ["3.01"] }),
    expected: { action: "route", destination: "classifier", rule: "filing_item.8k.unmapped" },
  },
  {
    name: "8-K with no item codes -> Classifier",
    message: filingItem("f1", AT, { item_codes: [] }),
    expected: { action: "route", destination: "classifier", rule: "filing_item.8k.unmapped" },
  },
  {
    name: "8-K/A is still an 8-K",
    message: filingItem("f1", AT, { form_type: "8-K/A", item_codes: ["3.01"] }),
    expected: { action: "route", destination: "classifier", rule: "filing_item.8k.unmapped" },
  },

  // filing_item periodic -> Extraction
  ...["10-K", "10-Q", "20-F"].map(
    (form): Case => ({
      name: `${form} -> Extraction`,
      message: filingItem(`f-${form}`, AT, { form_type: form, item_codes: [] }),
      expected: { action: "route", destination: "extraction", rule: "filing_item.periodic" },
    }),
  ),
  {
    name: "any other form falls back to the configured destination",
    message: filingItem("f1", AT, { form_type: "S-1", item_codes: [] }),
    expected: { action: "route", destination: "classifier", rule: "filing_item.other" },
  },

  // insider_filing -> store only
  {
    name: "insider_filing -> store only",
    message: insiderFiling("i1", AT),
    expected: { action: "store_only", rule: "insider_filing" },
  },

  // scheduled_event -> Scheduler
  {
    name: "scheduled_event -> Scheduler",
    message: scheduledEvent("s1", AT, "2026-09-01T20:30:00.000Z"),
    expected: { action: "route", destination: "scheduler", rule: "scheduled_event" },
  },

  // Priority-gated Analyst rows
  {
    name: "unexplained_move at P0 -> Analyst",
    message: unexplainedMove("u1", AT),
    band: "P0",
    expected: { action: "route", destination: "analyst", rule: "unexplained_move.analyst" },
  },
  {
    name: "unexplained_move at P1 -> Analyst",
    message: unexplainedMove("u1", AT),
    band: "P1",
    expected: { action: "route", destination: "analyst", rule: "unexplained_move.analyst" },
  },
  {
    name: "unexplained_move at P2 -> store only",
    message: unexplainedMove("u1", AT),
    band: "P2",
    expected: { action: "store_only", rule: "unexplained_move.store" },
  },
  {
    name: "unexplained_move at P3 -> store only",
    message: unexplainedMove("u1", AT),
    band: "P3",
    expected: { action: "store_only", rule: "unexplained_move.store" },
  },
  {
    name: "drift_event at P1 -> Analyst",
    message: driftEvent("d1", AT),
    band: "P1",
    expected: { action: "route", destination: "analyst", rule: "drift_event.analyst" },
  },
  {
    name: "drift_event at P2 -> store only",
    message: driftEvent("d1", AT),
    band: "P2",
    expected: { action: "store_only", rule: "drift_event.store" },
  },
  {
    name: "insider_cluster at P1 -> Analyst",
    message: insiderCluster("c1", AT),
    band: "P1",
    expected: { action: "route", destination: "analyst", rule: "insider_cluster.analyst" },
  },
  {
    name: "insider_cluster at P2 -> store only",
    message: insiderCluster("c1", AT),
    band: "P2",
    expected: { action: "store_only", rule: "insider_cluster.store" },
  },

  // gap_event — tag-gated, not priority-gated
  {
    name: "gap_event with event_gap -> Propagation",
    message: gapEvent("g1", AT),
    band: "P3",
    tags: ["event_gap"],
    expected: { action: "route", destination: "propagation", rule: "gap_event.propagation" },
  },
  {
    name: "gap_event without event_gap -> Analyst",
    message: gapEvent("g1", AT),
    band: "P3",
    expected: { action: "route", destination: "analyst", rule: "gap_event.analyst" },
  },

  // Unconditional store-only detectors
  {
    name: "volume_anomaly alone -> store only, even at P0",
    message: volumeAnomaly("v1", AT),
    band: "P0",
    tags: ["unexplained_activity"],
    expected: { action: "store_only", rule: "volume_anomaly.store" },
  },
  {
    name: "news_burst alone -> store only",
    message: newsBurst("b1", AT),
    band: "P0",
    expected: { action: "store_only", rule: "news_burst.store" },
  },

  // Tag-gated detectors
  {
    name: "silence_anomaly with pre_earnings_silence -> Analyst",
    message: silenceAnomaly("s1", AT),
    band: "P3",
    tags: ["pre_earnings_silence"],
    expected: { action: "route", destination: "analyst", rule: "silence_anomaly.analyst" },
  },
  {
    name: "silence_anomaly without the tag -> store only",
    message: silenceAnomaly("s1", AT),
    band: "P0",
    expected: { action: "store_only", rule: "silence_anomaly.store" },
  },
  {
    name: "filing_overdue with disclosure_risk -> Analyst",
    message: filingOverdue("o1", AT),
    band: "P3",
    tags: ["disclosure_risk"],
    expected: { action: "route", destination: "analyst", rule: "filing_overdue.analyst" },
  },
  {
    name: "filing_overdue without the tag -> store only",
    message: filingOverdue("o1", AT),
    band: "P0",
    expected: { action: "store_only", rule: "filing_overdue.store" },
  },
  {
    // S2: the channel is off by default, so even a P0 structure stores only.
    name: "tape_structure with screenToAnalystEnabled off -> store only",
    message: tapeStructure("ts1", AT),
    band: "P0",
    expected: { action: "store_only", rule: "tape_structure.store" },
  },
  {
    name: "tape_structure enabled at P2 -> Analyst",
    message: tapeStructure("ts1", AT),
    band: "P2",
    config: ENABLED,
    expected: { action: "route", destination: "analyst", rule: "tape_structure.analyst" },
  },
  {
    name: "tape_structure enabled but below P2 -> store only",
    message: tapeStructure("ts1", AT),
    band: "P3",
    config: ENABLED,
    expected: { action: "store_only", rule: "tape_structure.store" },
  },
];

describe("§4 routing table", () => {
  for (const testCase of CASES) {
    it(testCase.name, () => {
      const outcome = routeMessage(
        testCase.message,
        incidentCtx(testCase.band ?? "P2", testCase.tags ?? []),
        testCase.config ?? CONFIG,
      );
      assert.deepEqual(outcome, testCase.expected);
    });
  }

  it("covers every message type the table names", () => {
    const covered = new Set<BaseMessageType>(CASES.map((c) => c.message.type));
    for (const rule of ROUTING_TABLE) {
      assert.ok(covered.has(rule.type), `no test case for ${rule.type} (rule ${rule.id})`);
    }
  });
});

describe("§4 routing is config-driven", () => {
  it("honours a changed mapped-item-code list", () => {
    const config = mergeBaseConfig({
      routing: { ...CONFIG.routing, mapped8kItemCodes: ["1.05"] },
    });
    const message = filingItem("f1", AT, { item_codes: ["2.02"] });
    assert.deepEqual(routeMessage(message, incidentCtx(), config), {
      action: "route",
      destination: "classifier",
      rule: "filing_item.8k.unmapped",
    });
  });

  it("honours a changed Analyst band gate", () => {
    const config = mergeBaseConfig({ routing: { ...CONFIG.routing, analystMinBand: "P2" } });
    assert.deepEqual(routeMessage(unexplainedMove("u1", AT), incidentCtx("P2"), config), {
      action: "route",
      destination: "analyst",
      rule: "unexplained_move.analyst",
    });
  });

  it("honours a changed fallback for unrecognised forms", () => {
    const config = mergeBaseConfig({
      routing: { ...CONFIG.routing, otherFilingDestination: "extraction" },
    });
    const message = filingItem("f1", AT, { form_type: "DEF 14A", item_codes: [] });
    assert.deepEqual(routeMessage(message, incidentCtx(), config), {
      action: "route",
      destination: "extraction",
      rule: "filing_item.other",
    });
  });
});

describe("§4 incident-level routing", () => {
  it("collapses repeated destinations and lists the rules that produced them", () => {
    const incident = {
      ...incidentCtx("P1", ["event_gap"]),
      messages: [
        filingItem("f1", AT, { item_codes: ["2.02"] }), // propagation
        gapEvent("g1", AT), // propagation (event_gap)
        newsItem("n1", AT), // classifier
        volumeAnomaly("v1", AT), // store only
      ],
    };
    const routing = routeIncident(incident, CONFIG);
    assert.deepEqual(
      routing.destinations.map((d) => d.destination),
      ["propagation", "classifier"],
    );
    assert.deepEqual(routing.destinations[0].rules, [
      "filing_item.8k.mapped",
      "gap_event.propagation",
    ]);
    assert.deepEqual(routing.destinations[0].message_ids, ["f1", "g1"]);
    assert.equal(routing.store_only, false);
    assert.equal(routing.per_message.length, 4);
  });

  it("reports store_only when nothing in the incident routes", () => {
    const incident = {
      ...incidentCtx("P3"),
      messages: [volumeAnomaly("v1", AT), newsBurst("b1", AT), insiderFiling("i1", AT)],
    };
    const routing = routeIncident(incident, CONFIG);
    assert.deepEqual(routing.destinations, []);
    assert.equal(routing.store_only, true);
  });

  it("sends a scheduled due-trigger incident to the Analyst whatever it contains", () => {
    const incident = {
      ...incidentCtx("P3", [], "scheduled"),
      messages: [scheduledEvent("s1", AT, "2026-09-01T20:30:00.000Z")],
    };
    const routing = routeIncident(incident, CONFIG);
    // Analyst is guaranteed by the due-trigger row; the constituent
    // scheduled_event still routes to the Scheduler on its own.
    assert.deepEqual(
      routing.destinations.map((d) => d.destination).sort(),
      ["analyst", "scheduler"],
    );
    const analyst = routing.destinations.find((d) => d.destination === "analyst")!;
    assert.deepEqual(analyst.rules, ["scheduler.due_trigger"]);
  });
});
