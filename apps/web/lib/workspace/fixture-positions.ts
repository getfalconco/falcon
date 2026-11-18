import type { PortfolioAccount, PortfolioPosition } from "../portfolio-holdings";

/**
 * Development only: a sample portfolio with sizes for the preview
 * (/app?preview=1&sizes=1), so the Dashboard's POSITIONS card and Settings >
 * Portfolio can be looked at with real-looking rows. Read only by
 * GET /api/portfolio/holdings under `next dev` (a dynamic import inside a
 * NODE_ENV check, dropped from production builds). Quantities and costs are
 * made up for the preview; live prices still come from the quote source.
 *
 * FIXTURE_TICKERS is the ticker-only variant (/app?preview=1&tickers=1): a
 * list with no sizes, as older imports have, read by the Workspace's preview
 * list behind the same NODE_ENV check. Its live prices come from the quote source.
 */

export const FIXTURE_TICKERS: readonly { ticker: string; name: string }[] = [
  { ticker: "AAPL", name: "Apple Inc." },
  { ticker: "NVDA", name: "NVIDIA Corp" },
  { ticker: "MSFT", name: "Microsoft Corp" },
  { ticker: "AMD", name: "Advanced Micro Devices" },
  { ticker: "TSM", name: "Taiwan Semiconductor Manufacturing" },
  { ticker: "QQQ", name: "Invesco QQQ Trust" },
];

const AS_OF = "2026-11-14T21:00:00.000Z";

export const FIXTURE_ACCOUNTS: PortfolioAccount[] = [
  {
    id: "b_000000000000000000000001",
    source: "broker",
    name: "Individual",
    institution: "Sample Brokerage",
    numberLast4: "4821",
    currency: "USD",
    totalValue: 85_000,
    cash: 12_480.22,
    buyingPower: 24_960.44,
    holdingsUnavailable: false,
    asOf: AS_OF,
  },
  {
    id: "screenshot",
    source: "screenshot",
    name: "Roth IRA",
    institution: null,
    numberLast4: null,
    currency: "USD",
    totalValue: null,
    cash: 1_250,
    buyingPower: null,
    holdingsUnavailable: false,
    asOf: AS_OF,
  },
];

const base = { ticker: null, name: "", avgCost: null, price: null, marketValue: null, unrealizedPnl: null, currency: "USD", optionType: null, strike: null, expiry: null, multiplier: null, asOf: AS_OF } as const;
const B = "b_000000000000000000000001";

/**
 * About $97k: NVDA well above a 10% cap (about 22%), INTC down about 17% from
 * its cost (at mid-November 2026 prices), the rest under the cap, and cash in
 * both accounts. Live prices move these a little.
 */
export const FIXTURE_POSITIONS: PortfolioPosition[] = [
  { ...base, accountId: B, kind: "stock", symbol: "NVDA", ticker: "NVDA", name: "NVIDIA Corp", quantity: 143, avgCost: 120 },
  { ...base, accountId: B, kind: "stock", symbol: "AAPL", ticker: "AAPL", name: "Apple Inc.", quantity: 25, avgCost: 300 },
  { ...base, accountId: B, kind: "stock", symbol: "INTC", ticker: "INTC", name: "Intel Corp", quantity: 155, avgCost: 65.8 },
  { ...base, accountId: B, kind: "stock", symbol: "MSFT", ticker: "MSFT", name: "Microsoft Corp", quantity: 16, avgCost: 450 },
  { ...base, accountId: B, kind: "stock", symbol: "AMD", ticker: "AMD", name: "Advanced Micro Devices", quantity: 14, avgCost: 300 },
  { ...base, accountId: B, kind: "stock", symbol: "TSM", ticker: "TSM", name: "Taiwan Semiconductor Manufacturing", quantity: 16, avgCost: 250 },
  {
    ...base,
    accountId: B,
    kind: "option",
    symbol: "NVDA261218C00150000",
    ticker: "NVDA",
    name: "NVDA Dec 18 2026 150 Call",
    quantity: 2,
    avgCost: 12,
    price: 14.8,
    optionType: "call",
    strike: 150,
    expiry: "2026-12-18",
    multiplier: 100,
  },
  { ...base, accountId: B, kind: "crypto", symbol: "BTC", name: "Bitcoin", quantity: 0.08, avgCost: 52_000 },
  { ...base, accountId: "screenshot", kind: "etf", symbol: "QQQ", ticker: "QQQ", name: "Invesco QQQ Trust", quantity: 14, avgCost: 560 },
  { ...base, accountId: "screenshot", kind: "etf", symbol: "SPY", ticker: "SPY", name: "SPDR S&P 500 ETF", quantity: 11, avgCost: 640 },
];
