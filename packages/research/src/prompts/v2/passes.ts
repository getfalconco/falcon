import { NARRATIVE_FIELD_RULES } from "./narrative.js";

export const PASS1_PROMPT = `Pass 1 — Company profile & financial foundation

Write substantive prose in every financialFoundation field (2-4 sentences each). assessment must be a 4-6 sentence overview.

Return JSON:
{
  "companyProfile": { "name", "ticker", "exchange", "sector", "industry", "country", "businessModel", "mainProducts", "revenueSources", "mainMarkets" },
  "financialFoundation": { "assessment", "revenueGrowth", "profitability", "margins", "cashFlow", "debt", "valuation", "analystContext", "historicalPerformance" }
}`;

export const PASS2_PROMPT = `Pass 2 — Supply chain, customers, competitors

Each layer summary must be 3-5 sentences covering the key insight, concentration, and risk.

Return JSON:
{
  "supplyChainIntelligence": { "summary", "entities": [{ "name", "role", "relationship", "confidenceScore", "sourceUrls", "notes" }], "risks", "opportunities" },
  "customerEcosystem": { "summary", "entities": [...], "risks", "opportunities" },
  "competitorLandscape": { "summary", "entities": [...], "risks", "opportunities" }
}`;

export const PASS2B_VERIFY_PROMPT = (entities: string[]) =>
  `Verify these entities are real and correctly associated with the target company: ${entities.join(", ")}. Return JSON: { "verified": [{ "name", "valid": boolean, "notes" }] }`;

export const PASS3_PROMPT = `Pass 3 — Industry, regulatory, macro

Return JSON:
{
  "industryTrends": [{ "name", "direction": "positive"|"negative"|"neutral", "impact", "confidenceScore", "sourceUrls" }],
  "regulatoryFactors": [...],
  "macroFactors": [...]
}`;

export const PASS4_PROMPT = `Pass 4 — Relationship graph (60-80 nodes) & second-order chains

Return JSON:
{
  "relationshipGraph": [{ "category", "color", "nodes": [{ "id", "name", "role", "relationshipType", "importanceScore", "confidenceScore", "sourceUrls", "description" }] }],
  "secondOrderEffectChains": [{ "id", "trigger", "mechanism", "affectedEntities", "severity", "confidenceScore", "sourceUrls" }]
}

Target 60-80 total nodes across categories. Include second_order and risk relationship types.`;

export const PASS4B_PROMPT = (hubs: string[]) =>
  `Pass 4b — Expand these hub entities (importanceScore >= 75): ${hubs.join(", ")}. Return JSON: { "expansions": [{ "hubEntity", "nodes": [...] }] }`;

export const PASS4C_PROMPT = `Pass 4c — Cross-company graph links (15-40 links)

Return JSON: { "graphCrossLinks": [{ "from", "to", "relationship", "strength" }] }`;

export const PASS5_PROMPT = (scoresJson: string) => `Pass 5 — Full narrative report (DO NOT change score values)

Pre-computed scores (explain only — do not modify numeric values):
${scoresJson}

Synthesize ALL prior pass outputs (company profile, financials, supply chain, customers, competitors, industry, macro, relationship graph) into the narrative below.
${NARRATIVE_FIELD_RULES}

Return JSON:
{
  "scoreExplanations": {
    "overallMeridianScore": "2-3 sentences",
    "financialStrength": "2-3 sentences",
    "supplyChainHealth": "2-3 sentences",
    "customerQuality": "2-3 sentences",
    "competitivePosition": "2-3 sentences",
    "regulatoryRisk": "2-3 sentences",
    "macroSensitivity": "2-3 sentences",
    "industryMomentum": "2-3 sentences"
  },
  "executiveSummary": "5-8 sentence institutional overview",
  "plainLanguageSummary": "2-3 sentences in plain English",
  "finalConclusion": "2-4 sentence decisive research verdict (attractive / mixed / concerning — no trade language)",
  "monitoringPriorities": ["4-6 specific watch items"],
  "assumptions": ["3-5 explicit assumptions"],
  "risks": [{ "name": "string", "severity": "low"|"medium"|"high", "explanation": "2-4 sentences", "sourceUrls": [] }],
  "keyOpportunities": [{ "name": "string", "explanation": "2-3 sentences", "confidence": 0-100, "sourceUrls": [] }]
}`;

export const PASS7_PROMPT = `Pass 7 — Citation binding

Bind claims to URLs from meta.citations only. Return JSON:
{
  "citationBindings": [{ "claim", "urls": ["must be from provided citations list"] }],
  "warnings": ["string"]
}`;
