/**
 * The conversation under an Insight card's brief. Unlike the brief itself this
 * is never cached or shared — a question is one reader's, and the answer is
 * only worth what the question asked. It lives in the panel for as long as the
 * panel is open on that event, and goes when the event does.
 */

export type InsightChatTurn = {
  role: "user" | "assistant";
  text: string;
};

/** One name the event reaches, as the chat needs to know it. */
export type InsightChatName = {
  ticker: string;
  label?: string;
  mechanism?: string;
  /** Signed share of the called move travelled — see `targetPricedIn`. */
  priced_in?: number | null;
};

export type InsightChatRequest = {
  run_id: string;
  headline: string;
  root_ticker: string;
  event_type?: string;
  event_direction?: string;
  event_materiality?: string;
  /** The brief the panel is showing, so the chat starts on the same page. */
  summary?: string;
  points?: string[];
  names?: InsightChatName[];
  /** The conversation so far, oldest first, the new question last. */
  turns: InsightChatTurn[];
};

export type InsightChatResult = { ok: true; reply: string } | { ok: false; error: string };
