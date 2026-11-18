// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/portfolio-holdings.test.ts
// The stored portfolio's pure rules: validation, keys, caps, the screenshot / broker / CSV mappings, valuation and weights.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MAX_POSITIONS,
  benchmarkChange,
  benchmarkStart,
  aiWeights,
  brokerAccountSkipped,
  brokerPosition,
  clampNumber,
  cleanImport,
  cleanPosition,
  contractLabel,
  csvImport,
  holdingsOf,
  importSummary,
  occSymbol,
  parseOcc,
  quoteSymbol,
  reviewedImport,
  screenshotImport,
  valuePortfolio,
  watchTickers,
  type PortfolioPosition,
  type Quote,
  type ScreenshotAnswer,
} from "./portfolio-holdings";

const NOW = Date.UTC(2026, 10, 17, 15);
const B = "b_0123456789abcdef01234567";
const acct = (id = B) => ({ id, name: "Individual", institution: "Broker", numberLast4: "123456789", currency: "USD", totalValue: 1000, cash: 10, buyingPower: 20, asOf: "2026-11-17T10:00:00Z" });
const pos = (p: Record<string, unknown>) => ({ accountId: B, kind: "stock", name: "", quantity: 1, ...p });

test("numbers are clamped to finite, bounded values; strings with separators are read", () => {
  assert.equal(clampNumber(1.123456789123, 1e12), 1.12345679);
  assert.equal(clampNumber("1,234.5", 1e12), 1234.5);
  assert.equal(clampNumber(Infinity, 1e12), null);
  assert.equal(clampNumber(2e12, 1e12), null);
  assert.equal(clampNumber(-5, 1e9, { min: 0 }), null);
  assert.equal(clampNumber("abc", 1e9), null);
  const p = cleanPosition(pos({ symbol: "AAPL", quantity: 1e15, price: -3, avgCost: 1e10, marketValue: "12,000.50" }), NOW)!;
  assert.equal(p.quantity, null, "a quantity beyond 1e12 is dropped, not capped");
  assert.equal(p.price, null, "a negative price is dropped");
  assert.equal(p.avgCost, null);
  assert.equal(p.marketValue, 12000.5);
});

test("accounts keep only the last 4 of the number and a known id", () => {
  const r = cleanImport({ source: "broker", accounts: [acct(), { ...acct("b_raw-snaptrade-id") }], positions: [] }, NOW);
  assert.ok(r.ok);
  assert.equal(r.value.accounts.length, 1, "an id that is not ours is dropped");
  assert.equal(r.value.accounts[0]!.numberLast4, "6789");
  assert.deepEqual(cleanImport({ source: "nope", accounts: [], positions: [] }), { ok: false, error: "Unknown import source." });
  const mixed = cleanImport({ source: "screenshot", accounts: [acct(), { id: "screenshot" }], positions: [] }, NOW);
  assert.ok(mixed.ok);
  assert.deepEqual(mixed.value.accounts.map((a) => a.id), ["screenshot"], "accounts of another source are dropped");
  const paper = cleanImport({ source: "csv", accounts: [{ id: "paper" }], positions: [] }, NOW);
  assert.ok(paper.ok && paper.value.accounts.length === 0, "an import never writes the paper account");
});

test("options keep underlying, type, strike, expiry and multiplier; the key is the OCC symbol", () => {
  assert.deepEqual(parseOcc("NVDA  261218C00150000"), { underlying: "NVDA", expiry: "2026-12-18", optionType: "call", strike: 150 });
  assert.equal(occSymbol("NVDA", "2026-12-18", "put", 152.5), "NVDA261218P00152500");
  const fromOcc = cleanPosition(pos({ kind: "option", symbol: "NVDA  261218C00150000", ticker: "NVDA", quantity: 2, multiplier: "100" }), NOW)!;
  assert.equal(fromOcc.symbol, "NVDA261218C00150000");
  assert.equal(fromOcc.ticker, "NVDA");
  assert.deepEqual([fromOcc.optionType, fromOcc.strike, fromOcc.expiry, fromOcc.multiplier], ["call", 150, "2026-12-18", 100]);
  assert.equal(contractLabel(fromOcc), "NVDA 150C 2026-12-18");
  const fromFields = cleanPosition(pos({ kind: "option", symbol: "AAPL", ticker: "AAPL", optionType: "put", strike: 200, expiry: "2027-01-15" }), NOW)!;
  assert.equal(fromFields.symbol, "AAPL270115P00200000");
  assert.equal(cleanPosition(pos({ kind: "option", symbol: "AAPL", ticker: "AAPL", optionType: "put" }), NOW), null, "an option without its full contract is dropped");
});

