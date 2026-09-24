/**
 * Handover briefing: the overnight markets table.
 *
 * Turns one chart-meta read per symbol into a row that says how far the
 * market moved since the last US close, and, just as importantly, whether the
 * figure is an overnight figure at all. Pure: the only clock is the
 * `overnightSince` instant the caller passes in.
 */

import type { MarketGroup, MarketRow, MarketSnapshot, MarketUnit } from "./types.js";

export type MarketSymbolDef = {
  symbol: string;
  label: string;
  group: MarketGroup;
  unit: MarketUnit;
  basis: "prev_close" | "prior_settle";
};

/**
 * The table, in display order. Futures and the two commodity contracts are
 * measured from a settlement rather than a close, and the row says so.
 *
 * VIX is quoted in points and the 10-year in basis points because a percent
 * change of either misleads: a VIX going 14 to 16 reads as "+14%", and a yield
 * going 4.25 to 4.31 reads as "+1.4%" when the desk word for it is "6 bp".
 */
export const MARKET_SYMBOLS: MarketSymbolDef[] = [
  { symbol: "^N225", label: "Nikkei 225", group: "asia", unit: "pct", basis: "prev_close" },
  { symbol: "^HSI", label: "Hang Seng", group: "asia", unit: "pct", basis: "prev_close" },
  { symbol: "000001.SS", label: "Shanghai Composite", group: "asia", unit: "pct", basis: "prev_close" },
  { symbol: "^AXJO", label: "ASX 200", group: "asia", unit: "pct", basis: "prev_close" },

  { symbol: "^STOXX50E", label: "Euro Stoxx 50", group: "europe", unit: "pct", basis: "prev_close" },
  { symbol: "^GDAXI", label: "DAX", group: "europe", unit: "pct", basis: "prev_close" },
  { symbol: "^FTSE", label: "FTSE 100", group: "europe", unit: "pct", basis: "prev_close" },
  { symbol: "^FCHI", label: "CAC 40", group: "europe", unit: "pct", basis: "prev_close" },

  { symbol: "ES=F", label: "S&P 500 futures", group: "us_futures", unit: "pct", basis: "prior_settle" },
  { symbol: "NQ=F", label: "Nasdaq-100 futures", group: "us_futures", unit: "pct", basis: "prior_settle" },
  { symbol: "YM=F", label: "Dow futures", group: "us_futures", unit: "pct", basis: "prior_settle" },
  { symbol: "RTY=F", label: "Russell 2000 futures", group: "us_futures", unit: "pct", basis: "prior_settle" },

  { symbol: "^VIX", label: "VIX", group: "macro", unit: "pts", basis: "prev_close" },
  { symbol: "DX-Y.NYB", label: "US dollar index", group: "macro", unit: "pct", basis: "prev_close" },
  { symbol: "CL=F", label: "WTI crude", group: "macro", unit: "pct", basis: "prior_settle" },
  { symbol: "GC=F", label: "Gold", group: "macro", unit: "pct", basis: "prior_settle" },
  { symbol: "^TNX", label: "US 10-year yield", group: "macro", unit: "bp", basis: "prev_close" },
];

/**
 * The symbols whose search news stand in for market-wide headlines. The
 * provider's search endpoint answers a symbol query with headlines tagged to
 * it and a free-text query ("stock market", "Federal Reserve") with nothing
 * useful, so the tape is read through the index funds, the S&P itself,
 * volatility, Treasuries, oil, gold, the dollar and small caps. Shared by the
 * desktop port and the replay script, so both read the same tape.
 */
export const MARKET_NEWS_SYMBOLS: readonly string[] = ["SPY", "QQQ", "^GSPC", "^VIX", "TLT", "CL=F", "GC=F", "DX-Y.NYB", "IWM"];

/**
 * The rows a narrative is allowed to quote, in the order it would mention
 * them: where the US is pointing first, then the two regional benchmarks,
 * then volatility. Seventeen figures in one paragraph is a table read aloud.
 */
const LEAD_SYMBOLS = ["ES=F", "NQ=F", "^N225", "^STOXX50E", "^VIX"] as const;

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Rounds to `decimals` places; a rounded negative zero is reported as plain 0. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

