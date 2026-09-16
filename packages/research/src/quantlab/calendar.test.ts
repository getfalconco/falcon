import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { barsFrom, tradingDays } from "../screen/test-fixtures.js";
import { TradingCalendar } from "./calendar.js";

const days = tradingDays(30);
const bars = barsFrom({ days, returns: new Array(29).fill(0.001), startPrice: 500 });
const cal = TradingCalendar.fromBars(bars);

describe("quantlab/calendar — derived from benchmark bars", () => {
  it("takes its sessions from the bars, de-duplicated and sorted", () => {
    const scrambled = TradingCalendar.fromBars([bars[5], bars[0], bars[5], bars[2]]);
    assert.equal(scrambled.length, 3);
    assert.deepEqual([...scrambled.sessions()], [days[0], days[2], days[5]]);
  });

  it("a date the benchmark did not trade is not a session", () => {
    assert.equal(cal.has(days[10]), true);
    // New Year's Day appears in no bar series, so it is simply not a session.
    assert.equal(cal.has("2026-01-01"), false);
    assert.equal(cal.positionOf("2026-01-01"), null);
  });

  it("shift walks the real calendar in both directions and stops at the ends", () => {
    assert.equal(cal.shift(days[10], 5), days[15]);
    assert.equal(cal.shift(days[10], -10), days[0]);
    assert.equal(cal.shift(days[0], -1), null);
    assert.equal(cal.shift(days[29], 1), null);
    assert.equal(cal.shift("2026-01-01", 1), null, "non-session input yields null, never a guess");
  });

  it("between is signed and refuses non-sessions", () => {
    assert.equal(cal.between(days[3], days[9]), 6);
    assert.equal(cal.between(days[9], days[3]), -6);
    assert.equal(cal.between(days[3], "2026-01-01"), null);
  });

  it("range is inclusive at both ends", () => {
    assert.deepEqual(cal.range(days[4], days[7]), [days[4], days[5], days[6], days[7]]);
    assert.deepEqual(cal.range(days[7], days[4]), []);
  });

  it("onOrBefore / onOrAfter map a non-trading date onto the real sessions", () => {
    assert.equal(cal.onOrBefore(days[10]), days[10]);
    assert.equal(cal.onOrAfter(days[10]), days[10]);
    assert.equal(cal.onOrBefore("2099-01-01"), days[29]);
    assert.equal(cal.onOrAfter("1999-01-01"), days[0]);
    assert.equal(cal.onOrBefore("1999-01-01"), null);
    assert.equal(cal.onOrAfter("2099-01-01"), null);
  });

  it("exposes first and last", () => {
    assert.equal(cal.first, days[0]);
    assert.equal(cal.last, days[29]);
    assert.equal(TradingCalendar.fromBars([]).first, null);
  });
});
