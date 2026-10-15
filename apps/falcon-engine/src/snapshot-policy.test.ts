import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  SNAPSHOT_HEARTBEAT_MS,
  SNAPSHOT_MIN_INTERVAL_MS,
  SNAPSHOT_RETENTION,
  idsToDownsample,
  marketSession,
  retentionBucket,
  shouldWriteSnapshot,
  type SnapshotRowRef,
} from "./snapshot-policy.js";
import { selectSnapshotsToWrite } from "./portfolio-tracker.js";
import { runSnapshotRetention, type RetentionClient } from "./portfolio-retention.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("marketSession (America/New_York)", () => {
  it("reads the regular, extended and closed sessions, DST-aware", () => {
    // Wed 2026-10-14, EDT (UTC-4).
    assert.equal(marketSession(new Date("2026-10-14T13:29:00Z")), "extended"); // 09:29
    assert.equal(marketSession(new Date("2026-10-14T13:30:00Z")), "regular"); // 09:30
    assert.equal(marketSession(new Date("2026-10-14T19:59:00Z")), "regular"); // 15:59
    assert.equal(marketSession(new Date("2026-10-14T20:00:00Z")), "extended"); // 16:00
    assert.equal(marketSession(new Date("2026-10-15T00:00:00Z")), "closed"); // 20:00
    assert.equal(marketSession(new Date("2026-10-14T07:59:00Z")), "closed"); // 03:59
    assert.equal(marketSession(new Date("2026-10-14T08:00:00Z")), "extended"); // 04:00
    // Wed 2026-12-16, EST (UTC-5): 09:30 is 14:30Z.
    assert.equal(marketSession(new Date("2026-12-16T14:29:00Z")), "extended");
    assert.equal(marketSession(new Date("2026-12-16T14:30:00Z")), "regular");
    // Saturday midday.
    assert.equal(marketSession(new Date("2026-10-17T16:00:00Z")), "closed");
  });
});

describe("shouldWriteSnapshot — write throttle", () => {
  const t0 = Date.parse("2026-10-14T15:00:00Z");

  it("writes the first row for a user", () => {
    assert.equal(shouldWriteSnapshot(undefined, t0, 10_000, "regular"), true);
  });

  it("never writes more often than the session allows, even when the value moves", () => {
    const last = { at: t0, value: 10_000 };
    assert.equal(shouldWriteSnapshot(last, t0 + 5_000, 10_500, "regular"), false);
    assert.equal(shouldWriteSnapshot(last, t0 + SNAPSHOT_MIN_INTERVAL_MS.regular - 1, 10_500, "regular"), false);
    assert.equal(shouldWriteSnapshot(last, t0 + SNAPSHOT_MIN_INTERVAL_MS.regular, 10_500, "regular"), true);
    assert.equal(shouldWriteSnapshot(last, t0 + 4 * MIN, 10_500, "extended"), false);
    assert.equal(shouldWriteSnapshot(last, t0 + 5 * MIN, 10_500, "extended"), true);
    assert.equal(shouldWriteSnapshot(last, t0 + 59 * MIN, 10_500, "closed"), false);
    assert.equal(shouldWriteSnapshot(last, t0 + HOUR, 10_500, "closed"), true);
  });

  it("skips a value that has not moved meaningfully, until the heartbeat", () => {
    const last = { at: t0, value: 10_000 };
    // 0.5bp of 10,000 is 0.50.
    assert.equal(shouldWriteSnapshot(last, t0 + 2 * MIN, 10_000.2, "regular"), false);
    assert.equal(shouldWriteSnapshot(last, t0 + 2 * MIN, 10_000.5, "regular"), true);
    assert.equal(shouldWriteSnapshot(last, t0 + SNAPSHOT_HEARTBEAT_MS - 1, 10_000, "regular"), false);
    assert.equal(shouldWriteSnapshot(last, t0 + SNAPSHOT_HEARTBEAT_MS, 10_000, "regular"), true);
    // A cent is the floor on a tiny book.
    assert.equal(shouldWriteSnapshot({ at: t0, value: 5 }, t0 + 2 * MIN, 5.005, "regular"), false);
    assert.equal(shouldWriteSnapshot({ at: t0, value: 5 }, t0 + 2 * MIN, 5.01, "regular"), true);
  });

  it("refuses a non-finite value", () => {
    assert.equal(shouldWriteSnapshot(undefined, t0, Number.NaN, "regular"), false);
  });

  it("caps a full regular session at one row per minute per user (was one per 5s)", () => {
    // Simulate the tracker ticking every 5s through 09:30–16:00 with a value that moves every tick.
    const open = Date.parse("2026-10-14T13:30:00Z");
    const close = Date.parse("2026-10-14T20:00:00Z");
    const last = new Map<string, { at: number; value: number }>();
    let rows = 0;
    let value = 10_000;
    for (let t = open; t < close; t += 5_000) {
      value += 1;
      const picked = selectSnapshotsToWrite([{ user_id: "u", value }], t, last);
      for (const s of picked) last.set(s.user_id, { at: t, value: s.value });
      rows += picked.length;
    }
    assert.equal(rows, 390);
  });

  it("an idle weekend costs one heartbeat row per hour", () => {
    const start = Date.parse("2026-10-17T04:00:00Z"); // Sat 00:00 ET
    const last = new Map<string, { at: number; value: number }>();
    let rows = 0;
    for (let t = start; t < start + DAY; t += 15_000) {
      const picked = selectSnapshotsToWrite([{ user_id: "u", value: 10_000 }], t, last);
      for (const s of picked) last.set(s.user_id, { at: t, value: s.value });
      rows += picked.length;
    }
    assert.equal(rows, 24);
  });
});