test("shorts keep a negative quantity; crypto never collides with a stock of the same letters", () => {
  const r = cleanImport(
    {
      source: "broker",
      accounts: [acct()],
      positions: [pos({ symbol: "COIN", quantity: -50 }), pos({ kind: "crypto", symbol: "coin", quantity: 3 }), pos({ kind: "crypto", symbol: "BTC/USD", quantity: 0.5 })],
    },
    NOW,
  );
  assert.ok(r.ok);
  const [short, coin, btc] = r.value.positions;
  assert.equal(short!.quantity, -50);
  assert.deepEqual([coin!.kind, coin!.symbol, coin!.ticker], ["crypto", "COIN", null], "same letters, a different key, no ticker");
  assert.equal(btc!.symbol, "BTC-USD");
  assert.deepEqual(watchTickers(r.value.positions), ["COIN"], "crypto does not feed the ticker list");
});

test("one row per (account, kind, symbol): duplicates add up with cost averaged; at most 200 positions", () => {
  const r = cleanImport({ source: "broker", accounts: [acct()], positions: [pos({ symbol: "AAPL", quantity: 10, avgCost: 100, marketValue: 1500 }), pos({ symbol: "aapl", quantity: 30, avgCost: 140, marketValue: 4500 })] }, NOW);
  assert.ok(r.ok);
  assert.equal(r.value.positions.length, 1);
  assert.deepEqual([r.value.positions[0]!.quantity, r.value.positions[0]!.avgCost, r.value.positions[0]!.marketValue], [40, 130, 6000]);
  const many = Array.from({ length: 260 }, (_, i) => pos({ kind: "crypto", symbol: `C${i}` }));
  const capped = cleanImport({ source: "broker", accounts: [acct()], positions: many }, NOW);
  assert.ok(capped.ok);
  assert.equal(capped.value.positions.length, MAX_POSITIONS);
  assert.deepEqual(cleanImport({ source: "broker", accounts: [acct()], positions: Array.from({ length: 401 }, () => ({})) }), { ok: false, error: "At most 200 positions." });
});

test("the screenshot reader's answer maps to the screenshot account; nothing is computed", () => {
  const answer: ScreenshotAnswer = {
    is_portfolio: true,
    account: { name: "Roth IRA", currency: "usd", total_value: 52000, cash: 1200.5, buying_power: null },
    holdings: [
      { ticker: "AAPL", name: "Apple", kind: "stock", shares: 10, value: 2300, avg_cost: 150, price: 230, unrealized_pnl: 800, currency: null, option_type: null, strike: null, expiry: null, multiplier: null, underlying: null },
      { ticker: "NVDA", name: "NVDA Dec 150 Call", kind: "option", shares: 2, value: null, avg_cost: null, price: 21.1, unrealized_pnl: null, currency: null, option_type: "CALL", strike: 150, expiry: "2026-12-18", multiplier: null, underlying: "NVDA" },
      { ticker: "SPAXX", name: "Fidelity Government Money Market", kind: "fund", shares: 100, value: 100, avg_cost: null, price: null, unrealized_pnl: null, currency: null, option_type: null, strike: null, expiry: null, multiplier: null, underlying: null },
      { ticker: "ETH", name: "Ethereum", kind: "crypto", shares: 1.5, value: null, avg_cost: null, price: null, unrealized_pnl: null, currency: null, option_type: null, strike: null, expiry: null, multiplier: null, underlying: null },
    ],
  };
  const imp = screenshotImport(answer, NOW);
  assert.equal(imp.source, "screenshot");
  assert.deepEqual(imp.accounts[0], { id: "screenshot", source: "screenshot", name: "Roth IRA", institution: null, numberLast4: null, currency: "USD", totalValue: 52000, cash: 1200.5, buyingPower: null, holdingsUnavailable: false, asOf: new Date(NOW).toISOString() });
  assert.deepEqual(imp.positions.map((p) => [p.kind, p.symbol, p.ticker]), [
    ["stock", "AAPL", "AAPL"],
    ["option", "NVDA261218C00150000", "NVDA"],
    ["crypto", "ETH", null],
  ]);
  assert.equal(imp.positions[1]!.multiplier, null, "a multiplier the screen did not show stays null");
  assert.equal(imp.positions[0]!.currency, "USD", "a row without its own currency takes the account's");
  assert.deepEqual(holdingsOf(imp), [
    { ticker: "AAPL", name: "Apple", shares: 10, value: 2300 },
    { ticker: "NVDA", name: "" },
  ], "the routes' holdings stay one row per ticker for the iPhone app");
  assert.equal(importSummary(imp), "Added 3 positions and 1 account balance.");
});

