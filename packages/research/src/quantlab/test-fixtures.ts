/**
 * Quant Lab test fixtures — synthetic series with hand-computable returns.
 *
 * Prices are built so the arithmetic is exact: a series specified with a
 * constant 1% daily return has a 5-session return of 1.01^5 − 1 to the last
 * bit, which is what makes the backtest goldens goldens rather than
 * regression snapshots of whatever the code happened to produce.
 */

import { barsFrom, tradingDays } from "../screen/test-fixtures.js";
import { TradingCalendar } from "./calendar.js";
import type { FilingEvent } from "./filings.js";
import { buildSectorIndex, type ReturnContext } from "./returns.js";
import type { QuantSeries, QuantSnapshot } from "./types.js";

export { tradingDays };

export type SeriesSpec = {
  ticker: string;
  days: string[];
  /** returns.length === days.length − 1 */
  returns: number[];
  startPrice?: number;
  volumes?: number[];
  /** Open as a fraction of the same session's close (1 = open equals close). */
  openFactor?: number;
  beta?: number | null;
  dailyVol?: number | null;
};

/**
 * A series with exact prices and directly specified derived fields.
 *
 * The derived fields (beta, daily_vol) are set rather than computed: a returns
 * golden should not also be a test of the regression, and pinning them keeps
 * the expected market-adjusted number arithmetic anyone can check by hand.
 */
export function seriesFrom(spec: SeriesSpec): QuantSeries {
  const bars = barsFrom({
    days: spec.days,
    returns: spec.returns,
    startPrice: spec.startPrice ?? 100,
    volumes: spec.volumes,
  });
  const openFactor = spec.openFactor ?? 1;
  const snapshots: QuantSnapshot[] = bars.map((bar, i) => ({
    d: bar.d,
    open: bar.c * openFactor,
    close: bar.c,
    volume: bar.v,
    ret: i === 0 ? null : bars[i].c / bars[i - 1].c - 1,
    bench_ret: null,
    volume_ratio: 1,
    residual_move: null,
    residual_z: null,
    beta: spec.beta === undefined ? 1 : spec.beta,
    r2: 0.5,
    daily_vol: spec.dailyVol === undefined ? 0.02 : spec.dailyVol,
    vol_regime: 1,
    momentum_5d: null,
    momentum_20d: null,
    range_10s: null,
    pct_from_52w_high: null,
    pct_from_52w_low: null,
    history_sessions: i + 1,
  }));
  return { ticker: spec.ticker.toUpperCase(), snapshots };
}

/** A flat series at a constant price — a benchmark that contributes nothing. */
export function flatSeries(ticker: string, days: string[], price = 100): QuantSeries {
  return seriesFrom({ ticker, days, returns: new Array(days.length - 1).fill(0), startPrice: price });
}

export type ContextSpec = {
  series: QuantSeries[];
  benchmark?: string;
  sectors?: Record<string, string>;
  minSectorPeers?: number;
};

export function contextFrom(spec: ContextSpec): { ctx: ReturnContext; calendar: TradingCalendar } {
  const benchmark = spec.benchmark ?? "SPY";
  const seriesByTicker = new Map(spec.series.map((s) => [s.ticker, s]));
  const bench = seriesByTicker.get(benchmark);
  if (!bench) throw new Error(`fixture is missing the ${benchmark} series`);
  const calendar = TradingCalendar.fromBars(
    bench.snapshots.map((s) => ({ d: s.d, o: s.open, h: s.close, l: s.close, c: s.close, v: s.volume })),
  );
  const { sectorOf, sectorMembers } = buildSectorIndex(
    Object.entries(spec.sectors ?? {}).map(([ticker, sector]) => ({ ticker, sector })),
  );
  return {
    calendar,
    ctx: {
      calendar,
      seriesByTicker,
      benchmark,
      sectorOf,
      sectorMembers,
      minSectorPeers: spec.minSectorPeers ?? 1,
    },
  };
}

/** An 8-K event on a session, before or after that session's close. */
export function filingEvent(
  ticker: string,
  session: string,
  items: string[],
  afterClose: boolean,
): FilingEvent {
  return {
    ticker: ticker.toUpperCase(),
    form: "8-K",
    accession: `${ticker}-${session}`,
    filed_at: session,
    accepted_at: `${session}T${afterClose ? "21" : "11"}:00:00.000Z`,
    items,
    session,
    after_close: afterClose,
  };
}
