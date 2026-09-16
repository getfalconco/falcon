/**
 * The NVDA dry run — synthetic end-to-end chain for the 2026-08-26 (AMC)
 * release, built from NVDA's real calendar entry (dueAt 2026-08-26T20:00Z,
 * confirmed; history: amc).
 *
 *   scheduled_event (emitted days ahead)
 *     -> Scheduler due-trigger at due_at
 *       -> absorbing scheduled incident opens
 *         -> synthetic 8-K 2.02 (D 16:20 ET) joins
 *         -> D+1 09:30 gap joins                  (17h later: past the 8h cap)
 *         -> D+1 close volume_anomaly joins
 *           -> earnings_surprise (+ event_gap)
 *             -> severity read from the realised |residual_zscore|
 *               -> routing: Analyst (due-trigger) + Propagation (8-K 2.02)
 *
 * Each step below is its own assertion so a failure says which link broke.
 * If Tracker's side (T5) emits these messages on Wednesday, this is the path
 * they take — the WMT case, caught this time.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BASE_CONFIG } from "./config.js";
import { absorptionEndAt, buildIncidents, openScheduledIncident } from "./incident.js";
import { computePriority, isEarningsReaction, severityOf } from "./priority.js";
import { routeIncident } from "./routing.js";
import { filingItem, gapEvent, scheduledEvent, seqIds, volumeAnomaly } from "./test-fixtures.js";
import type { SchedulerDueTrigger } from "./types.js";

const CONFIG = DEFAULT_BASE_CONFIG;
const NVDA = "NVDA";

// Real calendar entry: due exactly at the 16:00 ET close.
const DUE_AT = "2026-08-26T20:00:00.000Z";
// Tracker emitted the scheduled_event on 2026-08-18 in the shadow log span.
const SCHEDULED_EMITTED_AT = "2026-08-18T22:50:00.000Z";

// Synthetic release + reaction. Quant context carries the realised residual
// on every message, as Tracker does; the detector itself is suppressed by the
// earnings_window flag so no unexplained_move is ever emitted.
const REALISED_Z = -5.2;
const EARNINGS_Q = { residual_zscore: REALISED_Z, volume_ratio: 3.1 };
const WINDOW = { context_flags: ["earnings_window" as const], quant: EARNINGS_Q, ticker: NVDA };

const MESSAGES = [
  scheduledEvent("sched", SCHEDULED_EMITTED_AT, DUE_AT, { fiscal_period: "Q2 2027" }, { ticker: NVDA }),
  // D 16:20 ET — the 8-K 2.02, after the close.
  filingItem("8k", "2026-08-26T20:20:00.000Z", { item_codes: ["2.02", "9.01"] }, WINDOW),
  // D+1 09:30 ET — the gap it caused.
  gapEvent("gap", "2026-08-27T13:30:00.000Z", { gap_z: -4.8, direction: "down" }, WINDOW),
  // D+1 close batch — volume.
  volumeAnomaly("vol", "2026-08-27T20:15:00.000Z", { volume_ratio: 3.1 }, WINDOW),
];

const TRIGGER: SchedulerDueTrigger = {
  id: "trig-nvda-q2",
  ticker: NVDA,
  due_at: DUE_AT,
  fired_at: DUE_AT,
};

const NOW = "2026-08-28T06:00:00.000Z";
const OPTS = { config: CONFIG, makeIncidentId: seqIds, now: NOW, dueTriggers: [TRIGGER] };

describe("NVDA dry run — scheduled_event to dispatch", () => {
  it("step 1: the scheduled_event is recorded in its own incident ahead of time", () => {
    const pre = buildIncidents([MESSAGES[0]], { config: CONFIG, makeIncidentId: seqIds, now: "2026-08-19T12:00:00.000Z" });
    assert.equal(pre.length, 1);
    assert.equal(pre[0].trigger_type, "organic");
    assert.deepEqual(pre[0].trigger_identities, [`sched:${DUE_AT}`]);
    assert.deepEqual(
      routeIncident(pre[0], CONFIG).destinations.map((d) => d.destination),
      ["scheduler"],
      "the scheduled_event itself goes to the Scheduler, which will fire the due-trigger",
    );
  });

  it("step 2: the due-trigger opens an absorbing scheduled incident at due_at", () => {
    // Prior = the world before the trigger: the scheduled_event incident alone.
    const prior = buildIncidents([MESSAGES[0]], { config: CONFIG, makeIncidentId: seqIds, now: "2026-08-19T12:00:00.000Z" });
    const scheduled = openScheduledIncident(TRIGGER, prior, {
      config: CONFIG,
      makeIncidentId: () => "inc-sched",
    });
    assert.equal(scheduled.trigger_type, "scheduled");
    assert.equal(scheduled.window_start, DUE_AT);
    assert.equal(scheduled.earnings_absorption, true);
    assert.equal(scheduled.related_incident_id, "inc-0", "points back at the incident that carried the scheduled_event");
  });

  it("step 3: due_at exactly at the close is AMC -> absorb to D+1 close + grace", () => {
    // 20:00Z is the 16:00 ET close; `>= close` reads as after-market, so the
    // reaction session is D+1 and the window runs to its close plus 6h.
    assert.equal(absorptionEndAt(DUE_AT, CONFIG), "2026-08-28T02:00:00.000Z");
  });

  it("step 4: the 8-K, the next open's gap and the close volume all join that one incident", () => {
    const incidents = buildIncidents(MESSAGES, OPTS);
    const nvda = incidents.filter((i) => i.ticker === NVDA);
    // One for the early scheduled_event, one absorbing incident for the release.
    assert.equal(nvda.length, 2, `expected 2 NVDA incidents, got ${nvda.length}`);
    const release = nvda.find((i) => i.trigger_type === "scheduled")!;
    assert.ok(release, "no scheduled incident was opened");
    assert.deepEqual(
      release.messages.map((m) => m.id).sort(),
      ["8k", "gap", "sched", "vol"],
      "17h between 8-K and gap must not split them — absorption overrides the 8h cap",
    );
    assert.equal(release.window_end, "2026-08-28T02:00:00.000Z");
    assert.equal(release.window_status, "closed");
  });

  it("step 5: earnings_surprise forms (plus event_gap)", () => {
    const release = buildIncidents(MESSAGES, OPTS).find((i) => i.trigger_type === "scheduled")!;
    assert.deepEqual(release.composite_tags, ["earnings_surprise", "event_gap"]);
  });

  it("step 6: severity is read from the realised |residual_zscore|, not the suppressed detector", () => {
    const release = buildIncidents(MESSAGES, OPTS).find((i) => i.trigger_type === "scheduled")!;
    assert.ok(!release.messages.some((m) => m.type === "unexplained_move"), "precondition: no unexplained_move emitted");
    assert.equal(isEarningsReaction(release.messages, CONFIG), true);
    const { severity } = severityOf(release.messages, CONFIG);
    assert.equal(severity, 40, "|z| 5.2 is past the 4.0 anchor -> severity cap"); // gap |z| 4.8 alone would also give 40
  });

  it("step 7: priority and band — tracked-only reaches P1, watchlist/held P0", () => {
    const release = buildIncidents(MESSAGES, OPTS).find((i) => i.trigger_type === "scheduled")!;
    const at = "2026-08-27T20:15:00.000Z"; // the close batch moment
    const tracked = computePriority({ messages: release.messages, composite_tags: release.composite_tags, user_proximity: "tracked", now: at, config: CONFIG });
    // severity 40 + earnings_surprise 15 = 55; x1.0; freshness: driver is the
    // close volume (neutral 5) or the gap (market_open, 6h45 old -> ~7.5);
    // the latest equal-severity message wins -> volume -> 5.
    assert.equal(tracked.combined, 55);
    assert.equal(tracked.priority, 60);
    assert.equal(tracked.band, "P1");
    const watch = computePriority({ ...{ messages: release.messages, composite_tags: release.composite_tags, now: at, config: CONFIG }, user_proximity: "watchlist" });
    assert.equal(watch.priority, 74); // 55 * 1.25 + 5 = 73.75
    assert.equal(watch.band, "P0");
    const held = computePriority({ ...{ messages: release.messages, composite_tags: release.composite_tags, now: at, config: CONFIG }, user_proximity: "held" });
    assert.equal(held.priority, 88); // 55 * 1.5 + 5 = 87.5
    assert.equal(held.band, "P0");
  });

  it("step 8: dispatch — Analyst (due-trigger) and Propagation (8-K 2.02), not Analyst alone", () => {
    const release = buildIncidents(MESSAGES, OPTS).find((i) => i.trigger_type === "scheduled")!;
    const routing = routeIncident(release, CONFIG);
    const dests = routing.destinations.map((d) => d.destination).sort();
    assert.deepEqual(dests, ["analyst", "propagation", "scheduler"]);
    const analyst = routing.destinations.find((d) => d.destination === "analyst")!;
    assert.ok(analyst.rules.includes("scheduler.due_trigger"));
    const prop = routing.destinations.find((d) => d.destination === "propagation")!;
    // The 8-K (mapped item 2.02) and the gap (it carries event_gap) both go
    // to Propagation per §4 — two rows, one destination.
    assert.deepEqual(prop.message_ids.sort(), ["8k", "gap"]);
    assert.equal(routing.store_only, false);
  });

  it("contrast: the same messages with NO due-trigger still absorb off the 8-K alone", () => {
    // Belt and braces — if the Scheduler is late or silent on Wednesday, the
    // 8-K path (openOnAnnouncementFiling) still produces one incident.
    const incidents = buildIncidents(MESSAGES, { config: CONFIG, makeIncidentId: seqIds, now: NOW });
    const nvda = incidents.filter((i) => i.ticker === NVDA);
    const release = nvda.find((i) => i.messages.some((m) => m.id === "8k"))!;
    assert.deepEqual(release.messages.map((m) => m.id).sort(), ["8k", "gap", "vol"]);
    assert.equal(release.trigger_type, "organic");
    assert.deepEqual(release.composite_tags, ["earnings_surprise", "event_gap"]);
    assert.equal(severityOf(release.messages, CONFIG).severity, 40);
  });

  it("contrast: with absorption disabled the chain fragments into three incidents", () => {
    const off = { ...CONFIG, earnings: { ...CONFIG.earnings, enabled: false } };
    const incidents = buildIncidents(MESSAGES, { config: off, makeIncidentId: seqIds, now: NOW });
    const nvda = incidents.filter((i) => i.ticker === NVDA && i.window_start >= "2026-08-26");
    assert.ok(nvda.length >= 3, `expected fragmentation, got ${nvda.length}`);
    assert.ok(!nvda.some((i) => i.composite_tags.includes("earnings_surprise")));
  });
});
