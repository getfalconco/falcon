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
  CLOSED_MS,
  finishCurve,
  historyStart,
  nearestIndex,
  niceTicks,
  nominalStart,
  rangeCoverage,
  sessionsBetween,
  sameHoldings,
  snapshotOf,
  snapshotPoints,
  snapshotsInRange,
  timeScale,
  timeTicks,
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

test("the chart starts on the account's first day: nothing before it, SPY rebased there, the change from there", () => {
  const first = NOW - 4 * 24 * H;
  const from = NOW - 30 * 24 * H;
  const spy = s([[from + 24 * H, 500], [from + 10 * 24 * H, 550], [first - 24 * H, 600], [first + H, 606], [NOW - H, 612]]);
  const real = snapshotPoints({ snapshots: [snap(first, [pos("AAPL", 10)], 0)], series: { AAPL: s([[first - 24 * H, 100], [first + H, 101], [NOW - H, 110]]) }, from, nowMs: NOW, currency: "USD", spy });
  assert.equal(real.points[0]!.t, first, "the real points start at the first snapshot, not the timeframe's start");
  // An older server's flat lead-in (Oct 22 to the connection) is dropped, curve and SPY alike.
  const lead = [{ t: from + 24 * H, v: 1000, spy: 500 }, { t: from + 10 * 24 * H, v: 1000, spy: 550 }];
  const c = finishCurve([...lead, ...real.points], 1120, NOW, real.firstAt);
  assert.ok(c.points.every((p) => p.t >= first), "no point before the account's first day");
  assert.equal(c.points[0]!.t, first);
  assert.deepEqual([c.start, c.end, c.change, c.pct], [1000, 1120, 120, 12], "the change counts from the first day");
  assert.equal(c.points[0]!.spy, 1000, "SPY starts at the account's value on its first day");
  assert.equal(Math.round(c.spyPct! * 100) / 100, 2, "SPY's move from the first day: the close in force there (600) to 612");
  assert.equal(historyStart("1M", first, from), first, "the label: Since ...");
  assert.equal(historyStart("1W", first, NOW - 3 * 24 * H), null, "a timeframe inside the history keeps its name");
});

test("timeframes before the account: the shortest that covers it says Since, longer ones would repeat it", () => {
  const now = new Date(2026, 10, 22, 15).getTime();
  assert.deepEqual(rangeCoverage(new Date(2026, 10, 18, 10).getTime(), now), { "1D": "full", "1W": "since", "1M": "same", "3M": "same", YTD: "same", "1Y": "same", "5Y": "same" });
  assert.deepEqual(rangeCoverage(new Date(2026, 8, 1).getTime(), now), { "1D": "full", "1W": "full", "1M": "full", "3M": "since", YTD: "same", "1Y": "same", "5Y": "same" });
  assert.deepEqual(Object.values(rangeCoverage(null, now)), Array(7).fill("full"), "no history yet: nothing to mark");
});

test("x by time, not by index: calendar time for daily timeframes, 18 days 18 times as wide as one", () => {
  const ts = [Date.UTC(2026, 9, 22), Date.UTC(2026, 10, 9), Date.UTC(2026, 10, 18), Date.UTC(2026, 10, 19)];
  for (const range of ["1M", "3M", "YTD", "1Y", "5Y"] as const) {
    const x = timeScale(range, ts);
    assert.equal(x.kind, "calendar");
    const w = (a: number, b: number) => x.at(ts[b]!) - x.at(ts[a]!);
    assert.ok(Math.abs(w(0, 1) / w(2, 3) - 18) < 1e-9, `${range}: Oct 22 to Nov 9 is 18 times Nov 18 to Nov 19`);
  }
  const x = timeScale("1M", ts);
  assert.deepEqual([x.at(ts[0]!), x.at(ts[3]!), x.at(ts[0]! - H), x.at(ts[3]! + H)], [0, 1, 0, 1], "the ends, clamped");
  assert.equal(x.invert(x.at(ts[2]!)), ts[2], "invert undoes at");
  assert.equal(timeScale("1M", [ts[0]!]).at(ts[0]!), 0, "one point: no division by zero");
});

