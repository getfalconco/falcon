import type { PortfolioAccount, PortfolioPosition } from "../portfolio-holdings";

/**
 * Development only: the random test portfolio behind ⌘P (Ctrl+P) in the
 * Workspace, so the founder can try the Dashboard card on many shapes of
 * portfolio. Pure: a seeded plan (which names, how many, whether an option
 * and coins), then sizes from live reference prices. Nothing here reads or
 * writes storage, the network or the database; the server
 * (lib/test-portfolio-server.ts, under `next dev` only) passes in the live
 * prices and the option contract, and the result is valued like any stored
 * portfolio, held in the browser's memory only (lib/workspace/holdings.ts).
 *
 * The rules:
 *   6 to 14 positions from a pool of liquid, well-covered names: mostly
 *   large-cap stocks, 1 to 3 ETFs, about half the time 1 option on one of
 *   the held stocks (strike nearest the live price, expiry 1 to 3 months
 *   out), about half the time BTC and/or ETH.
 *   Quantities sized to $2k to $60k a position; the average cost within
 *   ±40% of the reference price, so gains and losses vary.
 *   Cash of $1k to $50k over 1 or 2 accounts.
 */

export const TEST_STOCKS: readonly { ticker: string; name: string }[] = [
  { ticker: "AAPL", name: "Apple Inc." },
  { ticker: "MSFT", name: "Microsoft Corp" },
  { ticker: "NVDA", name: "NVIDIA Corp" },
  { ticker: "AMZN", name: "Amazon.com Inc." },
  { ticker: "GOOGL", name: "Alphabet Inc." },
  { ticker: "META", name: "Meta Platforms Inc." },
  { ticker: "TSLA", name: "Tesla Inc." },
  { ticker: "AVGO", name: "Broadcom Inc." },
  { ticker: "AMD", name: "Advanced Micro Devices" },
  { ticker: "TSM", name: "Taiwan Semiconductor Manufacturing" },
  { ticker: "JPM", name: "JPMorgan Chase & Co." },
  { ticker: "V", name: "Visa Inc." },
  { ticker: "MA", name: "Mastercard Inc." },
  { ticker: "LLY", name: "Eli Lilly and Co." },
  { ticker: "UNH", name: "UnitedHealth Group" },
  { ticker: "XOM", name: "Exxon Mobil Corp" },
  { ticker: "COST", name: "Costco Wholesale" },
  { ticker: "WMT", name: "Walmart Inc." },
  { ticker: "NFLX", name: "Netflix Inc." },
  { ticker: "ORCL", name: "Oracle Corp" },
  { ticker: "CRM", name: "Salesforce Inc." },
  { ticker: "KO", name: "Coca-Cola Co." },
  { ticker: "BAC", name: "Bank of America" },
  { ticker: "DIS", name: "Walt Disney Co." },
  { ticker: "INTC", name: "Intel Corp" },
  { ticker: "BRK.B", name: "Berkshire Hathaway" },
];

export const TEST_ETFS: readonly { ticker: string; name: string }[] = [
  { ticker: "SPY", name: "SPDR S&P 500 ETF" },
  { ticker: "QQQ", name: "Invesco QQQ Trust" },
  { ticker: "VTI", name: "Vanguard Total Stock Market ETF" },
  { ticker: "IWM", name: "iShares Russell 2000 ETF" },
  { ticker: "SCHD", name: "Schwab US Dividend Equity ETF" },
  { ticker: "GLD", name: "SPDR Gold Shares" },
  { ticker: "XLK", name: "Technology Select Sector SPDR" },
];

export const TEST_COINS: readonly { symbol: string; name: string }[] = [
  { symbol: "BTC", name: "Bitcoin" },
  { symbol: "ETH", name: "Ethereum" },
];

export const TEST_BOUNDS = {
  minPositions: 6,
  maxPositions: 14,
  minValue: 2_000,
  maxValue: 60_000,
  costSpread: 0.4,
  minCash: 1_000,
  maxCash: 50_000,
  minOptionDays: 28,
  maxOptionDays: 95,
} as const;

