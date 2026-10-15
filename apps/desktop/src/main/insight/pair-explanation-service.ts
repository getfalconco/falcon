import { repairMojibake } from "@meridian/research/news";
import { anthropicGlossCaller, glossConfigured } from "@meridian/research/gloss";
import { DEFAULT_PROPAGATION_CONFIG } from "@meridian/research/propagation/engine";
import { insightModel } from "./insight-explanation-service";
import { createFileStore, decodeEscapes, hash, readCloudRow, writeCloudRow } from "./explanation-cache";
import type { PairExplanation, PairExplanationRequest } from "../../shared/pair-explanation";
import { PROMPT_COPY_RULE } from "../../shared/copy-rules";

/**
 * The write-up behind one affected name on an Insight card. Same three-step
 * economy as the card's own explanation (disk, then Supabase, then the model),
 * keyed by the run, the name and the headline, so a re-worded event writes a
 * new one and the second reader of a pair never spends a token.
 *
 * PROMPT_VERSION is part of the key. Rows written under the first prompt state
 * a view on the price ("Down 1-2% over the next few sessions"), and rows
 * under v2 count past links as "calls"; bumping the version leaves them
 * unread, so no reader sees that text again.
 */

const PROMPT_VERSION = "v3";

const MAX_TOKENS = 2200;
const TIMEOUT_MS = 60_000;
const TABLE = "insight_pair_explanations";

const SCHEMA = {
  type: "object",
  properties: {
    outlook: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["up", "down", "unclear"] },
        magnitude: { type: "string" },
        horizon: { type: "string" },
        conviction: { type: "string", enum: ["low", "medium", "high"] },
        call: { type: "string" },
      },
      required: ["direction", "magnitude", "horizon", "conviction", "call"],
      additionalProperties: false,
    },
    why: { type: "string" },
    precedent: { type: "string" },
    this_time: { type: "string" },
    // No array bounds: the API rejects them above 1. The count is set by the
    // prompt and enforced by the slice below.
    watch: { type: "array", items: { type: "string" } },
  },
  required: ["outlook", "why", "precedent", "this_time", "watch"],
  additionalProperties: false,
} as const;

const SYSTEM = `You explain, in an equity-research app, why one company is exposed to an event
that happened at another company.

Voice: plain, concrete, no hype, no hedging filler, no disclaimers. The reader
follows markets but may not know this relationship.

You are given the pair's own record: past events at the root, the direction
this link implied for each, and how the share price moved afterwards. Use it.
If the record is thin or empty, say so plainly instead of inventing a history.
Describe that history as past moves: "moved the implied way 4 of 5 times",
"the move went the other way once". Never call past events calls, picks or a
track record.

You describe the link and its record. You never give a view on the price and
never say what the share price does next.

Return JSON only:
- "outlook": what the link implies, read from the relationship and the record,
  not a view on the price. "direction" is the sign the relationship carries for
  this kind of event (up, down, or unclear when the link does not decide it);
  "magnitude" the size of past moves on this link as the record shows them, in
  words such as "1-2%", or "no record" when there is none; "horizon" the window
  those past moves were measured in, taken from the record (such as "3
  sessions"), or "no record" when no past move has resolved;
  "conviction" the weight of the record (low, medium, high: low when the record
  is thin or the link is marginal); "call" one line under 100 characters that
  describes the link and its record, e.g. "Critical foundry link, moved the
  implied way 4 of 5 times, about 1.7% on average." or "Supplier link, past
  moves 1-2% on a thin record." Saying unclear is fine: a stated non-view
  beats a manufactured one.
- "why": 2-3 sentences. The mechanism: how the event reaches this company's
  numbers. Be specific about the channel, not the sector.
- "precedent": 2-3 sentences. What happened to this name after events of this
  kind before, using the record given. Cite the counts and the typical size
  where they exist; say the record is thin when it is.
- "this_time": 2-3 sentences. How this event differs from the precedents: its
  type, its size, the strength of the link, what is new about it.
- "watch": 2-4 lines, each under 110 characters. The facts in the input this
  read rests on, one per line. No bullet characters.

Never invent numbers, dates, filings or quotes that are not in the input.
Percentages you cite must come from the record you were given.

${PROMPT_COPY_RULE}`;

const store = createFileStore<PairExplanation>("pair-explanations.json");

