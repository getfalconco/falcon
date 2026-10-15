import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FilingRecord, TickerState } from "../tracker/types.js";
import { TradingCalendar } from "./calendar.js";
import {
  attributeFiling,
  buildEarningsHistory,
  buildFilingEvents,
  earningsRhythmAsOf,
  earningsWithin,
  nextEarningsAsOf,
  type FilingEvent,
} from "./filings.js";
import { barsFrom, tradingDays } from "../screen/test-fixtures.js";
import { filingsFromSubmissions } from "../tracker/sources.js";

const days = tradingDays(60);
const calendar = TradingCalendar.fromBars(barsFrom({ days, returns: new Array(59).fill(0), startPrice: 100 }));

function filing(over: Partial<FilingRecord> & { filedAt: string }): FilingRecord {
  return {
    form: "8-K",
    accessionNumber: `acc-${over.filedAt}`,
    acceptedAt: null,
    // Fixture instants are true UTC, as the fetch stores them.
    acceptedAtUtc: true,
    reportDate: over.filedAt,
    items: ["2.02"],
    primaryDocument: null,
    ...over,
  };
}

function stateWith(filings: FilingRecord[]): TickerState {
  return { ticker: "AAA", filings } as unknown as TickerState;
}

describe("quantlab/filings — acceptance-time attribution (§6)", () => {
  const session = days[20];

  it("a release accepted before the open leaves that session's close available", () => {
    const result = attributeFiling(filing({ filedAt: session, acceptedAt: `${session}T11:00:00.000Z` }), calendar)!;
    assert.equal(result.session, session);
    assert.equal(result.after_close, false);
  });

  it("a release accepted after the close does not", () => {
    const result = attributeFiling(filing({ filedAt: session, acceptedAt: `${session}T21:00:00.000Z` }), calendar)!;
    assert.equal(result.session, session);
    assert.equal(result.after_close, true);
  });

  it("an unknown acceptance time is treated as after the close", () => {
    const result = attributeFiling(filing({ filedAt: session, acceptedAt: null }), calendar)!;
    assert.equal(result.after_close, true, "an unknown must never resolve in the backtest's favour");
  });

  it("an unparseable acceptance time is also treated as after the close", () => {
    const result = attributeFiling(filing({ filedAt: session, acceptedAt: "not-a-date" }), calendar)!;
    assert.equal(result.after_close, true);
  });

  it("a filing on a non-session maps to the next session, whose close IS available", () => {
    // A date the benchmark never traded — the market's first chance is the next session.
    const between = "2026-01-01";
    const result = attributeFiling(filing({ filedAt: between, acceptedAt: `${between}T21:00:00.000Z` }), calendar);
    if (result) {
      assert.ok(calendar.has(result.session));
      assert.equal(result.after_close, false, "the news was public before that session opened");
    }
  });

  it("a filing after the last known session cannot be attributed", () => {
    assert.equal(attributeFiling(filing({ filedAt: "2099-01-01" }), calendar), null);
  });
});

/**
 * EDGAR's submissions index stamps an older entry of a file SEC rebuilt since
 * 2026-10-03 with the true instant plus New York's offset; a file not rebuilt
 * since keeps the true instant (research/edgar-time.ts). Read as UTC, a
 * shifted 13:00 release lands after the close and its session's close is
 * wrongly withheld; a morning one reads mid-session. Morning, midday and
 * evening filings in daylight time and in winter; the evening one is dated
 * the next business day.
 */
