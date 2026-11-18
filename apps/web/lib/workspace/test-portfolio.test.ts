// Run: cd packages/engine && node --import tsx --test ../../apps/web/lib/workspace/test-portfolio.test.ts
// The ⌘P test portfolio (development only): its bounds, the option and crypto rules, the cash, and that it touches no storage.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { quoteSymbol } from "../portfolio-holdings";
import {
  TEST_ACCOUNT_IDS,
  TEST_BOUNDS,
  TEST_COINS,
  TEST_ETFS,
  TEST_STOCKS,
  buildTestPortfolio,
  nearestContract,
  pickExpiry,
  planTestPortfolio,
  type TestContract,
} from "./test-portfolio";

const NOW = Date.UTC(2026, 10, 17, 15);
const AS_OF = new Date(NOW).toISOString();
const SEEDS = Array.from({ length: 400 }, (_, i) => i * 7919 + 1);

/** A reference price for every pool name (the server passes the previous close). */
const REFS: Record<string, number> = Object.fromEntries([
  ...TEST_STOCKS.map((s, i) => [s.ticker.replace(".", "-"), 50 + i * 23.5] as const),
  ...TEST_ETFS.map((e, i) => [e.ticker, 80 + i * 61] as const),
  ["BTC-USD", 91_000],
  ["ETH-USD", 3_100],
]);

const contractFor = (ticker: string, call: boolean): TestContract => ({ symbol: `${ticker}261218${call ? "C" : "P"}00150000`, ticker, call, strike: 150, expiry: "2026-12-18", price: 7.4 });

function build(seed: number) {
  const plan = planTestPortfolio(seed);
  const contract = plan.option ? contractFor(plan.option.ticker, plan.option.call) : null;
  return { plan, ...buildTestPortfolio(plan, REFS, contract, AS_OF) };
}

test("the same seed gives the same portfolio; different seeds differ", () => {
  assert.deepEqual(build(42), build(42));
  const shapes = new Set(SEEDS.slice(0, 40).map((s) => build(s).positions.map((p) => `${p.symbol}:${p.quantity}`).join(",")));
  assert.ok(shapes.size > 35, "a new random set on each toggle-on");
});

test("6 to 14 positions from the pool, mostly stocks, 1 to 3 ETFs, each name once, quantities and costs within bounds", () => {
  const stocks = new Set(TEST_STOCKS.map((s) => s.ticker));
  const etfs = new Set(TEST_ETFS.map((e) => e.ticker));
  for (const seed of SEEDS) {
    const { positions } = build(seed);
    assert.ok(positions.length >= TEST_BOUNDS.minPositions && positions.length <= TEST_BOUNDS.maxPositions, `seed ${seed}: ${positions.length} positions`);
    assert.equal(new Set(positions.map((p) => p.symbol)).size, positions.length, "no name twice");
    const byKind = (k: string) => positions.filter((p) => p.kind === k);
    assert.ok(byKind("etf").length >= 1 && byKind("etf").length <= 3);
    assert.ok(byKind("stock").length >= 2 && byKind("stock").length >= byKind("etf").length - 1);
    for (const p of positions) {
      assert.ok(p.quantity !== null && p.quantity > 0, "long positions only");
      assert.ok(p.avgCost !== null && p.avgCost > 0);
      if (p.kind === "stock") assert.ok(stocks.has(p.symbol) && p.ticker === p.symbol);
      if (p.kind === "etf") assert.ok(etfs.has(p.symbol));
      if (p.kind === "option") continue;
      const ref = REFS[quoteSymbol(p)!]!;
      assert.ok(p.avgCost! >= ref * (1 - TEST_BOUNDS.costSpread) - 0.01 && p.avgCost! <= ref * (1 + TEST_BOUNDS.costSpread) + 0.01, `${p.symbol}: cost within ±40% of the price`);
      const value = p.quantity! * ref;
      assert.ok(value >= TEST_BOUNDS.minValue * 0.5 - ref && value <= TEST_BOUNDS.maxValue + ref, `${p.symbol}: $${Math.round(value)} sized near $2k to $60k`);
    }
  }
});

