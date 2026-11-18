// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/workspace/positions-view.test.ts
// The Portfolio Overview's rows: combined across accounts, ticker-only rows, groups, the total, the line under it, the table rows and formats.
import assert from "node:assert/strict";
import { test } from "node:test";
import { cleanPosition, valuePortfolio, type PortfolioPosition, type Quote } from "../portfolio-holdings";
import {
  COLUMN_FROM,
  accountWeights,
  capText,
  cashLine,
  cashRows,
  compactMoney,
  compactNumber,
  dayLine,
  gainLine,
  groupRows,
  lineText,
  money,
  nextSort,
  overviewColumns,
  overviewModel,
  pctText,
  positionRows,
  searchRows,
  signedMoney,
  sortRows,
  todayLine,
  weightText,
  type LinePart,
  type OverviewRow,
} from "./positions-view";

const B1 = "b_000000000000000000000001";
const NOW = Date.UTC(2026, 10, 17, 15);
const q = (price: number, changePct: number | null = null, change: number | null = null, extra: Partial<Quote> = {}): Quote => ({ price, change, changePct, currency: "USD", at: NOW, source: "live", ...extra });
const text = (parts: LinePart[] | null) => (parts ? lineText(parts) : null);
const strong = (parts: LinePart[] | null) => (parts ?? []).filter((p) => p.em).map((p) => p.text);
const make = (rows: Partial<PortfolioPosition>[]) => rows.map((p) => cleanPosition({ accountId: B1, name: "", currency: "USD", ...p }, NOW)!);

const positions = make([
  { kind: "stock", symbol: "AMD", quantity: 100, avgCost: 50 },
  { kind: "stock", symbol: "AAPL", quantity: 10, avgCost: 100 },
  { accountId: "screenshot", kind: "stock", symbol: "AAPL", quantity: 10, avgCost: 140 },
  { kind: "etf", symbol: "QQQ", quantity: 1, avgCost: 400 },
  { kind: "option", symbol: "NVDA261218C00150000", ticker: "NVDA", quantity: 1, avgCost: 10, price: 12 },
  { kind: "crypto", symbol: "BTC", quantity: 0.01 },
]);
const quotes: Record<string, Quote> = { AMD: q(150, 1, 1.5), AAPL: q(200, -1, -2), QQQ: q(500), "BTC-USD": q(80000), MSFT: q(500, 0.5) };
const valuation = valuePortfolio(positions, quotes);

test("one row per instrument across accounts; tickers without a size get their own row with a live price", () => {
  const rows = positionRows(valuation.positions, { tickers: ["AAPL", "MSFT"], quotes: { MSFT: q(500, 0.5) }, names: { MSFT: "Microsoft" } });
  const aapl = rows.find((r) => r.symbol === "AAPL")!;
  assert.equal(aapl.quantity, 20);
  assert.equal(aapl.value, 4000);
  assert.equal(aapl.avgCost, 120, "average cost across accounts, weighted by quantity");
  assert.equal(aapl.unrealized, 1600);
  assert.equal(aapl.accounts.length, 2);
  const msft = rows.find((r) => r.symbol === "MSFT")!;
  assert.deepEqual([msft.tickerOnly, msft.quantity, msft.value, msft.weight, msft.lastPrice, msft.dayChangePct, msft.name], [true, null, null, null, 500, 0.5, "Microsoft"]);
  assert.equal(rows.filter((r) => r.symbol === "AAPL").length, 1, "a held ticker is not listed twice");
  const option = rows.find((r) => r.kind === "option")!;
  assert.deepEqual([option.label, option.ticker, option.group], ["NVDA 150C 2026-12-18", "NVDA", "options"]);
  const btc = rows.find((r) => r.kind === "crypto")!;
  assert.deepEqual([btc.label, btc.ticker, btc.group], ["BTC", null, "crypto"]);
  const one = positionRows(valuation.positions, { accountIds: new Set(["screenshot"]) });
  assert.deepEqual(one.map((r) => [r.symbol, r.quantity]), [["AAPL", 10]], "an account filter keeps only that account's rows");
});