/** Anything already in a cache predates the decode, so clean on the way out. */
function clean(e: PairExplanation): PairExplanation {
  return {
    ...e,
    outlook: e.outlook
      ? {
          ...e.outlook,
          magnitude: decodeEscapes(e.outlook.magnitude ?? ""),
          horizon: decodeEscapes(e.outlook.horizon ?? ""),
          call: decodeEscapes(e.outlook.call),
        }
      : e.outlook,
    why: decodeEscapes(e.why),
    precedent: decodeEscapes(e.precedent),
    this_time: decodeEscapes(e.this_time),
    watch: e.watch.map(decodeEscapes),
  };
}

function cacheKey(req: PairExplanationRequest): string {
  const target = req.target_ticker.trim().toUpperCase();
  return `${PROMPT_VERSION}:${req.run_id}:${target}:${hash(req.headline.trim().toLowerCase())}`;
}

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(1)}%`;
}

/** The engine's outcome codes as plain words, so the model never echoes "hit" or "miss". */
function outcomeWords(outcome: string): string {
  switch (outcome) {
    case "hit":
      return "moved the implied way";
    case "partial":
      return "moved the implied way, smaller than implied";
    case "miss":
      return "moved the other way";
    case "open":
      return "still inside the window";
    case "expired":
      return "window passed with no clear move";
    default:
      return outcome;
  }
}

function buildUser(req: PairExplanationRequest): string {
  const root = req.root_ticker.toUpperCase();
  const target = req.target_ticker.toUpperCase();
  const lines = [
    `Event: ${req.headline}`,
    `It happened at: ${root}`,
    `Explain the exposure of: ${target}${req.target_label ? ` (${req.target_label})` : ""}`,
    req.event_type ? `Event type: ${req.event_type}` : null,
    req.event_direction ? `Direction at the root: ${req.event_direction}` : null,
    req.event_materiality ? `Materiality: ${req.event_materiality}` : null,
    req.role ? `Relationship: ${target} is a ${req.role} of ${root}` : null,
    req.tier ? `Link strength: ${req.tier}` : null,
    req.mechanism ? `Mechanism on file: ${req.mechanism}` : null,
  ].filter((line): line is string => line !== null);

  const record = req.record;
  if (record) {
    const resolved = record.hits + record.partials + record.misses;
    const horizon = req.horizon_sessions;
    lines.push(
      "",
      "The record on this exact pair:",
      `- past events with a resolved move: ${resolved} (moved the implied way ${record.hits + record.partials}, moved the other way ${record.misses})`,
      `- still inside the window: ${record.open}; window passed with no clear move: ${record.expired}`,
      `- share that moved the implied way: ${record.hit_rate == null ? "n/a" : `${Math.round(record.hit_rate * 100)}%`}`,
      `- typical implied size: ${pct(record.avg_expected_pct)}; typical realised move: ${pct(record.avg_realized_pct)}`,
      `- realised as a share of implied: ${record.avg_ratio == null ? "n/a" : record.avg_ratio.toFixed(2)}`,
      resolved > 0 && horizon != null && horizon > 0
        ? `- window each move was measured in: ${horizon} ${horizon === 1 ? "session" : "sessions"} after the event`
        : "- window each move was measured in: no resolved move yet",
    );
  }

  const precedents = (req.precedents ?? []).slice(0, 10);
  if (precedents.length > 0) {
    lines.push("", "Past events on this pair, newest first:");
    for (const p of precedents) {
      lines.push(
        `- ${p.event_ts.slice(0, 10)} · ${p.type} · ${p.label} → ${outcomeWords(p.outcome)} (implied ${pct(
          p.expected_pct,
        )}, realised ${pct(p.realized_pct)})`,
      );
    }
  }
  return lines.join("\n");
}

async function generate(req: PairExplanationRequest): Promise<PairExplanation> {
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

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(output.text) as Record<string, unknown>;
  } catch {
    throw new Error("the model returned malformed JSON");
  }
  const text = (key: string): string =>
    typeof parsed[key] === "string" ? decodeEscapes((parsed[key] as string).trim()) : "";
  const why = text("why");
  if (!why) throw new Error("the model returned no explanation");

  const raw = parsed.outlook as Record<string, unknown> | undefined;
  const pick = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
    typeof value === "string" && (allowed as readonly string[]).includes(value)
      ? (value as T)
      : fallback;
  const outlook =
    raw && typeof raw === "object"
      ? {
          direction: pick(raw.direction, ["up", "down", "unclear"] as const, "unclear"),
          magnitude: typeof raw.magnitude === "string" ? decodeEscapes(raw.magnitude.trim()) : "",
          horizon: typeof raw.horizon === "string" ? decodeEscapes(raw.horizon.trim()) : "",
          conviction: pick(raw.conviction, ["low", "medium", "high"] as const, "low"),
          call: typeof raw.call === "string" ? decodeEscapes(raw.call.trim()) : "",
        }
      : null;

  const watch = Array.isArray(parsed.watch)
    ? (parsed.watch as unknown[])
        .filter((x): x is string => typeof x === "string" && x.trim().length > 0)
        .map((x) => decodeEscapes(x.trim()))
        .slice(0, 4)
    : [];

  return {
    run_id: req.run_id,
    target: req.target_ticker.trim().toUpperCase(),
    headline: req.headline,
    outlook,
    why,
    precedent: text("precedent"),
    this_time: text("this_time"),
    watch,
    model: insightModel(),
    generated_at: new Date().toISOString(),
  };
}

/** Two readers opening the same name at once share one model call. */
const inFlight = new Map<string, Promise<{ explanation: PairExplanation; source: "model" }>>();

/**
 * The window the record measures moves in: the request's own, else the live
 * engine's (main passes its config getter), else the engine default.
 */
function withHorizon(req: PairExplanationRequest, liveHorizon?: () => number | null | undefined): PairExplanationRequest {
  if (req.horizon_sessions != null && req.horizon_sessions > 0) return req;
  let sessions: number | null | undefined = null;
  try {
    sessions = liveHorizon?.();
  } catch {
    sessions = null;
  }
  const value =
    sessions != null && Number.isFinite(sessions) && sessions > 0 ? sessions : DEFAULT_PROPAGATION_CONFIG.pricing.horizonSessions;
  return { ...req, horizon_sessions: value };
}

export async function getPairExplanation(
  rawReq: PairExplanationRequest,
  opts: { horizonSessions?: () => number | null | undefined } = {},
): Promise<{ explanation: PairExplanation; source: "local" | "cloud" | "model" }> {
  // A headline filed before ingestion repaired provider mojibake ("weekâ€™s")
  // is fixed before it reaches the model (and so the brief). Clean text, and
  // with it the cache key, is unchanged.
  const repaired: PairExplanationRequest =
    typeof rawReq?.headline === "string" ? { ...rawReq, headline: repairMojibake(rawReq.headline) } : rawReq;
  if (!repaired?.run_id || !repaired.headline?.trim() || !repaired.target_ticker?.trim()) {
    throw new Error("Nothing to explain yet.");
  }
  const req = withHorizon(repaired, opts.horizonSessions);
  const key = cacheKey(req);

  const local = store.get(key);
  if (local?.why) return { explanation: clean(local), source: "local" };

  const row = await readCloudRow<{
    run_id?: string;
    target?: string;
    headline?: string;
    outlook?: PairExplanation["outlook"];
    why?: string;
    precedent?: string;
    this_time?: string;
    watch?: string[];
    model?: string;
    generated_at?: string;
  }>(TABLE, key);
  if (row?.why) {
    const cloud: PairExplanation = {
      run_id: row.run_id ?? req.run_id,
      target: row.target ?? req.target_ticker.toUpperCase(),
      headline: row.headline ?? req.headline,
      outlook: row.outlook ?? null,
      why: row.why,
      precedent: row.precedent ?? "",
      this_time: row.this_time ?? "",
      watch: Array.isArray(row.watch) ? row.watch : [],
      model: row.model ?? insightModel(),
      generated_at: row.generated_at ?? new Date().toISOString(),
    };
    store.put(key, cloud);
    return { explanation: clean(cloud), source: "cloud" };
  }

  const pending = inFlight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const explanation = await generate(req);
    store.put(key, explanation);
    void writeCloudRow(TABLE, {
      cache_key: key,
      run_id: explanation.run_id,
      target: explanation.target,
      headline: explanation.headline,
      outlook: explanation.outlook,
      why: explanation.why,
      precedent: explanation.precedent,
      this_time: explanation.this_time,
      watch: explanation.watch,
      model: explanation.model,
      generated_at: explanation.generated_at,
    });
    return { explanation, source: "model" as const };
  })().finally(() => inFlight.delete(key));

  inFlight.set(key, task);
  return task;
}
