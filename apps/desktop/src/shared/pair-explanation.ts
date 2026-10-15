/**
 * The write-up behind one line of an Insight card: why *this* name is exposed
 * to the event, what happened to the name after events like it before, and
 * how this event differs. Generated once per (run, name) and then shared, exactly
 * as the card's own explanation is — disk, then Supabase, then the model.
 */

/**
 * What the link implies, stated rather than buried in prose. Never a view on
 * the price: the sign the relationship carries, the size of past moves on the
 * link, the window they resolved in, and the weight of that record.
 */
export type PairOutlook = {
  direction: "up" | "down" | "unclear";
  /** The size of past moves on this link, from the record, e.g. "1-2%". */
  magnitude: string;
  /** The window those past moves resolved in, e.g. "3 to 5 sessions". */
  horizon: string;
  conviction: "low" | "medium" | "high";
  /** One line describing the link and its record. */
  call: string;
};

export type PairExplanation = {
  run_id: string;
  target: string;
  /** The headline it explains — a re-worded event regenerates. */
  headline: string;
  /** What the link implies. Optional: rows written before it existed. */
  outlook?: PairOutlook | null;
  /** 2–3 sentences: how the event reaches this name. */
  why: string;
  /** 2–3 sentences: what this kind of event has done to it before. */
  precedent: string;
  /** 2 to 3 sentences: how this event differs from the precedents. */
  this_time: string;
  /** Short lines: the facts in the input the read rests on. */
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
  /**
   * Sessions after an event inside which the record measures a move (the
   * propagation engine's pricing horizon). Main fills it from the live engine
   * config when the renderer leaves it out.
   */
  horizon_sessions?: number | null;
};

export type PairExplanationResult =
  | { ok: true; explanation: PairExplanation; source: "local" | "cloud" | "model" }
  | { ok: false; error: string };