test("groups come in a fixed order, sorted by value, with subtotals; search matches symbol or name", () => {
  const rows = positionRows(valuation.positions, { tickers: ["MSFT"], quotes });
  const groups = groupRows(rows);
  assert.deepEqual(groups.map((g) => g.id), ["stocks", "etfs", "options", "crypto"]);
  assert.deepEqual(groups[0]!.rows.map((r) => r.symbol), ["AMD", "AAPL", "MSFT"], "largest weight first, ticker-only rows last");
  assert.equal(groups[0]!.value, 15000 + 4000);
  assert.deepEqual(searchRows(rows, "nvda").map((r) => r.kind), ["option"]);
  assert.deepEqual(searchRows(rows, "  ").length, rows.length);
});

test("formats", () => {
  assert.equal(money(399509.36), "$399,509.36");
  assert.equal(money(-12, "EUR"), "-€12.00");
  assert.equal(money(5, "CHF"), "5.00 CHF");
  assert.equal(weightText(0.01), "<0.1%");
  assert.equal(weightText(-2.24), "-2.2%");
  assert.equal(compactMoney(3.42e12), "$3.42T");
  assert.equal(compactMoney(812e9), "$812B");
  assert.equal(compactMoney(81.24e9), "$81.2B");
  assert.equal(compactMoney(3.4e12), "$3.4T", "trailing zeros dropped");
  assert.equal(compactMoney(2.1e9, "CHF"), "2.1B CHF");
  assert.equal(compactNumber(48_213_000), "48.2M");
  assert.equal(compactNumber(950), "950");
  assert.equal(compactNumber(1_200), "1.2K");
  assert.equal(compactNumber(999_600), "1M", "rounds up into the next unit");
  assert.equal(compactNumber(10_000_000), "10M");
  assert.equal(signedMoney(-412.4, "USD", 0), "-$412");
  assert.equal(signedMoney(0.3, "USD", 0), "$0", "no sign on a move that rounds to zero");
  assert.equal(pctText(-0.001), "0.00%", "nor on a % that rounds to zero");
  assert.equal(pctText(-1.234, 1), "-1.2%");
});


/** A row for the line builders: the fields they read. */
const lr = (label: string, f: { unrealized?: number; dayChange?: number; dayChangePct?: number; value?: number; kind?: "stock" | "option" }) => ({
  label,
  ticker: label.split(" ")[0]!,
  kind: f.kind ?? ("stock" as const),
  dayChangePct: f.dayChangePct ?? null,
  unrealized: f.unrealized ?? null,
  dayChange: f.dayChange ?? null,
  value: f.value ?? null,
  currency: "USD",
});
const w10 = () => 10;

test("the overview rows: value, weight of the whole account (cash included), today's position move, market data", () => {
  const market: Record<string, Quote> = {
    ...quotes,
    AMD: q(150, 1, 1.5, { marketCap: 243e9, volume: 48_200_000, name: "Advanced Micro Devices, Inc." }),
    NVDA261218C00150000: q(12, 5, 0.6, { marketCap: 1e9, volume: 1200 }),
    "BTC-USD": q(80000, 2, 1600, { marketCap: 1.6e12, volume: 3.1e10 }),
  };
  const v = valuePortfolio(positions, market);
  const rows = positionRows(v.positions, { tickers: ["MSFT"], quotes });
  // Values: AMD 15000, AAPL 4000, QQQ 500, option 1200, BTC 800 = 21500; cash 1000: account 22500.
  const m = overviewModel({ rows, cash: 1000, cashByCurrency: [{ currency: "USD", amount: 1000 }], mainCurrency: "USD", market, cap: 10, nowMs: NOW });
  assert.equal(m.total, 22500, "positions plus cash");
  assert.deepEqual(m.groups.map((g) => [g.id, g.rows.map((r) => r.label)]), [
    ["stocks", ["AMD", "AAPL"]],
    ["etfs", ["QQQ"]],
    ["options", ["NVDA 150C 2026-12-18"]],
    ["crypto", ["BTC"]],
  ], "a sized portfolio lists its holdings only, largest value first");
  const amd = m.groups[0]!.rows[0]!;
  assert.deepEqual([amd.value, amd.dayMove, amd.changePct, amd.marketCap, amd.volume, amd.name, amd.ticker], [15000, 150, 1, 243e9, 48_200_000, "Advanced Micro Devices, Inc.", "AMD"]);
  assert.equal(Math.round(amd.weight! * 100) / 100, Math.round((15000 / 22500) * 10000) / 100, "share of the whole account, cash included");
  assert.equal(amd.overCap, true);
  const aapl = m.groups[0]!.rows[1]!;
  assert.deepEqual([aapl.dayMove, aapl.overCap], [20 * -2, true], "20 shares down $2 each, across both accounts");
  const option = m.groups[2]!.rows[0]!;
  assert.deepEqual([option.value, option.dayMove, option.marketCap, option.name, option.ticker], [1200, 60, null, "", "NVDA"], "a contract: x100 for value and move, no market cap");
  const btc = m.groups[3]!.rows[0]!;
  assert.deepEqual([btc.dayMove, btc.marketCap, btc.ticker, btc.quoteSymbol], [16, 1.6e12, null, "BTC-USD"]);
  assert.equal(Math.round(m.cash[0]!.weight! * 100) / 100, Math.round((1000 / 22500) * 10000) / 100, "cash has its share too");
  const total = [...m.groups.flatMap((g) => g.rows.map((r) => r.weight ?? 0)), m.cash[0]!.weight!].reduce((a, b) => a + b, 0);
  assert.equal(Math.round(total * 1e6) / 1e6, 100, "weights and cash add up to the account");
});

