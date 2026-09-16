/**
 * §3 component functions — pure, hand-checkable. Each returns its 0–100 score
 * (unrounded) plus the context payload the card/panel and the driver sentence
 * are built from. Missing inputs never block: substitutions are applied and
 * reported back through `degraded` (§2).
 */

import type { GraphIndex } from "../propagation/engine/graph.js";
import { interpolateAnchors, round } from "./anchors.js";
import type { RiskConfig } from "./config.js";
import { linkedFraction } from "./network.js";
import { alignReturns, portfolioReturns, sharpeOf, type RiskBar } from "./sharpe.js";
import type {
  SharpePayload,
  ConcentrationPayload,
  EventContributor,
  EventPayload,
  MarketPayload,
  NetworkPayload,
  RiskAccountInput,
  RiskDegraded,
  RiskLiveInput,
  RiskQuantInput,
  RiskWeight,
  VolatilityPayload,
} from "./types.js";

// ---------------------------------------------------------------------------
// Weights
// ---------------------------------------------------------------------------

export type WeightsResult = {
  weights: RiskWeight[];
  invested: number;
  invested_fraction: number;
  degraded: RiskDegraded[];
};

/**
 * Position weights over invested (absolute) market value. A position is valued
 * at the caller's market value, else |shares| × Tracker last price, else its
 * |cost basis| (recorded as degraded: price → cost basis).
 */
export function buildWeights(account: RiskAccountInput, quant: Record<string, RiskQuantInput | null>): WeightsResult {
  const degraded: RiskDegraded[] = [];
  const valued: Array<{ ticker: string; market_value: number; side: "long" | "short" }> = [];
  for (const p of account.positions) {
    const ticker = p.ticker.trim().toUpperCase();
    if (!ticker || !Number.isFinite(p.shares) || Math.abs(p.shares) <= 1e-9) continue;
    let mv: number | null = null;
    if (p.market_value != null && Number.isFinite(p.market_value)) mv = Math.abs(p.market_value);
    else {
      const price = quant[ticker]?.last_price ?? null;
      if (price != null && Number.isFinite(price) && price > 0) mv = Math.abs(p.shares) * price;
      else {
        mv = Math.abs(p.cost_usd);
        degraded.push({ ticker, field: "price", substitute: "cost_basis" });
      }
    }
    if (!(mv > 0)) continue;
    valued.push({ ticker, market_value: mv, side: p.shares < 0 ? "short" : "long" });
  }
  // Merge duplicate tickers (defensive; the paper account keys by symbol).
  const merged = new Map<string, { market_value: number; side: "long" | "short" }>();
  for (const v of valued) {
    const cur = merged.get(v.ticker);
    if (cur) cur.market_value += v.market_value;
    else merged.set(v.ticker, { market_value: v.market_value, side: v.side });
  }
  const invested = [...merged.values()].reduce((s, v) => s + v.market_value, 0);
  const weights: RiskWeight[] = [...merged.entries()]
    .map(([ticker, v]) => ({ ticker, weight: invested > 0 ? v.market_value / invested : 0, market_value: v.market_value, side: v.side }))
    .sort((a, b) => b.weight - a.weight || a.ticker.localeCompare(b.ticker));
  const cash = Number.isFinite(account.cash) ? Math.max(0, account.cash) : 0;
  const total = invested + cash;
  return { weights, invested, invested_fraction: total > 0 ? invested / total : 0, degraded };
}

// ---------------------------------------------------------------------------
// 3.1 Concentration
// ---------------------------------------------------------------------------

export function concentrationComponent(weights: RiskWeight[], config: RiskConfig): ConcentrationPayload {
  const hhi = weights.reduce((s, w) => s + w.weight * w.weight, 0);
  return {
    score: weights.length === 0 ? 0 : interpolateAnchors(config.anchors.concentration, hhi),
    hhi: round(hhi, 4),
    top: weights.slice(0, config.payloadTop).map((w) => ({ ticker: w.ticker, weight: round(w.weight, 4) })),
  };
}

// ---------------------------------------------------------------------------
// 3.2 Market sensitivity
// ---------------------------------------------------------------------------

/** β per held ticker with the null → substitute rule applied. */
export function resolveBetas(
  weights: RiskWeight[],
  quant: Record<string, RiskQuantInput | null>,
  config: RiskConfig,
  degraded: RiskDegraded[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const w of weights) {
    const q = quant[w.ticker];
    const beta = q?.beta;
    if (beta != null && Number.isFinite(beta)) out.set(w.ticker, beta);
    else {
      out.set(w.ticker, config.substitutes.beta);
      degraded.push({ ticker: w.ticker, field: q ? "beta" : "quant", substitute: config.substitutes.beta });
    }
  }
  return out;
}

