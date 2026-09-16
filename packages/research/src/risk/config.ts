/**
 * Risk Engine config (spec §3–§5, §11). Every calibration knob lives here —
 * anchor tables, blend weights, event contributions, the shared-dependency
 * factor, debounce, retention, sentence templates — and is overridable from
 * `data/risk/config.json`. Stored config overrides code defaults field by field.
 */

import type { RiskAnomalyKind, RiskComponentKey, RiskPriorityBand, RiskStrengthTier } from "./types.js";

/** Piecewise-linear anchor table: [input value, score] pairs, ascending by value. */
export type AnchorTable = Array<[number, number]>;

export type RiskEventConfig = {
  /** Open-incident contribution per band (highest band per ticker only). */
  incident: Record<RiskPriorityBand, number>;
  /** Active edge-triggered anomaly states. */
  anomalies: Record<RiskAnomalyKind, number>;
  earnings: {
    /** Sessions ahead that count as "within the earnings window". */
    horizonSessions: number;
    /** Base points: base × min(rhythm / rhythmRef, maxFactor). */
    base: number;
    /** Earnings-rhythm reference (5% = 0.05). */
    rhythmRef: number;
    maxFactor: number;
  };
};

export type RiskSharpeConfig = {
  /** Sessions of history the ratio is measured over. */
  windowSessions: number;
  /** Below this many aligned sessions the component drops out of the blend. */
  minSessions: number;
  /**
   * Annual risk-free rate, in percent. There is no rate feed on this side, so
   * this is an explicit assumption rather than a measurement — it travels in
   * the payload so it can be seen and argued with.
   */
  riskFreeAnnualPct: number;
  tradingDaysPerYear: number;
};

export type RiskTemplates = {
  concentration: string;
  market: string;
  volatility: string;
  sharpe: string;
  network: { direct: string; shared: string };
  event: {
    incident: string;
    insider_cluster: string;
    unexplained_move: string;
    drift: string;
    filing_overdue: string;
    earnings_window: string;
    earnings_today: string;
  };
};

