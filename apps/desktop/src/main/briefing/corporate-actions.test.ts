import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { CorporateCalendarRead, RecentCorporateEventsRead } from "../stock/market-data-service";
import { FAILURE_TTL_MS, GOOD_ANSWER_TTL_MS, createCorporateActions } from "./corporate-actions";

const MINUTE = 60_000;
const START = Date.parse("2026-09-21T00:30:00.000Z");

const CALENDAR: CorporateCalendarRead = {
  available: true,
  exDividendDate: "2026-10-09",
  dividendDate: "2026-10-14",
  dividendRate: 1.08,
  earningsDates: ["2026-10-29"],
  earningsEstimated: false,
};
const FUND_CALENDAR: CorporateCalendarRead = {
  available: false,
  exDividendDate: null,
  dividendDate: null,
  dividendRate: null,
  earningsDates: [],
  earningsEstimated: null,
};
const EVENTS: RecentCorporateEventsRead = { dividends: [{ date: "2026-08-10", amount: 0.27 }], splits: [] };

let dir = "";
let file = "";
let clock = START;
let calls: { calendar: number; events: number };
let calendarAnswer: () => Promise<CorporateCalendarRead>;
let eventsAnswer: () => Promise<RecentCorporateEventsRead>;

/** Flushed before the temp dir goes, so a pending write never recreates it afterwards. */
const made: Array<{ flush(): void }> = [];

function make() {
  const actions = createCorporateActions({
    file,
    now: () => clock,
    fetchCalendar: () => {
      calls.calendar += 1;
      return calendarAnswer();
    },
    fetchEvents: () => {
      calls.events += 1;
      return eventsAnswer();
    },
  });
  made.push(actions);
  return actions;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-corporate-"));
  file = path.join(dir, "corporate-actions.json");
  clock = START;
  calls = { calendar: 0, events: 0 };
  calendarAnswer = async () => CALENDAR;
  eventsAnswer = async () => EVENTS;
});

afterEach(() => {
  for (const actions of made.splice(0)) actions.flush();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("corporate actions cache", () => {
  it("merges the two reads and answers the second call from memory", async () => {
    const actions = make();
    const first = await actions.get("aapl");
    assert.equal(first.symbol, "AAPL");
    assert.equal(first.ex_dividend_date, "2026-10-09");
    assert.deepEqual(first.recent_dividends, [{ date: "2026-08-10", amount: 0.27 }]);

    clock += GOOD_ANSWER_TTL_MS - MINUTE;
    await actions.get("AAPL");
    assert.deepEqual(calls, { calendar: 1, events: 1 });

    clock += 2 * MINUTE;
    await actions.get("AAPL");
    assert.deepEqual(calls, { calendar: 2, events: 2 });
  });

  it("keeps a fund's empty calendar as long as any good answer", async () => {
    calendarAnswer = async () => FUND_CALENDAR;
    const actions = make();
    assert.equal((await actions.get("SPY")).available, false);
    clock += GOOD_ANSWER_TTL_MS - MINUTE;
    await actions.get("SPY");
    assert.equal(calls.calendar, 1);
  });

  it("survives a restart through the file on disk", async () => {
    const first = make();
    await first.get("AAPL");
    first.flush();
    assert.ok(fs.existsSync(file));

    const second = make();
    const answer = await second.get("AAPL");
    assert.equal(answer.ex_dividend_date, "2026-10-09");
    assert.deepEqual(calls, { calendar: 1, events: 1 });
  });

  it("remembers a failed calendar read for thirty minutes and still answers from the events", async () => {
    calendarAnswer = async () => {
      throw new Error("HTTP 429");
    };
    const actions = make();
    const answer = await actions.get("AAPL");
    assert.equal(answer.available, false);
    assert.deepEqual(answer.recent_dividends, [{ date: "2026-08-10", amount: 0.27 }]);

    clock += FAILURE_TTL_MS - MINUTE;
    await actions.get("AAPL");
    assert.equal(calls.calendar, 1);

    calendarAnswer = async () => CALENDAR;
    clock += 2 * MINUTE;
    assert.equal((await actions.get("AAPL")).available, true);
    assert.equal(calls.calendar, 2);
    assert.equal(calls.events, 1);
  });

  it("raises when the price-history events are missing, and does not retry inside the window", async () => {
    eventsAnswer = async () => {
      throw new Error("timeout");
    };
    const actions = make();
    await assert.rejects(actions.get("AAPL"));
    clock += FAILURE_TTL_MS - MINUTE;
    await assert.rejects(actions.get("AAPL"));
    assert.equal(calls.events, 1);

    eventsAnswer = async () => EVENTS;
    clock += 2 * MINUTE;
    assert.equal((await actions.get("AAPL")).symbol, "AAPL");
    assert.equal(calls.events, 2);
  });

  it("reads the events again once the session they were read before has opened", async () => {
    const open = START + 13 * 60 * MINUTE;
    const actions = make();
    await actions.get("AAPL", { eventsNotBeforeMs: open });

    clock = open - MINUTE;
    await actions.get("AAPL", { eventsNotBeforeMs: open });
    assert.equal(calls.events, 1);

    clock = open + MINUTE;
    await actions.get("AAPL", { eventsNotBeforeMs: open });
    assert.deepEqual(calls, { calendar: 1, events: 2 });

    clock = open + 5 * MINUTE;
    await actions.get("AAPL", { eventsNotBeforeMs: open });
    assert.equal(calls.events, 2);
  });

  it("shares one pair of reads between callers that arrive together", async () => {
    const actions = make();
    await Promise.all([actions.get("AAPL"), actions.get("aapl"), actions.get(" AAPL ")]);
    assert.deepEqual(calls, { calendar: 1, events: 1 });
  });

  it("starts empty from a corrupt cache file", async () => {
    fs.writeFileSync(file, "{ nope", "utf8");
    const actions = make();
    assert.equal((await actions.get("AAPL")).symbol, "AAPL");
    assert.deepEqual(calls, { calendar: 1, events: 1 });
  });
});
