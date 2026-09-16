import type {
  GraphCrossLink,
  RelationshipGraphCategory,
  SecondOrderChain,
} from "./relationshipTypes.js";

export type { GraphCrossLink, RelationshipGraphCategory, SecondOrderChain } from "./relationshipTypes.js";

export type PipelinePhase =
  | "resolve"
  | "market"
  | "quant"
  | "edgar"
  | "pass0"
  | "websearch"
  | "pass1"
  | "pass2"
  | "pass2b"
  | "pass3"
  | "pass4"
  | "pass4b"
  | "pass4c"
  | "scoring"
  | "pass5"
  | "pass6"
  | "pass7"
  | "merge";

export const PHASE_LABELS: Record<PipelinePhase, string> = {
  resolve: "Resolving company",
  market: "Fetching market data",
  quant: "Building quant context",
  edgar: "Loading SEC filings",
  pass0: "Planning research",
  websearch: "Running web research",
  pass1: "Company profile & financials",
  pass2: "Supply chain & ecosystem",
  pass2b: "Verifying entities",
  pass3: "Industry & macro",
  pass4: "Building relationship graph",
  pass4b: "Expanding key hubs",
  pass4c: "Cross-company links",
  scoring: "Computing Falcon scores",
  pass5: "Writing narrative",
  pass6: "Red-team audit",
  pass7: "Binding citations",
  merge: "Finalizing report",
};

export type StreamEvent =
  | { type: "phase"; phase: PipelinePhase; label: string }
  | { type: "entity"; name: string; role: string; layer: "supply" | "customer" | "competitor" }
  | { type: "graph_category"; category: string; color?: string }
  | { type: "graph_node"; category: string; node: unknown }
  | { type: "expansion_start"; hubEntity: string; importanceScore: number }
  | { type: "secondary_node"; hubEntity: string; node: unknown }
  | { type: "done"; report: MeridianReport }
  | { type: "error"; message: string }
  | {
      type: "council_message";
      personaId: string;
      personaName: string;
      round: number;
      content: string;
      liveQueriesUsed: number;
    }
  | {
      type: "council_query";
      personaId: string;
      personaName: string;
      query: string;
      status: "start" | "done" | "error";
      snippet?: string;
    }
  | {
      type: "relationship_edge";
      edge: {
        from: string;
        to: string;
        relation: string;
        strength: "weak" | "moderate" | "strong";
        note?: string;
        sourceUrls?: string[];
      };
    }
  | {
      type: "council_verdict";
      verdict: {
        stance: "constructive" | "cautious" | "defensive";
        conviction: "high" | "medium" | "low";
        verdict: string;
        dissent?: string;
      };
    }
  | { type: "obsidian_map"; markdown: string };

export type ProgressCallback = (event: StreamEvent) => void;

export type CompanyProfile = {
  name: string;
  ticker: string;
  exchange?: string;
  sector?: string;
  industry?: string;
  country?: string;
  businessModel?: string;
  mainProducts?: string[];
  revenueSources?: string[];
  mainMarkets?: string[];
};

export type MarketSnapshot = {
  price?: number;
  changePercent?: number;
  marketCap?: number;
  peRatio?: number;
  eps?: number;
  volume?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
};

export type MeridianScores = {
  overallMeridianScore: number;
  financialStrength: number;
  supplyChainHealth: number;
  customerQuality: number;
  competitivePosition: number;
  regulatoryRisk: number;
  macroSensitivity: number;
  industryMomentum: number;
};

export type StructuredEntity = {
  name: string;
  role?: string;
  relationship?: string;
  confidenceScore?: number;
  sourceUrls?: string[];
  notes?: string;
};

export type StructuredLayer = {
  summary?: string;
  entities: StructuredEntity[];
  risks?: string[];
  opportunities?: string[];
};

export type TrendFactor = {
  name: string;
  direction?: "positive" | "negative" | "neutral";
  impact?: string;
  confidenceScore?: number;
  sourceUrls?: string[];
};

