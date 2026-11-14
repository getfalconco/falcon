/** Token usage and its estimated cost (list prices per million tokens, checked 2026-11-14). */

export type Usage = {
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  usd: number;
  promptVersion: string;
};

const PRICES: Record<string, { input: number; output: number; cacheRead: number }> = {
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.1 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
};

/** Cache writes are priced as 1-hour writes (2x input), the TTL these prompts use. */
export function costUsd(u: Pick<Usage, "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens">, model: string): number {
  const p = PRICES[model] ?? PRICES["claude-sonnet-5-5"]!;
  return (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.input * 2) / 1e6;
}
