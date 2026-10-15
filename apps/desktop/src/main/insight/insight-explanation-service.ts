import { repairMojibake } from "@meridian/research/news";
import { CLAUDE_WRITING_MODEL, anthropicGlossCaller, glossConfigured } from "@meridian/research/gloss";
import { createFileStore, decodeEscapes, hash, readCloudRow, writeCloudRow } from "./explanation-cache";
import { PROMPT_COPY_RULE } from "../../shared/copy-rules";
import type {
  InsightExplanation,
  InsightExplanationRequest,
} from "../../shared/insight-explanation";

/**
 * One explanation per propagation run, written once and then reused by
 * everyone: disk first (instant, offline), Supabase second (what another
 * install already paid for), the model last. Every generated row is pushed
 * back to Supabase, so the second reader of an event never spends a token.
 *
 * The key is the run id plus a hash of the headline: a re-worded event is a
 * different explanation, a re-read of the same one is not.
 */

/**
 * The Insight write-up model: `FALCON_INSIGHT_MODEL`, the same variable the
 * engine service reads, else the writing tier. Read per call so a .env edit
 * or a late env load is seen without a restart.
 */
export function insightModel(): string {
  return process.env.FALCON_INSIGHT_MODEL?.trim() || CLAUDE_WRITING_MODEL;
}
const MAX_TOKENS = 1600;
const TIMEOUT_MS = 45_000;
const TABLE = "insight_explanations";

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    // No minItems/maxItems: the API rejects array bounds above 1. The count
    // is set by the prompt and enforced by the slice below.
    points: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "points"],
  additionalProperties: false,
} as const;

const SYSTEM = `You write the short brief under a market event headline in an equity-research app.

Voice: plain, concrete, no hype, no hedging filler, no disclaimers. You are
writing for someone who already follows markets but may not know this specific
company or mechanism.

Return JSON only:
- "summary": 2-3 sentences. What actually happened, and why it matters to the
  companies connected to it. Never restate the headline verbatim.
- "points": 2-4 lines, each under 110 characters. How the effect travels to the
  related names, and which facts in the input the read rests on. No bullet
  characters.

Never invent numbers, dates, filings or quotes that are not in the input.

${PROMPT_COPY_RULE}`;

const store = createFileStore<InsightExplanation>("explanations.json");

function cacheKey(req: InsightExplanationRequest): string {
  return `${req.run_id}:${hash(req.headline.trim().toLowerCase())}`;
}

/* ------------------------------------------------------------------ */
/* Generation                                                           */
/* ------------------------------------------------------------------ */

function buildUser(req: InsightExplanationRequest): string {
  const lines = [
    `Headline: ${req.headline}`,
    `Root company: ${req.root_ticker}`,
    req.event_type ? `Event type: ${req.event_type}` : null,
    req.event_direction ? `Direction: ${req.event_direction}` : null,
    req.event_materiality ? `Materiality: ${req.event_materiality}` : null,
  ].filter((line): line is string => line !== null);

  const targets = (req.targets ?? []).slice(0, 8);
  if (targets.length > 0) {
    lines.push("Related names the event reaches:");
    for (const t of targets) {
      lines.push(
        `- ${t.ticker}${t.label ? ` (${t.label})` : ""}${t.mechanism ? `: ${t.mechanism}` : ""}`,
      );
    }
  }
  return lines.join("\n");
}

async function generate(req: InsightExplanationRequest): Promise<InsightExplanation> {
  if (!glossConfigured()) throw new Error("ANTHROPIC_API_KEY is not configured");
  const output = await anthropicGlossCaller({
    model: insightModel(),
    max_tokens: MAX_TOKENS,
    effort: "low",
    system: SYSTEM,
    user: buildUser(req),
    output_schema: SCHEMA as unknown as Record<string, unknown>,
    timeout_ms: TIMEOUT_MS,
  });

  let parsed: { summary?: unknown; points?: unknown };
  try {
    parsed = JSON.parse(output.text) as { summary?: unknown; points?: unknown };
  } catch {
    throw new Error("the model returned malformed JSON");
  }
  const summary = typeof parsed.summary === "string" ? decodeEscapes(parsed.summary.trim()) : "";
  if (!summary) throw new Error("the model returned no summary");
  const points = Array.isArray(parsed.points)
    ? parsed.points.filter((p): p is string => typeof p === "string" && p.trim().length > 0)
    : [];

  return {
    run_id: req.run_id,
    headline: req.headline,
    summary,
    points: points.map((p) => decodeEscapes(p.trim())).slice(0, 4),
    model: insightModel(),
    generated_at: new Date().toISOString(),
  };
}

/* ------------------------------------------------------------------ */
/* Entry point                                                          */
/* ------------------------------------------------------------------ */

/** Two readers opening the same card at once share one model call. */
const inFlight = new Map<string, Promise<{ explanation: InsightExplanation; source: "model" }>>();

export async function getInsightExplanation(
  rawReq: InsightExplanationRequest,
): Promise<{ explanation: InsightExplanation; source: "local" | "cloud" | "model" }> {
  // A headline filed before ingestion repaired provider mojibake ("weekâ€™s")
  // is fixed before it reaches the model (and so the brief). Clean text, and
  // with it the cache key, is unchanged.
  const req: InsightExplanationRequest =
    typeof rawReq?.headline === "string" ? { ...rawReq, headline: repairMojibake(rawReq.headline) } : rawReq;
  if (!req.run_id || !req.headline?.trim()) {
    throw new Error("Nothing to explain yet.");
  }
  const key = cacheKey(req);

  const local = store.get(key);
  if (local?.summary) {
    // Cached before the decode existed — clean on the way out too.
    return {
      explanation: {
        ...local,
        summary: decodeEscapes(local.summary),
        points: local.points.map(decodeEscapes),
      },
      source: "local",
    };
  }

  const row = await readCloudRow<{
    run_id?: string;
    headline?: string;
    summary?: string;
    points?: string[];
    model?: string;
    generated_at?: string;
  }>(TABLE, key);
  if (row?.summary) {
    const cloud: InsightExplanation = {
      run_id: row.run_id ?? req.run_id,
      headline: row.headline ?? req.headline,
      summary: row.summary,
      points: Array.isArray(row.points) ? row.points : [],
      model: row.model ?? insightModel(),
      generated_at: row.generated_at ?? new Date().toISOString(),
    };
    store.put(key, cloud);
    return { explanation: cloud, source: "cloud" };
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const explanation = await generate(req);
    store.put(key, explanation);
    void writeCloudRow(TABLE, {
      cache_key: key,
      run_id: explanation.run_id,
      headline: explanation.headline,
      summary: explanation.summary,
      points: explanation.points,
      model: explanation.model,
      generated_at: explanation.generated_at,
    });
    return { explanation, source: "model" as const };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}
