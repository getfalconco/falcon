/**
 * Desktop-side mirror of the Classifier contracts so the renderer and main
 * process don't import the Node-only research package directly.
 * Keep in sync with packages/research/src/classifier/{types,service,eval}.ts.
 */

export type ClassifierEventType =
  | "earnings_results"
  | "guidance"
  | "analyst_action"
  | "ma_activity"
  | "capital_allocation"
  | "financing_credit"
  | "product_clinical"
  | "regulatory_decision"
  | "legal"
  | "management_governance"
  | "contract_partnership"
  | "supply_chain_ops"
  | "macro_sector"
  | "ownership_flows"
  | "other";

export const CLASSIFIER_EVENT_TYPES: ClassifierEventType[] = [
  "earnings_results",
  "guidance",
  "analyst_action",
  "ma_activity",
  "capital_allocation",
  "financing_credit",
  "product_clinical",
  "regulatory_decision",
  "legal",
  "management_governance",
  "contract_partnership",
  "supply_chain_ops",
  "macro_sector",
  "ownership_flows",
  "other",
];

export type ClassifierRelevance = "direct" | "indirect" | "none";
export type ClassifierMateriality = "high" | "standard" | "low";
export type ClassifierDirection = "positive" | "negative" | "mixed" | "unclear";

export type ClassifierTickerVerdict =
  | { ticker: string; relevance: "none" }
  | {
      ticker: string;
      relevance: "direct" | "indirect";
      materiality: ClassifierMateriality;
      direction: ClassifierDirection;
    };

export type ClassifierVerdict = {
  schema_version: number;
  prompt_version: string;
  model: string;
  article_key: string;
  kind: "news" | "filing";
  event_type: ClassifierEventType;
  event_label: string;
  syndication_scope: number;
  tickers: ClassifierTickerVerdict[];
  unassessed_tickers: string[];
  status: "ok" | "failed";
  metadata_missing: boolean;
  classified_at: string;
  failure_reason: string | null;
};

export type ClassifierBreakerState = {
  status: "closed" | "open";
  consecutive_failures: number;
  open_until: string | null;
  trips: number;
};

export type ClassifierMetrics = {
  verdicts_ok: number;
  verdicts_failed: number;
  validation_failures: number;
  transport_failures: number;
  retries: number;
  breaker_trips: number;
  addenda: number;
  verdict_disagreements: number;
  overflows: number;
  cache_hits: number;
  latencies_ms: number[];
  input_tokens: number;
  output_tokens: number;
  by_cell: Record<string, number>;
};

/**
 * The host-facing shapes moved to the engine package when the Classifier host
 * did — the desktop panel and the always-on engine service both read them, so
 * neither owns the definition. Re-exported here so the renderer keeps one
 * import path.
 */
export type {
  ClassifierRunSummary,
  ClassifierStatus,
} from "@meridian/research/classifier";

export type ClassifierEvalMetric = {
  name: string;
  label: string;
  correct: number;
  total: number;
  accuracy: number | null;
  threshold: number;
  pass: boolean;
};

export type ClassifierEvalReport = {
  labeled_articles: number;
  evaluated_articles: number;
  missing_verdicts: number;
  metrics: ClassifierEvalMetric[];
  pass: boolean;
  size_ok: boolean;
  event_type_confusion: Record<string, Record<string, number>>;
  misses: Array<{
    article_key: string;
    ticker: string | null;
    field: "event_type" | "relevance" | "materiality" | "direction";
    expected: string;
    got: string;
  }>;
};
