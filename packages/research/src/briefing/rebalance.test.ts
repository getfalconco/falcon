import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTradingDay } from "../tracker/calendar.js";
import { expiryEventsBetween } from "./expiry.js";
import { nasdaq100Events, rebalanceEventsBetween, spQuarterlyRebalance } from "./rebalance.js";
import type { IndexEvent } from "./types.js";

/** House copy rules for reader-facing text: no long dashes, no directive or predictive wording. */
const BANNED_WORDS =
  /\b(buy|buys|buying|bought|sell|sells|selling|sold|enter|enters|entered|entering|exit|exits|exited|exiting|long|longs|longer|short|shorts|shorted|shorting|add|adds|added|adding|trim|trims|trimmed|trimming|target|targets|targeted|targeting|stop|stops|stopped|stopping|take profit|signal|signals|signaled|signalled|prediction|predictions|recommend|recommends|recommended|recommending|recommendation|reduce|reduces|reduced|reducing|consider|considers|considered|considering|should|will|expect|expects|expected|expecting|forecast|forecasts|forecasted|forecasting|predict|predicts|predicted|predicting|likely|may)\b/i;
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

const curatedRow = (date: string, family: IndexEvent["family"], title: string): IndexEvent => ({
  date,
  family,
  title,
  source: "test",
});

describe("spQuarterlyRebalance", () => {
  it("2026: third Friday of each quarter-end month, June rolled back off Juneteenth", () => {
    assert.equal(spQuarterlyRebalance(2026, 1), "2026-03-20");
    assert.equal(spQuarterlyRebalance(2026, 2), "2026-06-18");
    assert.equal(spQuarterlyRebalance(2026, 3), "2026-09-18");
    assert.equal(spQuarterlyRebalance(2026, 4), "2026-12-18");
  });

  it("Good Friday on the third Friday of March rolls back to Thursday", () => {
    assert.equal(spQuarterlyRebalance(2008, 1), "2008-03-20");
  });

  it("is always a trading day and shares its date with the quarterly expiry", () => {
    for (let year = 2022; year <= 2035; year++) {
      for (const quarter of [1, 2, 3, 4] as const) {
        const date = spQuarterlyRebalance(year, quarter);
        assert.ok(isTradingDay(date), date);
        const [expiry] = expiryEventsBetween(date, date).filter((e) => e.kind === "quarterly_expiry");
        assert.equal(expiry?.date, date);
      }
    }
  });

  it("rejects a quarter outside 1-4", () => {
    assert.throws(() => spQuarterlyRebalance(2026, 5 as unknown as 1), RangeError);
    assert.throws(() => spQuarterlyRebalance(2026, 0 as unknown as 1), RangeError);
  });
});

describe("nasdaq100Events", () => {
  it("2026: four quarterly dates, December flagged as the annual reconstitution", () => {
    assert.deepEqual(nasdaq100Events(2026), [
      { date: "2026-03-20", annual: false },
      { date: "2026-06-18", annual: false },
      { date: "2026-09-18", annual: false },
      { date: "2026-12-18", annual: true },
    ]);
  });

  it("only December is annual, in any year", () => {
    for (let year = 2024; year <= 2030; year++) {
      const events = nasdaq100Events(year);
      assert.deepEqual(
        events.map((e) => e.annual),
        [false, false, false, true],
      );
      assert.equal(events[3].date.slice(5, 7), "12");
    }
  });
});

