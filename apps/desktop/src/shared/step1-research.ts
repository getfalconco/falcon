export type ValidatedEdge = {
  root_ticker: string;
  counterparty_name: string;
  counterparty_ticker: string | null;
  counterparty_type: string;
  category: string;
  subtype: string;
  /** 0–1; disclosed pct/100 or tier default. Set during step1 validation. */
  strength?: number;
  strength_tier?: "critical" | "important" | "marginal";
  strength_basis?: "disclosed" | "classified";
  epistemic_label: "VERIFIED";
  confidence: number;
  evidence: Array<{
    quote: string;
    source_url: string;
    located_at: string;
  }>;
  valid_from: string;
  shared_evidence_group?: string;
};

export type MergedCandidate = {
  counterparty_name: string;
  category: string;
  subtype?: string;
  evidence_quote?: string;
  confidence?: number;
  merged_into: string;
};

export type RejectedCandidate = {
  counterparty_name: string;
  category: string;
  subtype?: string;
  evidence_quote?: string;
  confidence?: number;
  reason: string;
  stage: string;
};

export type Step1Stats = {
  form_type: "10-K" | "20-F";
  filing_date: string;
  section_chars: number;
  section_method: "item_span_last" | "anchor_windowed" | "anchor_fls" | "anchor_no_end" | "item4_span_20f" | "fallback_60pct";
  section_extraction_failed: boolean;
  content_suspect?: boolean;
  chunks: number;
  api_errors: number;
  parse_errors: number;
  candidates_extracted: number;
  candidates_per_chunk: number[];
  dropped_low_confidence: number;
  deduped: number;
  rejected_quote_not_found: number;
  rejected_by_auditor: number;
  validated: number;
  input_tokens?: number;
  output_tokens?: number;
  estimated_cost_usd?: number;
  fetch_seconds?: number;
  extract_seconds?: number;
  audit_seconds?: number;
};

export type Step1Result = {
  ticker: string;
  companyName: string;
  form: "10-K" | "20-F";
  filingDate: string;
  sourceUrl: string;
  validated: ValidatedEdge[];
  rejected: RejectedCandidate[];
  merged: MergedCandidate[];
  stats: Step1Stats;
  generatedAt: string;
  cacheKey?: string;
  accessionNumber?: string;
  fromCache?: boolean;
};
