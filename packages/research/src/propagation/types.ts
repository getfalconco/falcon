import type { EventDirection, EventType } from "./event-types.js";

export type { EventDirection, EventType };

export type MaterialNewsEvent = {
  id: string;
  article_id: number;
  ticker: string;
  headline: string;
  source_url: string;
  article_datetime: number;
  classified_at: string;
  is_material_event: true;
  event_type: EventType;
  affected_ticker: string;
  direction_on_primary: EventDirection;
  summary: string;
  confidence: number;
};

export type PropagationEvent = MaterialNewsEvent & {
  source_urls: string[];
  merged_from?: string[];
};

export type PathHop = {
  from_ticker: string;
  to_ticker: string;
  category: string;
  subtype: string;
  edge_confidence: number;
  strength: number;
  strength_tier: "critical" | "important" | "marginal";
  evidence_quote: string;
  source_url: string;
};

export type SignalMagnitude = "high" | "medium" | "low";
export type SignalTimeframe = "days" | "weeks" | "quarters";
export type PricedInStatus = "likely priced in" | "not yet reflected";

/** Filled once by the outcome tracker; never overwritten. */
export type SignalOutcome = {
  pct: number;
  aligned: boolean;
  filled_at: string;
};

export type SecondOrderSignal = {
  id: string;
  event_id: string;
  event_summary: string;
  /** Unix seconds of the originating event (for terminal dedupe window). */
  event_datetime: number;
  event_type: EventType;
  /** Shocked / originating ticker for this path. */
  root_ticker: string;
  path: PathHop[];
  terminal_ticker: string;
  /** Display direction — always the judge's adjusted_direction. */
  direction: EventDirection;
  /** Mechanical traversal direction before judge adjustment. */
  mechanical_direction: EventDirection;
  /** True when judge adjusted_direction differs from mechanical path direction. */
  judge_adjusted: boolean;
  magnitude: SignalMagnitude;
  timeframe: SignalTimeframe;
  path_confidence: number;
  priced_in_status: PricedInStatus;
  price_change_pct: number | null;
  /** Terminal price at signal generation (from priced-in candle last close). */
  price_at_signal: number | null;
  /** Judge's estimate of the move size on the terminal stock, absolute % (0–40). */
  expected_move_pct: number | null;
  /** Judge's estimate of days for the move to largely play out (1–365). */
  expected_days: number | null;
  /** price_at_signal projected by expected_move_pct in the signal direction. */
  target_price: number | null;
  /** Share of the expected move already realized since the event, 0–100. */
  priced_in_pct: number | null;
  /** Historical precedent: mean 5d reaction across past comparable occurrences, %. */
  precedent_avg_5d: number | null;
  /** Historical precedent: number of measurable past occurrences. */
  precedent_n: number | null;
  /** Historical precedent: % of past cases that moved in this signal's direction. */
  precedent_direction_consistency: number | null;
  reasoning: string;
  mechanism: string;
  evidence: Array<{ quote: string; source_url: string; from_ticker: string; to_ticker: string }>;
  /** Summaries of other events merged onto this card by terminal dedupe. */
  supporting_events?: string[];
  /** Last time the signal cooldown attached a new qualifying event to this card. */
  last_supported_at?: string;
  outcome_1d?: SignalOutcome;
  outcome_5d?: SignalOutcome;
  outcome_20d?: SignalOutcome;
  generated_at: string;
};

export type DailySignalsFile = {
  date: string;
  signals: SecondOrderSignal[];
};

export type CandidatePath = {
  hops: PathHop[];
  terminal_ticker: string;
  direction: EventDirection;
  path_confidence: number;
};

export type GraphEdge = {
  id: string;
  root_ticker: string;
  counterparty_id: string;
  counterparty_name: string;
  counterparty_ticker: string | null;
  /** Extractor's counterparty kind; only `public_company` is a tradable target. */
  counterparty_type?: string | null;
  category: string;
  subtype: string;
  confidence: number;
  strength?: number;
  strength_tier?: "critical" | "important" | "marginal";
  evidence_quote: string;
  source_url: string;
  valid_from: string;
  /** Date the source filing was filed with the SEC (YYYY-MM-DD). */
  filing_date?: string;
  /** SEC accession number of the source filing, dashed form. */
  accession_number?: string | null;
};

export type GraphFile = {
  nodes: Array<{ id: string; label: string; kind: "ticker" | "name" }>;
  edges: GraphEdge[];
};