describe("rebalanceEventsBetween: rule-derived events", () => {
  it("2026 with nothing curated: S&P and Nasdaq-100 only, sorted by date then family", () => {
    const events = rebalanceEventsBetween("2026-01-01", "2026-12-31", []);
    assert.deepEqual(
      events.map((e) => [e.date, e.family, e.title]),
      [
        ["2026-03-20", "sp", "S&P quarterly index rebalance"],
        ["2026-03-20", "nasdaq100", "Nasdaq-100 quarterly rebalance"],
        ["2026-06-18", "sp", "S&P quarterly index rebalance"],
        ["2026-06-18", "nasdaq100", "Nasdaq-100 quarterly rebalance"],
        ["2026-09-18", "sp", "S&P quarterly index rebalance"],
        ["2026-09-18", "nasdaq100", "Nasdaq-100 quarterly rebalance"],
        ["2026-12-18", "sp", "S&P quarterly index rebalance"],
        ["2026-12-18", "nasdaq100", "Nasdaq-100 annual reconstitution"],
      ],
    );
    for (const e of events) {
      assert.equal(e.certainty, "rule");
      assert.equal(e.source, "rule");
      assert.match(e.detail, /^Scheduled, per index methodology/);
    }
  });

  it("says so when a holiday moved the date", () => {
    const june = rebalanceEventsBetween("2026-06-01", "2026-06-30", []);
    assert.equal(june.length, 2);
    for (const e of june) assert.match(e.detail, /market holiday/);

    const september = rebalanceEventsBetween("2026-09-01", "2026-09-30", []);
    for (const e of september) assert.doesNotMatch(e.detail, /holiday/);
  });

  it("filters by range, inclusive on both ends, across a year boundary", () => {
    assert.deepEqual(rebalanceEventsBetween("2026-09-19", "2026-12-17", []), []);
    assert.equal(rebalanceEventsBetween("2026-09-18", "2026-09-18", []).length, 2);
    assert.deepEqual(
      rebalanceEventsBetween("2026-12-01", "2027-03-31", []).map((e) => e.date),
      ["2026-12-18", "2026-12-18", "2027-03-19", "2027-03-19"],
    );
  });

  it("an inverted range is empty; a malformed bound throws", () => {
    assert.deepEqual(rebalanceEventsBetween("2026-12-31", "2026-01-01", []), []);
    assert.throws(() => rebalanceEventsBetween("2026", "2026-12-31", []), RangeError);
    assert.throws(() => rebalanceEventsBetween("2026-01-01", "", []), RangeError);
  });
});

