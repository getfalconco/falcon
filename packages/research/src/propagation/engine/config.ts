/**
 * Propagation configuration (§5, §6, §7, §11, §13 — every calibration knob
 * is data, not code).
 *
 * The transmission matrix, the strength map, the pricing thresholds and tier
 * scales, the horizon, max_targets, the 8-K item → event shape map, the
 * stage-2 model settings, retries, breaker, field caps, retention and the
 * Phase B surfacing flag all live here. The stage-2 daily budget and the
 * dispatch band are Base's (`BaseConfig.propagation`).
 */

import type { Direction, EventType, Materiality } from "../../classifier/types.js";
import { EVENT_TYPES } from "../../classifier/types.js";
import {
  PROPAGATION_ROLES,
  type MatrixCell,
  type PropagationRole,
  type PropagationTier,
  type StrengthTier,
  type TransmissionMatrix,
} from "./types.js";

const MINUTE = 60_000;

export type PropagationBreakerConfig = {
  /** Consecutive transport failures that open the breaker (§7 `k`). */
  consecutiveFailures: number;
  cooldownMs: number;
};

export type PropagationPricingConfig = {
  /** |realized| below this × expected → open (§6). */
  openBelow: number;
  /** |realized| at or above this × expected, in the transmitted direction → priced. */
  pricedAtOrAbove: number;
  /** Expected scale = daily_vol_30d × tierScale[tier]. */
  tierScale: Record<PropagationTier, number>;
  /** Sessions from the event inside which the check is live; beyond → stale. */
  horizonSessions: number;
  /** Below this R² the residual basis is not trusted → raw move (flagged). */
  lowR2Fallback: number;
};

/** How a mapped 8-K item code is read as an event when no verdict exists (§2). */
export type EightKItemEvent = {
  type: EventType;
  materiality: Materiality;
  direction: Direction;
  label: string;
};

export type PropagationFieldCaps = {
  mechanism: number;
  rationale: number;
  label: number;
};

export type PropagationConfig = {
  /** Master switch for the live (Phase A) loop in the desktop host. */
  enabled: boolean;
  // --- stage-2 model (§7) ---
  model: string;
  /** Kept for the seam; Fable 5 rejects sampling params so the live caller omits it. */
  temperature: number;
  maxTokens: number;
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  timeoutMs: number;
  transportRetries: number;
  validationRetries: number;
  retryBackoffMs: number;
  concurrency: number;
  promptVersion: string;
  breaker: PropagationBreakerConfig;
  // --- stage-1 (§4–§6) ---
  maxTargets: number;
  matrix: TransmissionMatrix;
  /** strength_tier × event materiality → propagation tier (§6). */
  strengthMap: Record<StrengthTier, Record<Materiality, PropagationTier>>;
  pricing: PropagationPricingConfig;
  eightKItemEvents: Record<string, EightKItemEvent>;
  /** |gap_z| at or above this reads as a high-materiality gap cause. */
  gapHighMaterialityZ: number;
  fieldCaps: PropagationFieldCaps;
  // --- §11 ---
  maxAttemptsPerRequest: number;
  retentionDays: number;
  latencyWindow: number;
  /**
   * §10 Phase B gate — historical. Surfacing graduated to on-by-default once
   * the dashboard card shipped; the flag remains only as an off switch.
   */
  propagationSurfacingEnabled: boolean;
  /** Bumped when a stored config needs a one-time migration on load. */
  configVersion: number;
};

// ---------------------------------------------------------------------------
// §5 seed matrix — all config, calibrated later
// ---------------------------------------------------------------------------

type Row = Record<PropagationRole, MatrixCell>;

const cell = (transmits: MatrixCell["transmits"], direction: MatrixCell["direction"], note?: string): MatrixCell =>
  note ? { transmits, direction, note } : { transmits, direction };

const NO: MatrixCell = { transmits: "no", direction: "unclear" };

const NONE_ROW: Row = {
  supplier: NO,
  customer: NO,
  competitor: NO,
  partner: NO,
  dependency: NO,
  depended_on_by: NO,
};

const EARNINGS_ROW: Row = {
  supplier: cell("yes", "same", "demand read-through"),
  customer: cell("weak", "same"),
  competitor: cell("yes", "unclear", "share-shift vs sector read-through — stage-2 resolves"),
  partner: cell("weak", "same"),
  dependency: cell("yes", "same"),
  depended_on_by: cell("weak", "same"),
};

const SUPPLY_ROW: Row = {
  supplier: cell("weak", "same"),
  customer: cell("yes", "inverse", "supply risk to the root's customers"),
  competitor: cell("yes", "inverse", "competitors gain"),
  partner: cell("weak", "same"),
  dependency: cell("yes", "same"),
  depended_on_by: cell("yes", "inverse", "supply risk to those who depend on the root"),
};

const REGULATORY_ROW: Row = {
  supplier: cell("weak", "same"),
  customer: cell("weak", "same"),
  competitor: cell("yes", "inverse"),
  partner: cell("yes", "same"),
  dependency: cell("yes", "same"),
  depended_on_by: cell("weak", "same"),
};

const PRODUCT_ROW: Row = {
  supplier: cell("weak", "same"),
  customer: cell("weak", "same"),
  competitor: cell("yes", "inverse"),
  partner: cell("yes", "same"),
  dependency: cell("weak", "same"),
  depended_on_by: cell("weak", "same"),
};

const MA_ROW: Row = {
  supplier: cell("weak", "same"),
  customer: cell("weak", "same"),
  competitor: cell("yes", "unclear", "consolidation vs peer re-rating — stage-2 resolves"),
  partner: cell("yes", "same"),
  dependency: cell("weak", "same"),
  depended_on_by: cell("weak", "same"),
};

