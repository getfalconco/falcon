import type { MeridianReport } from "./types.js";

export function parseJsonSafe<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function parsePassOutput<T>(raw: string, passName: string): T {
  const parsed = parseJsonSafe<T>(raw);
  if (!parsed) {
    throw new Error(`Failed to parse JSON for ${passName}`);
  }
  return parsed;
}

export function ensureReportShape(partial: Partial<MeridianReport>, company: string, ticker: string): MeridianReport {
  const emptyLayer = { entities: [] as MeridianReport["supplyChainIntelligence"]["entities"] };

  return {
    company,
    ticker,
    companyProfile: partial.companyProfile ?? { name: company, ticker },
    marketSnapshot: partial.marketSnapshot ?? {},
    marketData: partial.marketData ?? {},
    dataProvenance: partial.dataProvenance ?? "llm",
    scores: partial.scores ?? {
      overallMeridianScore: 50,
      financialStrength: 50,
      supplyChainHealth: 50,
      customerQuality: 50,
      competitivePosition: 50,
      regulatoryRisk: 50,
      macroSensitivity: 50,
      industryMomentum: 50,
    },
    scoreExplanations: partial.scoreExplanations ?? {},
    executiveSummary: partial.executiveSummary ?? "",
    plainLanguageSummary: partial.plainLanguageSummary ?? "",
    financialFoundation: partial.financialFoundation ?? {},
    supplyChainIntelligence: partial.supplyChainIntelligence ?? emptyLayer,
    customerEcosystem: partial.customerEcosystem ?? emptyLayer,
    competitorLandscape: partial.competitorLandscape ?? emptyLayer,
    industryTrends: partial.industryTrends ?? [],
    regulatoryFactors: partial.regulatoryFactors ?? [],
    macroFactors: partial.macroFactors ?? [],
    relationshipGraph: partial.relationshipGraph ?? [],
    secondOrderEffectChains: partial.secondOrderEffectChains ?? [],
    risks: partial.risks ?? [],
    keyOpportunities: partial.keyOpportunities ?? [],
    finalConclusion: partial.finalConclusion ?? "",
    monitoringPriorities: partial.monitoringPriorities ?? [],
    assumptions: partial.assumptions ?? [],
    meta: partial.meta ?? {
      warnings: [],
      passTimingsMs: {},
      edgarUsed: false,
      edgarFilingCount: 0,
      edgarFilingTypes: [],
      webResearchUsed: false,
      webResearchQueryCount: 0,
      citations: [],
      meridianConfidence: 35,
    },
  };
}
