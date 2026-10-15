/**
 * Position weights for every desktop surface that prints one: the Positions
 * card, the Risk Score card's concentration sentence, the Shift+R panel.
 *
 * The definition and its arithmetic live in `@meridian/research/portfolio`,
 * the same module the Risk Engine quotes its sentence from, so the engine and
 * the renderer cannot drift apart:
 *
 *   weight = position market value / (cash + Σ signed position market value)
 *
 * This file only adapts the paper account's shape (symbol-keyed positions,
 * `costUsd`) to it.
 */

import { bookWeights, type AccountWeights } from "@meridian/research/portfolio";

export {
  accountValue,
  accountWeight,
  accountWeights,
  bookWeights,
  formatWeightPct,
  positionMarketValue,
  weightPercent,
  type AccountWeightRow,
  type AccountWeights,
  type BookHolding,
} from "@meridian/research/portfolio";

/** The paper account as this module reads it (a structural subset of `PaperAccount`). */
export type PaperBook = {
  cash: number;
  positions: Record<string, { symbol: string; shares: number; costUsd: number }>;
};

/**
 * The paper account's weights at the given prints (symbol → last price). A
 * symbol with no print is carried at cost, exactly as the Positions card
 * values it, so two surfaces handed the same prices print the same weights.
 */
export function paperAccountWeights(account: PaperBook, prices: Readonly<Record<string, number | null | undefined>>): AccountWeights {
  return bookWeights(
    account.cash,
    Object.values(account.positions ?? {})
      .filter((p) => p && typeof p.symbol === "string" && Number.isFinite(p.shares) && p.shares !== 0)
      .map((p) => ({ ticker: p.symbol, shares: p.shares, cost_usd: p.costUsd })),
    (ticker) => prices[ticker] ?? prices[ticker.toUpperCase()],
  );
}
