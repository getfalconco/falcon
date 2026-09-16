/**
 * §3 input assembly goldens: the WMT 81-message incident (cap respected,
 * direct-first ordering, count line for excluded articles), determinism,
 * what is never included, and the config caps.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { insiderFiling, newsItem, gapEvent, plusMinutes } from "../base/test-fixtures.js";
import type { Verdict } from "../classifier/types.js";
import { assembleInput, excludedCount, slimPayload } from "./assemble.js";
import { mergeAnalystConfig } from "./config.js";
import { AT, classified, failedVerdictFor, incidentFrom, loadRecorded } from "./test-fixtures.js";

const CONFIG = mergeAnalystConfig(null);

describe("WMT 81-message incident", () => {
  const rec = loadRecorded("wmt-earnings");
  const input = assembleInput(rec.incident, rec.verdicts, "anomaly_review", CONFIG);

  it("ships the anomaly, filing and calendar messages in full", () => {
    assert.equal(rec.incident.messages.length, 81);
    assert.deepEqual(
      input.anomalies.map((a) => a.type),
      ["volume_anomaly", "gap_event", "drift_event"],
    );
    assert.equal(input.filings.length, 1);
    assert.deepEqual(input.filings[0].item_codes, ["2.02", "9.01"]);
    assert.equal(input.calendar.length, 2);
    assert.equal(input.insiders.length, 0);
  });

  it("news: cap 20, direct first by materiality desc, then indirect; the rest counted", () => {
    assert.equal(input.news.length, 20);
    assert.ok(input.news.every((n) => n.relevance === "direct"));
    assert.ok(input.news.slice(0, 15).every((n) => n.materiality === "high"));
    assert.ok(input.news.slice(15).every((n) => n.materiality === "standard"));
    // 41 direct (15 high, 14 standard, 12 low) + 5 indirect classified; 28 none; 1 unclassified.
    assert.deepEqual(input.news_omitted, { direct: 21, indirect: 5 });
    assert.deepEqual(input.news_excluded, { none: 28, unassessed: 0, failed: 0, unclassified: 1 });
    assert.equal(excludedCount(input), 29);
  });

  it("refs cover exactly the included messages; evidence universe is the whole incident", () => {
    const included = input.anomalies.length + input.filings.length + input.calendar.length + input.insiders.length + input.news.length;
    assert.equal(Object.keys(input.refs).length, included);
    assert.equal(Object.keys(input.refs).length, 26);
    assert.equal(input.evidence_ids.length, 81);
    // refs are m1..mN in inclusion order
    assert.equal(input.anomalies[0].ref, "m1");
    assert.equal(input.filings[0].ref, "m4");
    assert.equal(input.news[0].ref, "m7");
    assert.equal(input.refs.m4, input.filings[0].id);
  });

  it("never includes user identity, holdings, watchlist or priority", () => {
    const text = JSON.stringify(input);
    assert.ok(!("priority" in input.incident));
    assert.ok(!("priority_band" in input.incident));
    assert.ok(!("user_proximity" in input.incident));
    assert.ok(!/"priority"|"priority_band"|"user_proximity"|"held"|"watchlist"/.test(text));
  });

  it("is deterministic and independent of input message order", () => {
    const shuffled = { ...rec.incident, messages: [...rec.incident.messages].reverse() };
    const again = assembleInput(shuffled, rec.verdicts, "anomaly_review", CONFIG);
    assert.deepEqual(again, input);
  });

  it("carries tags, latest quant context, degraded flag and reaction_state", () => {
    assert.deepEqual(input.incident.composite_tags, ["earnings_surprise", "volume_without_price", "event_gap"]);
    assert.equal(input.incident.degraded_context, false);
    assert.equal(input.quant_context?.r_squared, rec.incident.quant_context?.r_squared);
    assert.equal(input.reaction_state.edge_default, "no_edge");
  });

  it("news line cap is configuration", () => {
    const small = assembleInput(rec.incident, rec.verdicts, "anomaly_review", mergeAnalystConfig({ newsLineCap: 5 }));
    assert.equal(small.news.length, 5);
    assert.deepEqual(small.news_omitted, { direct: 36, indirect: 5 });
  });
});

describe("synthetic incidents", () => {
  it("indirect lines follow direct ones within the cap; failed/unassessed/none/unclassified counted separately", () => {
    const msgs = Array.from({ length: 8 }, (_, i) => newsItem(`n${i}`, plusMinutes(AT, i)));
    const inc = incidentFrom([...msgs, gapEvent("g", plusMinutes(AT, 20))]);
    const verdicts = {
      n0: classified(msgs[0], { relevance: "indirect", materiality: "high", direction: "negative" }),
      n1: classified(msgs[1], { relevance: "direct", materiality: "low", direction: "positive" }),
      n2: classified(msgs[2], { relevance: "none" }),
      n3: failedVerdictFor(msgs[3]),
      n4: { state: "unassessed" as const, verdict: (failedVerdictFor(msgs[4]) as { verdict: Verdict }).verdict },
      n5: classified(msgs[5], { relevance: "direct", materiality: "high", direction: "negative" }),
      // n6, n7 unclassified
    };
    const input = assembleInput(inc, verdicts, "anomaly_review", CONFIG);
    assert.deepEqual(
      input.news.map((n) => `${n.id}:${n.relevance}/${n.materiality}`),
      ["n5:direct/high", "n1:direct/low", "n0:indirect/high"],
    );
    assert.deepEqual(input.news_excluded, { none: 1, unassessed: 1, failed: 1, unclassified: 2 });
    assert.equal(input.anomalies[0].ref, "m1");
    assert.equal(input.news[0].ref, "m2");
  });

  it("insider filings are capped with an omitted count", () => {
    const filings = Array.from({ length: 5 }, (_, i) => insiderFiling(`f${i}`, plusMinutes(AT, i)));
    const inc = incidentFrom(filings);
    const input = assembleInput(inc, {}, "anomaly_review", mergeAnalystConfig({ insiderLineCap: 3 }));
    assert.equal(input.insiders.length, 3);
    assert.equal(input.insiders_omitted, 2);
  });

  it("CAH recorded: 7 insider filings all shipped under the default cap; cluster payload in full", () => {
    const rec = loadRecorded("cah-insider-cluster");
    const input = assembleInput(rec.incident, rec.verdicts, "anomaly_review", CONFIG);
    assert.equal(input.insiders.length, 7);
    assert.equal(input.insiders_omitted, 0);
    assert.equal(input.anomalies.length, 1);
    assert.equal(input.anomalies[0].type, "insider_cluster");
    assert.ok(Array.isArray(input.anomalies[0].payload.transactions));
  });

  it("strips display-only URLs from payloads", () => {
    assert.deepEqual(slimPayload({ a: 1, url: "x", filing_url: "y" }), { a: 1 });
    const inc = incidentFrom([gapEvent("g", AT)]);
    const input = assembleInput(inc, {}, "anomaly_review", CONFIG);
    assert.ok(!("url" in input.anomalies[0].payload));
  });

  it("kind and trigger type are carried", () => {
    const inc = incidentFrom([gapEvent("g", AT)], { trigger_type: "scheduled" });
    const input = assembleInput(inc, {}, "scheduled_brief", CONFIG);
    assert.equal(input.kind, "scheduled_brief");
    assert.equal(input.incident.trigger_type, "scheduled");
  });
});
