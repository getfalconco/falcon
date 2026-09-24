import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isTradingDay, weekdayOf } from "../tracker/calendar.js";
import {
  expiryEventsBetween,
  isQuarterlyExpiryMonth,
  monthlyOpex,
  thirdFriday,
  vixExpiry,
} from "./expiry.js";

/** House copy rules for reader-facing text: no long dashes, no directive or predictive wording. */
const BANNED_WORDS =
  /\b(buy|buys|buying|bought|sell|sells|selling|sold|enter|enters|entered|entering|exit|exits|exited|exiting|long|longs|longer|short|shorts|shorted|shorting|add|adds|added|adding|trim|trims|trimmed|trimming|target|targets|targeted|targeting|stop|stops|stopped|stopping|take profit|signal|signals|signaled|signalled|prediction|predictions|recommend|recommends|recommended|recommending|recommendation|reduce|reduces|reduced|reducing|consider|considers|considered|considering|should|will|expect|expects|expected|expecting|forecast|forecasts|forecasted|forecasting|predict|predicts|predicted|predicting|likely|may)\b/i;
const LONG_DASH = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

describe("thirdFriday / monthlyOpex", () => {
  it("2026: every third Friday, with June rolled back off Juneteenth", () => {
    const expectedFridays = [
      "2026-01-16",
      "2026-02-20",
      "2026-03-20",
      "2026-04-17",
      "2026-05-15",
      "2026-06-19",
      "2026-07-17",
      "2026-08-21",
      "2026-09-18",
      "2026-10-16",
      "2026-11-20",
      "2026-12-18",
    ];
    for (let month = 1; month <= 12; month++) {
      const friday = thirdFriday(2026, month);
      assert.equal(friday, expectedFridays[month - 1]);
      assert.equal(weekdayOf(friday), 5);
      // 2026-06-19 is Juneteenth, a Friday: the expiry moves to Thursday 06-18.
      assert.equal(monthlyOpex(2026, month), month === 6 ? "2026-06-18" : friday);
    }
  });

  it("Good Friday on the third Friday moves the expiry to Thursday", () => {
    assert.equal(thirdFriday(2025, 4), "2025-04-18");
    assert.equal(monthlyOpex(2025, 4), "2025-04-17");
    assert.equal(monthlyOpex(2022, 4), "2022-04-14");
    assert.equal(monthlyOpex(2008, 3), "2008-03-20");
  });

  it("is always a trading day, never after the third Friday, never outside its month", () => {
    for (let year = 2022; year <= 2035; year++) {
      for (let month = 1; month <= 12; month++) {
        const opex = monthlyOpex(year, month);
        assert.ok(isTradingDay(opex), opex);
        assert.ok(opex <= thirdFriday(year, month), opex);
        assert.equal(opex.slice(0, 7), thirdFriday(year, month).slice(0, 7));
      }
    }
  });

  it("rejects a month outside 1-12", () => {
    assert.throws(() => thirdFriday(2026, 0), RangeError);
    assert.throws(() => monthlyOpex(2026, 13), RangeError);
    assert.throws(() => vixExpiry(2026, 1.5), RangeError);
  });
});

describe("isQuarterlyExpiryMonth", () => {
  it("is true for March, June, September and December only", () => {
    const quarterly = [];
    for (let month = 1; month <= 12; month++) if (isQuarterlyExpiryMonth(month)) quarterly.push(month);
    assert.deepEqual(quarterly, [3, 6, 9, 12]);
  });
});