describe("rebalanceEventsBetween: curated events", () => {
  it("Russell and MSCI appear only when curated", () => {
    const none = rebalanceEventsBetween("2026-01-01", "2026-12-31", []);
    assert.equal(none.filter((e) => e.family === "russell" || e.family === "msci").length, 0);

    const curated = [
      curatedRow("2026-11-24", "msci", "MSCI index review"),
      curatedRow("2026-06-26", "russell", "Russell reconstitution"),
    ];
    const events = rebalanceEventsBetween("2026-01-01", "2026-12-31", curated);
    const russell = events.filter((e) => e.family === "russell");
    const msci = events.filter((e) => e.family === "msci");
    assert.deepEqual(
      russell.map((e) => [e.date, e.title, e.certainty, e.source]),
      [["2026-06-26", "Russell reconstitution", "confirmed", "curated"]],
    );
    assert.deepEqual(
      msci.map((e) => [e.date, e.title, e.certainty, e.source]),
      [["2026-11-24", "MSCI index review", "confirmed", "curated"]],
    );
    // The rule-derived families are untouched by them.
    assert.equal(events.filter((e) => e.source === "rule").length, 8);
  });

  it("a curated S&P entry overrides the rule date for that family and quarter only", () => {
    const curated = [curatedRow("2026-12-21", "sp", "S&P quarterly index rebalance (announced)")];
    const events = rebalanceEventsBetween("2026-12-01", "2026-12-31", curated);
    assert.deepEqual(
      events.map((e) => [e.date, e.family, e.certainty, e.source]),
      [
        ["2026-12-18", "nasdaq100", "rule", "rule"],
        ["2026-12-21", "sp", "confirmed", "curated"],
      ],
    );
    // Other quarters keep their rule dates.
    const september = rebalanceEventsBetween("2026-09-01", "2026-09-30", curated);
    assert.deepEqual(
      september.map((e) => [e.family, e.source]),
      [
        ["sp", "rule"],
        ["nasdaq100", "rule"],
      ],
    );
  });

  it("a curated Nasdaq-100 entry on the rule date replaces it rather than doubling it", () => {
    const curated = [curatedRow("2026-12-18", "nasdaq100", "Nasdaq-100 annual reconstitution (announced)")];
    const ndx = rebalanceEventsBetween("2026-12-01", "2026-12-31", curated).filter((e) => e.family === "nasdaq100");
    assert.equal(ndx.length, 1);
    assert.equal(ndx[0].certainty, "confirmed");
    assert.equal(ndx[0].source, "curated");
    assert.doesNotMatch(ndx[0].detail, /per index methodology/);
  });

  it("the override holds even when the curated date falls outside the requested range", () => {
    const curated = [curatedRow("2026-12-21", "sp", "S&P quarterly index rebalance (announced)")];
    const events = rebalanceEventsBetween("2026-12-18", "2026-12-18", curated);
    assert.deepEqual(
      events.map((e) => e.family),
      ["nasdaq100"],
    );
  });

  it("a curated entry in the quarter-end month but away from the rule date does not silence it", () => {
    // An ad-hoc constituent change in December is an event of its own, and the
    // quarter's own rebalance is still the deepest closing auction of it.
    const curated = [curatedRow("2026-12-04", "sp", "S&P 500 constituent change")];
    assert.deepEqual(
      rebalanceEventsBetween("2026-12-01", "2026-12-31", curated).filter((e) => e.family === "sp").map((e) => [e.date, e.source]),
      [
        ["2026-12-04", "curated"],
        ["2026-12-18", "rule"],
      ],
    );
    // The range the report itself builds for a mid-December target session.
    assert.deepEqual(
      rebalanceEventsBetween("2026-12-14", "2027-01-08", curated).map((e) => [e.date, e.family, e.source]),
      [
        ["2026-12-18", "sp", "rule"],
        ["2026-12-18", "nasdaq100", "rule"],
      ],
    );
    // Rolled back off the rule date by a session, it is that event again.
    const moved = [curatedRow("2026-12-17", "sp", "S&P quarterly index rebalance (announced)")];
    assert.deepEqual(
      rebalanceEventsBetween("2026-12-01", "2026-12-31", moved).filter((e) => e.family === "sp").map((e) => [e.date, e.source]),
      [["2026-12-17", "curated"]],
    );
  });

  it("a curated entry outside the quarter-end month is listed beside the rule date, not instead of it", () => {
    const curated = [curatedRow("2026-07-24", "nasdaq100", "Nasdaq-100 special rebalance")];
    const events = rebalanceEventsBetween("2026-07-01", "2026-09-30", curated).filter((e) => e.family === "nasdaq100");
    assert.deepEqual(
      events.map((e) => [e.date, e.source]),
      [
        ["2026-07-24", "curated"],
        ["2026-09-18", "rule"],
      ],
    );
  });

  it("filters curated entries by range and sorts them in with the rule events", () => {
    const curated = [
      curatedRow("2026-11-24", "msci", "MSCI index review"),
      curatedRow("2026-08-25", "msci", "MSCI index review"),
      curatedRow("2026-09-18", "russell", "Russell reconstitution"),
      curatedRow("2027-02-23", "msci", "MSCI index review"),
    ];
    const events = rebalanceEventsBetween("2026-08-25", "2026-11-23", curated);
    assert.deepEqual(
      events.map((e) => [e.date, e.family]),
      [
        ["2026-08-25", "msci"],
        ["2026-09-18", "sp"],
        ["2026-09-18", "nasdaq100"],
        ["2026-09-18", "russell"],
      ],
    );
  });

  it("drops malformed and duplicate curated rows instead of failing the list", () => {
    const curated = [
      curatedRow("2026-11-24", "msci", "MSCI index review"),
      curatedRow("2026-11-24", "msci", " MSCI index review "),
      curatedRow("2026-11-31", "msci", "not a date"),
      curatedRow("24/11/2026", "msci", "wrong format"),
      curatedRow("2026-11-25", "ftse" as unknown as IndexEvent["family"], "unknown family"),
      curatedRow("2026-11-26", "msci", "   "),
      null as unknown as IndexEvent,
    ];
    const events = rebalanceEventsBetween("2026-11-01", "2026-11-30", curated);
    assert.deepEqual(
      events.map((e) => [e.date, e.family, e.title]),
      [["2026-11-24", "msci", "MSCI index review"]],
    );
    assert.deepEqual(rebalanceEventsBetween("2026-11-01", "2026-11-30", undefined as unknown as IndexEvent[]), []);
  });

  it("does not mutate the curated list", () => {
    const curated = [curatedRow("2026-11-24", "msci", " MSCI index review ")];
    const snapshot = JSON.stringify(curated);
    rebalanceEventsBetween("2026-01-01", "2026-12-31", curated);
    assert.equal(JSON.stringify(curated), snapshot);
  });
});

describe("rebalance copy", () => {
  it("every title and detail written here follows the copy rules", () => {
    const events = rebalanceEventsBetween("2024-01-01", "2028-12-31", [
      curatedRow("2026-11-24", "msci", "MSCI index review"),
    ]);
    assert.ok(events.length > 30);
    for (const e of events) {
      for (const text of [e.title, e.detail]) {
        assert.doesNotMatch(text, BANNED_WORDS, text);
        assert.doesNotMatch(text, LONG_DASH, text);
      }
    }
  });
});
