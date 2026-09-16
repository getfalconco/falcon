export type CounterpartyType =
  | "public_company"
  | "private_company"
  | "product"
  | "commodity"
  | "government"
  | "other";

export const RELATIONSHIP_CATEGORIES = [
  "supplier",
  "customer",
  "partner",
  "competitor",
  "dependency",
] as const;

export type RelationshipCategory = (typeof RELATIONSHIP_CATEGORIES)[number];

export type AnnualFilingForm = "10-K" | "20-F";

export type EvidenceLocatedAt = "10-K Item 1/1A" | "20-F Item 3-5" | "20-F Item 4-8";

export type CandidateEdge = {
  counterparty_name: string;
  counterparty_type: CounterpartyType;
  category: RelationshipCategory;
  subtype: string;
  disclosed_revenue_dependency_pct: number | null;
  evidence_quote: string;
  evidence_quotes: string[];
  confidence: number;
  chunk_index: number;
};

export type StrengthTier = "critical" | "important" | "marginal";

export type StrengthBasis = "disclosed" | "classified";

export type ValidatedEdge = {
  root_ticker: string;
  counterparty_name: string;
  counterparty_ticker: string | null;
  counterparty_type: string;
  category: RelationshipCategory;
  subtype: string;
  /** 0–1 transmission weight; disclosed pct/100 or tier default. */
  strength: number;
  strength_tier: StrengthTier;
  strength_basis: StrengthBasis;
  epistemic_label: "VERIFIED";
  confidence: number;
  evidence: Array<{
    quote: string;
    source_url: string;
    located_at: EvidenceLocatedAt;
  }>;
  valid_from: string;
  shared_evidence_group: string;
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
  stage: "dedupe" | "quote_check" | "audit" | "parse";
};

export type Step1Progress = {
  stage: string;
  progress: { current: number; total: number } | null;
  done: boolean;
  error: string | null;
};

export type SectionMethod =
  | "item_span_last"
  | "anchor_windowed"
  | "anchor_fls"
  | "anchor_no_end"
  | "item4_span_20f"
  | "fallback_60pct";

export type Step1Stats = {
  form_type: AnnualFilingForm;
  filing_date: string;
  section_chars: number;
  section_method: SectionMethod;
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
  form: AnnualFilingForm;
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

export type AuditorVerdict = {
  verdict: "approve" | "fix" | "reject";
  reason: string;
  corrected: {
    counterparty_name: string;
    counterparty_type: string;
    category: string;
    subtype: string;
  } | null;
  confidence: number;
};