test("today's position move: long, short and an option's multiplier", () => {
  const ps = make([
    { kind: "stock", symbol: "AAPL", quantity: 30, avgCost: 200 },
    { kind: "stock", symbol: "TSLA", quantity: -10, avgCost: 400 },
    { kind: "option", symbol: "AMD261218P00150000", ticker: "AMD", quantity: 2, avgCost: 5 },
  ]);
  const qs: Record<string, Quote> = { AAPL: q(250, -1, -2.5), TSLA: q(380, -2, -7.76), AMD261218P00150000: q(6, 10, 0.55) };
  const rows = overviewModel({ rows: positionRows(valuePortfolio(ps, qs).positions), cash: null, mainCurrency: "USD", market: qs, nowMs: NOW }).groups.flatMap((g) => g.rows);
  const move = (l: string) => rows.find((r) => r.label.startsWith(l))!.dayMove;
  assert.equal(move("AAPL"), -75, "30 x -$2.50");
  assert.equal(move("TSLA"), 77.6, "a short gains when the price falls: -10 x -$7.76");
  assert.equal(move("AMD"), 110, "2 contracts x $0.55 x 100");
  const tickersOnly = overviewModel({ rows: positionRows([], { tickers: ["AAPL"], quotes: qs }), cash: null, mainCurrency: null, market: qs, nowMs: NOW }).groups[0]!.rows[0]!;
  assert.deepEqual([tickersOnly.value, tickersOnly.weight, tickersOnly.dayMove, tickersOnly.changePct], [null, null, null, -1], "ticker-only: % only");
});

test("account weights: one helper, cash included, shorts by their size, other currencies left out; the cap's tooltip", () => {
  const rows = [
    { value: 6000, currency: "USD", tickerOnly: false },
    { value: -2000, currency: "USD", tickerOnly: false },
    { value: 5000, currency: "EUR", tickerOnly: false },
    { value: null, currency: "USD", tickerOnly: true },
  ];
  const w = accountWeights(rows, 2000, "USD");
  assert.equal(w.gross, 10000);
  assert.deepEqual([w.of(6000, "USD"), w.of(-2000, "USD"), w.of(5000, "EUR"), w.of(null, "USD"), w.cash], [60, 20, null, null, 20]);
  assert.deepEqual(accountWeights([], 50_000, "USD").cash, 100, "a cash-only account is 100% cash");
  assert.equal(accountWeights([], null, "USD").of(100, "USD"), null);
  assert.equal(capText(22.4, 10), "22% of the account, above your 10% cap");
  assert.equal(capText(10, 10), null, "at the cap is fine");
  assert.equal(capText(null, 10), null);
});

