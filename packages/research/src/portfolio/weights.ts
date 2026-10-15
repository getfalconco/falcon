/**
 * Position weights: the one definition every surface that prints a "% of the
 * portfolio" reads.
 *
 *   market value  = shares × price (signed: a short is negative), or the
 *                   signed cost basis while no price is known
 *   account value = cash + Σ market value      (signed cash: margin debt counts)
 *   weight        = market value / account value
 *
 * That is what a broker prints as "% of account": what the account would be
 * worth if everything were closed at these prices, and each holding's share of
 * it. Cash is in the denominator, so a book that is a quarter LLY reads 24.8%
 * on the Positions card and in the risk sentence alike, and the holdings plus
 * the cash line sum to 100%.
 *
 * Risk maths that needs weights over the holdings alone (HHI, beta, vol) keeps
 * its own invested-only weights internally; any percentage a reader sees comes
 * from here.
 *
 * Pure: no fs, no network, no clock. Renderer-safe (`@meridian/research/portfolio`).
 */

/** Below this an account value is treated as nothing: no share of it is printed. */
const ACCOUNT_EPSILON = 1e-9;

/**
 * A holding's signed market value. `price` wins when it is a real print; with
 * no price the position is carried at its cost rather than at zero, given the
 * sign of the shares, so one failed quote neither shrinks the account nor
 * flips a short to a long.
 */
export function positionMarketValue(shares: number, costUsd: number, price: number | null | undefined): number {
  if (!Number.isFinite(shares)) return 0;
  if (price != null && Number.isFinite(price) && price > 0) return shares * price;
  return Number.isFinite(costUsd) ? Math.sign(shares) * Math.abs(costUsd) : 0;
}

/** Cash plus every signed market value. Non-finite inputs count as zero. */
export function accountValue(cash: number, marketValues: Iterable<number>): number {
  let total = Number.isFinite(cash) ? cash : 0;
  for (const v of marketValues) if (Number.isFinite(v)) total += v;
  return total;
}

/**
 * `marketValue` as a share of `total` (signed: a short is a negative weight).
 * Null when the account is worth nothing or less: a share of a wiped-out or
 * negative account is a sign-flipped or infinite figure, not a weight.
 */
export function accountWeight(marketValue: number, total: number): number | null {
  if (!Number.isFinite(marketValue) || !Number.isFinite(total) || total <= ACCOUNT_EPSILON) return null;
  return marketValue / total;
}

export type AccountWeightRow = { ticker: string; market_value: number; weight: number | null };

export type AccountWeights = {
  /** Cash + Σ signed market value. */
  total: number;
  cash: number;
  /** Cash as a share of the account (negative under margin), null when total ≤ 0. */
  cash_weight: number | null;
  /** Per ticker (upper-cased, duplicates merged), largest |market value| first. */
  positions: AccountWeightRow[];
};

/** Every holding's weight, and the cash's, over one account value. */
export function accountWeights(cash: number, positions: Array<{ ticker: string; market_value: number }>): AccountWeights {
  const merged = new Map<string, number>();
  for (const p of positions) {
    const ticker = p.ticker.trim().toUpperCase();
    if (!ticker || !Number.isFinite(p.market_value)) continue;
    merged.set(ticker, (merged.get(ticker) ?? 0) + p.market_value);
  }
  const cashUsd = Number.isFinite(cash) ? cash : 0;
  const total = accountValue(cashUsd, merged.values());
  const rows = [...merged.entries()]
    .map(([ticker, market_value]) => ({ ticker, market_value, weight: accountWeight(market_value, total) }))
    .sort((a, b) => Math.abs(b.market_value) - Math.abs(a.market_value) || a.ticker.localeCompare(b.ticker));
  return { total, cash: cashUsd, cash_weight: accountWeight(cashUsd, total), positions: rows };
}

/** A holding as a book keeps it: signed shares, signed cost basis. */
export type BookHolding = { ticker: string; shares: number; cost_usd: number };

/**
 * The common case: holdings plus the prices a surface is showing, valued with
 * `positionMarketValue` and weighted with `accountWeights`. Two surfaces that
 * call this with the same prices print the same weights.
 */
export function bookWeights(
  cash: number,
  holdings: BookHolding[],
  priceOf: (ticker: string) => number | null | undefined,
): AccountWeights {
  return accountWeights(
    cash,
    holdings.map((h) => ({ ticker: h.ticker, market_value: positionMarketValue(h.shares, h.cost_usd, priceOf(h.ticker)) })),
  );
}

/** "24.8" for 0.248: the percentage figure, without the sign glyph. */
export function weightPercent(weight: number, digits = 1): string {
  const text = (weight * 100).toFixed(digits);
  // -0.0 reads as a short that is not there.
  return Number(text) === 0 ? (0).toFixed(digits) : text;
}

/** "24.8%" for 0.248, null for no weight. The one printed form. */
export function formatWeightPct(weight: number | null | undefined, digits = 1): string | null {
  if (weight == null || !Number.isFinite(weight)) return null;
  return `${weightPercent(weight, digits)}%`;
}
