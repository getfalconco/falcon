export type ResearchTier = "standard" | "deep" | "institutional";

export type ResearchConfig = {
  openaiApiKey: string;
  perplexityApiKey: string;
  massiveApiKey: string;
  marketDataProviderOrder: string;
  openaiModel: string;
  openaiModelFast: string;
  openaiModelReasoning: string;
  perplexityModel: string;
  perplexityVerifyModel: string;
  perplexityDeepModel: string;
  discoveryModel: string;
  discoveryResearchModel: string;
  discoveryMaxTokens: number;
  discoverySearchContextSize: "low" | "medium" | "high";
  discoveryMaxAttempts: number;
  discoveryReasoningEffort: "low" | "medium" | "high";
  signalResearchModel: string;
  analysisModel: string;
  signalAnalysisMaxTokens: number;
  researchTier: ResearchTier;
  graphMinNodes: number;
  graphRetryEnabled: boolean;
  priorContextMaxChars: number;
  openaiPassDelayMs: number;
  researchRequireWeb: boolean;
  secUserAgent: string;
  anthropicApiKey: string;
  /** Optional gateway base URL; empty means api.anthropic.com. */
  anthropicBaseUrl: string;
  falconModel: string;
  /** step1 extraction model; falls back to falconModel. */
  step1ExtractModel: string;
  /** step1 audit model — batched, so it can differ from extraction. */
  step1AuditModel: string;
  /** step1 strength classifier; small calls, cheapest model wins. */
  step1StrengthModel: string;
};

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envBool(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  return raw === "true" || raw === "1";
}

function envTier(): ResearchTier {
  const raw = process.env.RESEARCH_TIER ?? "institutional";
  if (raw === "standard" || raw === "deep" || raw === "institutional") return raw;
  return "institutional";
}

export function loadConfig(): ResearchConfig {
  return {
    openaiApiKey: process.env.OPENAI_API_KEY ?? "",
    perplexityApiKey: process.env.PERPLEXITY_API_KEY ?? "",
    massiveApiKey: process.env.MASSIVE_API_KEY ?? "",
    marketDataProviderOrder: process.env.MARKET_DATA_PROVIDER_ORDER ?? "massive",
    openaiModel: process.env.OPENAI_MODEL ?? "gpt-4o",
    openaiModelFast: process.env.OPENAI_MODEL_FAST ?? "gpt-4o",
    openaiModelReasoning: process.env.OPENAI_MODEL_REASONING ?? "gpt-4o",
    perplexityModel: process.env.PERPLEXITY_MODEL ?? "sonar-pro",
    perplexityVerifyModel: process.env.PERPLEXITY_VERIFY_MODEL ?? "sonar-reasoning-pro",
    perplexityDeepModel: process.env.PERPLEXITY_DEEP_MODEL ?? "sonar-deep-research",
    discoveryModel:
      process.env.DISCOVERY_MODEL ??
      (envTier() === "standard" ? "sonar-pro" : "sonar-deep-research"),
    discoveryResearchModel:
      process.env.DISCOVERY_RESEARCH_MODEL ??
      // Prefer fast sonar for rolling intelligence. Explicit DISCOVERY_RESEARCH_MODEL
      // is required to opt into sonar-deep-research (too slow for dashboard load).
      "sonar-pro",
    discoveryMaxTokens: envInt("DISCOVERY_MAX_TOKENS", 8000),
    discoverySearchContextSize:
      (process.env.DISCOVERY_SEARCH_CONTEXT_SIZE as "low" | "medium" | "high" | undefined) ??
      "medium",
    discoveryMaxAttempts: envInt("DISCOVERY_MAX_ATTEMPTS", 2),
    discoveryReasoningEffort:
      (process.env.DISCOVERY_REASONING_EFFORT as "low" | "medium" | "high" | undefined) ??
      "low",
    signalResearchModel: process.env.SIGNAL_RESEARCH_MODEL ?? "sonar-pro",
    analysisModel: process.env.ANALYSIS_MODEL ?? "gpt-4o",
    signalAnalysisMaxTokens: envInt("SIGNAL_ANALYSIS_MAX_TOKENS", 2000),
    researchTier: envTier(),
    graphMinNodes: envInt("GRAPH_MIN_NODES", envTier() === "standard" ? 20 : 50),
    graphRetryEnabled: envBool("GRAPH_RETRY_ENABLED", true),
    priorContextMaxChars: envInt("PRIOR_CONTEXT_MAX_CHARS", 32000),
    openaiPassDelayMs: envInt("OPENAI_PASS_DELAY_MS", 500),
    researchRequireWeb: envBool("RESEARCH_REQUIRE_WEB", false),
    secUserAgent:
      process.env.SEC_USER_AGENT ?? "Falcon Research dev@joinfalcon.ai",
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? "",
    anthropicBaseUrl: process.env.ANTHROPIC_BASE_URL?.trim() ?? "",
    falconModel: process.env.FALCON_MODEL ?? "claude-sonnet-4-5",
    // Per-stage, because the three do different work: extraction reads a 24k
    // chunk and must emit strict JSONL, audit judges a handful of candidates
    // against passages, strength answers one enum. Splitting them is what lets
    // the expensive one stay capable while the others get cheaper.
    step1ExtractModel:
      process.env.FALCON_STEP1_EXTRACT_MODEL ?? process.env.FALCON_MODEL ?? "claude-sonnet-4-5",
    step1AuditModel:
      process.env.FALCON_STEP1_AUDIT_MODEL ?? process.env.FALCON_MODEL ?? "claude-sonnet-4-5",
    step1StrengthModel:
      process.env.FALCON_STEP1_STRENGTH_MODEL ?? process.env.FALCON_MODEL ?? "claude-sonnet-4-5",
  };
}

export function getConfig(): ResearchConfig {
  return loadConfig();
}

/** Synthesis model — upgrades sonar-pro when phase-1 research uses a deep model. */
export function getDiscoverySynthesisModel(config: ResearchConfig = loadConfig()): string {
  const explicitSynth = process.env.DISCOVERY_SYNTHESIS_MODEL?.trim();
  if (explicitSynth) return explicitSynth;

  const explicitDiscovery = process.env.DISCOVERY_MODEL?.trim();
  if (explicitDiscovery) {
    const researchIsDeep =
      config.discoveryResearchModel.includes("deep") ||
      config.discoveryResearchModel.includes("reasoning");
    if (explicitDiscovery === "sonar-pro" && researchIsDeep) {
      console.warn(
        `[daily-signal] DISCOVERY_MODEL=sonar-pro is too fast for synthesis after ${config.discoveryResearchModel} — using ${config.perplexityVerifyModel}`,
      );
      return config.perplexityVerifyModel;
    }
    return explicitDiscovery;
  }

  return config.discoveryResearchModel;
}