test("columns: Stock, Value, Weight and Change % always; Market Cap goes first as the card narrows, then Volume, Price, Last 7 Days, the $ move", () => {
  const shown = (w: number) => Object.entries(overviewColumns(w)).filter(([k, v]) => k !== "market" && v).map(([k]) => k).sort().join(",");
  assert.equal(shown(1000), "cap,dollar,price,spark,volume");
  assert.equal(shown(COLUMN_FROM.cap - 1), "dollar,price,spark,volume");
  assert.equal(shown(COLUMN_FROM.volume - 1), "dollar,price,spark");
  assert.equal(shown(COLUMN_FROM.price - 1), "dollar,spark");
  assert.equal(shown(610), "dollar,spark", "half a wide row: Stock, Value, Weight, Change % + $ and Last 7 Days");
  assert.equal(shown(COLUMN_FROM.spark - 1), "dollar");
  assert.equal(shown(COLUMN_FROM.dollar - 1), "");
  assert.equal(overviewColumns(200).market, true);
  const order = Object.entries(COLUMN_FROM).sort((a, b) => b[1] - a[1]).map(([k]) => k);
  assert.deepEqual(order, ["cap", "volume", "price", "spark", "dollar"], "the drop order");
});

test("the since-you-bought line, the contributor's share and weight; calm when down; even", () => {
  assert.equal(text(gainLine([lr("AMD", { unrealized: 600, value: 1 }), lr("NVDA", { unrealized: 400, value: 1 })], 1000, "USD", w10)), "Up $1,000.00 since you bought. 60% of the gains from AMD, 10% of your account.");
  assert.equal(text(gainLine([lr("AMD", { unrealized: 1500 }), lr("INTC", { unrealized: -500 })], 1000, "USD")), "Up $1,000.00 since you bought. Led by AMD.", "never more than 100% of the gains; no weight when unknown");
  assert.equal(text(gainLine([lr("AMD", { unrealized: 1000, value: 1 })], 1000, "USD", w10)), "Up $1,000.00 since you bought. All of it from AMD, 10% of your account.");
  assert.equal(text(gainLine([lr("INTC", { unrealized: -700, value: 1 }), lr("AAPL", { unrealized: -300, value: 1 })], -1000, "USD", w10)), "Down $1,000.00 since you bought. Most of it from INTC, 10% of your account.");
  assert.equal(text(gainLine([lr("INTC", { unrealized: -400 }), lr("AAPL", { unrealized: -350 }), lr("MSFT", { unrealized: -250 })], -1000, "USD")), "Down $1,000.00 since you bought. 40% of it from INTC.");
  assert.equal(text(gainLine([lr("A", { unrealized: 0.001 }), lr("B", { unrealized: -0.001 })], 0, "USD")), "Even with what you paid.");
  assert.equal(gainLine([], null, "USD"), null);
  const optionAndStock = gainLine([lr("NVDA", { unrealized: 300, value: 1 }), lr("NVDA 150C", { unrealized: 300, value: 1, kind: "option" }), lr("AAPL", { unrealized: 400, value: 1 })], 1000, "USD", w10);
  assert.equal(text(optionAndStock), "Up $1,000.00 since you bought. 60% of the gains from NVDA, 20% of your account.", "a stock and its options count together, weights too");
});

test("the today line: the largest move in money, with its own % and weight; last session; flat", () => {
  const rows = [lr("NVDA", { dayChange: -900, dayChangePct: -1.5, value: 1 }), lr("CRM", { dayChange: -300, dayChangePct: -8.6, value: 1 }), lr("AAPL", { dayChange: -40, dayChangePct: -0.2, value: 1 })];
  const line = todayLine(rows, -1240, "USD", "today", (r) => (r.value ? 25 : null));
  assert.equal(text(line), "Today: down $1,240. Most of it from NVDA (-1.5%), 25% of your account.", "a very large position can move the most money on a small %");
  assert.deepEqual(line.filter((p) => p.tone).map((p) => [p.text, p.tone]), [["$1,240", "down"]]);
  assert.equal(text(todayLine([lr("CRM", { dayChange: 500, dayChangePct: 3 }), lr("AAPL", { dayChange: 500, dayChangePct: 1 })], 1000, "USD", "last session")), "Last session: up $1,000. 50% of the gains from CRM (+3.0%).");
  assert.equal(text(todayLine(rows, 0.2, "USD", "today")), "Today: flat.");
});

