import { accountWeight, formatWeightPct, paperAccountWeights, type PaperBook } from "../../../shared/portfolio-weights";
import { formatRiskShare } from "../../../shared/risk-card";
import type { RiskSnapshot } from "../../../shared/risk-types";

/**
 * The Stock tab header's "your context" for a held name, from the paper
 * account (or the demo book while Ctrl+P is on) and the latest risk
 * snapshot. Every figure is measured or left out: no price, no P&L; no
 * scored snapshot, no risk share.
 *
 *   weight      the shared definition (shared/portfolio-weights.ts), at the
 *               prints given; the snapshot's own account weight when the
 *               book has no print for the name
 *   cost        the position's cash basis, unsigned, and per share
 *   pnl         marked to the live price: shares x price minus the signed basis
 *   riskShare   the name's Euler share of the portfolio variance
 *
 * Pure.
 */

export type HeldContext = {
  shares: number;
  costUsd: number;
  costPerShare: number | null;
  pnlUsd: number | null;
  pnlPct: number | null;
  /** Formatted, "12.4%". */
  weight: string | null;
  /** Formatted, "31%". */
  riskShare: string | null;
};

export function heldContext(
  book: PaperBook,
  ticker: string,
  price: number | null | undefined,
  prices: Readonly<Record<string, number | null | undefined>>,
  snapshot: RiskSnapshot | null | undefined,
): HeldContext | null {
  const symbol = ticker.trim().toUpperCase();
  const position = book.positions?.[symbol];
  if (!position || !Number.isFinite(position.shares) || position.shares === 0) return null;
  const shares = position.shares;
  const costUsd = Number.isFinite(position.costUsd) ? Math.abs(position.costUsd) : 0;
  const live = typeof price === "number" && Number.isFinite(price) && price > 0 ? price : null;
  const pnlUsd = live == null ? null : shares * live - position.costUsd;
  const pnlPct = pnlUsd == null || costUsd <= 0 ? null : (pnlUsd / costUsd) * 100;

  const marks = live == null ? prices : { ...prices, [symbol]: live };
  const metrics = Array.isArray(snapshot?.positions) ? snapshot.positions.find((p) => p?.ticker === symbol) : undefined;
  let weight: number | null = null;
  if (marks[symbol] != null) {
    const weights = paperAccountWeights(book, marks);
    const row = weights.positions.find((p) => p.ticker === symbol);
    weight = row ? accountWeight(row.market_value, weights.total) : null;
  }
  if (weight == null && typeof metrics?.account_weight === "number" && Number.isFinite(metrics.account_weight)) {
    weight = metrics.account_weight;
  }
  const scored = snapshot && !snapshot.empty && snapshot.score != null;
  const share = scored && typeof metrics?.risk_share === "number" && Number.isFinite(metrics.risk_share) ? metrics.risk_share : null;

  return {
    shares,
    costUsd,
    costPerShare: costUsd > 0 ? costUsd / Math.abs(shares) : null,
    pnlUsd,
    pnlPct,
    weight: formatWeightPct(weight == null ? null : Math.abs(weight)),
    riskShare: share == null ? null : formatRiskShare(share),
  };
}
