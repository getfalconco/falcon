// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/workspace/equity.test.ts
// The Equity chart from real history: holdings snapshots x market prices, from the first snapshot on.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPosition, type PortfolioAccount, type PortfolioPosition } from "../portfolio-holdings";
import { seriesFromChart } from "../portfolio-history";
import {
  EQUITY_RANGES,
  chooseInterval,
  downsample,
  finishCurve,
  leadIn,
  historyStart,
  niceTicks,
  nominalStart,
  sameHoldings,
  snapshotOf,
  snapshotPoints,
  snapshotsInRange,
  type HoldingsSnapshot,
  type PriceSeries,
  type SnapshotPosition,
} from "./equity";
import { fixtureHistory, testHistory } from "./test-history";

const NOW = Date.UTC(2026, 10, 17, 20);
const H = 3_600_000;
const M = 60_000;
const s = (pts: [number, number][], prev?: number): PriceSeries => ({ t: pts.map((p) => p[0]), c: pts.map((p) => p[1]), ...(prev !== undefined ? { prev } : {}) });
const pos = (symbol: string, quantity: number, extra: Partial<SnapshotPosition> = {}): SnapshotPosition => ({ account_id: "csv", kind: "stock", symbol, ticker: symbol, quantity, multiplier: 1, currency: "USD", price: null, ...extra });
const snap = (at: number, positions: SnapshotPosition[], cash = 0): HoldingsSnapshot => ({ at, source: "csv", positions, cash: cash ? [{ account_id: "csv", currency: "USD", cash }] : [] });
const values = (r: { points: { v: number }[] }) => r.points.map((p) => Math.round(p.v * 100) / 100);

test("a snapshot keeps what was held (quantity, multiplier, currency, the import's price), never costs or names; identical holdings are no change", () => {
  const AT = "2026-11-17T15:00:00.000Z";
  const accounts: PortfolioAccount[] = [{ id: "csv", source: "csv", name: "Mine", institution: null, numberLast4: null, currency: "USD", totalValue: null, cash: 1200, buyingPower: null, holdingsUnavailable: false, asOf: AT }];
  const positions = [
    { accountId: "csv", kind: "stock", symbol: "AAPL", quantity: 10, avgCost: 173.25, price: 200 },
    { accountId: "csv", kind: "option", symbol: "AMD261218C00150000", ticker: "AMD", quantity: 2, price: 6 },
    { accountId: "csv", kind: "stock", symbol: "ZERO", quantity: 0 },
  ].map((p) => cleanPosition({ name: "Secret name", currency: "USD", asOf: AT, ...p } as Partial<PortfolioPosition>, NOW)!).filter(Boolean);
  const a = snapshotOf(accounts, positions);
  assert.deepEqual(a.positions, [
    { account_id: "csv", kind: "option", symbol: "AMD261218C00150000", ticker: "AMD", quantity: 2, multiplier: 100, currency: "USD", price: 6 },
    { account_id: "csv", kind: "stock", symbol: "AAPL", ticker: "AAPL", quantity: 10, multiplier: 1, currency: "USD", price: 200 },
  ], "sorted; a zero quantity is not held");
  assert.deepEqual(a.cash, [{ account_id: "csv", currency: "USD", cash: 1200 }]);
  assert.ok(!JSON.stringify(a).includes("Secret") && !JSON.stringify(a).includes("173.25"), "no names, no cost");
  const newPrice = snapshotOf(accounts, positions.map((p) => ({ ...p, price: 999 })));
  assert.equal(sameHoldings(a, newPrice), true, "a new price alone is no change: no row");
  assert.equal(sameHoldings(a, snapshotOf([{ ...accounts[0]!, cash: 1300 }], positions)), false, "cash moved");
  assert.equal(sameHoldings(a, snapshotOf(accounts, positions.slice(1))), false, "a position went");
});

test("snapshots over a range: the one in force at the start, then every later one", () => {
  const snaps = [snap(NOW - 30 * 24 * H, []), snap(NOW - 10 * 24 * H, []), snap(NOW - 2 * 24 * H, []), snap(NOW + H, [])];
  assert.deepEqual(snapshotsInRange(snaps, NOW - 5 * 24 * H, NOW).map((x) => x.at), [NOW - 10 * 24 * H, NOW - 2 * 24 * H], "the start's, then the later; never the future");
  assert.deepEqual(snapshotsInRange(snaps, NOW - 40 * 24 * H, NOW).map((x) => x.at), [NOW - 30 * 24 * H, NOW - 10 * 24 * H, NOW - 2 * 24 * H]);
});