/** The test accounts' ids: never the paper account's, never stored. */
export const TEST_ACCOUNT_IDS = ["test_individual", "test_roth"] as const;

/** A seeded random source in [0, 1) (mulberry32). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const int = (rng: () => number, lo: number, hi: number) => lo + Math.floor(rng() * (hi - lo + 1));

function sample<T>(rng: () => number, list: readonly T[], n: number): T[] {
  const pool = [...list];
  const out: T[] = [];
  while (out.length < n && pool.length) out.push(pool.splice(Math.floor(rng() * pool.length), 1)[0]!);
  return out;
}

export type TestPlan = {
  stocks: { ticker: string; name: string }[];
  etfs: { ticker: string; name: string }[];
  coins: { symbol: string; name: string }[];
  /** An option on one of `stocks`: call or put, and where in the 1 to 3 month window its expiry falls (0 to 1). */
  option: { ticker: string; call: boolean; expiryPick: number } | null;
  /** One amount per account, $1k to $50k in all. */
  cash: number[];
  /** Per sized position (stocks, ETFs, coins, then the option): its value target, cost factor and account. */
  draws: { value: number; costFactor: number; account: number }[];
};

/** Pure: the seeded plan; the same seed gives the same plan. */
export function planTestPortfolio(seed: number): TestPlan {
  const rng = seededRandom(seed);
  const b = TEST_BOUNDS;
  const n = int(rng, b.minPositions, b.maxPositions);
  const coinCount = rng() < 0.5 ? int(rng, 1, 2) : 0;
  const optionCount = rng() < 0.5 ? 1 : 0;
  const etfCount = Math.max(1, Math.min(int(rng, 1, 3), n - coinCount - optionCount - 2));
  const stockCount = n - coinCount - optionCount - etfCount;
  const stocks = sample(rng, TEST_STOCKS, stockCount);
  const etfs = sample(rng, TEST_ETFS, etfCount);
  const coins = sample(rng, TEST_COINS, coinCount);
  const option = optionCount ? { ticker: stocks[Math.floor(rng() * stocks.length)]!.ticker, call: rng() < 0.7, expiryPick: rng() } : null;
  const accounts = rng() < 0.5 ? 1 : 2;
  const cashTotal = Math.round((b.minCash + rng() * (b.maxCash - b.minCash)) * 100) / 100;
  const first = accounts === 1 ? cashTotal : Math.round(cashTotal * (0.3 + rng() * 0.5) * 100) / 100;
  const cash = accounts === 1 ? [cashTotal] : [first, Math.round((cashTotal - first) * 100) / 100];
  const draws = Array.from({ length: n }, () => ({
    value: b.minValue + rng() * (b.maxValue - b.minValue),
    costFactor: 1 + (rng() * 2 - 1) * b.costSpread,
    account: accounts === 1 ? 0 : rng() < 0.65 ? 0 : 1,
  }));
  return { stocks, etfs, coins, option, cash, draws };
}

/** One listed contract, as the server picked it from the live chain. */
export type TestContract = { symbol: string; ticker: string; call: boolean; strike: number; expiry: string; price: number };

/** Pure: the expiry (epoch seconds) 1 to 3 months out at `pick` (0 to 1) along the listed ones; null when none is listed in the window. */
export function pickExpiry(expiries: readonly number[], nowMs: number, pick: number): number | null {
  const day = 86_400;
  const now = nowMs / 1000;
  const inWindow = expiries.filter((e) => e - now >= TEST_BOUNDS.minOptionDays * day && e - now <= TEST_BOUNDS.maxOptionDays * day).sort((a, b) => a - b);
  if (!inWindow.length) return null;
  return inWindow[Math.min(inWindow.length - 1, Math.floor(pick * inWindow.length))]!;
}