export type RiskConfig = {
  schemaVersion: number;
  anchors: Record<RiskComponentKey, AnchorTable>;
  weights: Record<RiskComponentKey, number>;
  /** Lower bound of each band above `low`. */
  bands: { moderate: number; elevated: number; high: number };
  /** Pairwise link weight per strength tier (§3.4). */
  tierWeights: Record<RiskStrengthTier, number>;
  /** Shared critical dependency: l_shared = factor × min(tier weights). */
  sharedDependencyFactor: number;
  /** Minimum tier for a supplier/dependency edge to count as a shared dependency. */
  sharedMinTier: RiskStrengthTier;
  /** Edge categories that read as a dependency on the counterparty. */
  dependencyCategories: string[];
  event: RiskEventConfig;
  sharpe: RiskSharpeConfig;
  substitutes: {
    beta: number;
    /** Used only when the Tracker has no benchmark bars at all (fraction). */
    spyVol: number;
  };
  /** Top-N entries carried in the payloads. */
  payloadTop: number;
  templates: RiskTemplates;
  /** Position-change debounce. */
  debounceMs: number;
  /** Trigger-key poll cadence in the host. */
  pollIntervalMs: number;
  historyRetentionDays: number;
  /** Dashboard card reads the snapshot only when this is true (§8). */
  riskCardEnabled: boolean;
};

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  schemaVersion: 3,
  anchors: {
    concentration: [
      [0.05, 10],
      [0.1, 30],
      [0.2, 55],
      [0.33, 75],
      [0.5, 95],
    ],
    market: [
      [0.5, 15],
      [1.0, 45],
      [1.5, 70],
      [2.0, 90],
    ],
    // σ_p in daily percent.
    volatility: [
      [0.8, 15],
      [1.5, 45],
      [2.5, 70],
      [4.0, 90],
    ],
    network: [
      [0, 5],
      [0.15, 40],
      [0.3, 65],
      [0.5, 90],
    ],
    event: [
      [0, 5],
      [10, 40],
      [20, 65],
      [35, 90],
    ],
    // Sharpe runs the other way: the more a book has been paid for its
    // volatility, the lower this reads. Roughly — 0 → 71, 1.0 → 38.
    sharpe: [
      [-1.0, 95],
      [-0.25, 80],
      [0.25, 62],
      [0.75, 45],
      [1.5, 25],
      [2.5, 10],
    ],
  },
  // Rebalanced when Sharpe joined (schema 3). It overlaps §3.3 by construction
  // — the same volatility, now in a denominator — so it takes the smallest share.
  weights: {
    concentration: 0.18,
    market: 0.17,
    volatility: 0.18,
    network: 0.22,
    event: 0.13,
    sharpe: 0.12,
  },
  bands: { moderate: 30, elevated: 55, high: 75 },
  tierWeights: { critical: 1.0, important: 0.6, marginal: 0.3 },
  sharedDependencyFactor: 0.5,
  sharedMinTier: "important",
  dependencyCategories: ["supplier", "dependency"],
  event: {
    incident: { P0: 25, P1: 15, P2: 6, P3: 0 },
    anomalies: { insider_cluster: 8, unexplained_move: 6, drift: 4, filing_overdue: 4 },
    earnings: { horizonSessions: 5, base: 10, rhythmRef: 0.05, maxFactor: 2 },
  },
  sharpe: { windowSessions: 90, minSessions: 60, riskFreeAnnualPct: 4, tradingDaysPerYear: 252 },
  substitutes: { beta: 1.0, spyVol: 0.01 },
  payloadTop: 5,
  templates: {
    concentration: "{pct}% of the portfolio sits in {ticker}.",
    market: "The book moves about {beta_eff}× the market.",
    volatility: "A typical day swings the book about {vol}%.",
    sharpe: "The book's {sessions}-session Sharpe is {sharpe}.",
    network: {
      // No article before the tier: "a important" was a bug waiting in the
      // vocabulary. A mass noun needs none for any tier or category.
      direct: "{a} and {b} share {tier} {category} exposure.",
      shared: "{a} and {b} both depend on {counterparty}.",
    },
    event: {
      incident: "{ticker} has an open {band} incident.",
      insider_cluster: "{ticker} shows an active insider selling cluster.",
      unexplained_move: "{ticker} moved without a matching news explanation.",
      drift: "{ticker} is in an active drift.",
      filing_overdue: "{ticker} has an overdue filing.",
      earnings_window: "{ticker} reports earnings in {n} {sessions}.",
      earnings_today: "{ticker} reports earnings today.",
    },
  },
  debounceMs: 60_000,
  pollIntervalMs: 60_000,
  historyRetentionDays: 180,
  riskCardEnabled: true,
};

function isAnchorTable(value: unknown): value is AnchorTable {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    value.every((p) => Array.isArray(p) && p.length === 2 && p.every((n) => typeof n === "number" && Number.isFinite(n)))
  );
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] };

