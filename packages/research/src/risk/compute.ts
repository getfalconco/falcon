/**
 * `computeRiskSnapshot` — the one pure entry point: inputs + config → snapshot.
 * Fully deterministic; the host only gathers inputs and persists the result.
 */

import { roundScore, round } from "./anchors.js";
import { bandFor, blendScore, effectiveWeights, pickDriver } from "./blend.js";
import type { RiskConfig } from "./config.js";
import {
  buildWeights,
  concentrationComponent,
  eventComponent,
  marketComponent,
  networkComponent,
  resolveBetas,
  sharpeComponent,
  volatilityComponent,
} from "./components.js";
import { RISK_SCHEMA_VERSION, type RiskComponents, type RiskDegraded, type RiskInputs, type RiskSnapshot, type RiskTriggerReason } from "./types.js";

export type ComputeOptions = {
  trigger?: RiskTriggerReason[];
};

function dedupeDegraded(list: RiskDegraded[]): RiskDegraded[] {
  const seen = new Set<string>();
  const out: RiskDegraded[] = [];
  for (const d of list) {
    const key = `${d.ticker}|${d.field}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(d);
  }
  return out.sort((a, b) => a.ticker.localeCompare(b.ticker) || a.field.localeCompare(b.field));
}

export function computeRiskSnapshot(inputs: RiskInputs, config: RiskConfig, options: ComputeOptions = {}): RiskSnapshot {
  const trigger = options.trigger && options.trigger.length > 0 ? [...options.trigger] : ["manual" as const];
  const quant: Record<string, RiskInputs["quant"][string]> = {};
  for (const [k, v] of Object.entries(inputs.quant ?? {})) quant[k.toUpperCase()] = v;

  const { weights, invested_fraction, degraded: weightDegraded } = buildWeights(inputs.account, quant);
  const graphVersion = inputs.graph ? { ...inputs.graph.version } : null;
  const base = {
    schema_version: RISK_SCHEMA_VERSION,
    computed_at: inputs.now,
    account: "paper" as const,
    trigger,
    invested_fraction: round(invested_fraction, 4),
    position_count: weights.length,
    weights: weights.map((w) => ({ ...w, weight: round(w.weight, 5), market_value: round(w.market_value, 2) })),
    blend_weights: { ...config.weights },
    graph_version: graphVersion,
  };

  if (weights.length === 0) {
    return { ...base, score: null, band: null, components: null, driver: null, degraded: dedupeDegraded(weightDegraded), empty: true };
  }

  const degraded: RiskDegraded[] = [...weightDegraded];
  const betas = resolveBetas(weights, quant, config, degraded);
  const concentration = concentrationComponent(weights, config);
  const market = marketComponent(weights, betas, invested_fraction, config);
  const volatility = volatilityComponent(weights, betas, quant, { spyVol: inputs.spy_daily_vol, universeMedianVol: inputs.universe_median_vol }, config, degraded);
  const network = networkComponent(weights, inputs.graph, config, degraded);
  const event = eventComponent(weights, inputs.live, quant, config);
  const sharpe = sharpeComponent(weights, inputs.bars ?? {}, config, degraded);

  const components: RiskComponents = { concentration, market, volatility, network, event, sharpe };
  // Component scores are integers in the snapshot; the blend runs on the same
  // integers so a reader can re-derive the score from what they see.
  for (const key of Object.keys(components) as Array<keyof RiskComponents>) {
    const raw = components[key].score;
    if (raw != null) components[key].score = roundScore(raw);
  }
  const score = blendScore(components, config.weights);
  const driver = pickDriver(components, config);
  return {
    ...base,
    // What the blend actually applied — Sharpe drops out on thin history and
    // the rest are renormalised, so the panel's arithmetic still adds up.
    blend_weights: effectiveWeights(components, config.weights),
    score,
    band: bandFor(score, config.bands),
    components,
    driver,
    degraded: dedupeDegraded(degraded),
    empty: false,
  };
}
