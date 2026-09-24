/**
 * Handover briefing: what the held names did since the last US close, and the
 * book those moves add up to.
 *
 * Pure arithmetic over the holdings the renderer sends and the quotes the
 * ports return. No clock is read here: the only timestamps are the ones the
 * quotes carry and the `pricedAt` the caller passes through.
 */

import type {
  BriefingBook,
  BriefingHolding,
  BriefingPhase,
  HeldMover,
  HeldQuote,
  QuantSlice,
} from "./types.js";

/**
 * A move beyond this, in percent, is flagged for a corporate-action check.
 * The provider's previous close is not split-adjusted until some time after
 * the split, so an unannounced 2-for-1 arrives looking like a 50% fall. Real
 * overnight moves of this size exist (a failed trial, a takeover), which is
 * why the figure is kept and only flagged; it is withheld only when a split
 * is actually known to sit in the window.
 */
export const LARGE_MOVE_PCT = 35;

/** Matches the paper account's own "flat" test, so dust never counts as a position. */
const FLAT_SHARES = 1e-9;

const TOP_WEIGHTS = 5;

function finite(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A usable price: finite and above zero. Providers send 0 for "no print". */
function positive(value: number | null | undefined): number | null {
  const n = finite(value);
  return n !== null && n > 0 ? n : null;
}

/** Rounds to `decimals` places; a rounded negative zero is reported as plain 0. */
function roundTo(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

function normSymbol(symbol: string): string {
  return symbol.trim().toUpperCase();
}

/**
 * Re-keys a symbol map by upper-case symbol. The renderer, the ports and the
 * split list are written by different hands; a "brk.b" on one side and a
 * "BRK.B" on the other would otherwise read as a held name with no quote.
 * A null under one spelling never hides a value under another.
 */
function byUpperSymbol<T>(map: Map<string, T | null>): Map<string, T | null> {
  const out = new Map<string, T | null>();
  for (const [key, value] of map) {
    const symbol = normSymbol(key);
    const existing = out.get(symbol);
    if (existing === undefined || existing === null) out.set(symbol, value);
  }
  return out;
}

/**
 * One row per symbol: upper-cased, duplicates summed, flat positions dropped.
 * A book that arrives with the same name twice (two lots, or two spellings)
 * would otherwise show that name twice among the movers and split its weight
 * in two, understating the concentration the reader is carrying.
 */
export function mergeHoldings(holdings: BriefingHolding[]): BriefingHolding[] {
  const merged = new Map<string, BriefingHolding>();
  for (const holding of holdings) {
    const symbol = normSymbol(holding.symbol);
    const shares = finite(holding.shares);
    if (symbol === "" || shares === null || Math.abs(shares) < FLAT_SHARES) continue;
    const cost = finite(holding.cost_usd) ?? 0;
    const existing = merged.get(symbol);
    if (existing) {
      existing.shares += shares;
      existing.cost_usd += cost;
    } else {
      merged.set(symbol, { symbol, shares, cost_usd: cost });
    }
  }
  // Two opposite lots of one symbol net to nothing held.
  return [...merged.values()].filter((h) => Math.abs(h.shares) >= FLAT_SHARES);
}

type MoveFigures = {
  last: number;
  ref: number;
  basis: "since_close" | "today";
  /** Unrounded, so sums and ratios built on them do not compound rounding. */
  movePct: number;
  pnlUsd: number;
};

/**
 * The move and its reference, without the display fields. Shared by the
 * movers list and the book total so the two can never disagree on which
 * close a name was measured from.
 */
function measureMove(shares: number, quote: HeldQuote | null, phase: BriefingPhase): MoveFigures | null {
  const last = positive(quote?.price);
  if (quote === null || last === null || !Number.isFinite(shares)) return null;

  // Outside the US regular session the latest print is a pre/post-market one
  // and the question is "what happened since the close", so the reference is
  // the last regular-session price. Measuring from `previous_close` there
  // would fold the whole of yesterday's session into "overnight". It is used
  // only as a fallback, when the provider gave no separate regular price and
  // the alternative is no figure at all.
  // During the session the latest print is the regular price itself, so the
  // only meaningful reference is the close before it.
  const inSession = phase === "in_session";
  const ref = inSession
    ? positive(quote.previous_close)
    : (positive(quote.regular_price) ?? positive(quote.previous_close));
  if (ref === null) return null;

  return {
    last,
    ref,
    basis: inSession ? "today" : "since_close",
    movePct: (last / ref - 1) * 100,
    // Signed shares: a borrowed position gains when the price falls.
    pnlUsd: shares * (last - ref),
  };
}

export function heldMover(
  holding: BriefingHolding,
  quote: HeldQuote | null,
  quant: QuantSlice | null,
  phase: BriefingPhase,
  splitInWindow: boolean,
): HeldMover | null {
  const figures = measureMove(holding.shares, quote, phase);
  // A row with no print time cannot say how old its price is, and an undated
  // price in a report about "since the close" is worse than a missing row.
  if (figures === null || quote === null || quote.as_of === null) return null;

  const movePct = roundTo(figures.movePct, 2);
  const vol = positive(quant?.daily_vol_30d);
  const base = {
    ticker: normSymbol(holding.symbol),
    last: figures.last,
    ref_close: figures.ref,
    basis: figures.basis,
    session: quote.session ?? "closed",
    as_of: quote.as_of,
    // Kept on a split day too: they describe the name, not the withheld move,
    // and the book's beta still needs this name's share of it.
    beta: finite(quant?.beta),
    // The same zero guard as the multiple below: a volatility of 0 would size
    // every "normal day" scenario for this name at nothing.
    daily_vol_pct: vol,
  } as const;

  // On a split day the unadjusted previous close makes a 10-for-1 look like a
  // 90 percent loss. A withheld number with a flag is honest; a fake one is
  // not, so the move and its P&L are zeroed. The volatility multiple is
  // withheld as null rather than 0, because 0 would claim a perfectly quiet
  // night for a name whose move is simply unknown.
  if (splitInWindow) {
    return { ...base, move_pct: 0, move_z: null, pnl_usd: 0, flag: "corporate_action_check" };
  }

  return {
    ...base,
    move_pct: movePct,
    // `daily_vol_30d` is in percent, the same unit as the move.
    move_z: vol === null ? null : roundTo(figures.movePct / vol, 2),
    pnl_usd: roundTo(figures.pnlUsd, 2),
    flag: Math.abs(movePct) > LARGE_MOVE_PCT ? "corporate_action_check" : null,
  };
}

/**
 * Every held name that has a usable quote, largest move first. Flagged rows
 * go last whatever their size: their figure is either withheld or suspect,
 * and a suspect 90% at the head of the list would be the first thing read.
 */
export function heldMovers(
  holdings: BriefingHolding[],
  quotes: Map<string, HeldQuote | null>,
  quants: Map<string, QuantSlice | null>,
  phase: BriefingPhase,
  splitSymbols: Set<string>,
): HeldMover[] {
  const quoteBySymbol = byUpperSymbol(quotes);
  const quantBySymbol = byUpperSymbol(quants);
  const splits = new Set([...splitSymbols].map(normSymbol));

  const movers: HeldMover[] = [];
  for (const holding of mergeHoldings(holdings)) {
    const mover = heldMover(
      holding,
      quoteBySymbol.get(holding.symbol) ?? null,
      quantBySymbol.get(holding.symbol) ?? null,
      phase,
      splits.has(holding.symbol),
    );
    if (mover) movers.push(mover);
  }

  return movers.sort((a, b) => {
    const flagged = Number(a.flag !== null) - Number(b.flag !== null);
    if (flagged !== 0) return flagged;
    const size = Math.abs(b.move_pct) - Math.abs(a.move_pct);
    if (size !== 0) return size;
    // Ties broken by name so the same inputs always give the same order.
    return a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0;
  });
}

/** One merged position at the value `buildBook` carries it at. */
function valuePosition(position: BriefingHolding, quote: HeldQuote | null): { value: number; priced: boolean } {
  const price = positive(quote?.price);
  if (price !== null) return { value: position.shares * price, priced: true };
  // No price: the position is carried at what it cost rather than at zero, so
  // one failed quote does not make the book look smaller and every other
  // weight larger. The cost is given the sign of the shares in case a caller
  // sends an unsigned basis for a borrowed position.
  return { value: Math.sign(position.shares) * Math.abs(position.cost_usd), priced: false };
}

/**
 * Each position's signed market value, merged and valued exactly as
 * `buildBook` values it. Weights built on anything else (the raw holdings, or
 * a second pricing rule) would stop summing to the book's own invested figure,
 * and a conclusion sized on them would disagree with the book it sits beside.
 */
export function positionValues(
  holdings: BriefingHolding[],
  quotes: Map<string, HeldQuote | null>,
): Array<{ ticker: string; market_value: number; priced: boolean }> {
  const quoteBySymbol = byUpperSymbol(quotes);
  return mergeHoldings(holdings).map((position) => {
    const { value, priced } = valuePosition(position, quoteBySymbol.get(position.symbol) ?? null);
    return { ticker: position.symbol, market_value: value, priced };
  });
}

/**
 * The carried book. `splitSymbols` is optional and plays the same part as in
 * `heldMovers`: a name with a split in the window contributes no P&L, because
 * the fake loss the movers list withholds would otherwise reappear here as the
 * headline overnight figure.
 */
export function buildBook(
  holdings: BriefingHolding[],
  cash: number,
  quotes: Map<string, HeldQuote | null>,
  phase: BriefingPhase,
  pricedAt: string,
  splitSymbols: ReadonlySet<string> = new Set<string>(),
): BriefingBook {
  const positions = mergeHoldings(holdings);
  const quoteBySymbol = byUpperSymbol(quotes);
  const splits = new Set([...splitSymbols].map(normSymbol));
  const cashUsd = finite(cash) ?? 0;

  const unpriced: string[] = [];
  const pnlExcluded: string[] = [];
  const valued: Array<{ ticker: string; shares: number; value: number }> = [];
  let signedSum = 0;
  let invested = 0;
  let pnl = 0;
  let measured = 0;

  for (const position of positions) {
    const quote = quoteBySymbol.get(position.symbol) ?? null;
    const { value, priced } = valuePosition(position, quote);
    if (!priced) unpriced.push(position.symbol);
    valued.push({ ticker: position.symbol, shares: position.shares, value });
    signedSum += value;
    invested += Math.abs(value);

    // The position's value is in equity either way, so a name whose move could
    // not be measured leaves the P&L covering less of the book than the figure
    // it is expressed over. Named here rather than counted, so whoever prints
    // that figure can say which names are outside it.
    const figures = splits.has(position.symbol) ? null : measureMove(position.shares, quote, phase);
    if (figures) {
      pnl += figures.pnlUsd;
      measured += 1;
    } else {
      pnlExcluded.push(position.symbol);
    }
  }

  const equity = cashUsd + signedSum;
  // Exposure against a wiped-out or negative equity is a sign-flipped or
  // infinite percentage; 0 with the equity figure beside it says more.
  const exposure = (amount: number): number => (equity > 0 ? roundTo((amount / equity) * 100, 2) : 0);

  // The P&L is expressed against what the book was worth before it happened.
  const equityBefore = equity - pnl;
  const pnlKnown = measured > 0;

  const topWeights = valued
    .filter((p) => Math.abs(p.value) > 0)
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value) || (a.ticker < b.ticker ? -1 : a.ticker > b.ticker ? 1 : 0))
    .slice(0, TOP_WEIGHTS)
    .map((p) => ({
      ticker: p.ticker,
      // Share of gross invested, not of equity: a book with borrowed
      // positions has weights that still sum to one this way.
      weight: roundTo(Math.abs(p.value) / invested, 4),
      side: p.shares > 0 ? ("long" as const) : ("short" as const),
    }));

  return {
    position_count: positions.length,
    equity_usd: roundTo(equity, 2),
    cash_usd: roundTo(cashUsd, 2),
    invested_usd: roundTo(invested, 2),
    net_exposure_pct: exposure(signedSum),
    gross_exposure_pct: exposure(invested),
    overnight_pnl_usd: pnlKnown ? roundTo(pnl, 2) : null,
    overnight_pnl_pct: pnlKnown && equityBefore > 0 ? roundTo((pnl / equityBefore) * 100, 2) : null,
    top_weights: topWeights,
    unpriced,
    pnl_excluded: pnlExcluded,
    priced_at: pricedAt,
  };
}