test("about half the portfolios hold one option on a held stock, 1 to 3 months out; about half hold BTC and/or ETH", () => {
  let options = 0;
  let crypto = 0;
  for (const seed of SEEDS) {
    const { positions } = build(seed);
    const opts = positions.filter((p) => p.kind === "option");
    assert.ok(opts.length <= 1, "at most one option");
    if (opts.length) {
      options++;
      const o = opts[0]!;
      assert.ok(positions.some((p) => p.kind === "stock" && p.ticker === o.ticker), "on one of the held stocks");
      assert.deepEqual([o.multiplier, o.strike, o.expiry, o.price], [100, 150, "2026-12-18", 7.4]);
      assert.ok(o.quantity! >= 1 && o.quantity! <= 10);
      assert.ok(o.avgCost! >= 0.05 && o.avgCost! <= 7.4 * 1.4 + 0.01);
    }
    const coins = positions.filter((p) => p.kind === "crypto");
    assert.ok(coins.length <= 2 && coins.every((c) => TEST_COINS.some((t) => t.symbol === c.symbol) && c.ticker === null));
    if (coins.length) crypto++;
  }
  assert.ok(options > SEEDS.length * 0.35 && options < SEEDS.length * 0.65, `options in ${options} of ${SEEDS.length}`);
  assert.ok(crypto > SEEDS.length * 0.35 && crypto < SEEDS.length * 0.65, `crypto in ${crypto} of ${SEEDS.length}`);
  // No contract found: no option, never a made-up one.
  const seed = SEEDS.find((s) => planTestPortfolio(s).option)!;
  assert.ok(!buildTestPortfolio(planTestPortfolio(seed), REFS, null, AS_OF).positions.some((p) => p.kind === "option"));
});

test("the expiry falls 1 to 3 months out among the listed ones; the strike is the one nearest the price with a usable price", () => {
  const day = 86_400;
  const now = NOW / 1000;
  const listed = [7, 14, 30, 45, 60, 88, 120, 200].map((d) => now + d * day);
  assert.equal(pickExpiry(listed, NOW, 0), now + 30 * day);
  assert.equal(pickExpiry(listed, NOW, 0.99), now + 88 * day);
  assert.equal(pickExpiry([now + 7 * day, now + 200 * day], NOW, 0.5), null, "none in the window");
  const chain = [
    { strike: 140, bid: 9, ask: 10 },
    { strike: 150, bid: 0, ask: 0, lastPrice: 0 },
    { strike: 155, bid: 2, ask: 3 },
    { strike: 160, lastPrice: 1.2 },
  ];
  assert.deepEqual(nearestContract(chain, 151), { contract: chain[2], price: 2.5 }, "150 has no price: 155 is the nearest usable");
  assert.deepEqual(nearestContract(chain, 300)?.price, 1.2, "the last trade when there is no bid and ask");
  assert.equal(nearestContract([], 100), null);
});

test("cash of $1k to $50k over 1 or 2 test accounts, never the paper account; a name without a price is left out", () => {
  let two = 0;
  for (const seed of SEEDS) {
    const { accounts, positions } = build(seed);
    const cash = accounts.reduce((s, a) => s + (a.cash ?? 0), 0);
    assert.ok(cash >= TEST_BOUNDS.minCash - 0.01 && cash <= TEST_BOUNDS.maxCash + 0.01, `seed ${seed}: $${cash}`);
    assert.ok(accounts.length === 1 || accounts.length === 2);
    assert.ok(accounts.every((a) => (TEST_ACCOUNT_IDS as readonly string[]).includes(a.id) && a.source === "broker" && (a.cash ?? 0) > 0));
    assert.ok(positions.every((p) => accounts.some((a) => a.id === p.accountId)), "every position sits in one of its accounts");
    if (accounts.length === 2) two++;
  }
  assert.ok(two > 0 && two < SEEDS.length);
  const plan = planTestPortfolio(5);
  const none = buildTestPortfolio(plan, {}, null, AS_OF);
  assert.deepEqual(none.positions, [], "no reference prices, no sizes");
  assert.equal(none.accounts.length, plan.cash.length);
});

test("it never touches storage, the network or the database", () => {
  const touched: string[] = [];
  const trap = (name: string) => new Proxy({}, { get: (_t, k) => (touched.push(`${name}.${String(k)}`), () => undefined) });
  const g = globalThis as Record<string, unknown>;
  const saved = { localStorage: g.localStorage, sessionStorage: g.sessionStorage, fetch: g.fetch, indexedDB: g.indexedDB };
  Object.assign(g, { localStorage: trap("localStorage"), sessionStorage: trap("sessionStorage"), indexedDB: trap("indexedDB"), fetch: () => (touched.push("fetch"), Promise.reject(new Error("no"))) });
  try {
    for (const seed of SEEDS.slice(0, 50)) build(seed);
  } finally {
    Object.assign(g, saved);
  }
  assert.deepEqual(touched, []);
  const source = readFileSync(new URL("./test-portfolio.ts", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "");
  for (const word of ["localStorage", "sessionStorage", "indexedDB", "fetch(", "supabase", "document.cookie", "import(", "require("]) assert.ok(!source.includes(word), `no ${word} in the generator`);
  assert.ok(!/^import (?!type)/m.test(source), "the generator imports types only");
});
