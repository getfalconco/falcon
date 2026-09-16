/**
 * Panel row model (spec §7) — the one place that decides what the Shift+R
 * panel renders per component.
 *
 * Why this is a module and not a loop inside the panel: a snapshot is stored
 * data, and stored data outlives the code that wrote it. Snapshots written
 * before a component existed have no payload for it, and the panel iterating
 * the current component list would dereference `components.sharpe.sharpe` on
 * a five-component snapshot — a TypeError, and because the panel is mounted as
 * a sibling of <App/>, one that takes the whole window white. So a missing
 * payload is a first-class state here ("not measured"), exactly like a
 * component that ran and could not produce a score.
 */

import {
  RISK_COMPONENT_KEYS,
  type RiskComponentKey,
  type RiskComponents,
  type RiskSnapshot,
} from "./risk-types";

export const RISK_COMPONENT_LABEL: Record<RiskComponentKey, string> = {
  concentration: "Concentration",
  market: "Market sensitivity",
  volatility: "Volatility",
  network: "Network concentration",
  event: "Live event risk",
  sharpe: "Risk-adjusted return",
};

export type RiskPanelRow = {
  key: RiskComponentKey;
  label: string;
  /** null when the payload is missing (older snapshot) or the score was not measured. */
  score: number | null;
  weight: number;
  /** score × weight, null when there is no score. */
  contribution: number | null;
  isDriver: boolean;
  /**
   * "scored"    — payload present with a score
   * "unmeasured"— payload present, no score (out of the blend)
   * "absent"    — no payload at all: written before this component existed
   */
  state: "scored" | "unmeasured" | "absent";
};

export function riskPanelRows(snapshot: RiskSnapshot): RiskPanelRow[] {
  const components = (snapshot.components ?? {}) as Partial<RiskComponents>;
  const weights = snapshot.blend_weights ?? ({} as Record<RiskComponentKey, number>);
  return RISK_COMPONENT_KEYS.map((key) => {
    const payload = components[key];
    const rawScore = payload?.score;
    const score = typeof rawScore === "number" && Number.isFinite(rawScore) ? rawScore : null;
    const rawWeight = weights[key];
    const weight = typeof rawWeight === "number" && Number.isFinite(rawWeight) ? rawWeight : 0;
    return {
      key,
      label: RISK_COMPONENT_LABEL[key],
      score,
      weight,
      contribution: score == null ? null : score * weight,
      isDriver: snapshot.driver?.component === key,
      state: payload == null ? "absent" : score == null ? "unmeasured" : "scored",
    };
  });
}

/** The payload for a component, or null when this snapshot predates it. */
export function componentPayload<K extends RiskComponentKey>(
  snapshot: RiskSnapshot,
  key: K,
): RiskComponents[K] | null {
  const components = (snapshot.components ?? {}) as Partial<RiskComponents>;
  return (components[key] ?? null) as RiskComponents[K] | null;
}