export function marketComponent(weights: RiskWeight[], betas: Map<string, number>, investedFraction: number, config: RiskConfig): MarketPayload {
  let betaPort = 0;
  for (const w of weights) betaPort += w.weight * (betas.get(w.ticker) ?? config.substitutes.beta) * (w.side === "short" ? -1 : 1);
  const betaEff = Math.abs(betaPort) * investedFraction;
  return {
    score: weights.length === 0 ? 0 : interpolateAnchors(config.anchors.market, betaEff),
    beta_eff: round(betaEff, 3),
    beta_port: round(betaPort, 3),
  };
}

// ---------------------------------------------------------------------------
// 3.3 Volatility
// ---------------------------------------------------------------------------

export type VolInputs = {
  spyVol: number | null;
  universeMedianVol: number | null;
};

export function volatilityComponent(
  weights: RiskWeight[],
  betas: Map<string, number>,
  quant: Record<string, RiskQuantInput | null>,
  vols: VolInputs,
  config: RiskConfig,
  degraded: RiskDegraded[],
): VolatilityPayload {
  let spy = vols.spyVol;
  if (spy == null || !Number.isFinite(spy) || spy < 0) {
    spy = config.substitutes.spyVol;
    degraded.push({ ticker: "SPY", field: "spy_vol", substitute: spy });
  }
  const fallbackVol = vols.universeMedianVol != null && Number.isFinite(vols.universeMedianVol) ? vols.universeMedianVol : null;
  let betaPort = 0;
  let idio = 0;
  for (const w of weights) {
    const beta = betas.get(w.ticker) ?? config.substitutes.beta;
    betaPort += w.weight * beta * (w.side === "short" ? -1 : 1);
    let sigma = quant[w.ticker]?.daily_vol ?? null;
    if (sigma == null || !Number.isFinite(sigma)) {
      // Vol null → universe median vol; with no universe either, the
      // systematic leg alone carries the name (recorded the same way).
      sigma = fallbackVol ?? Math.abs(beta) * spy;
      degraded.push({ ticker: w.ticker, field: "vol", substitute: round(sigma, 5) });
    }
    const idioVar = Math.max(sigma * sigma - beta * beta * spy * spy, 0);
    idio += w.weight * w.weight * idioVar;
  }
  const systematicVar = betaPort * betaPort * spy * spy;
  const portVar = systematicVar + idio;
  const portVol = Math.sqrt(portVar);
  return {
    score: weights.length === 0 ? 0 : interpolateAnchors(config.anchors.volatility, portVol * 100),
    port_vol_daily_pct: round(portVol * 100, 3),
    spy_vol_daily_pct: round(spy * 100, 3),
    systematic_share: portVar > 0 ? round(systematicVar / portVar, 4) : 0,
  };
}

// ---------------------------------------------------------------------------
// 3.4 Network concentration
// ---------------------------------------------------------------------------

export function networkComponent(weights: RiskWeight[], graph: GraphIndex | null, config: RiskConfig, degraded: RiskDegraded[]): NetworkPayload {
  const result = linkedFraction(weights, graph, config);
  for (const ticker of result.excluded) degraded.push({ ticker, field: "graph", substitute: "excluded" });
  return {
    score: interpolateAnchors(config.anchors.network, weights.length < 2 ? 0 : result.linked_fraction),
    linked_fraction: round(result.linked_fraction, 4),
    pair_count: result.pair_count,
    excluded: result.excluded,
    top_links: result.links.slice(0, config.payloadTop).map((l) => ({ ...l, link: round(l.link, 3), pair_weight: round(l.pair_weight, 5) })),
  };
}

// ---------------------------------------------------------------------------
// 3.5 Live event risk
// ---------------------------------------------------------------------------

