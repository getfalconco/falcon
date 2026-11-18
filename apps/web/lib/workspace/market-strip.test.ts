// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/workspace/market-strip.test.ts
// Pure checks of the Dashboard market strip; nothing leaves the machine.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  changeTone,
  formatChange,
  formatValue,
  pickLeg,
  pollMs,
  sessionLabel,
  signed,
  stripItem,
  stripQuoteFromYahoo,
  stripSession,
  tnxScale,
  type StripQuote,
} from "./market-strip";

/** An instant from a New York wall clock with its offset, e.g. "2026-11-17T09:12:00-05:00". */
const at = (iso: string) => Date.parse(iso);
const M = "−";

test("session: pre-market, open, after hours and closed on the NYSE calendar", () => {
  // Tue 2026-11-17, a regular session (EST).
  assert.equal(stripSession(at("2026-11-17T03:59:00-05:00")), "closed");
  assert.equal(stripSession(at("2026-11-17T04:00:00-05:00")), "pre");
  assert.equal(stripSession(at("2026-11-17T09:29:00-05:00")), "pre");
  assert.equal(stripSession(at("2026-11-17T09:30:00-05:00")), "open");
  assert.equal(stripSession(at("2026-11-17T15:59:00-05:00")), "open");
  assert.equal(stripSession(at("2026-11-17T16:00:00-05:00")), "post");
  assert.equal(stripSession(at("2026-11-17T19:59:00-05:00")), "post");
  assert.equal(stripSession(at("2026-11-17T20:00:00-05:00")), "closed");
  // Weekend and Thanksgiving (2026-11-26): closed all day.
  assert.equal(stripSession(at("2026-11-21T11:00:00-05:00")), "closed");
  assert.equal(stripSession(at("2026-11-26T11:00:00-05:00")), "closed");
  // Day after Thanksgiving: 13:00 close, after hours to 17:00.
  assert.equal(stripSession(at("2026-11-27T12:59:00-05:00")), "open");
  assert.equal(stripSession(at("2026-11-27T13:00:00-05:00")), "post");
  assert.equal(stripSession(at("2026-11-27T17:00:00-05:00")), "closed");
  // Summer time (EDT).
  assert.equal(stripSession(at("2026-07-15T09:30:00-04:00")), "open");
});

test("session label: state and New York time; closed names the weekday", () => {
  assert.equal(sessionLabel(at("2026-11-17T09:12:00-05:00")), "Pre-market · 9:12 ET");
  assert.equal(sessionLabel(at("2026-11-17T11:40:30-05:00")), "Open · 11:40 ET");
  assert.equal(sessionLabel(at("2026-11-17T17:05:00-05:00")), "After hours · 17:05 ET");
  assert.equal(sessionLabel(at("2026-11-20T20:00:00-05:00")), "Closed · Fri 20:00 ET");
  assert.equal(sessionLabel(at("2026-11-21T10:02:00-05:00")), "Closed · Sat 10:02 ET");
  assert.equal(sessionLabel(at("2026-11-18T00:05:00-05:00")), "Closed · Wed 0:05 ET");
});

test("poll: 15 s while anything trades, 5 min when closed", () => {
  assert.equal(pollMs("pre"), 15_000);
  assert.equal(pollMs("open"), 15_000);
  assert.equal(pollMs("post"), 15_000);
  assert.equal(pollMs("closed"), 300_000);
});

test("colour rule: SPY/QQQ green up, VIX inverted, 10Y neutral, zero neutral", () => {
  assert.equal(changeTone("SPY", 1), "up");
  assert.equal(changeTone("QQQ", -1), "down");
  assert.equal(changeTone("VIX", 1), "down");
  assert.equal(changeTone("VIX", -1), "up");
  assert.equal(changeTone("TNX", 1), "flat");
  assert.equal(changeTone("TNX", -1), "flat");
  assert.equal(changeTone("SPY", 0), "flat");
});

