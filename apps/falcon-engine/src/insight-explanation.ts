/**
 * The plain-English write-up under an Insight headline, served to any client.
 *
 * This is the desktop's `main/insight/insight-explanation-service.ts` moved to
 * the box that already holds the runs, the Anthropic key and the service-role
 * key. The desktop could run it because it had all three; a phone has none of
 * them, and the write-up is exactly the kind of thing both clients must read
 * the same words of.
 *
 * The cache key is the desktop's, verbatim — run id plus a hash of the
 * headline — so a row either side wrote is a row the other reads, and the
 * second reader of an event never spends a token. The local file store the
 * desktop keeps is left out: this process is one hop from Supabase and would
 * only be caching for itself.
 */

import { anthropicGlossCaller, glossConfigured } from "@meridian/research/gloss";
import { targetProgress } from "@meridian/research/propagation/contracts";
import type { PropagationRun, PropagationTarget } from "@meridian/research/propagation/engine";
import { supabaseFetch } from "./supabase.js";

/**
 * The Insight write-up model.
 *
 * Env-driven because this is the only user-facing prose the product produces:
 * swapping it is a quality decision someone should be able to make and reverse
 * from a deployment, without a release.
 */
const MODEL = process.env.FALCON_INSIGHT_MODEL?.trim() || "claude-opus-5";
const MAX_TOKENS = 1600;
const TIMEOUT_MS = 45_000;
const TABLE = "insight_explanations";
/** What the desktop card puts under the headline, and so what it explains. */
const NAME_ROWS = 4;

export type InsightExplanation = {
  run_id: string;
  headline: string;
  summary: string;
  points: string[];
  model: string;
  generated_at: string;
};

const SCHEMA = {
  type: "object",
  properties: {
    summary: { type: "string" },
    // No minItems/maxItems: the API rejects array bounds above 1. The count is
    // set by the prompt and enforced by the slice below.
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
  related names, and what would confirm or kill the read. No bullet characters.

Never invent numbers, dates, filings or quotes that are not in the input.`;

/** FNV-1a — the desktop's `hash`, so both sides land on the same cache key. */
function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * A model sometimes escapes a character twice on the way into JSON, so an em
 * dash arrives as a literal backslash, a "u" and four hex digits. Decode
 * whatever survived.
 */
function decodeEscapes(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"');
}

/** The headline the card shows, which is the headline this explains. */
export function runHeadline(run: PropagationRun): string {
  return `${run.root_ticker.toUpperCase()} ${run.event.label}`;
}

function cacheKey(runId: string, headline: string): string {
  return `${runId}:${hash(headline.trim().toLowerCase())}`;
}

const TIER_RANK: Record<PropagationTarget["relationship"]["tier"], number> = {
  critical: 3,
  important: 2,
  marginal: 1,
};

/**
 * The names the card puts under the headline — the desktop's `cardTargets`:
 * tracked, with a ticker, not vetoed; strongest relationship first and, within
 * a tier, the still-open ones first. One row per tradable name.
 */
function cardTargets(run: PropagationRun, limit: number): PropagationTarget[] {
  const ranked = run.targets
    .filter((t) => t.tracked && t.ticker != null && t.stage2?.verdict !== "vetoed")
    .sort((a, b) => {
      const tier = TIER_RANK[b.relationship.tier] - TIER_RANK[a.relationship.tier];
      if (tier !== 0) return tier;
      const prog = targetProgress(a) - targetProgress(b);
      if (prog !== 0) return prog;
      return (a.ticker ?? "").localeCompare(b.ticker ?? "");
    });
  const seen = new Set<string>();
  const once: PropagationTarget[] = [];
  for (const target of ranked) {
    const key = (target.ticker ?? "").toUpperCase();
    if (seen.has(key)) continue;
    seen.add(key);
    once.push(target);
  }
  return once.slice(0, limit);
}

function buildUser(run: PropagationRun, headline: string): string {
  const lines = [
    `Headline: ${headline}`,
    `Root company: ${run.root_ticker}`,
    `Event type: ${run.event.type}`,
    `Direction: ${run.event.direction}`,
    `Materiality: ${run.event.materiality}`,
  ];

  const targets = cardTargets(run, NAME_ROWS);
  if (targets.length > 0) {
    lines.push("Related names the event reaches:");
    for (const t of targets) {
      lines.push(
        `- ${(t.ticker ?? "").toUpperCase()}${t.label ? ` (${t.label})` : ""}${
          t.mechanism ? ` — ${t.mechanism}` : ""
        }`,
      );
    }
  }
  return lines.join("\n");
}

async function readCloudRow(key: string): Promise<InsightExplanation | null> {
  try {
    const res = await supabaseFetch(
      `${TABLE}?cache_key=eq.${encodeURIComponent(key)}&select=*&limit=1`,
    );
    if (!res?.ok) return null;
    const rows = (await res.json()) as Array<Partial<InsightExplanation>>;
    const row = rows?.[0];
    if (!row?.summary) return null;
    return {
      run_id: row.run_id ?? "",
      headline: row.headline ?? "",
      summary: row.summary,
      points: Array.isArray(row.points) ? row.points : [],
      model: row.model ?? MODEL,
      generated_at: row.generated_at ?? new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Upsert; failures are logged and swallowed — the answer already stands. */
async function writeCloudRow(key: string, explanation: InsightExplanation): Promise<void> {
  try {
    const res = await supabaseFetch(TABLE, {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({ cache_key: key, ...explanation }),
    });
    if (res && !res.ok) {
      console.warn(
        `[engine] ${TABLE} upsert failed:`,
        res.status,
        (await res.text().catch(() => "")).slice(0, 200),
      );
    }
  } catch (err) {
    console.warn(`[engine] ${TABLE} upsert failed:`, err);
  }
}

async function generate(run: PropagationRun, headline: string): Promise<InsightExplanation> {
  if (!glossConfigured()) throw new Error("ANTHROPIC_API_KEY is not configured");
  const output = await anthropicGlossCaller({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    effort: "low",
    system: SYSTEM,
    user: buildUser(run, headline),
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
    run_id: run.run_id,
    headline,
    summary,
    points: points.map((p) => decodeEscapes(p.trim())).slice(0, 4),
    model: MODEL,
    generated_at: new Date().toISOString(),
  };
}

/** Two readers opening the same event at once share one model call. */
const inFlight = new Map<string, Promise<{ explanation: InsightExplanation; source: "model" }>>();

export async function getInsightExplanation(
  run: PropagationRun,
): Promise<{ explanation: InsightExplanation; source: "cloud" | "model" }> {
  const headline = runHeadline(run).trim();
  if (!run.run_id || !headline) throw new Error("Nothing to explain yet.");
  const key = cacheKey(run.run_id, headline);

  const cloud = await readCloudRow(key);
  if (cloud) {
    return {
      explanation: { ...cloud, run_id: cloud.run_id || run.run_id, headline: cloud.headline || headline },
      source: "cloud",
    };
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const explanation = await generate(run, headline);
    void writeCloudRow(key, explanation);
    return { explanation, source: "model" as const };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}
