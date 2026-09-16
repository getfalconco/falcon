/**
 * §4 blend, bands and driver. score = Σ component × weight; the driver is the
 * component with the largest score × weight contribution (tie → higher blend
 * weight, then the canonical component order). Sentences are config templates
 * with values injected from the component payloads — descriptive voice only.
 */

import { round, roundScore } from "./anchors.js";
import type { RiskConfig } from "./config.js";
import { RISK_COMPONENT_KEYS, type RiskBand, type RiskComponentKey, type RiskComponents, type RiskDriver } from "./types.js";

/**
 * The weights actually applied: a component that produced no score (Sharpe on
 * too little history) leaves the blend, and what remains is renormalised so
 * the score keeps its 0–100 meaning instead of quietly deflating. With every
 * component present and a config that sums to 1, these are the config's own.
 */
export function effectiveWeights(
  components: RiskComponents,
  weights: Record<RiskComponentKey, number>,
): Record<RiskComponentKey, number> {
  const present = RISK_COMPONENT_KEYS.filter((key) => components[key].score != null);
  const total = present.reduce((s, key) => s + (weights[key] ?? 0), 0);
  const out = {} as Record<RiskComponentKey, number>;
  for (const key of RISK_COMPONENT_KEYS) {
    out[key] = present.includes(key) && total > 0 ? (weights[key] ?? 0) / total : 0;
  }
  return out;
}

export function blendScore(components: RiskComponents, weights: Record<RiskComponentKey, number>): number {
  const effective = effectiveWeights(components, weights);
  let total = 0;
  for (const key of RISK_COMPONENT_KEYS) total += (components[key].score ?? 0) * effective[key];
  return roundScore(total);
}

export function bandFor(score: number, bands: RiskConfig["bands"]): RiskBand {
  if (score >= bands.high) return "high";
  if (score >= bands.elevated) return "elevated";
  if (score >= bands.moderate) return "moderate";
  return "low";
}

export function pickDriverKey(components: RiskComponents, weights: Record<RiskComponentKey, number>): RiskComponentKey {
  let best: RiskComponentKey = RISK_COMPONENT_KEYS[0];
  let bestValue = -Infinity;
  for (const key of RISK_COMPONENT_KEYS) {
    // A component with no score cannot be the reason the score is what it is.
    if (components[key].score == null) continue;
    const value = (components[key].score ?? 0) * (weights[key] ?? 0);
    const better = value > bestValue || (value === bestValue && (weights[key] ?? 0) > (weights[best] ?? 0));
    if (better) {
      best = key;
      bestValue = value;
    }
  }
  return best;
}

function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, name: string) => (values[name] != null ? String(values[name]) : `{${name}}`));
}

const CATEGORY_PHRASE: Record<string, string> = {
  supplier: "supply-chain",
  customer: "customer",
  competitor: "competitive",
  partner: "partnership",
  dependency: "dependency",
};

export function categoryPhrase(category: string): string {
  return CATEGORY_PHRASE[category] ?? category.replace(/_/g, " ");
}

/** The deterministic sentence for a component, from its payload. */
export function componentSentence(key: RiskComponentKey, components: RiskComponents, config: RiskConfig): string {
  const t = config.templates;
  switch (key) {
    case "concentration": {
      const top = components.concentration.top[0];
      return top
        ? fill(t.concentration, { pct: Math.round(top.weight * 100), ticker: top.ticker })
        : "The portfolio holds no positions.";
    }
    case "market":
      return fill(t.market, { beta_eff: round(components.market.beta_eff, 2).toFixed(2) });
    case "volatility":
      return fill(t.volatility, { vol: round(components.volatility.port_vol_daily_pct, 1).toFixed(1) });
    case "network": {
      const link = components.network.top_links[0];
      if (!link) return "No filing-backed links between held names.";
      if (link.via === "shared") {
        return fill(t.network.shared, { a: link.a, b: link.b, counterparty: link.counterparty_label ?? link.counterparty ?? "the same counterparty", tier: link.tier });
      }
      return fill(t.network.direct, { a: link.a, b: link.b, tier: link.tier, category: categoryPhrase(link.category) });
    }
    case "sharpe": {
      const s = components.sharpe;
      if (s.sharpe == null) return "Not enough history to measure return per unit of volatility.";
      return fill(t.sharpe, { sessions: s.sessions, sharpe: s.sharpe.toFixed(2) });
    }
    case "event": {
      const c = components.event.contributors[0];
      if (!c) return "No open incidents or scheduled events on held names.";
      switch (c.kind) {
        case "incident":
          return fill(t.event.incident, { ticker: c.ticker, band: c.detail });
        case "earnings_window": {
          if (c.detail === "today") return fill(t.event.earnings_today, { ticker: c.ticker });
          const n = parseInt(c.detail, 10);
          return fill(t.event.earnings_window, { ticker: c.ticker, n, sessions: n === 1 ? "session" : "sessions" });
        }
        default:
          return fill(t.event[c.kind], { ticker: c.ticker });
      }
    }
  }
}

export function pickDriver(components: RiskComponents, config: RiskConfig): RiskDriver {
  // Ranked on the weights actually applied, so a dropped component cannot
  // shift which of the survivors reads as the driver.
  const effective = effectiveWeights(components, config.weights);
  const key = pickDriverKey(components, effective);
  return {
    component: key,
    sentence: componentSentence(key, components, config),
    contribution: round((components[key].score ?? 0) * effective[key], 3),
  };
}