/** Deep-merge a stored partial config over the defaults (unknown/invalid fields ignored). */
export function mergeRiskConfig(stored: DeepPartial<RiskConfig> | null | undefined): RiskConfig {
  const d = DEFAULT_RISK_CONFIG;
  if (!stored) return structuredClone(d);
  const s = stored;
  const anchors = { ...d.anchors } as Record<RiskComponentKey, AnchorTable>;
  for (const key of Object.keys(d.anchors) as RiskComponentKey[]) {
    const candidate = s.anchors?.[key];
    anchors[key] = isAnchorTable(candidate) ? [...candidate].sort((a, b) => a[0] - b[0]) : [...d.anchors[key]];
  }
  const weights = { ...d.weights };
  for (const key of Object.keys(d.weights) as RiskComponentKey[]) weights[key] = num(s.weights?.[key], d.weights[key]);
  const tierWeights = { ...d.tierWeights };
  for (const key of Object.keys(d.tierWeights) as RiskStrengthTier[]) tierWeights[key] = num(s.tierWeights?.[key], d.tierWeights[key]);
  const incident = { ...d.event.incident };
  for (const key of Object.keys(incident) as RiskPriorityBand[]) incident[key] = num(s.event?.incident?.[key], d.event.incident[key]);
  const anomalies = { ...d.event.anomalies };
  for (const key of Object.keys(anomalies) as RiskAnomalyKind[]) anomalies[key] = num(s.event?.anomalies?.[key], d.event.anomalies[key]);
  const tEvent = { ...d.templates.event };
  for (const key of Object.keys(tEvent) as Array<keyof RiskTemplates["event"]>) tEvent[key] = str(s.templates?.event?.[key], d.templates.event[key]);
  const sharedMinTier = s.sharedMinTier;
  return {
    schemaVersion: d.schemaVersion,
    anchors,
    weights,
    bands: {
      moderate: num(s.bands?.moderate, d.bands.moderate),
      elevated: num(s.bands?.elevated, d.bands.elevated),
      high: num(s.bands?.high, d.bands.high),
    },
    tierWeights,
    sharedDependencyFactor: num(s.sharedDependencyFactor, d.sharedDependencyFactor),
    sharedMinTier: sharedMinTier === "critical" || sharedMinTier === "important" || sharedMinTier === "marginal" ? sharedMinTier : d.sharedMinTier,
    dependencyCategories: Array.isArray(s.dependencyCategories) && s.dependencyCategories.every((c) => typeof c === "string") ? [...s.dependencyCategories] : [...d.dependencyCategories],
    event: {
      incident,
      anomalies,
      earnings: {
        horizonSessions: num(s.event?.earnings?.horizonSessions, d.event.earnings.horizonSessions),
        base: num(s.event?.earnings?.base, d.event.earnings.base),
        rhythmRef: num(s.event?.earnings?.rhythmRef, d.event.earnings.rhythmRef),
        maxFactor: num(s.event?.earnings?.maxFactor, d.event.earnings.maxFactor),
      },
    },
    sharpe: {
      windowSessions: Math.max(2, Math.floor(num(s.sharpe?.windowSessions, d.sharpe.windowSessions))),
      minSessions: Math.max(2, Math.floor(num(s.sharpe?.minSessions, d.sharpe.minSessions))),
      riskFreeAnnualPct: num(s.sharpe?.riskFreeAnnualPct, d.sharpe.riskFreeAnnualPct),
      tradingDaysPerYear: Math.max(1, num(s.sharpe?.tradingDaysPerYear, d.sharpe.tradingDaysPerYear)),
    },
    substitutes: {
      beta: num(s.substitutes?.beta, d.substitutes.beta),
      spyVol: num(s.substitutes?.spyVol, d.substitutes.spyVol),
    },
    payloadTop: Math.max(1, Math.floor(num(s.payloadTop, d.payloadTop))),
    templates: {
      concentration: str(s.templates?.concentration, d.templates.concentration),
      market: str(s.templates?.market, d.templates.market),
      volatility: str(s.templates?.volatility, d.templates.volatility),
      sharpe: str(s.templates?.sharpe, d.templates.sharpe),
      network: {
        direct: str(s.templates?.network?.direct, d.templates.network.direct),
        shared: str(s.templates?.network?.shared, d.templates.network.shared),
      },
      event: tEvent,
    },
    debounceMs: Math.max(0, num(s.debounceMs, d.debounceMs)),
    pollIntervalMs: Math.max(5_000, num(s.pollIntervalMs, d.pollIntervalMs)),
    historyRetentionDays: Math.max(1, num(s.historyRetentionDays, d.historyRetentionDays)),
    riskCardEnabled: typeof s.riskCardEnabled === "boolean" ? s.riskCardEnabled : d.riskCardEnabled,
  };
}
