/**
 * Base → Analyst request building: deterministic ids, kind, update /
 * prior_request_id, verdict collection, and the Base-owned budget helpers.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { lookupFromVerdicts } from "../base/classification.js";
import { mergeBaseConfig } from "../base/config.js";
import type { ReplayedIncident } from "../base/replay.js";
import { gapEvent, newsItem, plusMinutes } from "../base/test-fixtures.js";
import {
  analystBudgetRemaining,
  analystKindOf,
  analystRequestId,
  applyAnalystBudget,
  buildAnalystRequests,
  collectVerdicts,
  stableIncidentId,
} from "./requests.js";
import { replayBase } from "../base/replay.js";
import { AT, classified, incidentFrom, loadRecorded } from "./test-fixtures.js";
import type { AnalystOutput } from "./types.js";
import type { Verdict } from "../classifier/types.js";

const BASE = mergeBaseConfig(null);

function replayed(incident: ReplayedIncident["incident"], analyst = true): ReplayedIncident {
  return {
    incident,
    routing: {
      destinations: analyst ? [{ destination: "analyst", rules: ["gap_event.analyst"], message_ids: [] }] : [],
      store_only: !analyst,
      per_message: [],
    },
  };
}

describe("ids and kind", () => {
  it("request id is deterministic in the message set, independent of order, and changes when it grows", () => {
    const a = gapEvent("a", AT);
    const b = newsItem("b", plusMinutes(AT, 1));
    const inc1 = incidentFrom([a, b]);
    const inc2 = incidentFrom([b, a]);
    assert.equal(analystRequestId(inc1), analystRequestId(inc2));
    assert.ok(analystRequestId(inc1).startsWith("an-inc-test-"));
    const inc3 = incidentFrom([a, b, newsItem("c", plusMinutes(AT, 2))]);
    assert.notEqual(analystRequestId(inc3), analystRequestId(inc1));
  });

  it("stableIncidentId is deterministic, uuid-shaped, and keyed on (ticker, window_start) only", () => {
    const a = stableIncidentId("WMT", "2026-08-21T00:39:53.797Z", 0);
    const b = stableIncidentId("wmt", "2026-08-21T00:39:53.797Z", 7);
    assert.equal(a, b);
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(a, stableIncidentId("WMT", "2026-08-21T00:39:53.798Z", 0));
    assert.notEqual(a, stableIncidentId("COST", "2026-08-21T00:39:53.797Z", 0));
  });

  it("replayBase with stableIncidentId keeps ids across replays; the default does not", () => {
    const msgs = [gapEvent("g1", AT), newsItem("n1", plusMinutes(AT, 1))];
    const one = replayBase(msgs, { config: BASE, now: plusMinutes(AT, 600), makeIncidentId: stableIncidentId });
    const two = replayBase(msgs, { config: BASE, now: plusMinutes(AT, 600), makeIncidentId: stableIncidentId });
    assert.equal(one.incidents.length, 1);
    assert.equal(one.incidents[0].incident.incident_id, two.incidents[0].incident.incident_id);
    const d1 = replayBase(msgs, { config: BASE, now: plusMinutes(AT, 600) });
    const d2 = replayBase(msgs, { config: BASE, now: plusMinutes(AT, 600) });
    assert.notEqual(d1.incidents[0].incident.incident_id, d2.incidents[0].incident.incident_id);
  });

  it("kind follows trigger_type", () => {
    assert.equal(analystKindOf({ trigger_type: "organic" }), "anomaly_review");
    assert.equal(analystKindOf({ trigger_type: "scheduled" }), "scheduled_brief");
  });
});

describe("buildAnalystRequests", () => {
  const a = gapEvent("a", AT);
  const n = newsItem("n", plusMinutes(AT, 1));
  const incA = incidentFrom([a, n], { incident_id: "inc-a", priority: 60 });
  const incB = incidentFrom([gapEvent("b", AT)], { incident_id: "inc-b", priority: 30 });
  const verdict = classified(n, { relevance: "direct", materiality: "high", direction: "negative" }) as { verdict: Verdict };
  const lookup = lookupFromVerdicts([verdict.verdict], BASE);

  it("only analyst-destination incidents; verdicts collected per message", () => {
    const built = buildAnalystRequests([replayed(incA), replayed(incB, false)], {
      verdictLookup: lookup,
      latestOutput: () => null,
      now: AT,
    });
    assert.equal(built.requests.length, 1);
    const r = built.requests[0];
    assert.equal(r.incident_id, "inc-a");
    assert.equal(r.kind, "anomaly_review");
    assert.equal(r.update, false);
    assert.equal(r.prior_request_id, null);
    assert.equal(r.requested_at, AT);
    assert.deepEqual(Object.keys(r.verdicts), ["n"]);
    assert.equal(r.verdicts.n.state, "classified");
    assert.equal(built.already_produced, 0);
    assert.equal(built.updates, 0);
  });

  it("skips incidents whose current request already has an ok output; marks updates with prior_request_id", () => {
    const prior = (request_id: string, status: "ok" | "failed" = "ok"): AnalystOutput =>
      ({ request_id, incident_id: "inc-a", status }) as AnalystOutput;
    const current = analystRequestId(incA);
    const same = buildAnalystRequests([replayed(incA)], { verdictLookup: lookup, latestOutput: () => prior(current), now: AT });
    assert.equal(same.requests.length, 0);
    assert.equal(same.already_produced, 1);

    const failed = buildAnalystRequests([replayed(incA)], { verdictLookup: lookup, latestOutput: () => prior(current, "failed"), now: AT });
    assert.equal(failed.requests.length, 1, "a failed output is retried on later cycles");
    assert.equal(failed.requests[0].update, false);

    const grown = buildAnalystRequests([replayed(incA)], { verdictLookup: lookup, latestOutput: () => prior("an-inc-a-old"), now: AT });
    assert.equal(grown.requests.length, 1);
    assert.equal(grown.requests[0].update, true);
    assert.equal(grown.requests[0].prior_request_id, "an-inc-a-old");
    assert.equal(grown.updates, 1);
  });

  it("collectVerdicts omits unclassified messages", () => {
    const v = collectVerdicts(incA, lookup);
    assert.deepEqual(Object.keys(v), ["n"]);
  });

  it("recorded WMT incident routes to analyst and builds one request", () => {
    const rec = loadRecorded("wmt-earnings");
    const built = buildAnalystRequests([{ incident: rec.incident, routing: rec.routing }], {
      verdictLookup: () => ({ state: "unclassified" }),
      latestOutput: () => null,
      now: AT,
    });
    assert.equal(built.requests.length, 1);
    assert.equal(built.requests[0].incident.ticker, "WMT");
  });
});

describe("budget (Base-owned, §8)", () => {
  it("default 50/day, ET-day ledger", () => {
    assert.equal(BASE.analyst.dailyBudget, 50);
    const now = "2026-08-21T15:00:00.000Z"; // 11:00 ET
    assert.equal(analystBudgetRemaining(null, now, BASE), 50);
    assert.equal(analystBudgetRemaining({ day: "2026-08-21", used: 48 }, now, BASE), 2);
    assert.equal(analystBudgetRemaining({ day: "2026-08-20", used: 50 }, now, BASE), 50);
    assert.equal(analystBudgetRemaining({ day: "2026-08-21", used: 60 }, now, BASE), 0);
  });

  it("applyAnalystBudget orders by incident priority, then request id", () => {
    const hi = { request_id: "b", incident: { priority: 70 } };
    const lo = { request_id: "a", incident: { priority: 20 } };
    const mid = { request_id: "c", incident: { priority: 20 } };
    const { dispatch, deferred } = applyAnalystBudget([lo, hi, mid] as never, 2);
    assert.deepEqual(dispatch.map((r: { request_id: string }) => r.request_id), ["b", "a"]);
    assert.deepEqual(deferred.map((r: { request_id: string }) => r.request_id), ["c"]);
    assert.equal(applyAnalystBudget([lo] as never, 0).dispatch.length, 0);
  });
});