describe("downsampling", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const at = (ms: number) => new Date(now - ms).toISOString();

  it("buckets by age: kept as-is, per minute, per hour, per day", () => {
    assert.equal(retentionBucket(now - 2 * HOUR, now), null);
    assert.equal(retentionBucket(now - SNAPSHOT_RETENTION.minuteAfterMs, now)?.[0], "m");
    assert.equal(retentionBucket(now - SNAPSHOT_RETENTION.hourAfterMs, now)?.[0], "h");
    assert.equal(retentionBucket(now - SNAPSHOT_RETENTION.dayAfterMs, now)?.[0], "d");
  });

  it("keeps the last row of each bucket and nothing young is touched", () => {
    const rows: SnapshotRowRef[] = [
      // Three rows in one UTC day, 100 days ago → keep only id 3.
      { id: 1, ts: "2026-07-07T10:00:00.000Z" },
      { id: 2, ts: "2026-07-07T14:00:00.000Z" },
      { id: 3, ts: "2026-07-07T20:00:00.000Z" },
      // Two rows in one hour, 10 days ago → keep id 5.
      { id: 4, ts: "2026-10-05T09:05:00.000Z" },
      { id: 5, ts: "2026-10-05T09:55:00.000Z" },
      // Next hour: alone, kept.
      { id: 6, ts: "2026-10-05T10:01:00.000Z" },
      // 5s apart, 2 days ago, same minute → keep id 8.
      { id: 7, ts: "2026-10-13T12:00:05.000Z" },
      { id: 8, ts: "2026-10-13T12:00:10.000Z" },
      // Young: every row survives.
      { id: 9, ts: at(10 * MIN) },
      { id: 10, ts: at(10 * MIN - 5_000) },
    ];
    assert.deepEqual(idsToDownsample(rows, now), [1, 2, 4, 7]);
    const kept = rows.filter((r) => ![1, 2, 4, 7].includes(r.id));
    assert.deepEqual(idsToDownsample(kept, now), [], "second pass must delete nothing");
  });

  function fakeTable(rows: Array<{ id: number; user_id: string; ts: string }>): RetentionClient & { rows: typeof rows; deletes: number } {
    const table = {
      rows: [...rows],
      deletes: 0,
      async nextUser(after: string | null, before: string) {
        const ids = [...new Set(table.rows.filter((r) => r.ts < before && (after === null || r.user_id > after)).map((r) => r.user_id))].sort();
        return ids[0] ?? null;
      },
      async page(userId: string, before: string, cursor: SnapshotRowRef | null, limit: number) {
        return table.rows
          .filter((r) => r.user_id === userId && r.ts < before)
          .filter((r) => !cursor || r.ts > cursor.ts || (r.ts === cursor.ts && r.id > cursor.id))
          .sort((a, b) => a.ts.localeCompare(b.ts) || a.id - b.id)
          .slice(0, limit)
          .map((r) => ({ id: r.id, ts: r.ts }));
      },
      async remove(userId: string, ids: number[]) {
        table.deletes += 1;
        const doomed = new Set(ids);
        table.rows = table.rows.filter((r) => !(r.user_id === userId && doomed.has(r.id)));
      },
    };
    return table;
  }

  // Legacy density: one row per 5s for 3 hours, 10 days ago, for two users.
  function legacy(): Array<{ id: number; user_id: string; ts: string }> {
    const out: Array<{ id: number; user_id: string; ts: string }> = [];
    let id = 0;
    const start = Date.parse("2026-10-05T09:00:00Z");
    for (const user of ["aaaaaaaa-0000-4000-8000-000000000000", "bbbbbbbb-0000-4000-8000-000000000000"]) {
      for (let t = start; t < start + 3 * HOUR; t += 5_000) out.push({ id: ++id, user_id: user, ts: new Date(t).toISOString() });
    }
    // A young row that must survive.
    out.push({ id: ++id, user_id: "aaaaaaaa-0000-4000-8000-000000000000", ts: at(5 * MIN) });
    return out;
  }

  it("thins old rows to one per hour per user across pages, in small batches, idempotently", async () => {
    const table = fakeTable(legacy());
    const first = await runSnapshotRetention(table, { now, pageSize: 250, batch: 50, pauseMs: 0 });
    assert.equal(first.users, 2);
    assert.equal(first.capped, false);
    // 3 hours × 2 users → 6 rows, plus the young one.
    assert.equal(table.rows.length, 7);
    assert.equal(first.deleted, 2 * (3 * 720 - 3));
    // Each kept row is the last of its hour.
    const kept = table.rows.filter((r) => r.ts.startsWith("2026-10-05")).map((r) => r.ts.slice(11, 19));
    assert.deepEqual(kept.sort(), ["09:59:55", "09:59:55", "10:59:55", "10:59:55", "11:59:55", "11:59:55"]);
    assert.ok(table.deletes >= first.deleted / 50);

    const second = await runSnapshotRetention(table, { now, pageSize: 250, batch: 50, pauseMs: 0 });
    assert.equal(second.deleted, 0);
    assert.equal(table.rows.length, 7);
  });

  it("stops at the per-run cap and finishes on the next run without over-deleting", async () => {
    const table = fakeTable(legacy());
    const capped = await runSnapshotRetention(table, { now, pageSize: 300, batch: 40, pauseMs: 0, maxDeletes: 1_000 });
    assert.equal(capped.capped, true);
    assert.equal(capped.deleted, 1_000);
    const rest = await runSnapshotRetention(table, { now, pageSize: 300, batch: 40, pauseMs: 0 });
    assert.equal(rest.capped, false);
    assert.equal(table.rows.length, 7);
  });
});