test("formatting: signs, decimals, the 10Y in percent, missing values", () => {
  assert.deepEqual(signed(0.44, 1), { text: "+0.4", sign: 1 });
  assert.deepEqual(signed(-0.04, 1), { text: "0.0", sign: 0 });
  assert.deepEqual(signed(-1.8, 2), { text: `${M}1.80`, sign: -1 });
  assert.equal(formatValue("SPY", 672.4), "672.40");
  assert.equal(formatValue("SPY", 1234.5), "1,234.50");
  assert.equal(formatValue("TNX", 4.2149), "4.21%");
  assert.equal(formatValue("VIX", null), "—");
  const leg = (change: number, changePct: number) => ({ price: 1, change, changePct, time: null });
  assert.deepEqual(formatChange("SPY", leg(2.7, 0.4)), { text: "+0.4%", tone: "up" });
  assert.deepEqual(formatChange("QQQ", leg(-4, -0.66)), { text: `${M}0.7%`, tone: "down" });
  assert.deepEqual(formatChange("VIX", leg(1.8, 9)), { text: "+1.80", tone: "down" });
  assert.deepEqual(formatChange("TNX", leg(-0.03, -0.7)), { text: `${M}0.03`, tone: "flat" });
  assert.deepEqual(formatChange("SPY", { price: 1, change: null, changePct: null, time: null }), { text: "—", tone: "flat" });
  assert.deepEqual(formatChange("SPY", null), { text: "—", tone: "flat" });
});

test("^TNX: percent as is, times-ten feeds divided by ten", () => {
  assert.equal(tnxScale(5.127), 1);
  assert.equal(tnxScale(42.1), 10);
  const q = stripQuoteFromYahoo("TNX", { regularMarketPrice: 42.1, regularMarketChange: -0.3, regularMarketChangePercent: -0.7, regularMarketTime: 1 });
  assert.ok(Math.abs(q.regular!.price - 4.21) < 1e-9);
  assert.ok(Math.abs(q.regular!.change! + 0.03) < 1e-9);
  assert.equal(q.pre, null);
  const now = stripQuoteFromYahoo("TNX", { regularMarketPrice: 5.127, regularMarketChange: 0.006, regularMarketTime: 1 });
  assert.equal(formatValue("TNX", now.regular!.price), "5.13%");
  assert.equal(formatChange("TNX", now.regular).text, "+0.01");
});

// A SPY row as Yahoo sent it in pre-market on 2026-11-17.
const SPY_ROW = {
  symbol: "SPY",
  marketState: "PRE",
  regularMarketPrice: 739.95,
  regularMarketChange: -14.42,
  regularMarketChangePercent: -1.91153,
  regularMarketTime: 1794862800,
  preMarketPrice: 739.15,
  preMarketChange: -0.80999756,
  preMarketChangePercent: -0.10946504,
  preMarketTime: 1794922512,
};

test("extended hours: the pre-market print in pre-market, the close otherwise", () => {
  const q = stripQuoteFromYahoo("SPY", SPY_ROW);
  assert.equal(pickLeg(q, "pre")?.kind, "pre");
  assert.equal(pickLeg(q, "open")?.kind, "regular");
  assert.equal(pickLeg(q, "closed")?.kind, "regular");
  // No after-hours print: after hours shows the close.
  assert.equal(pickLeg(q, "post")?.kind, "regular");
  const pre = stripItem("SPY", q, "pre");
  assert.equal(pre.value, "739.15");
  assert.equal(pre.change, `${M}0.1%`);
  assert.equal(pre.tone, "down");
  const closed = stripItem("SPY", q, "closed");
  assert.equal(closed.value, "739.95");
  assert.equal(closed.change, `${M}1.9%`);
});

test("extended hours: a pre-market print older than the close is not shown", () => {
  const q = stripQuoteFromYahoo("SPY", { ...SPY_ROW, preMarketTime: SPY_ROW.regularMarketTime - 3600 });
  assert.equal(pickLeg(q, "pre")?.kind, "regular");
});

test("extended hours: change from the close when Yahoo leaves it out", () => {
  const q = stripQuoteFromYahoo("QQQ", { regularMarketPrice: 100, regularMarketTime: 1, postMarketPrice: 101, postMarketTime: 2 });
  const p = pickLeg(q, "post");
  assert.equal(p?.kind, "post");
  assert.equal(p?.leg.change, 1);
  assert.equal(p?.leg.changePct, 1);
});

test("missing quotes show a dash, never a number", () => {
  const item = stripItem("VIX", null, "open");
  assert.equal(item.value, "—");
  assert.equal(item.change, "—");
  assert.equal(item.tone, "flat");
  const empty: StripQuote = stripQuoteFromYahoo("VIX", { symbol: "^VIX" });
  assert.equal(stripItem("VIX", empty, "open").value, "—");
});
