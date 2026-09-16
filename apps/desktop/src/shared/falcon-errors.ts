/**
 * User-facing Falcon errors. Short copy for investors; unique codes for the team.
 * Keep in sync with:
 *   apps/research-worker/src/errors.ts
 *   apps/mobile/src/lib/errors.ts
 */

export type FalconError = {
  code: string;
  message: string;
};

export const FALCON_ERRORS = {
  "FAL-AUTH-01": "Sign in to continue.",
  "FAL-AUTH-02": "Your session expired. Sign in again.",
  "FAL-AUTH-03": "This account isn't approved yet.",
  "FAL-REQ-01": "That request wasn't readable.",
  "FAL-REQ-02": "Enter a stock ticker to begin.",
  "FAL-REQ-03": "We lost track of this analysis.",
  "FAL-JOB-01": "We couldn't find that analysis.",
  "FAL-JOB-02": "This analysis stopped unexpectedly.",
  "FAL-JOB-03": "The research engine isn't available right now.",
  "FAL-JOB-04": "This analysis didn't finish.",
  "FAL-SEC-01": "We couldn't find a recent filing for that company.",
  "FAL-AI-01": "The research engine is temporarily unavailable.",
  "FAL-NET-01": "Check your connection and try again.",
  "FAL-INT-01": "Something went wrong. Try again in a moment.",
} as const;

export type FalconCode = keyof typeof FALCON_ERRORS;

export function falconError(code: FalconCode, override?: string): FalconError {
  return { code, message: override ?? FALCON_ERRORS[code] };
}

export function classifyEngineError(raw: string): FalconError {
  const t = raw.toLowerCase();
  if (!raw.trim()) return falconError("FAL-INT-01");
  if (t.includes("ticker is required")) return falconError("FAL-REQ-02");
  if (t.includes("job not found") || t.includes("job disappeared")) {
    return falconError("FAL-JOB-02");
  }
  if (
    t.includes("anthropic") ||
    t.includes("credit") ||
    t.includes("quota") ||
    t.includes("rate limit") ||
    t.includes("429") ||
    t.includes("openai") ||
    t.includes("api key") ||
    t.includes("401") ||
    t.includes("insufficient")
  ) {
    return falconError("FAL-AI-01");
  }
  if (
    t.includes("filing") ||
    t.includes("10-k") ||
    t.includes("20-f") ||
    t.includes("edgar") ||
    t.includes("cik") ||
    t.includes("no result") ||
    t.includes("not found")
  ) {
    return falconError("FAL-SEC-01");
  }
  if (
    t.includes("network") ||
    t.includes("econn") ||
    t.includes("enotfound") ||
    t.includes("etimedout") ||
    t.includes("fetch failed")
  ) {
    return falconError("FAL-NET-01");
  }
  return falconError("FAL-JOB-04");
}

export function parseFalconError(input: unknown): FalconError {
  if (input && typeof input === "object" && "code" in input && "message" in input) {
    const obj = input as { code: unknown; message: unknown };
    if (typeof obj.code === "string" && typeof obj.message === "string") {
      return { code: obj.code, message: obj.message };
    }
  }
  if (typeof input === "string") {
    const tagged = input.match(/^(.*)\s*\[(FAL-[A-Z]+-\d+)\]\s*$/s);
    if (tagged) {
      return { code: tagged[2]!, message: tagged[1]!.trim() };
    }
    return classifyEngineError(input);
  }
  return falconError("FAL-INT-01");
}