test("the curve starts at the first snapshot, never before: the connection 2 days into a 1M range", () => {
  const first = NOW - 2 * 24 * H;
  const aapl = s([[NOW - 20 * 24 * H, 180], [first - H, 190], [first + H, 200], [NOW - H, 210]]);
  const r = snapshotPoints({ snapshots: [snap(first, [pos("AAPL", 10)], 500)], series: { AAPL: aapl }, from: NOW - 30 * 24 * H, nowMs: NOW, currency: "USD" });
  assert.equal(r.firstAt, first);
  assert.deepEqual(r.points.map((p) => p.t), [first, first + H, NOW - H], "nothing before the connection");
  assert.deepEqual(values(r), [500 + 10 * 190, 500 + 10 * 200, 500 + 10 * 210], "at the connection: the last bar before it");
  assert.equal(historyStart("1M", r.firstAt, NOW - 30 * 24 * H), first, "the legend: Since …");
  assert.equal(historyStart("1D", first, NOW - 5 * H), null, "the history covers the day");
});

test("a snapshot inside the range steps the curve: a position added, the cash paid for it", () => {
  const t0 = NOW - 10 * H;
  const added = NOW - 5 * H;
  const series = { AAPL: s([[t0, 100], [NOW - 6 * H, 100], [NOW - 4 * H, 110], [NOW - 2 * H, 120]]), MSFT: s([[t0, 50], [NOW - 6 * H, 50], [NOW - 4 * H, 50], [NOW - 2 * H, 60]]) };
  const r = snapshotPoints({
    snapshots: [snap(t0, [pos("AAPL", 10)], 2000), snap(added, [pos("AAPL", 10), pos("MSFT", 20)], 1000)],
    series,
    from: NOW - 24 * H,
    nowMs: NOW,
    currency: "USD",
  });
  assert.deepEqual(r.points.map((p) => p.t), [t0, NOW - 6 * H, added - 1, added, NOW - 4 * H, NOW - 2 * H]);
  assert.deepEqual(values(r), [3000, 3000, 3000, 3000, 1000 + 1100 + 1000, 1000 + 1200 + 1200], "the old holdings up to the change, the new from it");
});

test("cash changes count; Clear portfolio takes the curve to zero (or to the cash that stayed)", () => {
  const t0 = NOW - 6 * H;
  const series = { AAPL: s([[t0, 100], [NOW - 4 * H, 100], [NOW - 2 * H, 100]]) };
  const cleared = snapshotPoints({ snapshots: [snap(t0, [pos("AAPL", 10)], 500), snap(NOW - 3 * H, [], 0)], series, from: NOW - 24 * H, nowMs: NOW, currency: "USD" });
  assert.deepEqual(values(cleared), [1500, 1500, 1500, 0, 0]);
  const deposit = snapshotPoints({ snapshots: [snap(t0, [], 1000), snap(NOW - 3 * H, [], 4000)], series: {}, from: NOW - 24 * H, nowMs: NOW, currency: "USD", spy: s([[t0, 1], [NOW - 4 * H, 1], [NOW - 2 * H, 1]]) });
  assert.deepEqual(values(deposit), [1000, 1000, 1000, 4000, 4000], "a cash-only history uses SPY's times");
});

test("minute bars: a snapshot between two bars is a point of its own; options are held at their recorded price; other currencies are left out", () => {
  const open = Date.UTC(2026, 10, 17, 14, 30);
  const bars = Array.from({ length: 5 }, (_, i) => [open + i * M, 100 + i] as [number, number]);
  const at = open + 2 * M + 30_000;
  const r = snapshotPoints({
    snapshots: [
      snap(open - H, [pos("AAPL", 1), pos("AMD261218C00150000", 2, { kind: "option", ticker: "AMD", multiplier: 100, price: 5 }), pos("SAP", 100, { currency: "EUR" })]),
      snap(at, [pos("AAPL", 3), pos("AMD261218C00150000", 2, { kind: "option", ticker: "AMD", multiplier: 100, price: 5 })]),
    ],
    series: { AAPL: s(bars) },
    from: open,
    nowMs: open + 4 * M + 1,
    currency: "USD",
  });
  assert.deepEqual(r.points.map((p) => p.t - open), [0, M, 2 * M, at - 1 - open, at - open, 3 * M, 4 * M]);
  assert.deepEqual(values(r), [1000 + 100, 1000 + 101, 1000 + 102, 1000 + 102, 1000 + 3 * 102, 1000 + 3 * 103, 1000 + 3 * 104], "the option: 2 x 100 x $5 throughout");
});

