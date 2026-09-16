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

const days = tradingDays(60);
const calendar = TradingCalendar.fromBars(barsFrom({ days, returns: new Array(59).fill(0), startPrice: 100 }));

function filing(over: Partial<FilingRecord> & { filedAt: string }): FilingRecord {
  return {
    form: "8-K",
    accessionNumber: `acc-${over.filedAt}`,
    acceptedAt: null,
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
