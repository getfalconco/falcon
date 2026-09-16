/** LLM and Finnhub fetch timeout — skip on expiry, never block the run. */
export const PROPAGATION_TIMEOUT_MS = 15_000;

/** Max concurrent judge + priced-in tasks (same pattern as step1 mapPool). */
export const PROPAGATION_CONCURRENCY = Math.max(
  1,
  Number.parseInt(process.env.FALCON_PROPAGATION_CONCURRENCY ?? "8", 10) || 8,
);

/** @deprecated use PROPAGATION_CONCURRENCY */
export const JUDGE_CONCURRENCY = PROPAGATION_CONCURRENCY;