test("1D from yesterday's close when the holdings were already held; the live total closes the curve; SPY from the same start", () => {
  const open = Date.UTC(2026, 10, 17, 14, 30);
  const series = { AAPL: s([[open, 101], [open + M, 102]], 100) };
  const spy = s([[open, 700], [open + M, 707]], 693);
  const held = snapshotPoints({ snapshots: [snap(open - 24 * H, [pos("AAPL", 10)], 0)], series, from: open, nowMs: open + 2 * M, currency: "USD", spy, fromPrevious: true });
  assert.deepEqual(values(held), [1000, 1010, 1020], "yesterday's close first");
  const fresh = snapshotPoints({ snapshots: [snap(open + 30_000, [pos("AAPL", 10)], 0)], series, from: open, nowMs: open + 2 * M, currency: "USD", spy, fromPrevious: true });
  assert.deepEqual(values(fresh), [1010, 1020], "connected after the open: no yesterday");
  const c = finishCurve(held.points, 1030, open + 3 * M, held.firstAt);
  assert.deepEqual([c.start, c.end, c.change, c.pct], [1000, 1030, 30, 3]);
  assert.deepEqual(c.points.map((p) => Math.round(p.spy!)), [1000, 1010, 1020, 1020], "SPY scaled to the curve's start (693 -> 707: +2%)");
  assert.equal(Math.round(c.spyPct! * 100) / 100, 2.02);
  assert.deepEqual(finishCurve([], 10, NOW, null), { points: [], start: null, end: null, change: null, pct: null, spyPct: null, firstAt: null }, "no history: nothing drawn");
  assert.deepEqual(snapshotPoints({ snapshots: [], series, from: open, nowMs: NOW, currency: "USD" }), { points: [], firstAt: null });
});

test("the preview's histories: ⌘P connected 30 days ago with changes inside, ending as the portfolio is; the fixture 2 days ago", () => {
  const AT = new Date(NOW).toISOString();
  const accounts: PortfolioAccount[] = [{ id: "csv", source: "csv", name: "Individual", institution: null, numberLast4: null, currency: "USD", totalValue: null, cash: 40_000, buyingPower: null, holdingsUnavailable: false, asOf: AT }];
  const positions = ["AAPL", "MSFT", "NVDA"].map((t, i) => cleanPosition({ accountId: "csv", kind: "stock", symbol: t, ticker: t, name: "", quantity: 10 + i, avgCost: 100, currency: "USD", asOf: AT }, NOW)!);
  const h = testHistory(7, accounts, positions, NOW);
  assert.ok(h.length >= 2 && h.length <= 3);
  assert.equal(h[0]!.at, NOW - 30 * 24 * H, "connected 30 days ago");
  assert.ok(h.every((x, i) => i === 0 || x.at > h[i - 1]!.at) && h[h.length - 1]!.at < NOW);
  assert.ok(sameHoldings(h[h.length - 1]!, snapshotOf(accounts, positions)), "the last snapshot is the portfolio as it is");
  assert.ok(h[0]!.positions.length < positions.length, "a position was added since");
  assert.ok(h.every((x) => x.cash.every((c) => c.cash >= 0)), "never negative cash");
  assert.deepEqual(fixtureHistory(accounts, positions, NOW).map((x) => x.at), [NOW - 2 * 24 * H]);
});

