/**
 * The plain-English write-up behind an Insight card's headline: what the event
 * is, why the network cares, and what the reader should watch. Generated once
 * per propagation run and then shared — the local file cache answers instantly,
 * Supabase carries it to every other install, and the model is only ever asked
 * when neither has it.
 */

export type InsightExplanation = {
  run_id: string;
  /** The headline it explains — kept so a re-worded event regenerates. */
  headline: string;
  /** 2–3 sentences: the event, in the reader's language. */
  summary: string;
  /** Short lines: how it travels the graph, what to watch. */
  points: string[];
  model: string;
  generated_at: string;
};

/** What the renderer sends; the main process does the rest. */
export type InsightExplanationRequest = {
  run_id: string;
  headline: string;
  root_ticker: string;
  event_type?: string;
  event_direction?: string;
  event_materiality?: string;
  /** Related names the run reached, strongest first. */
  targets?: Array<{ ticker: string; label?: string; mechanism?: string }>;
};

export type InsightExplanationResult =
  | { ok: true; explanation: InsightExplanation; source: "local" | "cloud" | "model" }
  | { ok: false; error: string };