describe("vixExpiry", () => {
  it("is the Wednesday 30 days before the following month's third Friday", () => {
    assert.equal(vixExpiry(2026, 9), "2026-09-16");
    assert.equal(weekdayOf(vixExpiry(2026, 9)), 3);
  });

  it("December anchors on the January third Friday of the next year", () => {
    assert.equal(vixExpiry(2026, 12), "2026-12-16");
  });

  it("a holiday on the far Friday moves the expiry to the business day before the Wednesday", () => {
    // April 2025's third Friday was Good Friday (04-18); 30 days earlier is Wednesday 03-19.
    assert.equal(vixExpiry(2025, 3), "2025-03-18");
    // June 2026's third Friday is Juneteenth (06-19); 30 days earlier is Wednesday 05-20.
    assert.equal(vixExpiry(2026, 5), "2026-05-19");
  });

  it("a holiday on the Wednesday itself moves the expiry to the business day before", () => {
    // Juneteenth 2024 fell on Wednesday 06-19, 30 days before Friday 07-19.
    assert.equal(vixExpiry(2024, 6), "2024-06-18");
  });

  it("2026: the full year under the rule", () => {
    const expected = [
      "2026-01-21",
      "2026-02-18",
      "2026-03-18",
      "2026-04-15",
      "2026-05-19",
      "2026-06-17",
      "2026-07-22",
      "2026-08-19",
      "2026-09-16",
      "2026-10-21",
      "2026-11-18",
      "2026-12-16",
    ];
    for (let month = 1; month <= 12; month++) assert.equal(vixExpiry(2026, month), expected[month - 1]);
  });

  it("always falls inside the month it is asked for, on a trading day", () => {
    for (let year = 2022; year <= 2035; year++) {
      for (let month = 1; month <= 12; month++) {
        const date = vixExpiry(year, month);
        assert.equal(Number(date.slice(0, 4)), year, date);
        assert.equal(Number(date.slice(5, 7)), month, date);
        assert.ok(isTradingDay(date), date);
      }
    }
  });
});

describe("expiryEventsBetween", () => {
  it("rolls from December into January, sorted by date", () => {
    const events = expiryEventsBetween("2026-12-01", "2027-01-31");
    assert.deepEqual(
      events.map((e) => [e.date, e.kind]),
      [
        ["2026-12-16", "vix_expiry"],
        ["2026-12-18", "quarterly_expiry"],
        ["2027-01-15", "monthly_opex"],
        ["2027-01-20", "vix_expiry"],
      ],
    );
  });

  it("a quarterly month carries one quarterly event in place of the monthly one", () => {
    const events = expiryEventsBetween("2026-09-01", "2026-09-30");
    assert.deepEqual(
      events.map((e) => e.kind),
      ["vix_expiry", "quarterly_expiry"],
    );
    const quarterly = events[1];
    assert.equal(quarterly.date, "2026-09-18");
    assert.equal(quarterly.title, "Quarterly options and futures expiry");
    assert.match(quarterly.detail, /triple witching/);
    assert.equal(events.filter((e) => e.kind === "monthly_opex").length, 0);
  });

  it("an ordinary month carries the monthly event", () => {
    const events = expiryEventsBetween("2026-10-01", "2026-10-31");
    assert.deepEqual(
      events.map((e) => [e.date, e.kind, e.title]),
      [
        ["2026-10-16", "monthly_opex", "Monthly options expiry"],
        ["2026-10-21", "vix_expiry", "VIX futures and options expiry"],
      ],
    );
  });

  it("bounds are inclusive on both ends", () => {
    assert.equal(expiryEventsBetween("2026-10-16", "2026-10-16").length, 1);
    assert.equal(expiryEventsBetween("2026-10-17", "2026-10-20").length, 0);
    assert.deepEqual(
      expiryEventsBetween("2026-10-16", "2026-10-21").map((e) => e.date),
      ["2026-10-16", "2026-10-21"],
    );
  });

  it("an inverted range is empty; a malformed bound throws", () => {
    assert.deepEqual(expiryEventsBetween("2026-10-31", "2026-10-01"), []);
    assert.throws(() => expiryEventsBetween("2026-10", "2026-10-31"), RangeError);
    assert.throws(() => expiryEventsBetween("2026-10-01", "soon"), RangeError);
  });

  it("says so when a holiday moved the date", () => {
    const [vix] = expiryEventsBetween("2026-05-19", "2026-05-19");
    assert.equal(vix.kind, "vix_expiry");
    assert.match(vix.detail, /market holiday/);

    const [quarterly] = expiryEventsBetween("2026-06-18", "2026-06-18");
    assert.equal(quarterly.kind, "quarterly_expiry");
    assert.match(quarterly.detail, /triple witching/);
    assert.match(quarterly.detail, /market holiday/);

    const [plain] = expiryEventsBetween("2026-10-16", "2026-10-16");
    assert.doesNotMatch(plain.detail, /holiday/);
  });

  it("every title and detail follows the copy rules", () => {
    const events = expiryEventsBetween("2024-01-01", "2027-12-31");
    assert.ok(events.length > 80);
    for (const e of events) {
      for (const text of [e.title, e.detail]) {
        assert.doesNotMatch(text, BANNED_WORDS, text);
        assert.doesNotMatch(text, LONG_DASH, text);
      }
    }
  });
});