test("a SnapTrade position maps with P&L from reported price and cost; cash and paper or closed accounts are skipped", () => {
  const option = brokerPosition(
    {
      units: "-2",
      price: "3.5",
      cost_basis: "5",
      currency: "USD",
      instrument: { kind: "option", symbol: "AAPL  270115P00200000", option_type: "PUT", strike_price: "200", expiration_date: "2027-01-15", multiplier: "100", underlying: { kind: "stock", symbol: "AAPL" } },
    },
    B,
    "2026-11-17T10:00:00Z",
  )!;
  assert.equal(option.marketValue, -700);
  assert.equal(option.unrealizedPnl, 300, "a short put that fell gained (3.5 - 5) x -2 x 100");
  const p = cleanPosition(option, NOW)!;
  assert.deepEqual([p.kind, p.symbol, p.ticker, p.optionType, p.quantity], ["option", "AAPL270115P00200000", "AAPL", "put", -2]);
  assert.equal(brokerPosition({ cash_equivalent: true, instrument: { kind: "mutualfund", symbol: "SPAXX" } }, B, null), null);
  assert.equal(brokerPosition({ instrument: { kind: "cash", symbol: "USD" } }, B, null), null);
  const btc = cleanPosition(brokerPosition({ units: "0.5", price: "90000", instrument: { kind: "crypto", symbol: "BTC" } }, B, null), NOW)!;
  assert.deepEqual([btc.kind, btc.symbol, btc.ticker, btc.marketValue, btc.unrealizedPnl], ["crypto", "BTC", null, 45000, null], "no cost basis, no P&L");
  assert.equal(brokerAccountSkipped({ is_paper: true, status: "open" }), true);
  assert.equal(brokerAccountSkipped({ is_paper: false, status: "closed" }), true);
  assert.equal(brokerAccountSkipped({ is_paper: false, status: "open" }), false);
});

test("CSV rows map to the csv account; the welcome review keeps what is still listed", () => {
  const imp = csvImport(
    [
      { ticker: "AAPL", name: "Apple", shares: 10, value: 2300, avgCost: 150, price: 230, currency: "USD" },
      { ticker: "MSFT", name: "Microsoft", shares: -5, value: -2500, avgCost: 400, price: 500, currency: null },
      { ticker: "SPAXX**", name: "Money market", shares: 1, value: 1, avgCost: null, price: null, currency: null },
    ],
    NOW,
  );
  assert.deepEqual(imp.positions.map((p) => [p.symbol, p.quantity]), [
    ["AAPL", 10],
    ["MSFT", -5],
  ]);
  const reviewed = reviewedImport(imp, [{ ticker: "AAPL", name: "Apple", shares: 12 }]);
  assert.deepEqual(reviewed.positions.map((p) => [p.symbol, p.quantity, p.marketValue]), [["AAPL", 12, null]], "removed rows go; an edited share count replaces the quantity");
  const untouched = reviewedImport(imp, holdingsOf(imp));
  assert.deepEqual(untouched.positions, imp.positions, "nothing edited, nothing changed (a short keeps its quantity)");
});

const valued = (positions: Partial<PortfolioPosition>[]) =>
  positions.map((p) => cleanPosition({ accountId: B, name: "", currency: "USD", ...p }, NOW)!).filter(Boolean);

