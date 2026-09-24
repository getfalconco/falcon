import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addCalendarDays,
  isTradingDay,
  nyParts,
  nyWallTimeToUtc,
  nyYmd,
  sessionTimes,
} from "../tracker/calendar.js";
import type { SessionOverride } from "./types.js";
import { resolveSessionWindow } from "./window.js";

/** A New York wall-clock moment as a UTC instant, via the calendar's own DST-aware converter. */
const et = (ymd: string, hh: number, mm: number): Date => nyWallTimeToUtc(ymd, hh, mm);
const iso = (ymd: string, hh: number, mm: number): string => et(ymd, hh, mm).toISOString();

describe("resolveSessionWindow: DST boundaries", () => {
  it("spring forward: Sunday 2026-03-08 evening opens the Monday 03-09 window at 20:00 New York time", () => {
    const w = resolveSessionWindow(et("2026-03-08", 21, 0));
    assert.equal(w.target_session_ymd, "2026-03-09");
    assert.equal(w.prev_session_ymd, "2026-03-06");

    const opens = new Date(w.window_opens_at);
    const p = nyParts(opens);
    assert.equal(nyYmd(opens), "2026-03-08");
    assert.deepEqual([p.hh, p.mm, p.ss], [20, 0, 0]);
    // Clocks moved at 02:00 that morning, so 20:00 is already EDT (UTC-4)...
    assert.equal(w.window_opens_at, "2026-03-09T00:00:00.000Z");
    // ...while Friday's close was still EST (UTC-5).
    assert.equal(w.overnight_since, "2026-03-06T21:00:00.000Z");
    assert.equal(w.target_open_at, "2026-03-09T13:30:00.000Z");
    assert.equal(w.phase, "pre_open");
    assert.equal(w.gap, "weekend");
  });

  it("fall back: Sunday 2026-11-01 evening opens the Monday 11-02 window at 20:00 New York time", () => {
    const w = resolveSessionWindow(et("2026-11-01", 21, 0));
    assert.equal(w.target_session_ymd, "2026-11-02");
    assert.equal(w.prev_session_ymd, "2026-10-30");

    const opens = new Date(w.window_opens_at);
    const p = nyParts(opens);
    assert.equal(nyYmd(opens), "2026-11-01");
    assert.deepEqual([p.hh, p.mm, p.ss], [20, 0, 0]);
    // Back on EST (UTC-5) since 02:00 that morning; Friday's close was EDT (UTC-4).
    assert.equal(w.window_opens_at, "2026-11-02T01:00:00.000Z");
    assert.equal(w.overnight_since, "2026-10-30T20:00:00.000Z");
    assert.equal(w.target_open_at, "2026-11-02T14:30:00.000Z");
    assert.equal(w.phase, "pre_open");
  });

  it("the repeated 01:30 hour on 2026-11-01 resolves to the same Monday window both times", () => {
    const first = et("2026-11-01", 1, 30);
    const second = new Date(first.getTime() + 60 * 60_000);
    for (const now of [first, second]) {
      const w = resolveSessionWindow(now);
      assert.equal(w.target_session_ymd, "2026-11-02");
      assert.equal(w.phase, "between_sessions");
    }
  });
});

describe("resolveSessionWindow: weekends", () => {
  it("Saturday noon: the target is Monday, between sessions", () => {
    const w = resolveSessionWindow(et("2026-09-19", 12, 0));
    assert.equal(w.target_session_ymd, "2026-09-21");
    assert.equal(w.prev_session_ymd, "2026-09-18");
    assert.equal(w.phase, "between_sessions");
    assert.equal(w.gap, "weekend");
    assert.equal(w.overnight_since, sessionTimes("2026-09-18")!.closeUtc.toISOString());
    assert.equal(w.window_opens_at, iso("2026-09-20", 20, 0));
  });

  it("Sunday 19:59 ET is still between sessions; 20:00 ET opens the window", () => {
    const before = resolveSessionWindow(et("2026-09-20", 19, 59));
    assert.equal(before.target_session_ymd, "2026-09-21");
    assert.equal(before.phase, "between_sessions");

    const at = resolveSessionWindow(et("2026-09-20", 20, 0));
    assert.equal(at.target_session_ymd, "2026-09-21");
    assert.equal(at.phase, "pre_open");
  });

  it("Monday 03:30 ET: pre-open, weekend gap", () => {
    const w = resolveSessionWindow(et("2026-09-21", 3, 30));
    assert.equal(w.target_session_ymd, "2026-09-21");
    assert.equal(w.prev_session_ymd, "2026-09-18");
    assert.equal(w.phase, "pre_open");
    assert.equal(w.gap, "weekend");
  });
});

