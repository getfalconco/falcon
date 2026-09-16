import { callClaudeJson, stripJsonFences } from "../step1/index.js";
import { EVENT_TYPES, type EventDirection, type EventType } from "../propagation/event-types.js";
import type { FinnhubNewsArticle } from "./finnhub-news.js";
import { withTimeout } from "./with-timeout.js";

const CLASSIFY_TIMEOUT_MS = 25_000;

export type ArticleClassification = {
  is_material_event: boolean;
  event_type: EventType;
  affected_ticker: string;
  direction_on_primary: EventDirection;
  summary: string;
  confidence: number;
};

const SYSTEM = `You classify company news for an institutional trading desk.
Output exactly one JSON object on a single line (JSONL). No markdown fences.

Fields:
- is_material_event (boolean): true only for concrete, dated corporate occurrences
- event_type: one of ${EVENT_TYPES.join("|")}
- affected_ticker: primary listed ticker affected (uppercase)
- direction_on_primary: positive|negative|unclear
- summary: max 30 words, factual
- confidence: 0-1

NOT material: routine price-movement commentary, analyst opinion/ratings, listicles, vague outlook without a new fact, rehashed old news.

An article whose core content is the stock's OWN price action is NEVER a material event, no matter how large the move — price action is the market's reaction, not a corporate occurrence. Rallies, sell-offs, market-cap milestones, win streaks, chart levels, "buy points", and index moves all fall under this rule.

Examples (correct is_material_event for these headline shapes):
- "XYZ stock rallied 21% this month, breaking past a new buy point" → false (price action only)
- "XYZ's market cap gain tops $30B as shares extend win streak" → false (price action only)
- "XYZ hits all-time high after analysts hike price targets" → false (price action + analyst opinion)
- "XYZ recalls 40,000 vehicles after regulator probe" → true (concrete corporate occurrence)`;

function parseClassification(raw: string): ArticleClassification | null {
  const line = stripJsonFences(raw)
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.startsWith("{"));
  if (!line) return null;

  try {
    const parsed = JSON.parse(line) as Partial<ArticleClassification>;
    if (typeof parsed.is_material_event !== "boolean") return null;
    if (!parsed.event_type || !EVENT_TYPES.includes(parsed.event_type as EventType)) return null;
    if (!parsed.affected_ticker?.trim()) return null;
    const direction = parsed.direction_on_primary;
    if (direction !== "positive" && direction !== "negative" && direction !== "unclear") return null;
    if (!parsed.summary?.trim()) return null;
    const confidence = Number(parsed.confidence);
    if (!Number.isFinite(confidence)) return null;

    const words = parsed.summary.trim().split(/\s+/);
    const summary = words.length > 30 ? `${words.slice(0, 30).join(" ")}…` : parsed.summary.trim();

    return {
      is_material_event: parsed.is_material_event,
      event_type: parsed.event_type as EventType,
      affected_ticker: parsed.affected_ticker.trim().toUpperCase(),
      direction_on_primary: direction,
      summary,
      confidence: Math.min(1, Math.max(0, confidence)),
    };
  } catch {
    return null;
  }
}

export async function classifyNewsArticle(
  ticker: string,
  article: FinnhubNewsArticle,
  options?: { model?: string; usage?: import("../step1/tokenUsage.js").TokenUsage },
): Promise<ArticleClassification | null> {
  const published = new Date(article.datetime * 1000).toISOString();
  const user = [
    `Ticker: ${ticker}`,
    `Published: ${published}`,
    `Headline: ${article.headline}`,
    `Summary: ${article.summary || "(none)"}`,
    `Source: ${article.source}`,
    `URL: ${article.url}`,
  ].join("\n");

  const raw = await withTimeout(
    callClaudeJson({
      system: SYSTEM,
      user,
      maxTokens: 400,
      model: options?.model,
      usage: options?.usage,
    }),
    CLASSIFY_TIMEOUT_MS,
    `classify ${ticker} #${article.id}`,
  );

  return parseClassification(raw);
}