test("value = quantity x live price x contract size; weights use the largest currency group, shorts negative", () => {
  const positions = valued([
    { kind: "stock", symbol: "AAPL", quantity: 10, avgCost: 100 },
    { kind: "stock", symbol: "INTC", quantity: -10, avgCost: 50 },
    { kind: "option", symbol: "AAPL261218C00150000", ticker: "AAPL", quantity: 1, avgCost: 10, price: 12 },
    { kind: "stock", symbol: "THYAO.IS", quantity: 10, currency: "TRY" },
    { kind: "crypto", symbol: "BTC", quantity: 0.1, avgCost: 50000 },
  ]);
  const q = (price: number, change: number | null = null): Quote => ({ price, change, changePct: null, currency: "USD", at: NOW, source: "live" });
  const quotes: Record<string, Quote> = { AAPL: q(200, 2), INTC: q(40), "BTC-USD": q(60000), "THYAO.IS": { ...q(300), currency: "TRY" } };
  const v = valuePortfolio(positions, quotes);
  const by = Object.fromEntries(v.positions.map((p) => [p.symbol, p]));
  assert.equal(by.AAPL!.value, 2000);
  assert.equal(by.AAPL!.dayChange, 20);
  assert.equal(by.INTC!.value, -400);
  assert.equal(by.INTC!.unrealized, 100, "a short that fell is a gain");
  assert.equal(by.AAPL261218C00150000!.value, 1200, "no option quote: the import price x 100");
  assert.equal(by.AAPL261218C00150000!.priceSource, "import");
  assert.equal(by["THYAO.IS"]!.weight, null, "another currency has no weight");
  assert.equal(v.weightCurrency, "USD");
  const gross = 2000 + 400 + 1200 + 6000;
  assert.ok(Math.abs(by.AAPL!.weight! - (2000 / gross) * 100) < 1e-9);
  assert.ok(by.INTC!.weight! < 0);
  assert.equal(v.totals[0]!.currency, "USD");
  assert.equal(v.totals[1]!.currency, "TRY", "no FX: the other currency has its own total");
  assert.equal(quoteSymbol({ kind: "stock", symbol: "BRK.B", ticker: "BRK.B", currency: null }), "BRK-B");

  const ai = aiWeights(v);
  assert.deepEqual(ai.find((w) => w.ticker === "AAPL"), { ticker: "AAPL", kind: "equity", weightPct: Math.round(((2000 + 1200) / gross) * 100), unrealisedPct: Math.round(((1000 + 200) / (1000 + 1000)) * 100) });
  assert.deepEqual(ai.find((w) => w.ticker === "BTC"), { ticker: "BTC", kind: "crypto", weightPct: Math.round((6000 / gross) * 100), unrealisedPct: 20 });
  assert.equal(ai.find((w) => w.ticker === "THYAO.IS")!.weightPct, null);
  for (const w of ai) for (const value of Object.values(w)) assert.ok(typeof value !== "number" || Number.isInteger(value), "whole percents only");
});

test("the benchmark window: from the start date, none under a day old, closes then a live price", () => {
  const now = Date.UTC(2026, 10, 17, 15);
  assert.equal(benchmarkStart(["2026-11-14T21:00:00Z", "2026-11-16T10:00:00Z", null], now), "2026-11-14", "the earliest date");
  assert.equal(benchmarkStart([new Date(now - 3_600_000).toISOString()], now), null, "under a day: no comparison");
  assert.equal(benchmarkStart([null], now), null);
  const bars: [string, number][] = [
    ["2026-11-13", 100],
    ["2026-11-14", 110],
    ["2026-11-16", 115.5],
  ];
  assert.equal(Math.round(benchmarkChange(bars, "2026-11-14")! * 100) / 100, 5, "first close on or after the start, to the last close");
  assert.equal(benchmarkChange(bars, "2026-11-15"), null, "only the start's own close: nothing to compare yet");
  assert.equal(Math.round(benchmarkChange(bars, "2026-11-15", 121.275)! * 100) / 100, 5, "a live price ends the window");
  assert.equal(benchmarkChange(bars, "2026-12-01", 120), null, "no close from the start on");
});
