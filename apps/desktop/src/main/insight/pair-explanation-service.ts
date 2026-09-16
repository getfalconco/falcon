import { anthropicGlossCaller, glossConfigured } from "@meridian/research/gloss";
import { createFileStore, decodeEscapes, hash, readCloudRow, writeCloudRow } from "./explanation-cache";
import type { PairExplanation, PairExplanationRequest } from "../../shared/pair-explanation";

/**
 * The write-up behind one affected name on an Insight card. Same three-step
 * economy as the card's own explanation — disk, then Supabase, then the model
 * — keyed by the run, the name and the headline, so a re-worded event writes a
 * new one and the second reader of a pair never spends a token.
 */

const MODEL = "claude-opus-5";
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

You are given the pair's own track record — how this app's engine has called
this exact link before, and how those calls resolved. Use it. If the record is
thin or empty, say so plainly instead of inventing a history.

Return JSON only:
- "outlook": the expectation, stated. "direction" is what you think this name
  does from here (up, down, or unclear); "magnitude" the size in words such as
  "1-2%"; "horizon" when, such as "the next 2-3 sessions"; "conviction" how
  much weight the evidence carries (low, medium, high — low when the record is
  thin or the edge is marginal); "call" one line under 100 characters saying
  the expectation plainly, e.g. "Down 1-2% over the next few sessions, on a
  thin record." Be willing to say unclear: a stated non-view beats a
  manufactured one.
- "why": 2-3 sentences. The mechanism: how the event actually reaches this
  company's numbers. Be specific about the channel, not the sector.
- "precedent": 2-3 sentences. What events of this kind have done to this name
  before, using the record given. Cite the counts and the typical size where
  they exist; say the record is thin when it is.
- "this_time": 2-3 sentences. How it is likely to go now and roughly how big,
  and what makes this instance different from the precedents.
- "watch": 2-4 lines, each under 110 characters. What would confirm the read
  and what would kill it. No bullet characters.

Never invent numbers, dates, filings or quotes that are not in the input.
Percentages you cite must come from the record you were given.`;

const store = createFileStore<PairExplanation>("pair-explanations.json");

/** Anything already in a cache predates the decode, so clean on the way out. */
function clean(e: PairExplanation): PairExplanation {
  return {
    ...e,
    outlook: e.outlook
      ? { ...e.outlook, call: decodeEscapes(e.outlook.call) }
      : e.outlook,
    why: decodeEscapes(e.why),
    precedent: decodeEscapes(e.precedent),
    this_time: decodeEscapes(e.this_time),
    watch: e.watch.map(decodeEscapes),
  };
}

function cacheKey(req: PairExplanationRequest): string {
  const target = req.target_ticker.trim().toUpperCase();
  return `${req.run_id}:${target}:${hash(req.headline.trim().toLowerCase())}`;
}

function pct(v: number | null | undefined): string {
  return v == null || !Number.isFinite(v) ? "n/a" : `${(v * 100).toFixed(1)}%`;
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
    req.tier ? `Edge strength: ${req.tier}` : null,
    req.mechanism ? `Mechanism on file: ${req.mechanism}` : null,
  ].filter((line): line is string => line !== null);

  const record = req.record;
  if (record) {
    const resolved = record.hits + record.partials + record.misses;
    lines.push(
      "",
      "The engine's record on this exact pair:",
      `- calls that resolved: ${resolved} (right direction ${record.hits + record.partials}, wrong direction ${record.misses})`,
      `- still open: ${record.open}; expired without resolving: ${record.expired}`,
      `- share called right: ${record.hit_rate == null ? "n/a" : `${Math.round(record.hit_rate * 100)}%`}`,
      `- typical expected move: ${pct(record.avg_expected_pct)}; typical realised move: ${pct(record.avg_realized_pct)}`,
      `- realised as a share of expected: ${record.avg_ratio == null ? "n/a" : record.avg_ratio.toFixed(2)}`,
    );
  }

  const precedents = (req.precedents ?? []).slice(0, 10);
  if (precedents.length > 0) {
    lines.push("", "Past events on this pair, newest first:");
    for (const p of precedents) {
      lines.push(
        `- ${p.event_ts.slice(0, 10)} · ${p.type} · ${p.label} → ${p.outcome} (expected ${pct(
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
    model: MODEL,
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
    model: MODEL,
    generated_at: new Date().toISOString(),
  };
}

/** Two readers opening the same name at once share one model call. */
const inFlight = new Map<string, Promise<{ explanation: PairExplanation; source: "model" }>>();

export async function getPairExplanation(
  req: PairExplanationRequest,
): Promise<{ explanation: PairExplanation; source: "local" | "cloud" | "model" }> {
  if (!req.run_id || !req.headline?.trim() || !req.target_ticker?.trim()) {
    throw new Error("Nothing to explain yet.");
  }
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
      model: row.model ?? MODEL,
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
