/**
 * Twelve starter strategies (design 3.1), also the audit's expressiveness set
 * (design 8, M1b acceptance 4), written as StrategySpec v2. The Strategy tab
 * offers them in alphabetical order; tests check every one compiles and
 * scripts/expressiveness.ts runs them on real data. Typed lists here are
 * examples a person would type; they carry the hindsight flag like any list.
 */

import { blankSpec, type ParamSpec, type StrategySpecV2 } from "./spec";

const int = (value: number, min: number, max: number, step = 1): ParamSpec => ({ type: "int", value, min, max, step });
const pct = (value: number, min: number, max: number, step = 0.5): ParamSpec => ({ type: "pct", value, min, max, step });
const num = (value: number, min: number, max: number, step = 0.01): ParamSpec => ({ type: "number", value, min, max, step });

function rules(name: string, tickers: string[], params: Record<string, ParamSpec>, entry: string, exit: string | null, more: Partial<StrategySpecV2> = {}, port: Record<string, unknown> = {}): StrategySpecV2 {
  return {
    ...blankSpec(),
    name,
    intent: name,
    universe: { kind: "static", tickers },
    params,
    portfolio: { mode: "rules", entry, exit, max_positions: tickers.length, clock: "close", reentry: "edge", tiebreak: "seeded", sizing: "equal", ...port } as StrategySpecV2["portfolio"],
    ...more,
  };
}

const noRisk = { stop_pct: null, trailing_pct: null, take_profit_pct: null, max_hold_days: null };

export type Starter = { id: string; text: string; spec: StrategySpecV2 };

