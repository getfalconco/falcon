/**
 * §9 layer 1 — incident model golden vectors.
 *
 * Every expected value in this file was computed by hand from the spec and is
 * pinned as a constant; nothing is derived by calling the code under test.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_BASE_CONFIG, mergeBaseConfig } from "./config.js";
import {
  buildIncidents,
  openScheduledIncident,
  windowCloseAt,
  type BuildIncidentsOptions,
} from "./incident.js";
import { computePriority, messageSeverity } from "./priority.js";
import { routeIncident } from "./routing.js";
import {
  TICKER,
  filingItem,
  gapEvent,
  insiderCluster,
  newsItem,
  plusMinutes,
  scheduledEvent,
  seqIds,
  unexplainedMove,
  volumeAnomaly,
} from "./test-fixtures.js";
import type { UserContext } from "./types.js";

const CONFIG = DEFAULT_BASE_CONFIG;
const TRACKED: BuildIncidentsOptions = { config: CONFIG, makeIncidentId: seqIds };
const HELD: UserContext = { held: [TICKER], watchlist: [] };

// ---------------------------------------------------------------------------
// §2 the 15:45 8-K -> close anomaly case
// ---------------------------------------------------------------------------

describe("§2 measurement-anchored window: 15:45 8-K to close-computed anomaly", () => {
  // 2026-08-21 is a full trading day: open 13:30Z (09:30 ET), close 20:00Z.
  const EIGHT_K_AT = "2026-08-21T19:45:00.000Z"; // 15:45 ET
  const CLOSE_BATCH_AT = "2026-08-21T20:15:00.000Z"; // 16:15 ET

  // The 8-K carries item 2.02, so this is an earnings release and absorption
  // governs the close: the 15:45 ET filing is intraday, priced by that same
  // session, so the window runs to its 20:00Z close plus the 6h grace that
  // lets the close-computed batch land inside it -> 2026-08-22T02:00Z.
  // (Without absorption it would have been the silence timer: 20:15Z + 6h.)
  const EXPECTED_WINDOW_END = "2026-08-22T02:00:00.000Z";
  // severity: unexplained |z| 3.0 -> 25 (anchor); volume 6.0 -> 17; filing -> base 5. max = 25.
  // bonus: unexplained_activity = +8. freshness: close-computed driver -> neutral 5.
  const EXPECTED_PRIORITY_NO_FLOOR = 38; // (25 + 8) * 1.0 + 5
  // combined = 33 >= 30, so the discovery floor lifts the tracked-only score to
  // the P1 threshold: a 3-sigma move on 6x volume is strong enough to look at
  // whoever happens to be watching the ticker.
  const EXPECTED_PRIORITY_TRACKED = 40;
  const EXPECTED_PRIORITY_HELD = 55; // (25 + 8) * 1.5 + 5 = 54.5 -> 55, already above the floor

  const stream = [
    filingItem("f1", EIGHT_K_AT, { item_codes: ["2.02"] }),
    unexplainedMove("u1", CLOSE_BATCH_AT, { residual_zscore: 3.0 }),
    volumeAnomaly("v1", CLOSE_BATCH_AT, { volume_ratio: 6 }),
  ];

  it("keeps the filing and the anomaly it caused in one incident", () => {
    const incidents = buildIncidents(stream, TRACKED);
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].messages.length, 3);
    assert.equal(incidents[0].window_start, EIGHT_K_AT);
    assert.equal(incidents[0].trigger_type, "organic");
    assert.deepEqual(incidents[0].composite_tags, ["unexplained_activity"]);
    assert.equal(incidents[0].degraded_context, false);
  });

  it("stays open until the measurement-silence timeout, then closes there", () => {
    const stillOpen = buildIncidents(stream, TRACKED);
    assert.equal(stillOpen[0].window_status, "open");
    assert.equal(stillOpen[0].window_end, null);
    assert.equal(windowCloseAt(stillOpen[0], CONFIG), EXPECTED_WINDOW_END);

    const closed = buildIncidents(stream, { ...TRACKED, now: "2026-08-22T03:00:00.000Z" });
    assert.equal(closed[0].window_status, "closed");
    assert.equal(closed[0].window_end, EXPECTED_WINDOW_END);
  });

  it("scores the incident to the pinned priority", () => {
    const tracked = buildIncidents(stream, TRACKED)[0];
    assert.equal(tracked.priority, EXPECTED_PRIORITY_TRACKED);
    assert.equal(tracked.priority_band, "P1");
    assert.equal(tracked.discovery_floor_applied, true);

    const held = buildIncidents(stream, { ...TRACKED, userContext: HELD })[0];
    assert.equal(held.priority, EXPECTED_PRIORITY_HELD);
    assert.equal(held.priority_band, "P1");
    assert.equal(held.discovery_floor_applied, false); // earned it on its own
  });

  it("without the discovery floor the same incident is tracked-only P2", () => {
    const noFloor = mergeBaseConfig({
      priority: { ...CONFIG.priority, discoveryFloor: { ...CONFIG.priority.discoveryFloor, enabled: false } },
    });
    const incident = buildIncidents(stream, { config: noFloor, makeIncidentId: seqIds })[0];
    assert.equal(incident.priority, EXPECTED_PRIORITY_NO_FLOOR);
    assert.equal(incident.priority_band, "P2");
    assert.equal(incident.discovery_floor_applied, false);
  });
});

// ---------------------------------------------------------------------------
// §2 news flow must not extend the window
// ---------------------------------------------------------------------------

describe("§2 high-news-volume ticker", () => {
  const START = "2026-08-21T13:00:00.000Z";
  // 19 news items, every 30 minutes: 13:00Z .. 22:00Z.
  const NEWS = Array.from({ length: 19 }, (_, i) =>
    newsItem(`n${String(i).padStart(2, "0")}`, plusMinutes(START, i * 30)),
  );
  const NOW = "2026-08-21T22:00:00.000Z";

  // No measurement message ever arrives, so only the 8h hard cap applies:
  // 13:00Z + 8h = 21:00Z. Items 0..15 (13:00..20:30) land in the first
  // incident; the item at exactly 21:00Z opens the next one.
  const EXPECTED_FIRST_CLOSE = "2026-08-21T21:00:00.000Z";
  const EXPECTED_SIZES = [16, 3];

  it("does not let a continuous news stream hold an incident open", () => {
    const incidents = buildIncidents(NEWS, { ...TRACKED, now: NOW });
    assert.deepEqual(
      incidents.map((i) => i.messages.length),
      EXPECTED_SIZES,
    );
    assert.equal(incidents[0].window_end, EXPECTED_FIRST_CLOSE);
    assert.equal(incidents[0].window_status, "closed");
    assert.equal(incidents[1].window_status, "open");
  });

  it("a single measurement message does extend it, closing 6h later instead", () => {
    // Measurement at 14:00Z -> silence closure 20:00Z, which beats the 21:00Z cap.
    const withMeasurement = [...NEWS, unexplainedMove("u1", "2026-08-21T14:00:00.000Z")];
    const incidents = buildIncidents(withMeasurement, { ...TRACKED, now: NOW });
    assert.equal(incidents[0].window_end, "2026-08-21T20:00:00.000Z");
    // news 13:00..19:30 (14 items) + the measurement = 15.
    assert.equal(incidents[0].messages.length, 15);
  });
});

// ---------------------------------------------------------------------------
// §2 closure rules
// ---------------------------------------------------------------------------

describe("§2 six-hour measurement silence", () => {
  const MEASURED_AT = "2026-08-21T12:00:00.000Z";
  const EXPECTED_CLOSE = "2026-08-21T18:00:00.000Z"; // 12:00Z + 6h, before the 20:00Z cap

  const base = [
    unexplainedMove("u1", MEASURED_AT),
    newsItem("n1", "2026-08-21T13:00:00.000Z"),
    newsItem("n2", "2026-08-21T15:00:00.000Z"),
    newsItem("n3", "2026-08-21T17:00:00.000Z"),
  ];

  it("closes exactly 6h after the last measurement despite intervening news", () => {
    const incidents = buildIncidents([...base, newsItem("n4", EXPECTED_CLOSE)], {
      ...TRACKED,
      now: "2026-08-22T00:00:00.000Z",
    });
    assert.equal(incidents.length, 2);
    assert.equal(incidents[0].messages.length, 4);
    assert.equal(incidents[0].window_end, EXPECTED_CLOSE);
    assert.equal(incidents[1].messages.length, 1);
    assert.equal(incidents[1].window_start, EXPECTED_CLOSE);
  });

  it("a message one minute inside the boundary still appends", () => {
    const incidents = buildIncidents([...base, newsItem("n4", "2026-08-21T17:59:00.000Z")], {
      ...TRACKED,
      now: "2026-08-22T00:00:00.000Z",
    });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].messages.length, 5);
    assert.equal(incidents[0].window_end, EXPECTED_CLOSE);
  });
});

describe("§2 eight-hour hard cap", () => {
  const START = "2026-08-21T12:00:00.000Z";
  const EXPECTED_CAP = "2026-08-21T20:00:00.000Z"; // 12:00Z + 8h

  it("caps the window even while measurements keep arriving", () => {
    // Last measurement 19:00Z would push silence closure to 01:00Z next day;
    // the cap at 20:00Z wins.
    const stream = [
      unexplainedMove("u1", START),
      unexplainedMove("u2", "2026-08-21T15:00:00.000Z"),
      unexplainedMove("u3", "2026-08-21T18:00:00.000Z"),
      unexplainedMove("u4", "2026-08-21T19:00:00.000Z"),
      unexplainedMove("u5", EXPECTED_CAP),
    ];
    const incidents = buildIncidents(stream, { ...TRACKED, now: "2026-08-22T06:00:00.000Z" });
    assert.equal(incidents.length, 2);
    assert.equal(incidents[0].messages.length, 4);
    assert.equal(incidents[0].window_end, EXPECTED_CAP);
    assert.equal(incidents[1].window_start, EXPECTED_CAP);
  });

  it("silenceAnchorFallback: window_start closes a news-only incident at 6h", () => {
    const config = mergeBaseConfig({
      window: { ...CONFIG.window, silenceAnchorFallback: "window_start" },
    });
    const stream = [
      newsItem("n1", START),
      newsItem("n2", "2026-08-21T17:00:00.000Z"),
      newsItem("n3", "2026-08-21T19:00:00.000Z"),
    ];
    const incidents = buildIncidents(stream, {
      config,
      makeIncidentId: seqIds,
      now: "2026-08-22T06:00:00.000Z",
    });
    assert.equal(incidents.length, 2);
    assert.equal(incidents[0].window_end, "2026-08-21T18:00:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// §2 per-ticker independence, ordering, idempotency
// ---------------------------------------------------------------------------

describe("§8 ordering and idempotency", () => {
  const stream = [
    filingItem("f1", "2026-08-21T19:45:00.000Z"),
    unexplainedMove("u1", "2026-08-21T20:15:00.000Z"),
    volumeAnomaly("v1", "2026-08-21T20:15:00.000Z"),
  ];
  const options: BuildIncidentsOptions = { ...TRACKED, now: "2026-08-22T03:00:00.000Z" };

  it("produces identical incidents from a shuffled, redelivered stream", () => {
    const expected = buildIncidents(stream, options);
    const shuffled = [stream[2], stream[0], stream[1], stream[0], stream[2]];
    assert.deepEqual(buildIncidents(shuffled, options), expected);
  });

  it("keeps separate tickers in separate incidents", () => {
    const mixed = [
      unexplainedMove("a1", "2026-08-21T20:15:00.000Z", {}, { ticker: "NVDA" }),
      unexplainedMove("b1", "2026-08-21T20:15:00.000Z", {}, { ticker: "AMD" }),
    ];
    const incidents = buildIncidents(mixed, options);
    assert.equal(incidents.length, 2);
    assert.deepEqual(
      incidents.map((i) => i.ticker).sort(),
      ["AMD", "NVDA"],
    );
  });
});

// ---------------------------------------------------------------------------
// §2 related incidents
// ---------------------------------------------------------------------------

describe("§2 related_incident_id", () => {
  const ACCESSION = "0000000000-26-ACC1";
  const first = [
    filingItem("f1", "2026-08-21T19:45:00.000Z", { accession_number: ACCESSION }),
    unexplainedMove("u1", "2026-08-21T20:15:00.000Z"),
  ];
  // First incident closes 2026-08-22T02:15Z (20:15Z + 6h).
  const options: BuildIncidentsOptions = { ...TRACKED, now: "2026-08-24T00:00:00.000Z" };

  it("links a later incident sharing the same 8-K accession within 24h", () => {
    const follow = filingItem("f2", "2026-08-22T10:00:00.000Z", { accession_number: ACCESSION });
    const incidents = buildIncidents([...first, follow], options);
    assert.equal(incidents.length, 2);
    assert.equal(incidents[0].related_incident_id, null);
    assert.equal(incidents[1].related_incident_id, "inc-0");
  });

  it("does not link past the 24h lookback", () => {
    const follow = filingItem("f2", "2026-08-23T10:00:00.000Z", { accession_number: ACCESSION });
    const incidents = buildIncidents([...first, follow], options);
    assert.equal(incidents[1].related_incident_id, null);
  });

  it("does not link a different trigger identity", () => {
    const follow = filingItem("f2", "2026-08-22T10:00:00.000Z", { accession_number: "OTHER" });
    const incidents = buildIncidents([...first, follow], options);
    assert.equal(incidents[1].related_incident_id, null);
  });
});

// ---------------------------------------------------------------------------
// §2 scheduled due-triggers
// ---------------------------------------------------------------------------

describe("§2 scheduler due-trigger incidents", () => {
  const DUE_AT = "2026-09-01T20:30:00.000Z";
  const SCHEDULED_AT = "2026-08-21T13:00:00.000Z";
  const FIRED_AT = "2026-09-01T13:30:00.000Z";
  // severity: scheduled_event -> base 5; no tags; freshness anchored on the
  // scheduled_event's own timestamp, 11 days stale -> 0. 5 * 1.0 + 0 = 5.
  const EXPECTED_PRIORITY = 5;

  const prior = buildIncidents([scheduledEvent("s1", SCHEDULED_AT, DUE_AT)], {
    ...TRACKED,
    now: "2026-08-22T00:00:00.000Z",
  });

  it("opens its own incident pointing back at the scheduling incident", () => {
    const incident = openScheduledIncident(
      { id: "t1", ticker: TICKER, due_at: DUE_AT, fired_at: FIRED_AT },
      prior,
      { config: CONFIG, makeIncidentId: () => "inc-sched" },
    );
    assert.equal(incident.incident_id, "inc-sched");
    assert.equal(incident.trigger_type, "scheduled");
    assert.equal(incident.window_start, FIRED_AT);
    assert.equal(incident.window_status, "open");
    assert.equal(incident.related_incident_id, "inc-0");
    assert.equal(incident.messages.length, 1);
    assert.equal(incident.priority, EXPECTED_PRIORITY);
    assert.equal(incident.priority_band, "P3");
  });

  it("does not require an open incident to exist", () => {
    const incident = openScheduledIncident(
      { id: "t1", ticker: TICKER, due_at: DUE_AT, fired_at: FIRED_AT },
      [],
      { config: CONFIG, makeIncidentId: () => "inc-sched" },
    );
    assert.equal(incident.related_incident_id, null);
    assert.equal(incident.messages.length, 0);
  });

  it("routes to the Analyst regardless of its band", () => {
    const incident = openScheduledIncident(
      { id: "t1", ticker: TICKER, due_at: DUE_AT, fired_at: FIRED_AT },
      prior,
      { config: CONFIG, makeIncidentId: () => "inc-sched" },
    );
    const routing = routeIncident(incident, CONFIG);
    assert.equal(routing.store_only, false);
    // Analyst from the due-trigger row, plus whatever the constituent messages
    // route to on their own — here the carried scheduled_event -> Scheduler.
    assert.deepEqual(
      routing.destinations.map((d) => d.destination).sort(),
      ["analyst", "scheduler"],
    );
  });
});

// ---------------------------------------------------------------------------
// The PFE case end to end: a strong cluster on an untracked ticker
// ---------------------------------------------------------------------------

describe("standalone insider cluster on an untracked ticker", () => {
  // Bourla (CEO) $1,000,920 + Blaylock (dir) $998,821 + Buckley (dir) $960,369
  // = $2,960,110, all open-market P, no 10b5-1, no partner measurement.
  const AT = "2026-08-21T20:15:00.000Z";
  const PFE_CLUSTER = insiderCluster("c1", AT, {
    insider_count: 3,
    direction: "buy",
    total_notional: 2_960_110,
  });

  // severity: insider_count 3 -> anchor 20; $2.96M is the $1M-5M tier -> x1.3 = 26.
  // bonus: standalone_insider_cluster = +8. combined = 34.
  // freshness: insider_cluster anchors on its own timestamp, evaluated at the
  // incident's last message -> 10.
  const EXPECTED_SEVERITY = 26;
  const EXPECTED_PRIORITY = 44; // 34 * 1.0 + 10

  it("reaches P1 and the Analyst with no partner message and nobody watching", () => {
    const incidents = buildIncidents([PFE_CLUSTER], TRACKED);
    assert.equal(incidents.length, 1);
    const incident = incidents[0];
    assert.equal(incident.user_proximity, "tracked");
    assert.deepEqual(incident.composite_tags, ["standalone_insider_cluster"]);
    assert.equal(incident.priority, EXPECTED_PRIORITY);
    assert.equal(incident.priority_band, "P1");
    assert.deepEqual(
      routeIncident(incident, CONFIG).destinations.map((d) => d.destination),
      ["analyst"],
    );
  });

  it("the notional multiplier, not headcount, is what carries it", () => {
    assert.equal(messageSeverity(PFE_CLUSTER, CONFIG).value, EXPECTED_SEVERITY);
    // The same three insiders at de minimis size stay well short.
    const thin = insiderCluster("c1", AT, {
      insider_count: 3,
      direction: "buy",
      total_notional: 180_000,
    });
    const incident = buildIncidents([thin], TRACKED)[0];
    assert.equal(messageSeverity(thin, CONFIG).value, 16); // 20 x 0.8
    assert.deepEqual(incident.composite_tags, []); // below the standalone threshold
    assert.equal(incident.priority, 26); // 16 * 1.0 + 10
    assert.equal(incident.priority_band, "P2");
  });

  it("the discovery floor holds it at P1 as freshness decays", () => {
    // A day later freshness is 0, so the raw score is just combined = 34 (P2).
    // The floor is what keeps a still-valid cluster from decaying out of reach.
    const stale = buildIncidents([PFE_CLUSTER], {
      ...TRACKED,
      now: "2026-08-23T20:15:00.000Z",
      evaluateAt: () => "2026-08-23T20:15:00.000Z",
    })[0];
    assert.equal(stale.priority, 40);
    assert.equal(stale.priority_band, "P1");
    assert.equal(stale.discovery_floor_applied, true);
  });
});

// ---------------------------------------------------------------------------
// §2 earnings_surprise end to end (multi-tag, pinned score)
// ---------------------------------------------------------------------------

describe("§2 earnings_surprise incident", () => {
  const DUE_AT = "2026-08-21T20:30:00.000Z"; // 16:30 ET, same NY day as the window start
  // severity: gap |z| 3.5 -> 25 + 0.5/1.0 * 15 = 32.5 (top driver).
  // bonus: earnings_surprise +15, event_gap +0 -> +15.
  // freshness: gap anchored on the 13:30Z open, evaluated at 13:35Z -> 10.
  const EXPECTED_PRIORITY = 58; // (32.5 + 15) * 1.0 + 10 = 57.5 -> 58

  const stream = [
    filingItem("f1", "2026-08-21T12:00:00.000Z", { item_codes: ["2.02"] }),
    scheduledEvent("s1", "2026-08-21T13:00:00.000Z", DUE_AT),
    gapEvent("g1", "2026-08-21T13:35:00.000Z", { gap_z: 3.5 }),
  ];

  it("tags, scores and routes the whole occurrence as one incident", () => {
    const incidents = buildIncidents(stream, TRACKED);
    assert.equal(incidents.length, 1);
    assert.deepEqual(incidents[0].composite_tags, ["earnings_surprise", "event_gap"]);
    assert.equal(incidents[0].priority, EXPECTED_PRIORITY);
    assert.equal(incidents[0].priority_band, "P1");
    assert.deepEqual(
      routeIncident(incidents[0], CONFIG).destinations.map((d) => d.destination),
      ["propagation", "scheduler"],
    );
  });
});

// ---------------------------------------------------------------------------
// §2 earnings absorption — the WMT case
// ---------------------------------------------------------------------------

describe("§2 earnings absorption window", () => {
  // 2026-08-20 and 2026-08-21 are consecutive trading days; each closes 20:00Z.
  // Announced after the 20:00Z close on D, so the reaction is D+1's session and
  // absorption runs to its close plus the grace: 2026-08-22T02:00Z.
  const ABSORB_UNTIL = "2026-08-22T02:00:00.000Z";
  const NOW = "2026-08-22T06:00:00.000Z";

  const amcSequence = [
    // D 16:10 ET — the release, after the close.
    filingItem("f1", "2026-08-20T20:10:00.000Z", { item_codes: ["2.02", "9.01"] }, {
      context_flags: ["earnings_window"],
      quant: { residual_zscore: -7.59 },
    }),
    // D+1 09:30 ET — the gap it caused, 17h later: past the 8h cap.
    gapEvent("g1", "2026-08-21T13:30:00.000Z", { gap_z: -7.31, direction: "down" }, {
      context_flags: ["earnings_window"],
      quant: { residual_zscore: -0.49 },
    }),
    // D+1 close batch.
    volumeAnomaly("v1", "2026-08-21T20:15:00.000Z", { volume_ratio: 3.84 }, {
      context_flags: ["earnings_window"],
      quant: { residual_zscore: -7.27 },
    }),
  ];

  it("keeps the release and the next session's reaction in one incident", () => {
    const incidents = buildIncidents(amcSequence, { ...TRACKED, now: NOW });
    assert.equal(incidents.length, 1, "the 8h cap must not split the release from its gap");
    assert.equal(incidents[0].messages.length, 3);
    assert.equal(incidents[0].earnings_absorption, true);
    assert.equal(incidents[0].window_end, ABSORB_UNTIL);
  });

  it("forms earnings_surprise without needing a scheduled_event", () => {
    // The absorbing window itself establishes "due today" — the calendar
    // channel emits almost no scheduled_event in practice.
    const incident = buildIncidents(amcSequence, { ...TRACKED, now: NOW })[0];
    assert.deepEqual(incident.composite_tags, ["earnings_surprise", "event_gap"]);
  });

  it("scores the realised reaction even though the detector was suppressed", () => {
    // No unexplained_move exists — earnings_window suppressed it — yet
    // |residual_zscore| 7.59 is past the 4.0 anchor, so severity is the 40 cap.
    const incident = buildIncidents(amcSequence, { ...TRACKED, now: NOW })[0];
    const scored = computePriority({
      messages: incident.messages,
      composite_tags: incident.composite_tags,
      user_proximity: "tracked",
      now: "2026-08-21T20:15:00.000Z",
      config: CONFIG,
    });
    assert.equal(scored.severity, 40);
    assert.equal(scored.composite_bonus, 15); // earnings_surprise +15, event_gap +0
    assert.equal(scored.combined, 55);
    assert.equal(scored.band, "P1");
  });

  it("a release announced before the open is priced by that same session", () => {
    // 2026-08-21 08:00 ET = 12:00Z, before the 13:30Z open -> absorb to that
    // day's close plus grace, not the next day's.
    const bmo = filingItem("f1", "2026-08-21T12:00:00.000Z", { item_codes: ["2.02"] });
    const incident = buildIncidents([bmo], { ...TRACKED, now: NOW })[0];
    assert.equal(incident.earnings_absorption, true);
    assert.equal(incident.window_end, "2026-08-22T02:00:00.000Z");
  });

  it("an 8-K without item 2.02 does not absorb", () => {
    const other = filingItem("f1", "2026-08-20T20:10:00.000Z", { item_codes: ["8.01"] });
    const incident = buildIncidents([other], { ...TRACKED, now: NOW })[0];
    assert.equal(incident.earnings_absorption, false);
    assert.equal(incident.window_end, "2026-08-21T04:10:00.000Z"); // 8h cap
  });

  it("absorption can be turned off entirely", () => {
    const off = mergeBaseConfig({ earnings: { ...CONFIG.earnings, enabled: false } });
    const incidents = buildIncidents(amcSequence, {
      config: off,
      makeIncidentId: seqIds,
      now: NOW,
    });
    // The cap splits the gap off the filing, then the silence timer splits the
    // close batch off the gap: three incidents where there is one occurrence.
    assert.equal(incidents.length, 3, "without absorption the timers fragment it");
    assert.ok(!incidents.some((i) => i.composite_tags.includes("earnings_surprise")));
  });
});

// ---------------------------------------------------------------------------
// B6 no-measurement incidents close at the pricing session's close + grace
// ---------------------------------------------------------------------------

describe("B6 no-measurement close rule (session anchor)", () => {
  // 2026-08-20 (Thu) and 2026-08-21 (Fri) are full trading days: 13:30Z open,
  // 20:00Z close. Grace is 60m, so the no-measurement target is 21:00Z.
  const LATE = "2026-08-22T12:00:00.000Z";

  it("1: opened 10:00 ET by news alone -> closes at close + grace (17:00 ET), not the 8h cap", () => {
    const stream = [newsItem("n1", "2026-08-21T14:00:00.000Z"), newsItem("n2", "2026-08-21T16:00:00.000Z")];
    const incident = buildIncidents(stream, { ...TRACKED, now: LATE })[0];
    assert.equal(incident.window_end, "2026-08-21T21:00:00.000Z"); // 20:00Z close + 60m
    assert.ok(incident.window_end! < "2026-08-21T22:00:00.000Z", "must beat the 14:00Z + 8h cap");
    assert.equal(windowCloseAt(incident, CONFIG), "2026-08-21T21:00:00.000Z");
  });

  it("2: a close-computed detector at 16:05 ET joins it, and it reverts to the measured rules", () => {
    const stream = [
      newsItem("n1", "2026-08-21T14:00:00.000Z"),
      unexplainedMove("u1", "2026-08-21T20:05:00.000Z"), // 16:05 ET, inside the grace
    ];
    const incidents = buildIncidents(stream, { ...TRACKED, now: LATE });
    assert.equal(incidents.length, 1, "the 16:05 detector must land in the news incident, not a new one");
    assert.equal(incidents[0].messages.length, 2);
    // Measured now: 6h silence from 20:05Z = 02:05Z vs cap 14:00Z + 8h = 22:00Z -> cap.
    assert.equal(incidents[0].window_end, "2026-08-21T22:00:00.000Z");
    assert.notEqual(incidents[0].window_end, "2026-08-21T21:00:00.000Z", "no longer the no-measurement close");
  });

  it("3: opened 18:30 ET post-market -> lives toward the NEXT session close, but the 8h cap wins (02:30 ET)", () => {
    // Thu 2026-08-20 22:30Z = 18:30 ET. Next session closes Fri 20:00Z (+60m = 21:00Z);
    // cap = 22:30Z + 8h = Fri 06:30Z = 02:30 ET, which comes first.
    const incident = buildIncidents([newsItem("n1", "2026-08-20T22:30:00.000Z")], { ...TRACKED, now: LATE })[0];
    assert.equal(incident.window_end, "2026-08-21T06:30:00.000Z");
  });

  it("3b: opened pre-market 07:00 ET -> same-session, so the cap stretches to the 17:00 ET target (B6-b)", () => {
    // 11:00Z = 07:00 ET. Target 21:00Z; nominal cap 19:00Z -> stretched to 21:00Z.
    const incident = buildIncidents([newsItem("n1", "2026-08-21T11:00:00.000Z")], { ...TRACKED, now: LATE })[0];
    assert.equal(incident.window_end, "2026-08-21T21:00:00.000Z");
  });

  it("3c: opened on a Saturday -> the next trading session prices it; cap still wins", () => {
    const incident = buildIncidents([newsItem("n1", "2026-08-22T15:00:00.000Z")], { ...TRACKED, now: "2026-08-25T12:00:00.000Z" })[0];
    assert.equal(incident.window_end, "2026-08-22T23:00:00.000Z"); // cap; Mon close + 60m is far later
  });

  it("5: measured incidents are untouched (6h silence / 8h cap) and absorption still overrides", () => {
    const measured = [unexplainedMove("u1", "2026-08-21T12:00:00.000Z")];
    assert.equal(buildIncidents(measured, { ...TRACKED, now: LATE })[0].window_end, "2026-08-21T18:00:00.000Z");
    const absorbing = [filingItem("f1", "2026-08-21T19:45:00.000Z", { item_codes: ["2.02"] })];
    assert.equal(buildIncidents(absorbing, { ...TRACKED, now: LATE })[0].window_end, "2026-08-22T02:00:00.000Z");
  });

  it("the grace is configuration", () => {
    const tight = mergeBaseConfig({ window: { ...CONFIG.window, noMeasurementCloseGraceMs: 5 * 60_000 } });
    const incident = buildIncidents([newsItem("n1", "2026-08-21T14:00:00.000Z")], { config: tight, makeIncidentId: seqIds, now: LATE })[0];
    assert.equal(incident.window_end, "2026-08-21T20:05:00.000Z");
  });
});

// ---------------------------------------------------------------------------
// B6-b no-measurement cap stretches to the same-session target
// ---------------------------------------------------------------------------

describe("B6-b no-measurement cap stretches to the session target", () => {
  const LATE = "2026-08-23T12:00:00.000Z";

  it("1: 07:00 ET news open -> not the 15:00 cap; closes at the 17:00 ET target, and the 16:44 close-run joins it", () => {
    // 11:00Z = 07:00 ET. Nominal cap 19:00Z (15:00 ET); target 21:00Z (17:00 ET).
    const alone = buildIncidents([newsItem("n1", "2026-08-21T11:00:00.000Z")], { ...TRACKED, now: LATE })[0];
    assert.equal(alone.window_end, "2026-08-21T21:00:00.000Z");

    // The live close-run in the pilot log landed 44 minutes after the bell.
    const withCloseRun = buildIncidents(
      [newsItem("n1", "2026-08-21T11:00:00.000Z"), volumeAnomaly("v1", "2026-08-21T20:44:00.000Z")],
      { ...TRACKED, now: LATE },
    );
    assert.equal(withCloseRun.length, 1, "the 16:44 detector must land in the 07:00 news incident");
    assert.equal(withCloseRun[0].messages.length, 2);
    // Measured now: the cap (19:00Z) cannot precede the 20:44Z message it
    // holds, so the 6h silence timer governs alone -> 02:44Z.
    assert.equal(withCloseRun[0].window_end, "2026-08-22T02:44:00.000Z");
  });

  it("2: 18:30 ET post-market open -> pricing session is tomorrow; cap stands, closes 02:30 ET", () => {
    const incident = buildIncidents([newsItem("n1", "2026-08-20T22:30:00.000Z")], { ...TRACKED, now: LATE })[0];
    assert.equal(incident.window_end, "2026-08-21T06:30:00.000Z");
  });

  it("3: 10:00 ET open -> target 17:00 already before the 18:00 cap; identical to B6", () => {
    const incident = buildIncidents([newsItem("n1", "2026-08-21T14:00:00.000Z")], { ...TRACKED, now: LATE })[0];
    assert.equal(incident.window_end, "2026-08-21T21:00:00.000Z");
  });

  it("measured incidents are untouched: a 07:00 open with a 09:00 measurement still caps at 15:00", () => {
    const stream = [newsItem("n1", "2026-08-21T11:00:00.000Z"), unexplainedMove("u1", "2026-08-21T13:00:00.000Z")];
    const incident = buildIncidents(stream, { ...TRACKED, now: LATE })[0];
    // min(13:00Z + 6h = 19:00Z, cap 19:00Z) = 19:00Z — the stretch never applies to a measured incident.
    assert.equal(incident.window_end, "2026-08-21T19:00:00.000Z");
  });

  it("the ceiling is the target — no second extension past it", () => {
    // News at 07:00 and again at 16:59 ET (20:59Z), still no measurement: closes at 21:00Z, not later.
    const stream = [newsItem("n1", "2026-08-21T11:00:00.000Z"), newsItem("n2", "2026-08-21T20:59:00.000Z")];
    const incidents = buildIncidents(stream, { ...TRACKED, now: LATE });
    assert.equal(incidents.length, 1);
    assert.equal(incidents[0].window_end, "2026-08-21T21:00:00.000Z");
    // And a message at exactly the target opens a new incident.
    const next = buildIncidents([...stream, newsItem("n3", "2026-08-21T21:00:00.000Z")], { ...TRACKED, now: LATE });
    assert.equal(next.length, 2);
  });
});