function moveIn(unit: MarketUnit, last: number, prev: number): number {
  switch (unit) {
    case "pct":
      return roundTo((last / prev - 1) * 100, 2);
    case "pts":
      return roundTo(last - prev, 2);
    case "bp":
      // The provider quotes ^TNX in percent (4.25 means 4.25%), so one unit of
      // the quote is a hundred basis points: 4.25 to 4.31 is +6 bp.
      return roundTo((last - prev) * 100, 1);
  }
}

export function marketRow(
  def: MarketSymbolDef,
  snapshot: MarketSnapshot | null,
  overnightSince: string,
): MarketRow {
  const base = { symbol: def.symbol, label: def.label, group: def.group, unit: def.unit, basis: def.basis };

  const last = finite(snapshot?.price);
  if (snapshot === null || last === null) {
    return { ...base, last: null, prev_close: null, move: null, state: "unavailable", as_of: null };
  }

  // A zero or negative previous close is a provider placeholder, not a level.
  // Dividing by it would print an infinite or sign-flipped move, so it is
  // dropped here and the row simply carries no move.
  const prevRaw = finite(snapshot.previous_close);
  const prev = prevRaw !== null && prevRaw > 0 ? prevRaw : null;

  // Compared as instants, not as strings: the provider's "21:00:00Z" and the
  // window's "21:00:00.000Z" are the same moment but sort differently as text.
  const printedAt = snapshot.market_time === null ? Number.NaN : Date.parse(snapshot.market_time);
  const since = Date.parse(overnightSince);

  // A print from before the last US close is not an overnight print. Without
  // this check a local holiday, or a market that has not opened yet, passes an
  // old session's move off as what happened overnight: on 2026-09-21 the
  // Nikkei was shut for a Japanese holiday and the provider returned the
  // 2026-09-18 print with that day's full move attached. The level and its
  // timestamp are still shown; the move is withheld. An unreadable timestamp
  // on either side lands here too, because "after the close" cannot be shown.
  if (!Number.isFinite(printedAt) || !Number.isFinite(since) || printedAt < since) {
    return {
      ...base,
      last,
      prev_close: prev,
      move: null,
      state: "stale",
      as_of: Number.isFinite(printedAt) ? snapshot.market_time : null,
    };
  }

  // A fresh print is not enough: the baseline has to belong to the session the
  // report measures from. `previous_close` is the close of the chart day
  // BEFORE the one the provider is serving, and for these symbols a chart day
  // is the ET calendar day, so from 16:00 ET until midnight (and right through
  // a weekend) the print is new while its baseline is a session too far back.
  // Measured against it, a future that has moved 0.1% since the settle reads
  // as 2.3%, and the report leads with that figure times the book's beta. The
  // level and the print time still stand; the move is withheld.
  const dayStart = typeof snapshot.session_start === "string" ? Date.parse(snapshot.session_start) : Number.NaN;
  if (Number.isFinite(dayStart) && dayStart <= since) {
    return { ...base, last, prev_close: prev, move: null, state: "stale", as_of: snapshot.market_time };
  }

  return {
    ...base,
    last,
    prev_close: prev,
    move: prev === null ? null : moveIn(def.unit, last, prev),
    state: snapshot.in_regular_session ? "live" : "final",
    as_of: snapshot.market_time,
  };
}

/** One row per `MARKET_SYMBOLS` entry, in that order; a symbol with no snapshot is "unavailable". */
export function marketRows(
  snapshots: Map<string, MarketSnapshot | null>,
  overnightSince: string,
): MarketRow[] {
  return MARKET_SYMBOLS.map((def) => marketRow(def, snapshots.get(def.symbol) ?? null, overnightSince));
}

/**
 * What a narrative may cite. Stale and unavailable rows are out because their
 * move is withheld; a fresh row whose previous close was missing is out for
 * the same reason, since a sentence built on it would name a market and then
 * have no figure to give.
 */
export function leadMarketRows(rows: MarketRow[]): MarketRow[] {
  const lead: MarketRow[] = [];
  for (const symbol of LEAD_SYMBOLS) {
    const row = rows.find((r) => r.symbol === symbol);
    if (!row) continue;
    if (row.state === "stale" || row.state === "unavailable") continue;
    if (row.move === null) continue;
    lead.push(row);
  }
  return lead;
}