const BAND_RANK: Record<string, number> = { P0: 3, P1: 2, P2: 1, P3: 0 };

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export function eventComponent(
  weights: RiskWeight[],
  live: RiskLiveInput,
  quant: Record<string, RiskQuantInput | null>,
  config: RiskConfig,
): EventPayload {
  const contributors: EventContributor[] = [];
  let raw = 0;
  const held = new Map(weights.map((w) => [w.ticker, w.weight]));

  // Open incidents: highest band per ticker only.
  const bestBand = new Map<string, { band: string; id: string }>();
  for (const inc of live.open_incidents) {
    const t = inc.ticker.toUpperCase();
    if (!held.has(t)) continue;
    const cur = bestBand.get(t);
    if (!cur || (BAND_RANK[inc.band] ?? -1) > (BAND_RANK[cur.band] ?? -1)) bestBand.set(t, { band: inc.band, id: inc.incident_id });
  }
  for (const [t, b] of bestBand) {
    const points = config.event.incident[b.band as keyof typeof config.event.incident] ?? 0;
    if (points <= 0) continue;
    const weighted = (held.get(t) ?? 0) * points;
    raw += weighted;
    contributors.push({ ticker: t, kind: "incident", detail: b.band, contribution: points, weighted: round(weighted, 4) });
  }

  // Active anomaly states (one entry per kind per ticker).
  const seen = new Set<string>();
  for (const a of live.anomalies) {
    const t = a.ticker.toUpperCase();
    if (!held.has(t)) continue;
    const key = `${t}|${a.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const points = config.event.anomalies[a.kind] ?? 0;
    if (points <= 0) continue;
    const weighted = (held.get(t) ?? 0) * points;
    raw += weighted;
    const detail = a.kind === "insider_cluster" ? "sell cluster" : a.kind.replace(/_/g, " ");
    contributors.push({ ticker: t, kind: a.kind, detail, contribution: points, weighted: round(weighted, 4) });
  }

  // Earnings within the horizon: nearest due date per ticker.
  const nearest = new Map<string, number>();
  for (const e of live.earnings) {
    const t = e.ticker.toUpperCase();
    if (!held.has(t)) continue;
    if (e.sessions_until < 0 || e.sessions_until > config.event.earnings.horizonSessions) continue;
    const cur = nearest.get(t);
    if (cur == null || e.sessions_until < cur) nearest.set(t, e.sessions_until);
  }
  for (const [t, sessions] of nearest) {
    const rhythm = quant[t]?.earnings_rhythm;
    const factor =
      rhythm != null && Number.isFinite(rhythm) && config.event.earnings.rhythmRef > 0
        ? Math.min(rhythm / config.event.earnings.rhythmRef, config.event.earnings.maxFactor)
        : 1;
    const points = config.event.earnings.base * factor;
    const weighted = (held.get(t) ?? 0) * points;
    raw += weighted;
    contributors.push({
      ticker: t,
      kind: "earnings_window",
      detail: sessions === 0 ? "today" : plural(sessions, "session"),
      contribution: round(points, 3),
      weighted: round(weighted, 4),
    });
  }

  contributors.sort((a, b) => b.weighted - a.weighted || a.ticker.localeCompare(b.ticker) || a.kind.localeCompare(b.kind));
  return {
    score: weights.length === 0 ? 0 : interpolateAnchors(config.anchors.event, raw),
    raw: round(raw, 4),
    contributors,
  };
}

// ---------------------------------------------------------------------------
// 3.6 Sharpe — return per unit of volatility
// ---------------------------------------------------------------------------

/**
 * The current allocation's realised Sharpe (§3.6). Held names without enough
 * aligned history are dropped and the remaining weights renormalised — with
 * too few sessions left, `score` is null and the component leaves the blend
 * rather than inventing a neutral number for itself.
 */
export function sharpeComponent(
  weights: RiskWeight[],
  bars: Record<string, RiskBar[]>,
  config: RiskConfig,
  degraded: RiskDegraded[],
): SharpePayload {
  const cfg = config.sharpe;
  const tickers = weights.map((w) => w.ticker);
  const aligned = alignReturns(bars ?? {}, tickers, cfg.windowSessions);
  const series = portfolioReturns(weights, aligned);
  const result = sharpeOf(series.returns, {
    riskFreeAnnualPct: cfg.riskFreeAnnualPct,
    tradingDaysPerYear: cfg.tradingDaysPerYear,
    minSessions: cfg.minSessions,
  });
  const excluded = tickers.filter((t) => !aligned.byTicker.has(t));
  for (const ticker of excluded) degraded.push({ ticker, field: "history", substitute: "excluded" });
  if (result.sharpe == null && weights.length > 0) {
    degraded.push({ ticker: "*", field: "sharpe", substitute: `${result.sessions} sessions` });
  }
  return {
    score: result.sharpe == null ? null : interpolateAnchors(config.anchors.sharpe, result.sharpe),
    sharpe: result.sharpe == null ? null : round(result.sharpe, 3),
    sessions: result.sessions,
    ann_return_pct: round(result.ann_return * 100, 2),
    ann_vol_pct: round(result.ann_vol * 100, 2),
    risk_free_pct: cfg.riskFreeAnnualPct,
    excluded,
  };
}
