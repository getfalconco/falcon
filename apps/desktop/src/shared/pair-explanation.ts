/**
 * The write-up behind one line of an Insight card: why *this* name is exposed
 * to the event, what events like it have done to the name before, and what to
 * expect this time. Generated once per (run, name) and then shared, exactly
 * as the card's own explanation is — disk, then Supabase, then the model.
 */

/**
 * The expectation, stated rather than buried in prose. The panel leads with
 * this: what the write-up thinks the name does from here, how big, by when,
 * and how much weight to put on it.
 */
export type PairOutlook = {
  direction: "up" | "down" | "unclear";
  /** The size in the write-up's own words, e.g. "1-2%". */
  magnitude: string;
  /** When, e.g. "the next 2-3 sessions". */
  horizon: string;
  conviction: "low" | "medium" | "high";
  /** One line: the expectation, said plainly. */
  call: string;
};

export type PairExplanation = {
  run_id: string;
  target: string;
  /** The headline it explains — a re-worded event regenerates. */
  headline: string;
  /** The stated expectation. Optional: rows written before it existed. */
  outlook?: PairOutlook | null;
  /** 2–3 sentences: how the event reaches this name. */
  why: string;
  /** 2–3 sentences: what this kind of event has done to it before. */
  precedent: string;
  /** 2–3 sentences: how it may go this time, and how big. */
  this_time: string;
  /** Short lines: what would confirm or kill the read. */
  watch: string[];
  model: string;
  generated_at: string;
};

/** One past call, flattened for the prompt. */
export type PairExplanationPrecedent = {
  label: string;
  type: string;
  event_ts: string;
  outcome: string;
  expected_pct: number | null;
  realized_pct: number | null;
};

export type PairExplanationRequest = {
  run_id: string;
  headline: string;
  root_ticker: string;
  target_ticker: string;
  target_label?: string;
  event_type?: string;
  event_direction?: string;
  event_materiality?: string;
  /** How the root reaches this name, from the graph. */
  role?: string;
  tier?: string;
  mechanism?: string;
  /** The pair's own record, so the write-up is about this pair. */
  record?: {
    hits: number;
    partials: number;
    misses: number;
    open: number;
    expired: number;
    hit_rate: number | null;
    avg_expected_pct: number | null;
    avg_realized_pct: number | null;
    avg_ratio: number | null;
  };
  /** The most recent past calls, newest first. */
  precedents?: PairExplanationPrecedent[];
};

export type PairExplanationResult =
  | { ok: true; explanation: PairExplanation; source: "local" | "cloud" | "model" }
  | { ok: false; error: string };
