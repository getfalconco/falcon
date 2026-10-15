import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  applyNotificationPatch,
  isQuietTime,
  normalizeNotificationSettings,
  shouldNotify,
} from "../../shared/notification-settings";
import type { PropagationRunListItem } from "../../shared/propagation-run-types";
import {
  notificationSettingsFile,
  readNotificationSettings,
  writeNotificationSettings,
} from "./notification-settings-store";
import { describeSignalRuns, takeNewSignalRuns } from "./signal-runs";

const at = (h: number, m = 0) => new Date(2026, 9, 10, h, m);

describe("normalizeNotificationSettings", () => {
  it("falls back field by field", () => {
    assert.deepEqual(normalizeNotificationSettings(null), DEFAULT_NOTIFICATION_SETTINGS);
    const s = normalizeNotificationSettings({
      enabled: false,
      categories: { agents: false, appUpdates: "yes", marketEvents: false },
      quietHours: { enabled: true, start: "25:00", end: "06:30" },
    });
    assert.equal(s.enabled, false);
    assert.equal(s.categories.agents, false);
    assert.equal(s.categories.appUpdates, true);
    // Only agents can be switched off; a stored "off" for another reads as on.
    assert.equal(s.categories.marketEvents, true);
    assert.equal(s.categories.secondOrderSignals, true);
    assert.deepEqual(s.quietHours, { enabled: true, start: "22:00", end: "06:30" });
  });

  it("lays a patch over the current settings without dropping siblings", () => {
    const s = applyNotificationPatch(DEFAULT_NOTIFICATION_SETTINGS, {
      categories: { agents: false },
      quietHours: { start: "23:15" },
    });
    assert.equal(s.categories.agents, false);
    assert.equal(s.categories.secondOrderSignals, true);
    assert.deepEqual(s.quietHours, { enabled: false, start: "23:15", end: "07:00" });
  });
});

describe("quiet hours", () => {
  const quiet = (start: string, end: string) => ({ enabled: true, start, end });

  it("wraps past midnight", () => {
    assert.equal(isQuietTime(quiet("22:00", "07:00"), at(23)), true);
    assert.equal(isQuietTime(quiet("22:00", "07:00"), at(3)), true);
    assert.equal(isQuietTime(quiet("22:00", "07:00"), at(7)), false);
    assert.equal(isQuietTime(quiet("22:00", "07:00"), at(12)), false);
  });

  it("handles a same-day window, an empty one and the off switch", () => {
    assert.equal(isQuietTime(quiet("12:00", "13:30"), at(13, 29)), true);
    assert.equal(isQuietTime(quiet("12:00", "13:30"), at(13, 30)), false);
    assert.equal(isQuietTime(quiet("09:00", "09:00"), at(9)), false);
    assert.equal(isQuietTime({ enabled: false, start: "00:00", end: "23:59" }, at(12)), false);
  });

  it("gates on the master switch, the category and quiet hours", () => {
    const base = DEFAULT_NOTIFICATION_SETTINGS;
    assert.equal(shouldNotify(base, "marketEvents", at(12)), true);
    assert.equal(shouldNotify({ ...base, enabled: false }, "marketEvents", at(12)), false);
    assert.equal(
      shouldNotify(applyNotificationPatch(base, { categories: { agents: false } }), "agents", at(12)),
      false,
    );
    assert.equal(shouldNotify(applyNotificationPatch(base, { quietHours: { enabled: true } }), "appUpdates", at(23)), false);
  });
});

describe("notification settings store", () => {
  it("reads defaults, writes patches and survives a corrupt file", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-notify-"));
    assert.deepEqual(readNotificationSettings(root), DEFAULT_NOTIFICATION_SETTINGS);
    writeNotificationSettings(root, { enabled: false });
    writeNotificationSettings(root, { categories: { agents: false } });
    const s = readNotificationSettings(root);
    assert.equal(s.enabled, false);
    assert.equal(s.categories.agents, false);
    fs.writeFileSync(notificationSettingsFile(root), "{not json");
    assert.deepEqual(readNotificationSettings(root), DEFAULT_NOTIFICATION_SETTINGS);
  });
});

function run(over: Partial<PropagationRunListItem> & { incident_id: string }): PropagationRunListItem {
  return {
    run_id: `run-${over.incident_id}`,
    root_ticker: "NVDA",
    event_label: "Export curbs widened",
    event_type: "regulatory",
    event_direction: "negative",
    event_materiality: "high",
    produced_at: "2026-10-10T12:00:00.000Z",
    event_ts: "2026-10-10T11:50:00.000Z",
    status: "ok",
    summary: { targets: 3, open: 2, partial: 0, priced: 1, contradicted: 0, stale: 0, untracked: 0, vetoed: 0, no_edge: false },
    superseded: false,
    update: false,
    stage2_state: "ok",
    synthetic: false,
    ...over,
  };
}

describe("second-order signal selection", () => {
  it("fires once per incident, only for runs with an open name", () => {
    const seen = new Set<string>();
    assert.equal(takeNewSignalRuns(seen, [run({ incident_id: "a" })]).length, 1);
    // A re-run of the same incident stays quiet.
    assert.equal(takeNewSignalRuns(seen, [run({ incident_id: "a", run_id: "run-a2" })]).length, 0);
    const skipped = takeNewSignalRuns(seen, [
      run({ incident_id: "b", synthetic: true }),
      run({ incident_id: "c", status: "failed" }),
      run({ incident_id: "d", superseded: true }),
      run({ incident_id: "e", summary: { ...run({ incident_id: "x" }).summary, open: 0 } }),
    ]);
    assert.equal(skipped.length, 0);
    // Seen while not worth a notification is still seen.
    assert.equal(takeNewSignalRuns(seen, [run({ incident_id: "e" })]).length, 0);
  });

  it("describes one run or a batch", () => {
    const one = describeSignalRuns([run({ incident_id: "a" })]);
    assert.equal(one.title, "Second-order effect: NVDA");
    assert.match(one.body, /Export curbs widened/);
    assert.match(one.body, /2 names not priced in/);
    const many = describeSignalRuns(["a", "b", "c", "d"].map((id) => run({ incident_id: id })));
    assert.equal(many.title, "4 new second-order effects");
    assert.match(many.body, /\+1 more$/);
  });
});
