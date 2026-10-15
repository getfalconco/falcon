/**
 * Per-position risk read: what the dashboard card shows while one Positions
 * row is hovered. Computed in the same recompute as the score, from the same
 * inputs and the same §3.3 single-factor model, so a name's share of the
 * portfolio risk adds up with the portfolio vol the card already quotes.
 *
 * Every figure is a measurement or null. Where the blend had to substitute a
 * missing input (a beta of 1, the universe median vol) the substitute still
 * feeds `risk_share`, exactly as it feeds the score, but it is never reported
 * as the name's own beta or vol.
 */

import { accountValue, accountWeight } from "../portfolio/weights.js";
import { round } from "./anchors.js";
import { resolveSigma, resolveSpyVol } from "./components.js";
import type { RiskConfig } from "./config.js";
import { alignReturns, type RiskBar } from "./sharpe.js";
import type { RiskInputs, RiskPositionMetrics, RiskQuantInput, RiskWeight } from "./types.js";

/** Fewer aligned sessions than this and a correlation is noise, not a reading. */
export const CORRELATION_MIN_SESSIONS = 20;

/** Pearson correlation of two equal-length series; null when either is flat. */
export function pearson(a: number[], b: number[]): number | null {
  const n = Math.min(a.length, b.length);
  if (n < 2) return null;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i];
    mb += b[i];
  }
  ma /= n;
  mb /= n;
  let cov = 0;
  let va = 0;
  let vb = 0;
  for (let i = 0; i < n; i++) {
    const da = a[i] - ma;
    const db = b[i] - mb;
    cov += da * db;
    va += da * da;
    vb += db * db;
  }
  if (va <= 0 || vb <= 0) return null;
  return Math.max(-1, Math.min(1, cov / Math.sqrt(va * vb)));
}

/** Realised correlation of `ticker` with `other` over the sessions both traded. */
function correlationWith(
  ticker: string,
  other: string,
  bars: Record<string, RiskBar[]>,
  window: number,
): { ticker: string; value: number; sessions: number } | null {
  const aligned = alignReturns(bars, [ticker, other], window);
  const a = aligned.byTicker.get(ticker);
  const b = aligned.byTicker.get(other);
  if (!a || !b || a.length < CORRELATION_MIN_SESSIONS) return null;
  const value = pearson(a, b);
  return value == null ? null : { ticker: other, value: round(value, 3), sessions: a.length };
}

export function positionMetrics(
  weights: RiskWeight[],
  betas: Map<string, number>,
  quant: Record<string, RiskQuantInput | null>,
  inputs: Pick<RiskInputs, "account" | "spy_daily_vol" | "universe_median_vol" | "live" | "bars">,
  config: RiskConfig,
): RiskPositionMetrics[] {
  if (weights.length === 0) return [];
  const { spy } = resolveSpyVol(inputs.spy_daily_vol, config);
  const sign = (w: RiskWeight) => (w.side === "short" ? -1 : 1);

  // §3.3: cov(i, j) = β_i β_j σ_m² (+ idio_i on the diagonal). A name's Euler
  // contribution s_i · cov(i, p) sums over the book to σ_p² exactly.
  const legs = weights.map((w) => {
    const beta = betas.get(w.ticker) ?? config.substitutes.beta;
    const { sigma } = resolveSigma(w.ticker, beta, quant, inputs.universe_median_vol, spy);
    return { w, s: w.weight * sign(w), beta, idio: Math.max(sigma * sigma - beta * beta * spy * spy, 0) };
  });
  const betaPort = legs.reduce((sum, l) => sum + l.s * l.beta, 0);
  const contributions = legs.map((l) => l.s * (l.beta * betaPort * spy * spy + l.s * l.idio));
  const portVar = contributions.reduce((sum, c) => sum + c, 0);

  const cash = Number.isFinite(inputs.account.cash) ? inputs.account.cash : 0;
  const total = accountValue(cash, weights.map((w) => sign(w) * w.market_value));

  const horizon = config.event.earnings.horizonSessions;
  const nearestEarnings = new Map<string, { due_at: string; sessions_until: number }>();
  for (const e of inputs.live.earnings) {
    const t = e.ticker.toUpperCase();
    if (e.sessions_until < 0 || e.sessions_until > horizon) continue;
    const cur = nearestEarnings.get(t);
    if (!cur || e.sessions_until < cur.sessions_until) nearestEarnings.set(t, { due_at: e.due_at, sessions_until: e.sessions_until });
  }

  const largest = weights[0].ticker;
  const bars = inputs.bars ?? {};
  return legs.map((l, i) => {
    const q = quant[l.w.ticker];
    const ownBeta = q?.beta;
    const ownVol = q?.daily_vol;
    const share = accountWeight(sign(l.w) * l.w.market_value, total);
    return {
      ticker: l.w.ticker,
      side: l.w.side,
      account_weight: share == null ? null : round(share, 5),
      beta: ownBeta != null && Number.isFinite(ownBeta) ? round(ownBeta, 3) : null,
      daily_vol_pct: ownVol != null && Number.isFinite(ownVol) ? round(ownVol * 100, 3) : null,
      risk_share: portVar > 0 ? round(contributions[i] / portVar, 4) : null,
      earnings: nearestEarnings.get(l.w.ticker) ?? null,
      correlation: l.w.ticker === largest ? null : correlationWith(l.w.ticker, largest, bars, config.sharpe.windowSessions),
    };
  });
}