export const EXPRESSIVENESS: Starter[] = [
  {
    id: "golden-cross",
    text: "Golden cross on SPY: hold while the 50-day average is above the 200-day",
    spec: rules("SPY golden cross", ["SPY"], { fast: int(50, 10, 100), slow: int(200, 100, 300, 10) }, "crosses_above(ts_mean(close, $fast), ts_mean(close, $slow))", "crosses_below(ts_mean(close, $fast), ts_mean(close, $slow))"),
  },
  {
    id: "rsi2-200",
    text: "RSI(2) below 10 on SPY above its 200-day average, exit when RSI(2) is above 70",
    spec: rules("SPY RSI(2) with 200-day filter", ["SPY"], { rsi_len: int(2, 2, 14), rsi_lo: num(10, 1, 40, 1), rsi_hi: num(70, 50, 95, 1), trend: int(200, 50, 300, 10) }, "rsi(close, $rsi_len) < $rsi_lo and close > ts_mean(close, $trend)", "rsi(close, $rsi_len) > $rsi_hi"),
  },
  {
    id: "tsm-after-nvda",
    text: "Buy TSM after NVDA's earnings reaction beats the market by 3%, hold 5 days",
    spec: rules("TSM after an NVDA earnings reaction", ["TSM"], { react: pct(3, 0, 20) }, 'of("NVDA", earnings.reaction_abn) > $react', null, { risk: { ...noRisk, max_hold_days: 5 } }),
  },
  {
    id: "qqq-3-down",
    text: "QQQ after 3 down closes in a row, hold 5 days",
    spec: rules("QQQ after 3 down closes", ["QQQ"], { downs: int(3, 2, 6) }, "streak(close < delay(close, 1)) >= $downs", null, { risk: { ...noRisk, max_hold_days: 5 } }),
  },
  {
    id: "sector-top3",
    text: "Top 3 of the 11 sector SPDRs by 6-month return, monthly",
    spec: {
      ...blankSpec(),
      name: "Top 3 sector ETFs by 6-month return",
      intent: "Top 3 of the 11 sector SPDRs by 6-month return, monthly",
      universe: { kind: "rule", base: "sector_etfs", filter: null },
      params: { lookback: int(126, 21, 252), n: int(3, 1, 6) },
      portfolio: { mode: "rank", score: "ret(close, $lookback)", order: "desc", select: { n: "$n" }, filter: null, weighting: "equal" },
      rebalance: "monthly",
    },
  },
  {
    id: "dual-momentum",
    text: "Dual momentum: SPY or EFA when it beats T-bills over 12 months, else AGG, monthly",
    spec: {
      ...blankSpec(),
      name: "Dual momentum SPY / EFA / AGG",
      intent: "Dual momentum",
      universe: { kind: "static", tickers: ["SPY", "EFA", "AGG"] },
      params: { lb: int(252, 63, 252, 21) },
      defs: { spy_mom: 'at("SPY", ret(close, $lb))', efa_mom: 'at("EFA", ret(close, $lb))' },
      portfolio: {
        mode: "weights",
        weights: {
          SPY: "if(spy_mom > tbill_ret($lb) and spy_mom >= efa_mom, 1, 0)",
          EFA: "if(efa_mom > tbill_ret($lb) and efa_mom > spy_mom, 1, 0)",
          AGG: '1 - w("SPY") - w("EFA")',
        },
      },
      rebalance: "monthly",
    },
  },
  {
    id: "vol-filter",
    text: "Hold SPY while its 21-day realized volatility is below 20%, out above 25%",
    spec: rules("SPY realized-volatility filter", ["SPY"], { vol_len: int(21, 10, 63), vol_lo: pct(20, 5, 50), vol_hi: pct(25, 5, 60) }, "vol($vol_len) < $vol_lo", "vol($vol_len) > $vol_hi"),
  },
  {
    id: "turn-of-month",
    text: "Turn of the month: SPY from the last trading day of the month for 4 days",
    spec: rules("SPY turn of the month", ["SPY"], {}, "tdom == -2", null, { risk: { ...noRisk, max_hold_days: 4 } }),
  },
  {
    id: "trailing-10",
    text: "AAPL, MSFT, JNJ, XOM, KO above their 100-day average with a 10% trailing stop",
    spec: rules("Typed list with a 10% trailing stop", ["AAPL", "MSFT", "JNJ", "XOM", "KO"], { ma: int(100, 20, 250, 5) }, "close > ts_mean(close, $ma)", null, { risk: { ...noRisk, trailing_pct: 10 } }),
  },
  {
    id: "sixty-forty",
    text: "60/40 SPY/TLT rebalanced quarterly",
    spec: {
      ...blankSpec(),
      name: "60/40 SPY / TLT",
      intent: "60/40 SPY/TLT quarterly",
      universe: { kind: "static", tickers: ["SPY", "TLT"] },
      params: { stocks: pct(60, 0, 100, 5) },
      portfolio: { mode: "weights", weights: { SPY: "$stocks", TLT: "1 - $stocks" } },
      rebalance: "quarterly",
    },
  },
  {
    id: "ko-pep",
    text: "Pairs: buy KO when the KO/PEP ratio is 2 deviations below its 60-day mean, exit at the mean",
    spec: rules(
      "KO vs PEP ratio z-score (KO leg)",
      ["KO"],
      { z_len: int(60, 20, 252), z_in: num(2, 0.5, 4, 0.1) },
      "ratio_z < -$z_in",
      "ratio_z > 0",
      { defs: { ratio_z: 'ts_zscore(at("KO", close) / at("PEP", close), $z_len)' } },
    ),
  },
  {
    id: "worst-3-weekly",
    text: "Each week buy the 3 worst 1-week performers of AAPL, MSFT, AMZN, GOOGL, META, NVDA, JPM, XOM, JNJ, PG",
    spec: {
      ...blankSpec(),
      name: "3 worst 1-week performers, weekly",
      intent: "worst 3 weekly",
      universe: { kind: "static", tickers: ["AAPL", "MSFT", "AMZN", "GOOGL", "META", "NVDA", "JPM", "XOM", "JNJ", "PG"] },
      params: { days: int(5, 2, 21), n: int(3, 1, 5) },
      portfolio: { mode: "rank", score: "ret(close, $days)", order: "asc", select: { n: "$n" }, filter: null, weighting: "equal" },
      rebalance: "weekly",
    },
  },
];

/** The starters as the Strategy tab lists them: alphabetical by name. */
export const STARTERS: Starter[] = [...EXPRESSIVENESS].sort((a, b) => a.spec.name.localeCompare(b.spec.name));