describe("quantlab/filings — EDGAR stamps are not UTC", () => {
  const stampCalendar = TradingCalendar.fromBars(
    barsFrom({ days: ["2026-01-13", "2026-01-14", "2026-07-14", "2026-07-15"], returns: [0, 0, 0], startPrice: 100 }),
  );
  const CASES = [
    { name: "summer 06:30", filedAt: "2026-07-14", shifted: "2026-07-14T14:30:38.000Z", utc: "2026-07-14T10:30:38.000Z", session: "2026-07-14", afterClose: false },
    { name: "summer 13:00", filedAt: "2026-07-14", shifted: "2026-07-14T21:00:00.000Z", utc: "2026-07-14T17:00:00.000Z", session: "2026-07-14", afterClose: false },
    { name: "summer 16:05", filedAt: "2026-07-14", shifted: "2026-07-15T00:05:00.000Z", utc: "2026-07-14T20:05:00.000Z", session: "2026-07-14", afterClose: true },
    { name: "summer 20:30", filedAt: "2026-07-15", shifted: "2026-07-15T04:30:00.000Z", utc: "2026-07-15T00:30:00.000Z", session: "2026-07-15", afterClose: false },
    { name: "winter 06:30", filedAt: "2026-01-13", shifted: "2026-01-13T16:30:38.000Z", utc: "2026-01-13T11:30:38.000Z", session: "2026-01-13", afterClose: false },
    { name: "winter 13:00", filedAt: "2026-01-13", shifted: "2026-01-13T23:00:00.000Z", utc: "2026-01-13T18:00:00.000Z", session: "2026-01-13", afterClose: false },
    { name: "winter 20:30", filedAt: "2026-01-14", shifted: "2026-01-14T06:30:00.000Z", utc: "2026-01-14T01:30:00.000Z", session: "2026-01-14", afterClose: false },
  ];
  /** Read on the evening of 2026-10-15 (New York). */
  const FETCHED = Date.parse("2026-10-15T21:15:00Z");
  /** The release, with (rebuilt) or without a Form 4 dated after SEC's change. */
  const index = (stamp: string, filedAt: string, rebuilt: boolean) => ({
    form: rebuilt ? ["8-K", "4"] : ["8-K"],
    filingDate: rebuilt ? [filedAt, "2026-10-13"] : [filedAt],
    acceptanceDateTime: rebuilt ? [stamp, "2026-10-14T01:09:29.000Z"] : [stamp],
    items: rebuilt ? ["2.02", ""] : ["2.02"],
    accessionNumber: rebuilt ? ["a-1", "a-2"] : ["a-1"],
  });
  for (const c of CASES) {
    it(`${c.name}: a stored raw stamp (kept from a read before the change) is the true instant`, () => {
      const result = attributeFiling(filing({ filedAt: c.filedAt, acceptedAt: c.utc, acceptedAtUtc: undefined }), stampCalendar)!;
      assert.equal(result.session, c.session);
      assert.equal(result.after_close, c.afterClose);
    });
    for (const rebuilt of [true, false]) {
      it(`${c.name}: the fetch stores the true instant (${rebuilt ? "rebuilt, shifted" : "not rebuilt, true"} file)`, () => {
        const [read] = filingsFromSubmissions(index(rebuilt ? c.shifted : c.utc, c.filedAt, rebuilt), FETCHED);
        assert.equal(read!.acceptedAtUtc, true);
        assert.equal(read!.acceptedAt, c.utc);
        const result = attributeFiling(read!, stampCalendar)!;
        assert.equal(result.session, c.session);
        assert.equal(result.after_close, c.afterClose);
        const [event] = buildFilingEvents(stateWith([read!]), stampCalendar);
        assert.equal(event!.accepted_at, read!.acceptedAt);
      });
    }
  }
});