describe("resolveSessionWindow: holidays and early closes", () => {
  it("Labor Day 2026-09-07 morning: target Tuesday, between sessions, holiday gap", () => {
    const w = resolveSessionWindow(et("2026-09-07", 8, 0));
    assert.equal(w.target_session_ymd, "2026-09-08");
    assert.equal(w.prev_session_ymd, "2026-09-04");
    assert.equal(w.gap, "holiday");
    assert.equal(w.phase, "between_sessions");
    assert.equal(w.window_opens_at, iso("2026-09-07", 20, 0));
  });

  it("Labor Day 2026-09-07 evening: same target, now pre-open", () => {
    const w = resolveSessionWindow(et("2026-09-07", 21, 0));
    assert.equal(w.target_session_ymd, "2026-09-08");
    assert.equal(w.prev_session_ymd, "2026-09-04");
    assert.equal(w.gap, "holiday");
    assert.equal(w.phase, "pre_open");
    assert.equal(w.overnight_since, sessionTimes("2026-09-04")!.closeUtc.toISOString());
  });

  it("Thanksgiving 2026-11-26: the target is the early-close Friday", () => {
    const w = resolveSessionWindow(et("2026-11-26", 10, 0));
    assert.equal(w.target_session_ymd, "2026-11-27");
    assert.equal(w.prev_session_ymd, "2026-11-25");
    assert.equal(w.gap, "holiday");
    assert.equal(w.early_close, true);
    assert.equal(w.target_close_at, iso("2026-11-27", 13, 0));
    assert.equal(w.phase, "between_sessions");

    const evening = resolveSessionWindow(et("2026-11-26", 20, 0));
    assert.equal(evening.phase, "pre_open");
    assert.equal(evening.window_opens_at, iso("2026-11-26", 20, 0));
  });

  it("early-close Friday 2026-11-27: in session until 13:00 ET, then Monday with overnight starting at 13:00", () => {
    const during = resolveSessionWindow(et("2026-11-27", 12, 59));
    assert.equal(during.target_session_ymd, "2026-11-27");
    assert.equal(during.phase, "in_session");
    assert.equal(during.early_close, true);
    assert.equal(during.target_close_at, iso("2026-11-27", 13, 0));

    const after = resolveSessionWindow(et("2026-11-27", 13, 0));
    assert.equal(after.target_session_ymd, "2026-11-30");
    assert.equal(after.prev_session_ymd, "2026-11-27");
    assert.equal(after.overnight_since, iso("2026-11-27", 13, 0));
    assert.equal(after.early_close, false);
    assert.equal(after.gap, "weekend");
    assert.equal(after.phase, "between_sessions");
  });

  it("a Friday holiday joined to the weekend reads as a holiday gap, not a weekend", () => {
    // Juneteenth 2026 is a Friday: Thursday close to Monday open spans the holiday and the weekend.
    const w = resolveSessionWindow(et("2026-06-20", 12, 0));
    assert.equal(w.target_session_ymd, "2026-06-22");
    assert.equal(w.prev_session_ymd, "2026-06-18");
    assert.equal(w.gap, "holiday");
  });
});

describe("resolveSessionWindow: inside a trading day", () => {
  it("00:30 ET: the window opened the evening before, target is today", () => {
    const w = resolveSessionWindow(et("2026-09-22", 0, 30));
    assert.equal(w.target_session_ymd, "2026-09-22");
    assert.equal(w.prev_session_ymd, "2026-09-21");
    assert.equal(w.window_opens_at, iso("2026-09-21", 20, 0));
    assert.equal(w.phase, "pre_open");
    assert.equal(w.gap, "overnight");
    assert.equal(w.early_close, false);
  });

  it("09:29 ET is pre-open; 09:30 ET is in session", () => {
    const before = resolveSessionWindow(et("2026-09-22", 9, 29));
    assert.equal(before.phase, "pre_open");

    const at = resolveSessionWindow(et("2026-09-22", 9, 30));
    assert.equal(at.target_session_ymd, "2026-09-22");
    assert.equal(at.phase, "in_session");
    assert.equal(at.target_open_at, iso("2026-09-22", 9, 30));
    assert.equal(at.target_close_at, iso("2026-09-22", 16, 0));
  });

  it("the close flips the target: 15:59 ET is today, 16:00 ET is the next session", () => {
    const before = resolveSessionWindow(et("2026-09-22", 15, 59));
    assert.equal(before.target_session_ymd, "2026-09-22");
    assert.equal(before.phase, "in_session");

    const at = resolveSessionWindow(et("2026-09-22", 16, 0));
    assert.equal(at.target_session_ymd, "2026-09-23");
    assert.equal(at.phase, "between_sessions");
  });

  it("17:00 ET: between sessions, the target is the next trading day", () => {
    const w = resolveSessionWindow(et("2026-09-22", 17, 0));
    assert.equal(w.target_session_ymd, "2026-09-23");
    assert.equal(w.prev_session_ymd, "2026-09-22");
    assert.equal(w.overnight_since, iso("2026-09-22", 16, 0));
    assert.equal(w.phase, "between_sessions");
    assert.equal(w.gap, "overnight");
  });

  it("Friday 17:00 ET targets Monday across the weekend", () => {
    const w = resolveSessionWindow(et("2026-09-18", 17, 0));
    assert.equal(w.target_session_ymd, "2026-09-21");
    assert.equal(w.prev_session_ymd, "2026-09-18");
    assert.equal(w.gap, "weekend");
    assert.equal(w.window_opens_at, iso("2026-09-20", 20, 0));
  });
});