test("which period the line speaks of: today while the market is open, since you bought otherwise, today without a cost basis", () => {
  const ps = make([
    { kind: "stock", symbol: "NVDA", quantity: 100, avgCost: 100 },
    { kind: "stock", symbol: "CRM", quantity: 10, avgCost: 300 },
  ]);
  const qs: Record<string, Quote> = { NVDA: q(150, -1, -1.5), CRM: q(250, -8.6, -23.5) };
  const rows = positionRows(valuePortfolio(ps, qs).positions);
  const open = overviewModel({ rows, cash: null, mainCurrency: "USD", market: qs, marketOpen: true, nowMs: NOW });
  assert.equal(open.linePeriod, "today");
  assert.equal(text(open.line), "Today: down $385. Most of it from CRM (-8.6%), 14% of your account.");
  const closed = overviewModel({ rows, cash: null, mainCurrency: "USD", market: qs, marketOpen: false, nowMs: NOW });
  assert.equal(closed.linePeriod, "sinceBought");
  assert.equal(text(closed.line), "Up $4,500.00 since you bought. Led by NVDA, 86% of your account.");
  const noCost = positionRows(valuePortfolio(make([{ kind: "stock", symbol: "CRM", quantity: 10 }]), qs).positions);
  assert.equal(overviewModel({ rows: noCost, cash: null, mainCurrency: "USD", market: qs, marketOpen: false, nowMs: NOW }).linePeriod, "today", "no cost basis: today's moves");
});

test("the indicator: since you bought against the total cost; today against yesterday's account value (cash included); always there with a total", () => {
  // Cost 100 x $100 + 10 x $300 = $13,000; now 100 x $150 + 10 x $250 = $17,500, cash $2,500: total $20,000.
  const ps = make([
    { kind: "stock", symbol: "NVDA", quantity: 100, avgCost: 100 },
    { kind: "stock", symbol: "CRM", quantity: 10, avgCost: 300 },
  ]);
  const qs: Record<string, Quote> = { NVDA: q(150, -1, -1.5), CRM: q(250, -8.6, -23.5) };
  const m = overviewModel({ rows: positionRows(valuePortfolio(ps, qs).positions), cash: 2500, mainCurrency: "USD", market: qs, nowMs: NOW });
  assert.equal(m.total, 20000);
  assert.deepEqual(m.indicator!.sinceBought, { amount: 4500, pct: (4500 / 13000) * 100, tone: "up" }, "+$4,500 on $13,000 paid: +34.6%");
  // Today: -150 + -235 = -$385; yesterday the account was $20,385.
  assert.deepEqual(m.indicator!.today, { amount: -385, pct: (-385 / 20385) * 100, tone: "down", when: "today" });
  const even = overviewModel({ rows: positionRows(valuePortfolio(make([{ kind: "stock", symbol: "AAPL", quantity: 10, avgCost: 200 }]), quotes).positions), cash: null, mainCurrency: "USD", market: quotes, nowMs: NOW });
  assert.equal(even.indicator!.sinceBought!.tone, "flat", "exactly even: grey, never hidden");
  const noCost = overviewModel({ rows: positionRows(valuePortfolio(make([{ kind: "stock", symbol: "AAPL", quantity: 10 }]), quotes).positions), cash: null, mainCurrency: "USD", market: quotes, nowMs: NOW });
  assert.deepEqual([noCost.indicator!.sinceBought, noCost.indicator!.today!.amount], [null, -20], "no cost basis: today only");
  const weekend = overviewModel({ rows: positionRows(valuePortfolio(make([{ kind: "stock", symbol: "AAPL", quantity: 10 }]), quotes).positions), cash: null, mainCurrency: "USD", market: quotes, nowMs: Date.UTC(2026, 10, 21, 16) });
  assert.equal(weekend.indicator!.today!.when, "last session");
  assert.deepEqual(overviewModel({ rows: [], cash: 10_000, mainCurrency: "USD", paper: true, nowMs: NOW }).indicator, { sinceBought: null, today: null }, "paper cash only: $0.00 · 0.00%");
  assert.equal(overviewModel({ rows: positionRows([], { tickers: ["AAPL"], quotes }), cash: null, mainCurrency: null, nowMs: NOW }).indicator, null, "no total, no indicator");
});

