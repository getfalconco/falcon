/** Claude Sonnet list pricing (USD per 1M tokens) — for cost estimates only. */
export const SONNET_INPUT_USD_PER_M = 3;
export const SONNET_OUTPUT_USD_PER_M = 15;

/**
 * Cache multipliers, applied to the input rate.
 *
 * A write costs MORE than sending the text uncached; it only pays for itself
 * once something reads it back. Tracking the two separately is the whole point
 * — a run with large `cacheCreationTokens` and near-zero `cacheReadTokens` is
 * paying the premium and collecting none of the discount, which is invisible if
 * you only sum "input tokens".
 */
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;

export type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Tokens written to the prompt cache, billed at 1.25x the input rate. */
  cacheCreationTokens: number;
  /** Tokens served from the prompt cache, billed at 0.1x the input rate. */
  cacheReadTokens: number;
};

export function createTokenUsage(): TokenUsage {
  return { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 };
}

export function addTokenUsage(target: TokenUsage, delta: TokenUsage): void {
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheCreationTokens += delta.cacheCreationTokens ?? 0;
  target.cacheReadTokens += delta.cacheReadTokens ?? 0;
}

export function estimateCostUsd(usage: TokenUsage): number {
  const cacheWrite = usage.cacheCreationTokens ?? 0;
  const cacheRead = usage.cacheReadTokens ?? 0;
  return (
    (usage.inputTokens / 1_000_000) * SONNET_INPUT_USD_PER_M +
    (cacheWrite / 1_000_000) * SONNET_INPUT_USD_PER_M * CACHE_WRITE_MULTIPLIER +
    (cacheRead / 1_000_000) * SONNET_INPUT_USD_PER_M * CACHE_READ_MULTIPLIER +
    (usage.outputTokens / 1_000_000) * SONNET_OUTPUT_USD_PER_M
  );
}

/**
 * Read ÷ write. Below 1 the cache is costing more than it saves: every write is
 * 1.25x and every read only claws back 0.9x of one, so a breakpoint needs
 * roughly one read per write just to break even.
 */
export function cacheEfficiency(usage: TokenUsage): number | null {
  const write = usage.cacheCreationTokens ?? 0;
  if (write === 0) return null;
  return (usage.cacheReadTokens ?? 0) / write;
}