test("trading time for 1D and 1W: sessions at full width, a night or a weekend shrunk to half an hour, holidays left out", () => {
  // Fri Nov 13 and Mon Nov 16 2026, New York 9:30 to 16:00 (14:30 to 21:00 UTC).
  const fri = Date.UTC(2026, 10, 13, 14, 30);
  const mon = Date.UTC(2026, 10, 16, 14, 30);
  const ts = [fri, fri + 6 * H, mon, mon + 6 * H];
  const x = timeScale("1W", ts);
  assert.equal(x.kind, "trading");
  const unit = 1 / (6.5 * H + CLOSED_MS + 6 * H);
  assert.ok(Math.abs(x.at(fri + 6.5 * H) - 6.5 * H * unit) < 1e-9, "Friday's session at full width");
  assert.ok(Math.abs(x.at(mon) - (6.5 * H + CLOSED_MS) * unit) < 1e-9, "the weekend: half an hour wide");
  const sat = Date.UTC(2026, 10, 14, 12);
  assert.ok(x.at(sat) > x.at(fri + 6.5 * H) && x.at(sat) < x.at(mon), "a point on the weekend keeps its place inside the gap");
  for (const t of [fri + H, sat, mon + 3 * H]) assert.ok(Math.abs(x.invert(x.at(t)) - t) < 1, "invert undoes at");
  // Thanksgiving week: Thursday Nov 26 closed, Friday Nov 27 closes at 13:00.
  const days = sessionsBetween(Date.UTC(2026, 10, 23), Date.UTC(2026, 10, 28)).map((d) => d.day);
  assert.deepEqual(days, ["2026-11-23", "2026-11-24", "2026-11-25", "2026-11-27"]);
  const early = sessionsBetween(Date.UTC(2026, 10, 27), Date.UTC(2026, 10, 28))[0]!;
  assert.equal(early.close - early.open, 3.5 * H, "the early close");
  // A 24/7 curve (crypto only) stays on calendar time.
  const hourly = Array.from({ length: 7 * 24 }, (_, i) => Date.UTC(2026, 10, 13) + i * H);
  assert.equal(timeScale("1W", hourly).kind, "calendar");
  assert.equal(timeScale("1D", [Date.UTC(2026, 10, 17, 14, 29, 59, 999), ...Array.from({ length: 78 }, (_, i) => Date.UTC(2026, 10, 17, 14, 30) + i * 5 * M)]).kind, "trading");
});

test("date ticks by time: round moments, the finest step that fits, sessions for 1W, hours inside the session for 1D", () => {
  const label = (range: Parameters<typeof timeScale>[0], a: number, b: number) => timeTicks(timeScale(range, [a, b]), 5).map((k) => k.label);
  assert.deepEqual(label("1M", new Date(2026, 9, 23, 10).getTime(), new Date(2026, 10, 22, 15).getTime()), ["Oct 26", "Nov 2", "Nov 9", "Nov 16"], "a month: Mondays");
  assert.deepEqual(label("1M", new Date(2026, 10, 18, 10).getTime(), new Date(2026, 10, 22, 15).getTime()), ["Nov 19", "Nov 20", "Nov 21", "Nov 22"], "since Nov 18: days");
  assert.deepEqual(label("1Y", new Date(2025, 10, 22).getTime(), new Date(2026, 10, 22).getTime()), ["2026", "Apr", "Jul", "Oct"], "a year: quarters, January as the year");
  assert.deepEqual(label("5Y", new Date(2021, 10, 22).getTime(), new Date(2026, 10, 22).getTime()), ["2022", "2023", "2024", "2025", "2026"]);
  assert.deepEqual(label("1M", new Date(2026, 10, 22, 10, 32).getTime(), new Date(2026, 10, 22, 10, 50).getTime()), ["10:32 AM"], "opened minutes ago: its start");
  const week = timeTicks(timeScale("1W", [Date.UTC(2026, 10, 23, 14, 30), Date.UTC(2026, 10, 27, 18)]), 5);
  assert.deepEqual(week.map((k) => k.label), ["Nov 23", "Nov 24", "Nov 25", "Nov 27"], "one per session, Thanksgiving left out");
  assert.equal(week[0]!.t, Date.UTC(2026, 10, 23, 14, 30), "at the session's open");
  const open = Date.UTC(2026, 10, 17, 14, 30);
  const x = timeScale("1D", Array.from({ length: 79 }, (_, i) => open + i * 5 * M));
  const day = timeTicks(x, 5);
  assert.ok(day.length >= 3 && day.length <= 5, "1D: a few hours");
  assert.ok(day.every((k) => k.t >= open && k.t <= open + 6.5 * H && new Date(k.t).getMinutes() === 0), "whole hours inside the session");
  for (let i = 1; i < day.length; i++) assert.ok(x.at(day[i]!.t) > x.at(day[i - 1]!.t), "in order on the axis");
});

test("hover snaps to the point nearest in time", () => {
  const ts = [0, 10, 11, 100];
  assert.deepEqual([nearestIndex(ts, -5), nearestIndex(ts, 4), nearestIndex(ts, 6), nearestIndex(ts, 10.6), nearestIndex(ts, 60), nearestIndex(ts, 500)], [0, 0, 1, 2, 3, 3]);
  assert.equal(nearestIndex([], 3), -1);
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