test("timeframes: 5Y is the longest; nominal starts; Yahoo's closes parsed, clipped, with the previous close; round axis ticks", () => {
  assert.deepEqual(EQUITY_RANGES, ["1D", "1W", "1M", "3M", "YTD", "1Y", "5Y"]);
  const now = new Date(2026, 10, 17, 15).getTime();
  assert.equal(nominalStart("1D", now), null);
  assert.equal(nominalStart("1W", now), now - 7 * 24 * H);
  assert.equal(nominalStart("YTD", now), new Date(2026, 0, 1).getTime());
  assert.equal(nominalStart("5Y", now), new Date(2021, 10, 17, 15).getTime());
  assert.deepEqual(seriesFromChart({ meta: {}, timestamp: [100, 160, 160, 220, 280], indicators: { quote: [{ close: [10, null, 11, 0, 12] }] } }), { t: [100_000, 160_000, 280_000], c: [10, 11, 12] });
  assert.deepEqual(seriesFromChart({ meta: {}, timestamp: [100, 160, 220], indicators: { quote: [{ close: [10, 11, 12] }] } }, 150_000), { t: [160_000, 220_000], c: [11, 12] });
  assert.equal(seriesFromChart({ meta: { chartPreviousClose: 9.5 }, timestamp: [100], indicators: { quote: [{ close: [10] }] } }).prev, 9.5);
  assert.deepEqual(niceTicks(97_800, 101_300, 4), [98_000, 99_000, 100_000, 101_000]);
});

test("a timeframe longer than the history keeps its span: a flat lead-in at the first real value on SPY's times, never counted in the change", () => {
  const first = NOW - 30 * 24 * H;
  const from = NOW - 365 * 24 * H;
  const spy = s([[from + 24 * H, 500], [from + 100 * 24 * H, 550], [first - 24 * H, 600], [first + H, 606], [NOW - H, 612]]);
  const real = snapshotPoints({ snapshots: [snap(first, [pos("AAPL", 10)], 0)], series: { AAPL: s([[first - 24 * H, 100], [first + H, 101], [NOW - H, 110]]) }, from, nowMs: NOW, currency: "USD", spy });
  const lead = leadIn(real.points, from, spy);
  assert.deepEqual(lead.map((p) => [p.t, p.v, p.pre]), [[from + 24 * H, 1000, true], [from + 100 * 24 * H, 1000, true], [first - 24 * H, 1000, true]], "flat at the first real value, up to the connection");
  assert.deepEqual(leadIn(real.points, first, spy), [], "the history covers the timeframe: no lead-in");
  assert.deepEqual(leadIn(real.points, from, null).map((p) => p.t), [from], "no SPY: one point at the start");
  const c = finishCurve([...lead, ...real.points], 1120, NOW, real.firstAt);
  assert.deepEqual([c.start, c.end, c.change, c.pct], [1000, 1120, 120, 12], "from the first real value, not the lead-in");
  assert.equal(Math.round(c.points[0]!.spy!), Math.round((1000 * 500) / 600), "SPY real over the whole span, meeting the curve at the connection");
  assert.equal(Math.round(c.spyPct! * 100) / 100, 2, "SPY's move from the connection: 600 -> 612");
});

test("resolution: the finest bars that keep the real part under ~250; min/max thinning keeps spikes, ends and order", () => {
  const day = 24 * H;
  assert.equal(chooseInterval(day), "5m", "a day: 5-minute");
  assert.equal(chooseInterval(7 * day), "15m", "a week: 15-minute");
  assert.equal(chooseInterval(30 * day), "60m", "30 days (inside 5Y too): hourly");
  assert.equal(chooseInterval(92 * day), "1d", "a quarter and longer: daily");
  assert.equal(chooseInterval(5 * 365 * day), "1d");
  const pts = Array.from({ length: 1000 }, (_, i) => ({ t: i, v: i === 400 ? 9999 : i === 700 ? -9999 : Math.sin(i / 10), spy: null }));
  const thin = downsample(pts, 100);
  assert.ok(thin.length <= 100);
  assert.deepEqual([thin[0]!.t, thin[thin.length - 1]!.t], [0, 999], "first and last kept");
  assert.ok(thin.some((p) => p.v === 9999) && thin.some((p) => p.v === -9999), "spikes survive");
  assert.ok(thin.every((p, i) => i === 0 || p.t > thin[i - 1]!.t), "in time order");
  assert.equal(downsample(pts.slice(0, 50), 100).length, 50, "small enough: untouched");
  const flatWithSpy = pts.map((p) => ({ ...p, v: 1, spy: p.t === 500 ? 2 : 1 }));
  assert.ok(downsample(flatWithSpy, 50, (p) => p.spy ?? p.v).some((p) => p.spy === 2), "the lead-in thins by SPY, keeping its spike");
});
