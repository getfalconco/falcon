/**
 * Classifier configuration (§14 — "all configuration, no code constants").
 *
 * Everything the service, the prompt and the eval gate read is here: model,
 * sampling, timeouts, retries, concurrency, ticker cap, verdict TTL, prompt
 * version, breaker parameters, metadata refresh interval and the §13 gate
 * thresholds. The §10b severity mapping lives on the Base side — Base owns
 * re-score — and the §9 daily budget is Base's too.
 */

import type { CapBucket } from "./types.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export type ClassifierEvalThresholds = {
  /** §13: relevance accuracy ≥ 0.90. */
  relevanceAccuracy: number;
  /** §13: event_type top-1 accuracy ≥ 0.80. */
  eventTypeAccuracy: number;
  /** §13: materiality within one tier ≥ 0.85. */
  materialityWithinOneTier: number;
  /** §13: direction accuracy on the direct subset ≥ 0.85. */
  directionAccuracyDirect: number;
  /** §13: the eval set must hold at least this many labeled articles. */
  minLabeledArticles: number;
};

export type ClassifierBreakerConfig = {
  /** Consecutive transport failures that open the breaker (§9 `k`). */
  consecutiveFailures: number;
  /** How long dispatches are refused once open. */
  cooldownMs: number;
};

/** §2 cap buckets — ascending inclusive lower bounds in USD. */
export type CapBucketThresholds = Record<Exclude<CapBucket, "small">, number>;

export type ClassifierConfig = {
  /** Master switch for the live (Phase A) loop in the desktop host. */
  enabled: boolean;
  model: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** Retries on transport error (§9 "retry ×2 with backoff"). */
  transportRetries: number;
  /** Retries on validation failure (§7 "retry up to 2 times"). */
  validationRetries: number;
  /** Base backoff between transport retries; doubles per attempt. */
  retryBackoffMs: number;
  concurrency: number;
  tickerCap: number;
  verdictTtlDays: number;
  promptVersion: string;
  breaker: ClassifierBreakerConfig;
  metadataRefreshMs: number;
  capBuckets: CapBucketThresholds;
  eval: ClassifierEvalThresholds;
  /** Size of the rolling latency window kept for p50/p95. */
  latencyWindow: number;
  /**
   * §9: a classification_failed article is retried on later batch cycles up
   * to this many total attempts, then marked permanent-failed.
   */
  maxAttemptsPerArticle: number;
};

export const DEFAULT_CLASSIFIER_CONFIG: ClassifierConfig = {
  enabled: false,
  model: "claude-haiku-4-5",
  temperature: 0,
  maxTokens: 1024,
  timeoutMs: 30_000,
  transportRetries: 2,
  validationRetries: 2,
  retryBackoffMs: 1_000,
  concurrency: 4,
  tickerCap: 8,
  verdictTtlDays: 7,
  promptVersion: "cls-1.0",
  breaker: { consecutiveFailures: 5, cooldownMs: 5 * MINUTE },
  metadataRefreshMs: 7 * DAY,
  capBuckets: { mega: 200e9, large: 10e9, mid: 2e9 },
  eval: {
    relevanceAccuracy: 0.9,
    eventTypeAccuracy: 0.8,
    materialityWithinOneTier: 0.85,
    directionAccuracyDirect: 0.85,
    minLabeledArticles: 100,
  },
  latencyWindow: 500,
  maxAttemptsPerArticle: 3,
};

/** Deep-merge a persisted partial config over the defaults. */
/**
 * Deployment-level model override.
 *
 * The stored config wins over the image once a volume has been written, which
 * is correct — the running chain's own settings should outrank a seed. But it
 * also means editing `seed-data` to change the model silently does nothing on
 * a box that has already run, and the only symptom is that the old model keeps
 * answering. Same shape as the budget override, for the same reason.
 */
function modelOverride(): string | null {
  const raw = process.env.FALCON_CLASSIFIER_MODEL?.trim();
  return raw ? raw : null;
}

export function mergeClassifierConfig(
  partial: Partial<ClassifierConfig> | null | undefined,
): ClassifierConfig {
  const base = structuredClone(DEFAULT_CLASSIFIER_CONFIG);
  const override = modelOverride();
  if (!partial) return override ? { ...base, model: override } : base;
  return {
    ...base,
    ...partial,
    breaker: { ...base.breaker, ...(partial.breaker ?? {}) },
    capBuckets: { ...base.capBuckets, ...(partial.capBuckets ?? {}) },
    eval: { ...base.eval, ...(partial.eval ?? {}) },
    // Last, so it beats the stored config too. Placed before `...partial` this
    // read as an override and behaved as a default — the exact silent failure
    // it exists to prevent, since the only symptom is the old model answering.
    ...(override ? { model: override } : {}),
  };
}

/** §2 bucket from a USD market cap; null when the cap is unknown. */
export function capBucketOf(
  marketCapUsd: number | null | undefined,
  thresholds: CapBucketThresholds = DEFAULT_CLASSIFIER_CONFIG.capBuckets,
): CapBucket | null {
  if (marketCapUsd === null || marketCapUsd === undefined || !Number.isFinite(marketCapUsd)) {
    return null;
  }
  if (marketCapUsd < 0) return null;
  if (marketCapUsd >= thresholds.mega) return "mega";
  if (marketCapUsd >= thresholds.large) return "large";
  if (marketCapUsd >= thresholds.mid) return "mid";
  return "small";
}