test("the day line: counts over rows with a change, today or the last session, one holding, all and none", () => {
  const rows = (pcts: (number | null)[], group: "stocks" | "crypto" = "stocks") => pcts.map((p, i) => ({ label: `T${i}`, group, dayChangePct: p, quoteSymbol: `T${i}` }));
  const market = (at: number) => Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`T${i}`, q(10, 0, 0, { at })]));
  assert.equal(text(dayLine(rows([1, 2, -1, 3, 0.5, -2]), market(NOW), NOW)), "4 of your 6 stocks are up today.");
  assert.deepEqual(strong(dayLine(rows([1, 2, -1, 3, 0.5, -2]), market(NOW), NOW)), ["4", "6"]);
  assert.equal(text(dayLine(rows([1, -1, null]), market(NOW), NOW)), "1 of your 2 stocks is up today.", "a row without a change is not counted");
  assert.equal(text(dayLine(rows([1, 2, 3]), market(NOW), NOW)), "All 3 of your stocks are up today.");
  assert.equal(text(dayLine(rows([1, 2]), market(NOW), NOW)), "Both of your stocks are up today.");
  assert.equal(text(dayLine(rows([-1, -2, 0]), market(NOW), NOW)), "None of your 3 stocks are up today.");
  assert.equal(text(dayLine(rows([-1.25]), market(NOW), NOW)), "T0 is down 1.3% today.");
  const saturday = Date.UTC(2026, 10, 21, 16);
  assert.equal(text(dayLine(rows([1, -1, 2]), market(NOW - 86_400_000), saturday)), "2 of your 3 stocks are up in the last session.", "quotes from an earlier day");
  assert.equal(text(dayLine([...rows([1, 2]), { label: "BTC", group: "crypto", dayChangePct: -1, quoteSymbol: "BTC-USD" }], market(NOW), NOW)), "2 of your 3 holdings are up today.");
  assert.equal(dayLine(rows([null, null]), market(NOW), NOW), null);
});

test("ticker-only: no total, the day line and the full table sorted by symbol, Value and Weight empty", () => {
  const qs = { MSFT: q(500, 0.5), AAPL: q(271.3, -1.25), NVDA: q(190, 2) };
  const m = overviewModel({ rows: positionRows([], { tickers: ["NVDA", "MSFT", "AAPL"], quotes: qs }), cash: null, mainCurrency: null, market: qs, marketOpen: true, nowMs: NOW });
  assert.deepEqual([m.sized, m.total, m.gain, m.cashOnly, m.indicator], [false, null, null, false, null]);
  assert.deepEqual(m.groups.map((g) => g.rows.map((r) => [r.label, r.price, r.changePct, r.value, r.weight])), [[["AAPL", 271.3, -1.25, null, null], ["MSFT", 500, 0.5, null, null], ["NVDA", 190, 2, null, null]]]);
  assert.equal(text(m.line), "2 of your 3 stocks are up today.");
});

test("cash only: the total is the cash, a paper line, only the Cash group", () => {
  const paper = overviewModel({ rows: [], cash: 50_000, cashByCurrency: [{ currency: "USD", amount: 50_000 }], mainCurrency: "USD", paper: true, nowMs: NOW });
  assert.deepEqual([paper.sized, paper.total, paper.gain, paper.cashOnly, paper.groups.length, paper.cash[0]!.weight], [true, 50_000, null, true, 0, 100]);
  assert.equal(text(paper.line), "Your paper account is ready. $50,000 to put to work.");
  assert.deepEqual(strong(paper.line), ["$50,000"]);
  assert.equal(text(cashLine(12_480.22, "USD", false)), "All in cash: $12,480.22.");
  assert.deepEqual(
    cashRows([{ cash: 12_480.22, currency: "USD" }, { cash: 2_000, currency: "EUR" }, { cash: 1_250, currency: null }, { cash: null, currency: "GBP" }, { cash: 0, currency: "JPY" }], "USD"),
    [{ currency: "USD", amount: 13_730.22 }, { currency: "EUR", amount: 2_000 }],
    "one row per currency, the main one first; none for no or zero cash",
  );
  assert.deepEqual(cashRows([{ cash: 150_000, currency: "JPY" }, { cash: 10, currency: "CAD" }, { cash: 5, currency: "USD" }], "USD").map((r) => r.currency), ["USD", "CAD", "JPY"], "then by code");
});

