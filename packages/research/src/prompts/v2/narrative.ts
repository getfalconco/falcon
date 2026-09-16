/** Minimum narrative contract for Pass 5 — enforced in prompt and optional retry. */

export const NARRATIVE_FIELD_RULES = `
NARRATIVE RULES (mandatory — empty or stub fields are invalid):
- Write in clear institutional English. No bullet lists inside string fields.
- Never say buy, sell, hold, overweight, underweight, or price targets.
- Every explanation must reference specific findings from prior passes (financials, supply chain, macro, graph).

Required minimum content:
- executiveSummary: 5-8 sentences. Cover business model, financial health, competitive position, key risk, and overall research stance.
- plainLanguageSummary: exactly 2-3 sentences a non-expert can understand.
- finalConclusion: 2-4 sentences. Decisive research verdict: structurally attractive, mixed, or concerning for a long-term allocator. State what stance a research desk would take (e.g. deepen diligence, monitor closely, deprioritize) — not a trade.
- scoreExplanations: one entry per score key. Each value is 2-3 sentences explaining WHY that score was earned, citing evidence.
- monitoringPriorities: 4-6 specific items to track over the next 2-4 quarters (metrics, events, filings, macro triggers).
- assumptions: 3-5 explicit assumptions underlying the analysis.
- risks: 4-8 items. Each needs name, severity (low|medium|high), and explanation (2-4 sentences).
- keyOpportunities: 3-6 items. Each needs name, explanation (2-3 sentences), and confidence 0-100.
`;

export const PASS5_RETRY_SUFFIX = `

Your previous narrative response was incomplete, too short, or missing required fields.
Return ONLY valid JSON. Every string field must meet the minimum length rules. Do not leave any field empty or as a placeholder.`;

export function isPass5NarrativeComplete(p5: Record<string, unknown>): boolean {
  const text = (v: unknown, min: number) =>
    typeof v === "string" && v.trim().length >= min;

  const exec = p5.executiveSummary;
  const plain = p5.plainLanguageSummary;
  const conclusion = p5.finalConclusion;
  const risks = Array.isArray(p5.risks) ? p5.risks : [];
  const opps = Array.isArray(p5.keyOpportunities) ? p5.keyOpportunities : [];
  const monitoring = Array.isArray(p5.monitoringPriorities) ? p5.monitoringPriorities : [];
  const assumptions = Array.isArray(p5.assumptions) ? p5.assumptions : [];
  const explanations = p5.scoreExplanations as Record<string, unknown> | undefined;

  const explanationCount = explanations
    ? Object.values(explanations).filter((v) => text(v, 40)).length
    : 0;

  const validRisks = risks.filter(
    (r) =>
      r &&
      typeof r === "object" &&
      text((r as { name?: string }).name, 2) &&
      text((r as { explanation?: string }).explanation, 40),
  ).length;

  const validOpps = opps.filter(
    (o) =>
      o &&
      typeof o === "object" &&
      text((o as { name?: string }).name, 2) &&
      text((o as { explanation?: string }).explanation, 30),
  ).length;

  return (
    text(exec, 120) &&
    text(plain, 50) &&
    text(conclusion, 80) &&
    explanationCount >= 7 &&
    validRisks >= 3 &&
    validOpps >= 2 &&
    monitoring.filter((m) => text(m, 8)).length >= 3 &&
    assumptions.filter((a) => text(a, 10)).length >= 2
  );
}
