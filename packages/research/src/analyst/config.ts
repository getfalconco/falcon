/**
 * Analyst configuration (§13 — "all configuration, no code constants").
 *
 * Everything the service, the reaction_state computation, the validators and
 * the prompt read is here: model, sampling, timeouts, retries, concurrency,
 * breaker, the news line cap, the tier-expectation map, the edge_default
 * thresholds, the generic-trigger rejection list, field caps, retention and
 * the Phase B surfacing flag. The daily budget is Base's (§8).
 */

import type { Materiality } from "../classifier/types.js";
import type { AnalystRequestKind } from "./types.js";

const MINUTE = 60_000;

export type AnalystBreakerConfig = {
  /** Consecutive transport failures that open the breaker (§8 `k`). */
  consecutiveFailures: number;
  /** How long dispatches are refused once open. */
  cooldownMs: number;
};

export type AnalystEdgeDefaultConfig = {
  /** No cause and |realized_z| at or above this → `watch` (§4). */
  watchMinAbsZ: number;
  /**
   * Half-width of the `consistent` band around tier_expectation_z:
   * |z| > tier + band → exceeded, |z| < tier − band → short_of, else consistent.
   */
  consistentBandZ: number;
  /**
   * Below this R² the residual model is not trusted and the move basis is
   * used (mirrors the Tracker's low-R² fallback, §4).
   */
  lowR2Fallback: number;
  /**
   * v1.1: a best_cause below this materiality can never default to no_edge —
   * a low-materiality verdict does not "price in" an anomaly; the default is
   * capped at undetermined.
   */
  noEdgeMinMateriality: Materiality;
};

export type AnalystFieldCaps = {
  cause_summary: number;
  mechanism: number;
  edge_rationale: number;
  watch_trigger: number;
  /** Maximum evidence refs accepted. */
  evidence: number;
};

export type AnalystConfig = {
  /** Master switch for the live (Phase A) loop in the desktop host. */
  enabled: boolean;
  model: string;
  /** Kept for the seam; Fable 5 rejects sampling params so the live caller omits it. */
  temperature: number;
  /** Fable 5's thinking counts toward max_tokens — do not lowball (§8). */
  maxTokens: number;
  /** output_config.effort for adaptive-thinking models. */
  effort: "low" | "medium" | "high" | "xhigh" | "max";
  /** §8: Fable reasons slowly. */
  timeoutMs: number;
  /** Retries on transport error (§8 "retry ×2 on transport"). */
  transportRetries: number;
  /** Retries on validation failure (§5 "retry with validator error appended (×2)"). */
  validationRetries: number;
  /** Base backoff between transport retries; doubles per attempt. */
  retryBackoffMs: number;
  concurrency: number;
  /** Default prompt version; a kind with its own template overrides it below. */
  promptVersion: string;
  /**
   * S3: `structure_review` asks a different question of different inputs, so
   * it carries its own template and its own version.
   */
  promptVersionOverrides: Partial<Record<AnalystRequestKind, string>>;
  breaker: AnalystBreakerConfig;
  /** §3: classified news lines shipped to the model, direct first. */
  newsLineCap: number;
  /** §3: insider_filing lines shipped (the cluster payload already summarises them). */
  insiderLineCap: number;
  /** §4: |z| a cause of each materiality tier is expected to produce. */
  tierExpectationZ: Record<Materiality, number>;
  edgeDefault: AnalystEdgeDefaultConfig;
  /** §5: watch_trigger phrases rejected as unfalsifiable (case-insensitive substring). */
  genericTriggerPhrases: string[];
  fieldCaps: AnalystFieldCaps;
  /**
   * §8: a failed request is retried on later cycles up to this many total
   * attempts, then marked permanent-failed and surfaced.
   */
  maxAttemptsPerRequest: number;
  /** §9: outputs are kept this long (aligned with incidents). */
  retentionDays: number;
  /** Size of the rolling latency window kept for p50/p95. */
  latencyWindow: number;
  /** §12 Phase B gate — outputs stay log-only while false. */
  analystSurfacingEnabled: boolean;
};

export const DEFAULT_ANALYST_CONFIG: AnalystConfig = {
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
  promptVersion: "an-1.0",
  promptVersionOverrides: { structure_review: "an-1.1" },
  breaker: { consecutiveFailures: 3, cooldownMs: 10 * MINUTE },
  newsLineCap: 20,
  insiderLineCap: 12,
  tierExpectationZ: { high: 2.0, standard: 1.0, low: 0.5 },
  edgeDefault: { watchMinAbsZ: 2.0, consistentBandZ: 0.5, lowR2Fallback: 0.15, noEdgeMinMateriality: "standard" },
  genericTriggerPhrases: [
    "watch for news",
    "watch for any news",
    "monitor the situation",
    "monitor developments",
    "monitor for developments",
    "keep an eye on",
    "wait and see",
    "stay tuned",
    "further developments",
    "any further news",
    "watch closely",
    "continue monitoring",
    "continue to monitor",
    "see how it develops",
    "general market conditions",
  ],
  fieldCaps: { cause_summary: 240, mechanism: 240, edge_rationale: 240, watch_trigger: 240, evidence: 12 },
  maxAttemptsPerRequest: 3,
  retentionDays: 90,
  latencyWindow: 500,
  analystSurfacingEnabled: false,
};

/** The prompt version a kind is served by (§13 — config, not a code constant). */
export function promptVersionFor(kind: AnalystRequestKind, config: Pick<AnalystConfig, "promptVersion" | "promptVersionOverrides">): string {
  return config.promptVersionOverrides[kind] ?? config.promptVersion;
}

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
  const raw = process.env.FALCON_ANALYST_MODEL?.trim();
  return raw ? raw : null;
}

export function mergeAnalystConfig(partial: Partial<AnalystConfig> | null | undefined): AnalystConfig {
  const base = structuredClone(DEFAULT_ANALYST_CONFIG);
  const override = modelOverride();
  if (!partial) return override ? { ...base, model: override } : base;
  return {
    ...base,
    ...partial,
    ...(override ? { model: override } : {}),
    breaker: { ...base.breaker, ...(partial.breaker ?? {}) },
    promptVersionOverrides: { ...base.promptVersionOverrides, ...(partial.promptVersionOverrides ?? {}) },
    tierExpectationZ: { ...base.tierExpectationZ, ...(partial.tierExpectationZ ?? {}) },
    edgeDefault: { ...base.edgeDefault, ...(partial.edgeDefault ?? {}) },
    fieldCaps: { ...base.fieldCaps, ...(partial.fieldCaps ?? {}) },
    genericTriggerPhrases: Array.isArray(partial.genericTriggerPhrases)
      ? partial.genericTriggerPhrases
      : base.genericTriggerPhrases,
  };
}