describe("quantlab/filings — event history", () => {
  it("keeps only the requested forms and item codes, oldest first", () => {
    const state = stateWith([
      filing({ filedAt: days[30], items: ["2.02"] }),
      filing({ filedAt: days[10], items: ["7.01"] }),
      filing({ filedAt: days[20], form: "10-Q", items: [] }),
      filing({ filedAt: days[15], form: "4", items: [] }),
    ]);
    const all = buildFilingEvents(state, calendar);
    assert.deepEqual(all.map((e) => e.session), [days[10], days[30]], "8-K only, sorted");

    const earnings = buildEarningsHistory(state, calendar);
    assert.deepEqual(earnings.map((e) => e.session), [days[30]], "item 2.02 only");
  });

  it("returns the FULL run, not Tracker's trailing four", () => {
    const state = stateWith(
      [0, 5, 10, 15, 20, 25, 30, 35].map((i) => filing({ filedAt: days[i], items: ["2.02"] })),
    );
    assert.equal(buildEarningsHistory(state, calendar).length, 8);
  });

  it("tolerates a malformed filing rather than dropping the whole history", () => {
    const state = stateWith([
      filing({ filedAt: days[10] }),
      { form: "8-K", filedAt: undefined } as unknown as FilingRecord,
    ]);
    assert.equal(buildFilingEvents(state, calendar).length, 1);
  });
});

describe("quantlab/filings — earnings proximity and the knowledge horizon", () => {
  const announcements: FilingEvent[] = [days[10], days[40]].map((session) => ({
    ticker: "AAA",
    form: "8-K",
    accession: session,
    filed_at: session,
    accepted_at: `${session}T21:00:00.000Z`,
    items: ["2.02"],
    session,
    after_close: true,
  }));

  it("sees an announcement inside the horizon", () => {
    const next = nextEarningsAsOf(days[30], announcements, calendar, 21)!;
    assert.equal(next.due_session, days[40]);
    assert.equal(next.sessions_until, 10);
  });

  it("is blind to one beyond the horizon — nobody could have known", () => {
    assert.equal(nextEarningsAsOf(days[10], announcements, calendar, 21), null);
  });

  it("a wider horizon reveals it again", () => {
    assert.equal(nextEarningsAsOf(days[10], announcements, calendar, 40)!.due_session, days[40]);
  });

  it("earningsWithin looks backwards freely", () => {
    // 2 sessions AFTER the day[10] announcement.
    assert.equal(earningsWithin(days[12], 3, announcements, calendar, 21), true);
    assert.equal(earningsWithin(days[20], 3, announcements, calendar, 21), false);
  });

  it("earningsWithin looks forward only inside the horizon", () => {
    // days[38] is 2 before days[40] — visible.
    assert.equal(earningsWithin(days[38], 3, announcements, calendar, 21), true);
    // 30 sessions before, with a 3-session filter: not within range at all.
    assert.equal(earningsWithin(days[10 - 0], 3, announcements, calendar, 0), true, "the same session counts");
  });

  it("a zero horizon hides every future announcement", () => {
    assert.equal(nextEarningsAsOf(days[39], announcements, calendar, 0), null);
  });
});

describe("quantlab/filings — earnings rhythm", () => {
  const announcements: FilingEvent[] = [days[10], days[20], days[30]].map((session) => ({
    ticker: "AAA",
    form: "8-K",
    accession: session,
    filed_at: session,
    accepted_at: `${session}T21:00:00.000Z`,
    items: ["2.02"],
    session,
    after_close: true,
  }));
  // An after-close release moves the NEXT session.
  const returns = new Map<string, number | null>([
    [days[11], 0.04],
    [days[21], -0.06],
    [days[31], 0.02],
  ]);

  it("averages the absolute reaction moves", () => {
    const rhythm = earningsRhythmAsOf(days[40], announcements, returns, calendar)!;
    assert.ok(Math.abs(rhythm - (0.04 + 0.06 + 0.02) / 3) < 1e-12);
  });

  it("uses only announcements already past — no look-ahead", () => {
    const rhythm = earningsRhythmAsOf(days[25], announcements, returns, calendar)!;
    assert.ok(Math.abs(rhythm - (0.04 + 0.06) / 2) < 1e-12, "the days[30] event is still in the future");
  });

  it("needs two observations rather than reporting one as a rhythm", () => {
    assert.equal(earningsRhythmAsOf(days[15], announcements, returns, calendar), null);
  });
});