/** Pure: the contract whose strike is nearest `price`, among those with a usable price (mid of bid and ask, else the last trade). */
export function nearestContract<T extends { strike?: number; bid?: number; ask?: number; lastPrice?: number }>(contracts: readonly T[], price: number): { contract: T; price: number } | null {
  let best: { contract: T; price: number; gap: number } | null = null;
  for (const c of contracts) {
    if (typeof c.strike !== "number" || !Number.isFinite(c.strike)) continue;
    const mid = (c.bid ?? 0) > 0 && (c.ask ?? 0) > 0 ? (c.bid! + c.ask!) / 2 : (c.lastPrice ?? 0) > 0 ? c.lastPrice! : null;
    if (mid === null) continue;
    const gap = Math.abs(c.strike - price);
    if (!best || gap < best.gap) best = { contract: c, price: mid, gap };
  }
  return best ? { contract: best.contract, price: best.price } : null;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/**
 * Pure: the plan sized from reference prices (`refs`, keyed by quote symbol:
 * BRK-B, BTC-USD), with the server's contract for the option. A name without
 * a reference price is left out (nothing is sized against a made-up price);
 * the option too when no contract was found.
 */
export function buildTestPortfolio(plan: TestPlan, refs: Readonly<Record<string, number>>, contract: TestContract | null, asOf: string): { accounts: PortfolioAccount[]; positions: PortfolioPosition[] } {
  const accounts: PortfolioAccount[] = plan.cash.map((cash, i) => ({
    id: TEST_ACCOUNT_IDS[i]!,
    source: "broker",
    // Reads like any brokerage account: no "test" wording reaches the UI.
    name: i === 0 ? "Individual" : "Roth IRA",
    institution: null,
    numberLast4: null,
    currency: "USD",
    totalValue: null,
    cash,
    buyingPower: null,
    holdingsUnavailable: false,
    asOf,
  }));
  const base = { name: "", price: null, marketValue: null, unrealizedPnl: null, currency: "USD", optionType: null, strike: null, expiry: null, multiplier: null, asOf } as const;
  const positions: PortfolioPosition[] = [];
  let d = 0;
  const draw = () => plan.draws[d++ % plan.draws.length]!;
  const accountOf = (i: number) => accounts[Math.min(i, accounts.length - 1)]!.id;

  const equity = (kind: "stock" | "etf", t: { ticker: string; name: string }) => {
    const x = draw();
    const ref = refs[t.ticker.replace(".", "-")];
    if (!ref || ref <= 0) return;
    positions.push({ ...base, accountId: accountOf(x.account), kind, symbol: t.ticker, ticker: t.ticker, name: t.name, quantity: Math.max(1, Math.round(x.value / ref)), avgCost: round(ref * x.costFactor, 2) });
  };
  for (const s of plan.stocks) equity("stock", s);
  for (const e of plan.etfs) equity("etf", e);
  for (const c of plan.coins) {
    const x = draw();
    const ref = refs[`${c.symbol}-USD`];
    if (!ref || ref <= 0) continue;
    positions.push({ ...base, accountId: accountOf(x.account), kind: "crypto", symbol: c.symbol, ticker: null, name: c.name, quantity: Math.max(0.0001, round(x.value / ref, 4)), avgCost: round(ref * x.costFactor, 2) });
  }
  if (plan.option && contract && contract.ticker === plan.option.ticker) {
    const x = draw();
    const contracts = Math.max(1, Math.min(10, Math.round(x.value / (contract.price * 100))));
    positions.push({
      ...base,
      accountId: accountOf(x.account),
      kind: "option",
      symbol: contract.symbol,
      ticker: contract.ticker,
      name: `${contract.ticker} ${contract.expiry} ${contract.strike} ${contract.call ? "Call" : "Put"}`,
      quantity: contracts,
      avgCost: Math.max(0.05, round(contract.price * x.costFactor, 2)),
      price: round(contract.price, 2),
      optionType: contract.call ? "call" : "put",
      strike: contract.strike,
      expiry: contract.expiry,
      multiplier: 100,
    });
  }
  return { accounts, positions };
}

/** A fresh seed for each toggle-on. */
export function newTestSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}
