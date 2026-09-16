/**
 * Classifier contracts — spec v1.0.
 *
 * Classifier is the first LLM-bearing engine in the pipeline. It consumes
 * classification requests from Base for information messages (news articles
 * and unmapped 8-Ks) and returns structured verdicts: per-ticker relevance,
 * materiality, event type and direction. Everything around the single LLM
 * call is deterministic; the LLM never sees price, user or incident state (§3).
 *
 * Division of labor: Tracker measures, Base coordinates, Classifier labels,
 * Analyst reasons, Propagation traverses.
 */

export const CLASSIFIER_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Closed enums (§4 — every field validated against these lists)
// ---------------------------------------------------------------------------

export const REQUEST_KINDS = ["news", "filing"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

/** §5 — fifteen event types, in table order. */
export const EVENT_TYPES = [
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
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

export const RELEVANCES = ["direct", "indirect", "none"] as const;
export type Relevance = (typeof RELEVANCES)[number];

export const MATERIALITIES = ["high", "standard", "low"] as const;
export type Materiality = (typeof MATERIALITIES)[number];

export const DIRECTIONS = ["positive", "negative", "mixed", "unclear"] as const;
export type Direction = (typeof DIRECTIONS)[number];

export const VERDICT_STATUSES = ["ok", "failed"] as const;
export type VerdictStatus = (typeof VERDICT_STATUSES)[number];

/** §2 market-cap buckets — the materiality scale anchor. */
export const CAP_BUCKETS = ["mega", "large", "mid", "small"] as const;
export type CapBucket = (typeof CAP_BUCKETS)[number];

// ---------------------------------------------------------------------------
// §2 company metadata
// ---------------------------------------------------------------------------

export type CompanyMetadata = {
  ticker: string;
  official_name: string;
  aliases: string[];
  sector: string | null;
  /** USD, as reported by the profile source; null when unknown. */
  market_cap_usd: number | null;
  cap_bucket: CapBucket | null;
  /** ISO instant the row was last refreshed from the profile source. */
  refreshed_at: string;
  source: "finnhub" | "manual";
};

/** What a request carries per ticker (§3). Never user or quant context. */
export type TickerContext = {
  ticker: string;
  official_name: string | null;
  sector: string | null;
  cap_bucket: CapBucket | null;
  /** §2: metadata missing never blocks — proceed on the symbol alone. */
  metadata_missing: boolean;
};

// ---------------------------------------------------------------------------
// §3 request contract
// ---------------------------------------------------------------------------

export type ArticleInput = {
  article_key: string;
  headline: string;
  summary: string;
  source: string;
  published_at: string;
  /** Provider article id when known (display/trace only). */
  article_id: string | null;
};

/**
 * §1 `filing` kind: classified from item codes + item descriptions + company
 * identity only; no filing-text fetch in v1.
 */
export type FilingInput = {
  article_key: string;
  form_type: string;
  accession_number: string;
  filed_at: string;
  item_codes: string[];
  /** Human descriptions of the item codes, resolved by the request builder. */
  item_descriptions: string[];
};

export type ClassificationRequest = {
  request_id: string;
  kind: RequestKind;
  /** `lead` carries the ticker set at dispatch; `addendum` restricts to new tickers (§3). */
  mode: "lead" | "addendum";
  article: ArticleInput | null;
  filing: FilingInput | null;
  /** Tickers to assess, after the cap (≤ config.tickerCap). */
  tickers: TickerContext[];
  /** Tickers beyond the cap — returned `unassessed`, never sent to the model. */
  unassessed_tickers: string[];
  /** Distinct tickers the article landed on at dispatch (B2 group size). */
  syndication_scope: number;
  /** Instant Base issued the request. */
  requested_at: string;
};

// ---------------------------------------------------------------------------
// §4 verdict schema
// ---------------------------------------------------------------------------

export type TickerVerdict =
  | { ticker: string; relevance: "none" }
  | {
      ticker: string;
      relevance: "direct" | "indirect";
      materiality: Materiality;
      direction: Direction;
    };

export type Verdict = {
  schema_version: number;
  prompt_version: string;
  model: string;
  article_key: string;
  kind: RequestKind;
  event_type: EventType;
  /** ≤ 80 chars, control characters stripped; display/context only (§4). */
  event_label: string;
  syndication_scope: number;
  tickers: TickerVerdict[];
  unassessed_tickers: string[];
  status: VerdictStatus;
  /** §2 — set when any ticker in the set lacked metadata. */
  metadata_missing: boolean;
  /** Instant the verdict was produced (first-writer for the article-level fields). */
  classified_at: string;
  /** Validation/transport detail for `status: "failed"`; null when ok. */
  failure_reason: string | null;
};

/** What the model is asked to produce: the verdict minus the envelope Classifier fills in. */
export type ModelOutput = {
  event_type: EventType;
  event_label: string;
  tickers: TickerVerdict[];
};

export function isAssessed(
  entry: TickerVerdict,
): entry is Extract<TickerVerdict, { relevance: "direct" | "indirect" }> {
  return entry.relevance !== "none";
}

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export type BreakerState = {
  status: "closed" | "open";
  consecutive_failures: number;
  /** ISO instant the breaker closes again; null while closed. */
  open_until: string | null;
  trips: number;
};

export type ClassifierMetrics = {
  verdicts_ok: number;
  verdicts_failed: number;
  /** Attempts that failed validation (each retry counted). */
  validation_failures: number;
  /** Attempts that failed on transport (each retry counted). */
  transport_failures: number;
  retries: number;
  breaker_trips: number;
  addenda: number;
  verdict_disagreements: number;
  /** Lead requests whose ticker set exceeded the cap. */
  overflows: number;
  cache_hits: number;
  /** Rolling window of call latencies in ms (bounded). */
  latencies_ms: number[];
  input_tokens: number;
  output_tokens: number;
  cache_creation_tokens: number;
  cache_read_tokens: number;
  /** Counts by "event_type|relevance|materiality" — materiality "-" for none. */
  by_cell: Record<string, number>;
};

export type ModelCallResult = {
  text: string;
  /** Everything billed as input, cache included — what this field always meant. */
  input_tokens: number;
  output_tokens: number;
  /**
   * The cache split, reported alongside the total rather than folded into it.
   *
   * Folding these in loses the one number that says whether caching is working:
   * a write costs 1.25x and a read 0.1x, so a host that writes and never reads
   * is paying a premium for nothing and looks identical to a healthy one when
   * you only see the total.
   */
  cache_creation_tokens?: number;
  cache_read_tokens?: number;
};

/** The one non-deterministic seam. Tests inject a fake; the real one is in anthropic.ts. */
export type ModelCaller = (input: {
  system: string;
  user: string;
  model: string;
  temperature: number;
  max_tokens: number;
  timeout_ms: number;
  /** JSON schema the output must conform to (structured output mode). */
  output_schema: Record<string, unknown>;
  signal: AbortSignal;
}) => Promise<ModelCallResult>;

export class ClassifierTransportError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "ClassifierTransportError";
  }
}

export class ClassifierBreakerOpenError extends Error {
  constructor(readonly open_until: string) {
    super(`Classifier circuit breaker open until ${open_until}`);
    this.name = "ClassifierBreakerOpenError";
  }
}
