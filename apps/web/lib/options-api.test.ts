// Run: node --import tsx --test apps/web/lib/options-api.test.ts (tsx from packages/engine)
import assert from "node:assert/strict";
import { test } from "node:test";
import type { RippleOptions } from "@falcon/ripple";
import { allForViewer, compactOf, emptyAll, ivByTicker, tickerForViewer, type OptionsAll, type OptionsTicker } from "./options-api";

const B: RippleOptions = {
  asOf: "2026-11-13T20:45:00.000Z",
  source: "OPRA via Databento",
  spot: 100,
  atmIv: 42.1,
  impliedMove5: { sessions: 5, expiration: "2026-11-20", rawPct: 3.2, marketAdjustedPct: 2.5 },
  impliedMove20: { sessions: 20, expiration: "2026-12-18", rawPct: 6.4, marketAdjustedPct: null },
  skew: 3.4,
  cpSpread: null,
  beta: 1.2,
  vix: 18,
};

const all = (): OptionsAll => ({ asOf: "2026-11-13", source: "OPRA via Databento", count: 1, tickers: { NVDA: compactOf(B, 72)! } });
const one = (): OptionsTicker => ({ ticker: "NVDA", date: "2026-11-13", options: B, ivDays: 30, history: [{ date: "2026-11-13", atmIv: 42.1 }] });

test("compact entry: card units, unknown optional numbers omitted", () => {
  assert.deepEqual(compactOf(B, 72), { atmIv: 42.1, ivPct: 72, im5: 3.2, im20: 6.4, im5adj: 2.5, skew: 3.4, asOf: "2026-11-13T20:45:00.000Z" });
  assert.deepEqual(compactOf({ ...B, impliedMove20: null, skew: null }, null), { atmIv: 42.1, im5: 3.2, im20: null, im5adj: 2.5, asOf: B.asOf });
  assert.equal(compactOf(null), null);
  // The block's own ivPct is used when the row has none.
  assert.equal(compactOf({ ...B, ivPct: 15 })?.ivPct, 15);
});

test("OPTIONS_DISPLAY: all serves everyone, admin only the admin, off nobody", () => {
  assert.equal(allForViewer(all(), "all", false).count, 1);
  assert.deepEqual(allForViewer(all(), "admin", false), emptyAll());
  assert.equal(allForViewer(all(), "admin", true).count, 1);
  assert.deepEqual(allForViewer(all(), "off", true), emptyAll());

  assert.equal(tickerForViewer(one(), "all", false).options?.atmIv, 42.1);
  const hidden = tickerForViewer(one(), "admin", false);
  assert.equal(hidden.options, null);
  assert.deepEqual(hidden.history, []);
  assert.equal(hidden.ticker, "NVDA");
  assert.equal(tickerForViewer(one(), "admin", true).options?.atmIv, 42.1);
  assert.equal(tickerForViewer(one(), "off", true).options, null);
});

test("IV per ticker for a filter", () => {
  assert.deepEqual(Array.from(ivByTicker(all()).entries()), [["NVDA", 42.1]]);
});
