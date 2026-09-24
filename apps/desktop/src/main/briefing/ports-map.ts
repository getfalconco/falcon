/**
 * Handover briefing: the shape changes between what the desktop's own readers
 * return (camelCase, epoch times, the Tracker's fractions) and what the
 * engine's ports promise (`BriefingPorts` in the briefing contract).
 *
 * Pure and electron-free, so every unit and naming decision in here is pinned
 * by a test over recorded provider shapes. Half of the inputs arrive as JSON
 * from the remote engine, so nothing is trusted to have the shape its type
 * claims.
 */

import type {
  CorporateCalendarRaw,
  HeldCoverage,
  HeldQuote,
  HeldSession,
  MarketSnapshot,
  QuantSlice,
  RiskLatestLite,
} from "../../shared/briefing-types";
import type { RiskLatest } from "../../shared/risk-types";
import type { LiveQuote } from "../../shared/stock-types";
import type { TrackerQuantContext, TrackerStatus } from "../../shared/tracker-types";
import type {
  CorporateCalendarRead,
  MarketSnapshotRead,
  RecentCorporateEventsRead,
} from "../stock/market-data-service";

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Providers send 0 for "no print"; a zero price is a placeholder, not a level. */
function positive(value: unknown): number | null {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
}

function isoFromMs(ms: number | null): string | null {
  if (ms === null) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function toMarketSnapshot(read: MarketSnapshotRead): MarketSnapshot {
  const at = finite(read.marketTime);
  return {
    symbol: read.symbol,
    price: finite(read.price),
    previous_close: finite(read.previousClose),
    market_time: isoFromMs(at === null ? null : at * 1000),
    in_regular_session: read.inRegularSession === true,
  };
}

const HELD_SESSIONS: ReadonlySet<string> = new Set<HeldSession>(["pre", "regular", "post", "closed"]);

/**
 * `price` is the live quote's own price, which outside the regular session is
 * the extended-hours print. `regular_price` is what it moved away from. The
 * book arithmetic measures "since the close" between those two, so swapping
 * them, or filling a missing regular price with the latest print, would report
 * a flat night for every name.
 */
export function toHeldQuote(quote: LiveQuote): HeldQuote {
  return {
    symbol: quote.symbol,
    price: positive(quote.price),
    regular_price: positive(quote.regularPrice),
    previous_close: positive(quote.previousClose),
    session: HELD_SESSIONS.has(quote.session) ? quote.session : null,
    as_of: isoFromMs(finite(quote.asOf)),
  };
}

/**
 * The forward calendar and the price-history events are separate requests and
 * either can be missing. Null for the calendar means the request failed;
 * null for the events means the same for the chart. `available` speaks for the
 * calendar only, because that is the question the report's coverage note asks:
 * does the provider publish anything ahead of time for this symbol.
 */
export function toCorporateCalendarRaw(
  symbol: string,
  calendar: CorporateCalendarRead | null,
  events: RecentCorporateEventsRead | null,
): CorporateCalendarRaw {
  return {
    symbol,
    available: calendar?.available === true,
    ex_dividend_date: calendar?.exDividendDate ?? null,
    dividend_date: calendar?.dividendDate ?? null,
    dividend_rate: finite(calendar?.dividendRate),
    earnings_dates: Array.isArray(calendar?.earningsDates) ? [...calendar.earningsDates] : [],
    earnings_estimated: typeof calendar?.earningsEstimated === "boolean" ? calendar.earningsEstimated : null,
    recent_dividends: Array.isArray(events?.dividends) ? events.dividends.map((d) => ({ ...d })) : [],
    recent_splits: Array.isArray(events?.splits) ? events.splits.map((s) => ({ ...s })) : [],
  };
}

/**
 * The Tracker keeps volatility as a fraction of price (0.018 for 1.8 percent a
 * day), the way it keeps every return. The briefing divides a move in percent
 * by this figure, so it is converted here; passed through as it is, every
 * held name would read as a move of a hundred standard deviations.
 */
export function toQuantSlice(quant: Pick<TrackerQuantContext, "daily_vol_30d" | "beta_90d"> | null | undefined): QuantSlice | null {
  if (!quant || typeof quant !== "object") return null;
  const vol = finite(quant.daily_vol_30d);
  return { daily_vol_30d: vol === null ? null : vol * 100, beta: finite(quant.beta_90d) };
}

/**
 * Null when the engine has computed nothing yet. An empty snapshot (no
 * positions) is still passed on, with no tickers: the assembly then finds it
 * does not describe the requested book and keeps its figures off the page.
 */
export function toRiskLatestLite(latest: Pick<RiskLatest, "snapshot"> | null | undefined): RiskLatestLite | null {
  const snapshot = latest?.snapshot;
  if (!snapshot || typeof snapshot !== "object") return null;
  const weights = Array.isArray(snapshot.weights) ? snapshot.weights : [];
  return {
    score: finite(snapshot.score),
    band: typeof snapshot.band === "string" ? snapshot.band : null,
    driver_component: typeof snapshot.driver?.component === "string" ? snapshot.driver.component : null,
    driver_sentence: typeof snapshot.driver?.sentence === "string" ? snapshot.driver.sentence : null,
    beta_eff: finite(snapshot.components?.market?.beta_eff),
    beta_port: finite(snapshot.components?.market?.beta_port),
    port_vol_daily_pct: finite(snapshot.components?.volatility?.port_vol_daily_pct),
    computed_at: typeof snapshot.computed_at === "string" ? snapshot.computed_at : "",
    tickers: weights
      .map((w) => (typeof w?.ticker === "string" ? w.ticker.trim().toUpperCase() : ""))
      .filter((ticker) => ticker !== ""),
  };
}

/**
 * How far the chain follows one held name, read off the Tracker's status.
 *
 * The status does not name the price tier, but it shows it: a price-tier name
 * is backfilled like any other and then never polled for news, so its news
 * channel has neither a success nor an error on record, while an event-tier
 * name gets one or the other during its backfill. A name that is listed but
 * not backfilled yet has no history to measure against, so it is "pending"
 * like one that is not listed at all: the weakest claim, and the one that
 * keeps an empty news list from reading as a quiet night.
 */
export function coverageOf(ticker: string, status: Pick<TrackerStatus, "tickers"> | null | undefined): HeldCoverage {
  const symbol = ticker.trim().toUpperCase();
  const rows = Array.isArray(status?.tickers) ? status.tickers : [];
  const row = rows.find((r) => typeof r?.ticker === "string" && r.ticker.trim().toUpperCase() === symbol);
  if (!row || row.backfilled !== true) return "pending";
  const news = row.health?.news;
  const newsNeverPolled = !news || (news.last_success_at == null && news.last_error == null);
  return newsNeverPolled ? "price_only" : "tracked";
}