describe("resolveSessionWindow: invariants", () => {
  it("hold for every half hour across both DST changes, Thanksgiving and the year end", () => {
    const ranges: Array<[string, string]> = [
      ["2026-03-05", "2026-03-11"],
      ["2026-06-17", "2026-06-23"],
      ["2026-10-29", "2026-11-04"],
      ["2026-11-24", "2026-12-01"],
      ["2026-12-23", "2027-01-05"],
    ];
    for (const [from, to] of ranges) {
      const end = et(to, 0, 0).getTime();
      for (let ms = et(from, 0, 0).getTime(); ms < end; ms += 30 * 60_000) {
        const now = new Date(ms);
        const w = resolveSessionWindow(now);
        const label = `${now.toISOString()} -> ${w.target_session_ymd}`;

        assert.ok(isTradingDay(w.target_session_ymd), label);
        assert.ok(isTradingDay(w.prev_session_ymd), label);
        assert.ok(w.prev_session_ymd < w.target_session_ymd, label);
        assert.ok(w.overnight_since < w.window_opens_at, label);
        assert.ok(w.window_opens_at < w.target_open_at, label);
        assert.ok(w.target_open_at < w.target_close_at, label);
        // The calendar never lists a session that is already over, and
        // "overnight" never starts in the future.
        assert.ok(now.toISOString() < w.target_close_at, label);
        assert.ok(w.overnight_since <= now.toISOString(), label);
        assert.equal(nyYmd(new Date(w.window_opens_at)), addCalendarDays(w.target_session_ymd, -1), label);
        assert.equal(nyParts(new Date(w.window_opens_at)).hh, 20, label);
      }
    }
  });

  it("rejects an invalid clock instead of resolving a window from it", () => {
    assert.throws(() => resolveSessionWindow(new Date(Number.NaN)), RangeError);
  });
});

describe("resolveSessionWindow: ad-hoc session overrides", () => {
  const override = (date: string, early_close: boolean): SessionOverride[] => [{ date, early_close, note: "Ad-hoc", source: "nyse" }];

  it("rolls the target forward once an added early close has passed", () => {
    const at = et("2026-09-21", 14, 30);
    const plain = resolveSessionWindow(at);
    assert.equal(plain.target_session_ymd, "2026-09-21");
    assert.equal(plain.phase, "in_session");

    const w = resolveSessionWindow(at, override("2026-09-21", true));
    assert.equal(w.target_session_ymd, "2026-09-22");
    assert.equal(w.prev_session_ymd, "2026-09-21");
    assert.equal(w.overnight_since, iso("2026-09-21", 13, 0));
    assert.equal(w.phase, "between_sessions");
    assert.equal(w.early_close, false);

    // Before that close the calendar is still on the session itself.
    const earlier = resolveSessionWindow(et("2026-09-21", 11, 0), override("2026-09-21", true));
    assert.equal(earlier.target_session_ymd, "2026-09-21");
    assert.equal(earlier.phase, "in_session");
    assert.equal(earlier.early_close, true);
    assert.equal(earlier.target_close_at, iso("2026-09-21", 13, 0));
  });

  it("keeps the target on a still-trading session when a wrongly derived early close is cleared", () => {
    // 2026-11-27 closes at 13:00 ET by the rules, so by 14:30 the algorithmic
    // window has already moved on to the next session.
    const at = et("2026-11-27", 14, 30);
    assert.equal(resolveSessionWindow(at).target_session_ymd, "2026-11-30");

    const w = resolveSessionWindow(at, override("2026-11-27", false));
    assert.equal(w.target_session_ymd, "2026-11-27");
    assert.equal(w.early_close, false);
    assert.equal(w.target_close_at, iso("2026-11-27", 16, 0));
    assert.equal(w.phase, "in_session");
    // The previous close is the real one, never an instant still ahead.
    assert.equal(w.overnight_since, iso("2026-11-25", 16, 0));
  });

  it("ignores a row that is not one, and one for a day it does not touch", () => {
    const at = et("2026-09-21", 14, 30);
    const plain = resolveSessionWindow(at);
    const junk = [null, { date: "2026-09-21" }, { early_close: true }, { date: 7, early_close: true }] as unknown as SessionOverride[];
    assert.deepEqual(resolveSessionWindow(at, junk), plain);
    assert.deepEqual(resolveSessionWindow(at, override("2026-09-14", true)), plain);
    assert.deepEqual(resolveSessionWindow(at, undefined), plain);
  });
});
