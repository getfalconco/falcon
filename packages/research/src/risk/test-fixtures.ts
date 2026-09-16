/** Shared fixtures for the Risk Engine tests. */

import { indexGraph, type GraphIndex } from "../propagation/engine/graph.js";
import type { GraphEdge } from "../propagation/types.js";
import { DEFAULT_RISK_CONFIG, mergeRiskConfig, type RiskConfig } from "./config.js";
import type { RiskBar } from "./sharpe.js";
import type { RiskAccountInput, RiskInputs, RiskLiveInput, RiskPositionInput, RiskQuantInput, RiskWeight } from "./types.js";

export const NOW = "2026-08-24T20:30:00.000Z";

export function cfg(overrides: Parameters<typeof mergeRiskConfig>[0] = null): RiskConfig {
  return mergeRiskConfig(overrides ?? null);
}

export function edge(
  root: string,
  counterparty: string,
  category: string,
  tier: "critical" | "important" | "marginal",
  overrides: Partial<GraphEdge> = {},
): GraphEdge {
  const isTicker = /^[A-Z]{1,5}$/.test(counterparty);
  const id = `${root}:${counterparty}:${category}:${overrides.subtype ?? "x"}:0`;
  return {
    id,
    root_ticker: root,
    counterparty_id: counterparty,
    counterparty_name: isTicker ? counterparty : counterparty.replace(/^name:/, ""),
    counterparty_ticker: isTicker ? counterparty : null,
    category,
    subtype: "x",
    confidence: 0.9,
    strength: tier === "critical" ? 1 : tier === "important" ? 0.6 : 0.3,
    strength_tier: tier,
    evidence_quote: `${root} names ${counterparty} as ${category}.`,
    source_url: "https://www.sec.gov/",
    valid_from: "2026-03-01",
    ...overrides,
  };
}

/**
 * Synthetic graph:
 *   NVDA → TSM supplier critical (the spec's critical link)
 *   PFE  → name:lonza supplier critical, MRK → name:lonza supplier critical (shared CDMO)
 *   AAA, BBB: known to the graph (one marginal competitor edge each), no link between them
 *   CCC: absent from the graph entirely
 *   DDD → TSM supplier important; EEE → TSM supplier marginal (shared-but-weak cases)
 *   GGG ↔ HHH: direct important + both critical on name:shared (direct beats shared)
 */
export function syntheticGraph(): GraphIndex {
  const edges: GraphEdge[] = [
    edge("NVDA", "TSM", "supplier", "critical", { subtype: "wafer" }),
    edge("PFE", "name:lonza", "supplier", "critical"),
    edge("MRK", "name:lonza", "supplier", "critical"),
    edge("AAA", "name:zzz", "competitor", "marginal"),
    edge("BBB", "name:yyy", "competitor", "marginal"),
    edge("DDD", "TSM", "supplier", "important"),
    edge("EEE", "TSM", "supplier", "marginal"),
    edge("GGG", "HHH", "partner", "important"),
    edge("GGG", "name:shared", "dependency", "critical"),
    edge("HHH", "name:shared", "dependency", "critical"),
  ];
  return indexGraph({
    generatedAt: "2026-08-22T00:00:00.000Z",
    pipelineVersion: 5,
    nodes: [
      { id: "NVDA", label: "NVIDIA", kind: "ticker" },
      { id: "TSM", label: "TSMC", kind: "ticker" },
      { id: "name:lonza", label: "Lonza Group", kind: "name" },
      { id: "name:shared", label: "Shared Co", kind: "name" },
    ],
    edges,
  });
}

export function position(ticker: string, shares: number, costUsd: number, marketValue: number | null = null): RiskPositionInput {
  return { ticker, shares, cost_usd: costUsd, market_value: marketValue };
}

export function account(positions: RiskPositionInput[], cash = 0): RiskAccountInput {
  return { account: "paper", cash, positions, as_of: NOW };
}

export function quant(overrides: Partial<RiskQuantInput> = {}): RiskQuantInput {
  return { beta: 1, r2: 0.3, daily_vol: 0.02, earnings_rhythm: null, last_price: 100, ...overrides };
}

export function weightsOf(entries: Array<[string, number]>): RiskWeight[] {
  return entries.map(([ticker, weight]) => ({ ticker, weight, market_value: weight * 10_000, side: "long" as const }));
}

export const EMPTY_LIVE: RiskLiveInput = { open_incidents: [], anomalies: [], earnings: [] };

/**
 * A flat-ish price path: `sessions` closes drifting by `driftPct` a day with a
 * deterministic ${±wigglePct} alternation, so Sharpe goldens can be computed by
 * hand and never depend on a random seed.
 */
export function barSeries(sessions: number, opts: { start?: number; driftPct?: number; wigglePct?: number; from?: string } = {}): RiskBar[] {
  const start = opts.start ?? 100;
  const drift = (opts.driftPct ?? 0) / 100;
  const wiggle = (opts.wigglePct ?? 0) / 100;
  const out: RiskBar[] = [];
  let close = start;
  for (let i = 0; i < sessions; i++) {
    if (i > 0) close = close * (1 + drift + (i % 2 === 0 ? wiggle : -wiggle));
    const day = new Date(Date.UTC(2026, 0, 5) + i * 86_400_000);
    out.push({ d: day.toISOString().slice(0, 10), c: close });
  }
  return out;
}

/** Closes for every held ticker, long enough to clear `minSessions`. */
export function barsFor(tickers: string[], sessions = 120, opts: { driftPct?: number; wigglePct?: number } = {}): Record<string, RiskBar[]> {
  const out: Record<string, RiskBar[]> = {};
  for (const t of tickers) out[t] = barSeries(sessions, { driftPct: opts.driftPct ?? 0.05, wigglePct: opts.wigglePct ?? 1 });
  return out;
}

export function inputs(overrides: Partial<RiskInputs> = {}): RiskInputs {
  return {
    now: NOW,
    account: account([]),
    quant: {},
    spy_daily_vol: 0.01,
    universe_median_vol: 0.02,
    graph: syntheticGraph(),
    live: EMPTY_LIVE,
    bars: {},
    ...overrides,
  };
}

export { DEFAULT_RISK_CONFIG };
