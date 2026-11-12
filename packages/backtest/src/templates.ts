/**
 * Starter strategies: the three examples verified end to end on real data
 * (scripts/examples.ts). The Strategy tab offers them as templates.
 */

import type { Strategy } from "./schema";

export const SEMIS = ["NVDA", "AMD", "AVGO", "QCOM", "TXN", "INTC", "MU", "AMAT", "LRCX", "KLAC", "ADI", "MRVL", "NXPI", "MCHP", "ON"];

export type StrategyTemplate = {
  id: string;
  /** The plain-English description the rules were written from. */
  text: string;
  rules: Strategy;
};

export const TEMPLATES: StrategyTemplate[] = [
  {
    id: "spy-200",
    text: "Hold SPY while it closes above its 200-day average, exit when it closes below",
    rules: {
      version: 1,
      name: "SPY above 200-day average",
      universe: ["SPY"],
      entry: { mode: "all", conditions: [{ type: "price_vs_ma", ticker: null, ma: "sma", period: 200, op: "above" }] },
      exit: {
        conditions: [{ type: "price_vs_ma", ticker: null, ma: "sma", period: 200, op: "below" }],
        stopLossPct: null,
        takeProfitPct: null,
        maxHoldingDays: null,
      },
      sizing: { maxPositions: 1, positionPct: null },
      rebalance: "none",
    },
  },
  {
    id: "semis-beat",
    text: "Semiconductor stocks 1 day after an earnings beat above 5%, hold 10 days",
    rules: {
      version: 1,
      name: "Semis after a 5% EPS beat, 10 days",
      universe: SEMIS,
      entry: { mode: "all", conditions: [{ type: "earnings_surprise", ticker: null, op: "above", pct: 5, daysAfter: 1 }] },
      exit: { conditions: [], stopLossPct: null, takeProfitPct: null, maxHoldingDays: 10 },
      sizing: { maxPositions: 10, positionPct: null },
      rebalance: "none",
    },
  },
  {
    id: "qqq-rsi2",
    text: "RSI(2) below 10 on QQQ, exit after 5 days",
    rules: {
      version: 1,
      name: "QQQ RSI(2) below 10, 5 days",
      universe: ["QQQ"],
      entry: { mode: "all", conditions: [{ type: "rsi", ticker: null, period: 2, op: "below", value: 10 }] },
      exit: { conditions: [], stopLossPct: null, takeProfitPct: null, maxHoldingDays: 5 },
      sizing: { maxPositions: 1, positionPct: null },
      rebalance: "none",
    },
  },
];