export type FinancialFoundation = {
  assessment?: string;
  revenueGrowth?: string;
  profitability?: string;
  margins?: string;
  cashFlow?: string;
  debt?: string;
  valuation?: string;
  analystContext?: string;
  historicalPerformance?: string;
};

export type ReportRisk = {
  name: string;
  severity: "low" | "medium" | "high";
  explanation: string;
  sourceUrls?: string[];
};

export type ReportOpportunity = {
  name: string;
  explanation: string;
  confidence: number;
  sourceUrls?: string[];
};

export type Citation = {
  url: string;
  title?: string;
  query?: string;
};

export type AuditResult = {
  contradictions: string[];
  unsupportedClaims: string[];
  revisedAssumptions: string[];
  meridianConfidence?: number;
  modelsUsed?: string[];
};

export type PerformanceHorizons = {
  return14d?: number;
  return30d?: number;
  return6m?: number;
  return1y?: number;
};

export type QuantContext = {
  risk?: {
    volatility?: number;
    maxDrawdown?: number;
    beta?: number;
  };
  peers?: Array<{ symbol: string; name?: string; peRatio?: number }>;
  fundamentals?: Record<string, number | string | undefined>;
};

export type MeridianReportMeta = {
  warnings: string[];
  passTimingsMs: Record<string, number>;
  edgarUsed: boolean;
  edgarFilingCount: number;
  edgarFilingTypes: string[];
  webResearchUsed: boolean;
  webResearchQueryCount: number;
  citations: Citation[];
  horizons?: PerformanceHorizons;
  quantContext?: QuantContext;
  graphCrossLinks?: GraphCrossLink[];
  audit?: AuditResult;
  meridianConfidence: number;
};

export type MeridianReport = {
  company: string;
  ticker: string;
  companyProfile: CompanyProfile;
  marketSnapshot: MarketSnapshot;
  marketData: Record<string, string>;
  dataProvenance: "llm" | "api" | "mixed";
  scores: MeridianScores;
  scoreExplanations: Record<string, string>;
  executiveSummary: string;
  plainLanguageSummary: string;
  financialFoundation: FinancialFoundation;
  supplyChainIntelligence: StructuredLayer;
  customerEcosystem: StructuredLayer;
  competitorLandscape: StructuredLayer;
  industryTrends: TrendFactor[];
  regulatoryFactors: TrendFactor[];
  macroFactors: TrendFactor[];
  relationshipGraph: RelationshipGraphCategory[];
  secondOrderEffectChains: SecondOrderChain[];
  risks: ReportRisk[];
  keyOpportunities: ReportOpportunity[];
  finalConclusion: string;
  monitoringPriorities: string[];
  assumptions: string[];
  meta: MeridianReportMeta;
};

export type DynamicQuery = {
  id: string;
  label: string;
  prompt: string;
  recency?: "month" | "week" | "year";
};

export type Pass0Output = {
  researchFocus: string[];
  dynamicQueries: DynamicQuery[];
};

export type WebResearchResult = {
  queryId: string;
  label: string;
  answer: string;
  citations: Citation[];
};

export type EdgarResearch = {
  symbol: string;
  cik: string;
  filings: Array<{
    type: string;
    filedAt: string;
    excerpt: string;
    url?: string;
  }>;
};

export type MarketBundle = {
  symbol: string;
  companyName: string;
  quote: MarketSnapshot & { symbol: string; companyName: string };
  profile?: Record<string, unknown>;
};

export type PipelineContext = {
  company: string;
  ticker: string;
  companyName: string;
  marketBundle: MarketBundle | null;
  horizons: PerformanceHorizons | null;
  quantContext: QuantContext | null;
  edgar: EdgarResearch | null;
  pass0: Pass0Output | null;
  webResearch: WebResearchResult[];
  researchContext: string;
  passOutputs: Record<string, unknown>;
  scores: MeridianScores | null;
  citations: Citation[];
  warnings: string[];
  passTimingsMs: Record<string, number>;
};