const CONTRACT_ROW: Row = {
  supplier: cell("yes", "same"),
  customer: cell("yes", "same"),
  competitor: cell("yes", "inverse"),
  partner: cell("yes", "same"),
  dependency: cell("weak", "same"),
  depended_on_by: cell("yes", "same"),
};

const GOVERNANCE_ROW: Row = {
  supplier: NO,
  customer: NO,
  competitor: cell("weak", "unclear"),
  partner: cell("weak", "same"),
  dependency: cell("weak", "same"),
  depended_on_by: cell("weak", "same"),
};

export const DEFAULT_TRANSMISSION_MATRIX: TransmissionMatrix = {
  earnings_results: EARNINGS_ROW,
  guidance: EARNINGS_ROW,
  supply_chain_ops: SUPPLY_ROW,
  regulatory_decision: REGULATORY_ROW,
  product_clinical: PRODUCT_ROW,
  ma_activity: MA_ROW,
  contract_partnership: CONTRACT_ROW,
  legal: GOVERNANCE_ROW,
  management_governance: GOVERNANCE_ROW,
  financing_credit: GOVERNANCE_ROW,
  analyst_action: NONE_ROW,
  ownership_flows: NONE_ROW,
  macro_sector: NONE_ROW,
  capital_allocation: NONE_ROW,
  other: NONE_ROW,
};

export const DEFAULT_PROPAGATION_CONFIG: PropagationConfig = {
  enabled: false,
  model: "claude-fable-5",
  temperature: 0,
  maxTokens: 16_000,
  effort: "high",
  timeoutMs: 120_000,
  transportRetries: 2,
  validationRetries: 2,
  retryBackoffMs: 2_000,
  concurrency: 2,
  promptVersion: "pr-1.0",
  breaker: { consecutiveFailures: 3, cooldownMs: 10 * MINUTE },
  maxTargets: 15,
  matrix: DEFAULT_TRANSMISSION_MATRIX,
  strengthMap: {
    critical: { high: "strong", standard: "moderate", low: "weak" },
    important: { high: "moderate", standard: "weak", low: "weak" },
    marginal: { high: "weak", standard: "weak", low: "weak" },
  },
  pricing: {
    openBelow: 0.35,
    pricedAtOrAbove: 1.0,
    tierScale: { strong: 1.0, moderate: 0.5, weak: 0.25 },
    horizonSessions: 3,
    lowR2Fallback: 0.15,
  },
  eightKItemEvents: {
    "2.02": { type: "earnings_results", materiality: "high", direction: "unclear", label: "8-K Item 2.02 — results of operations" },
    "1.01": { type: "contract_partnership", materiality: "standard", direction: "unclear", label: "8-K Item 1.01 — material definitive agreement" },
    "1.05": { type: "supply_chain_ops", materiality: "standard", direction: "negative", label: "8-K Item 1.05 — material cybersecurity incident" },
    "5.02": { type: "management_governance", materiality: "standard", direction: "unclear", label: "8-K Item 5.02 — officer / director change" },
    "8.01": { type: "other", materiality: "low", direction: "unclear", label: "8-K Item 8.01 — other events" },
  },
  gapHighMaterialityZ: 3.0,
  fieldCaps: { mechanism: 200, rationale: 200, label: 120 },
  maxAttemptsPerRequest: 3,
  retentionDays: 90,
  latencyWindow: 500,
  propagationSurfacingEnabled: true,
  configVersion: 2,
};

/** Deep-merge a persisted partial config over the defaults. */
/**
 * Deployment-level model override.
 *
 * Stored config wins over the seed once a volume exists, which is right — the
 * running chain's settings should outrank an image — but it means editing
 * seed-data changes nothing on a box that has already run, and the only
 * symptom is the old model still answering.
 */
function modelOverride(): string | null {
  const raw = process.env.FALCON_PROPAGATION_MODEL?.trim();
  return raw ? raw : null;
}

export function mergePropagationConfig(partial: Partial<PropagationConfig> | null | undefined): PropagationConfig {
  const base = structuredClone(DEFAULT_PROPAGATION_CONFIG);
  const override = modelOverride();
  if (!partial) return override ? { ...base, model: override } : base;
  const matrix = structuredClone(base.matrix);
  if (partial.matrix && typeof partial.matrix === "object") {
    for (const eventType of EVENT_TYPES) {
      const row = (partial.matrix as Partial<TransmissionMatrix>)[eventType];
      if (!row) continue;
      for (const role of PROPAGATION_ROLES) {
        const c = row[role];
        if (c && typeof c === "object") matrix[eventType][role] = { ...matrix[eventType][role], ...c };
      }
    }
  }
  const strengthMap = structuredClone(base.strengthMap);
  if (partial.strengthMap) {
    for (const tier of Object.keys(strengthMap) as StrengthTier[]) {
      strengthMap[tier] = { ...strengthMap[tier], ...(partial.strengthMap[tier] ?? {}) };
    }
  }
  return {
    ...base,
    ...partial,
    breaker: { ...base.breaker, ...(partial.breaker ?? {}) },
    matrix,
    strengthMap,
    pricing: {
      ...base.pricing,
      ...(partial.pricing ?? {}),
      tierScale: { ...base.pricing.tierScale, ...(partial.pricing?.tierScale ?? {}) },
    },
    eightKItemEvents: { ...base.eightKItemEvents, ...(partial.eightKItemEvents ?? {}) },
    fieldCaps: { ...base.fieldCaps, ...(partial.fieldCaps ?? {}) },
    // Last, so it beats the stored config too — placed earlier it would read
    // as an override and behave as a default.
    ...(override ? { model: override } : {}),
  };
}
