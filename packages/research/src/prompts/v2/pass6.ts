export const PASS6_PROMPT = `Pass 6 — Red-team audit

Review the draft report for contradictions, unsupported claims, and weak assumptions.

Return JSON:
{
  "contradictions": ["string"],
  "unsupportedClaims": ["string"],
  "revisedAssumptions": ["string"],
  "modelsUsed": ["string"]
}`;