test("sorting: natural direction first, reversed, then the default (by value); a missing number is always last; ties keep the default order", () => {
  const row = (label: string, value: number | null, weight: number | null, price: number | null, changePct: number | null, marketCap: number | null, volume: number | null): OverviewRow => ({
    key: label, group: "stocks", kind: "stock", symbol: label, label, name: "", ticker: label, quoteSymbol: label,
    value, currency: "USD", weight, overCap: false, dayMove: null, changePct, price, priceCurrency: "USD", marketCap, volume,
  });
  // The default order (by value) as the model gives it.
  const rows = [row("NVDA", 9000, 45, 150, -1.2, 3.7e12, 180e6), row("AAPL", 5000, 25, 350, null, 5.1e12, 13e6), row("INTC", -3000, 15, 54, 2, null, 50e6), row("MSFT", null, null, 500, 0.5, 3.7e12, null)];
  const labels = (r: OverviewRow[]) => r.map((x) => x.label);
  assert.deepEqual(nextSort(null, "stock"), { key: "stock", dir: "asc" }, "Stock starts A–Z");
  assert.deepEqual(nextSort(null, "value"), { key: "value", dir: "desc" }, "numbers start largest first");
  assert.deepEqual(nextSort({ key: "value", dir: "desc" }, "value"), { key: "value", dir: "asc" });
  assert.equal(nextSort({ key: "value", dir: "asc" }, "value"), null, "third click: back to the default");
  assert.deepEqual(nextSort({ key: "price", dir: "asc" }, "weight"), { key: "weight", dir: "desc" }, "another column starts fresh");
  assert.deepEqual(labels(sortRows(rows, null)), ["NVDA", "AAPL", "INTC", "MSFT"]);
  assert.deepEqual(labels(sortRows(rows, { key: "stock", dir: "asc" })), ["AAPL", "INTC", "MSFT", "NVDA"]);
  assert.deepEqual(labels(sortRows(rows, { key: "value", dir: "asc" })), ["INTC", "AAPL", "NVDA", "MSFT"], "a short ranks by its size; — last");
  assert.deepEqual(labels(sortRows(rows, { key: "weight", dir: "desc" })), ["NVDA", "AAPL", "INTC", "MSFT"]);
  assert.deepEqual(labels(sortRows(rows, { key: "price", dir: "desc" })), ["MSFT", "AAPL", "NVDA", "INTC"]);
  assert.deepEqual(labels(sortRows(rows, { key: "change", dir: "desc" })), ["INTC", "MSFT", "NVDA", "AAPL"], "— last");
  assert.deepEqual(labels(sortRows(rows, { key: "change", dir: "asc" })), ["NVDA", "MSFT", "INTC", "AAPL"], "— last ascending too");
  assert.deepEqual(labels(sortRows(rows, { key: "cap", dir: "desc" })), ["AAPL", "NVDA", "MSFT", "INTC"], "a tie keeps the default order; — last");
  assert.deepEqual(labels(sortRows(rows, { key: "volume", dir: "asc" })), ["AAPL", "INTC", "NVDA", "MSFT"]);
  assert.deepEqual(labels(rows), ["NVDA", "AAPL", "INTC", "MSFT"], "the input is not changed");
});

test("no test, sample or demo wording in anything the card or the ⌘P portfolio can show", async () => {
  const { buildTestPortfolio, planTestPortfolio } = await import("./test-portfolio");
  const refs = new Proxy({}, { get: () => 100 }) as Record<string, number>;
  const words = /\b(test|sample|demo)\b/i;
  for (let seed = 1; seed < 60; seed++) {
    const plan = planTestPortfolio(seed);
    const contract = plan.option ? { symbol: `${plan.option.ticker}261218C00100000`, ticker: plan.option.ticker, call: true, strike: 100, expiry: "2026-12-18", price: 5 } : null;
    const { accounts, positions } = buildTestPortfolio(plan, refs, contract, new Date(NOW).toISOString());
    for (const a of accounts) assert.ok(!words.test(`${a.name} ${a.institution ?? ""}`), `account "${a.name}"`);
    for (const p of positions) assert.ok(!words.test(`${p.name} ${p.symbol}`), p.name);
    const m = overviewModel({ rows: positionRows(valuePortfolio(positions, {}, accounts).positions), cash: 1000, mainCurrency: "USD", nowMs: NOW });
    assert.ok(!words.test(text(m.line) ?? ""));
  }
  const { readFileSync } = await import("node:fs");
  const card = readFileSync(new URL("../../app/app/_components/tabs/PositionsCard.tsx", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  const strings = card.match(/"[^"]*"|`[^`]*`|>[^<>{}]+</g) ?? [];
  assert.deepEqual(strings.filter((t) => words.test(t)), [], "no such words in the card's text");
});
