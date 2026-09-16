import { getConfig } from "../config.js";
import { callClaudeJson } from "./anthropicClient.js";
import { mapPool } from "./asyncPool.js";
import { stripJsonFences } from "./normalize.js";
import type { TokenUsage } from "./tokenUsage.js";
import type { StrengthBasis, StrengthTier } from "./types.js";

export type { StrengthBasis, StrengthTier };

export const STRENGTH_BY_TIER: Record<StrengthTier, number> = {
  critical: 1.0,
  important: 0.6,
  marginal: 0.3,
};

export const STRENGTH_CLASSIFY_SYSTEM = [
  "You classify the materiality strength of ONE business relationship edge from SEC filing evidence.",
  "Use ONLY the evidence quote and disclosed fields. No outside knowledge.",
  "Tiers:",
  '- "critical": filing discloses high dependency (revenue % >= 10, "substantial majority", "primarily", sole/single-source supplier).',
  '- "important": named material relationship, no dominance language.',
  '- "marginal": named only in a list (e.g. one of many competitors), no materiality signal.',
  "If disclosed_revenue_dependency_pct is set, still output the matching tier from that pct (>=10 critical, >=5 important, else marginal).",
  'Output JSON only: {"strength_tier": "critical"|"important"|"marginal"}',
].join(" ");


/** Batched form of STRENGTH_CLASSIFY_SYSTEM — same tiers, several edges per call. */
export const STRENGTH_CLASSIFY_BATCH_SYSTEM = [
  "You classify the materiality strength of business relationship edges from SEC filing evidence.",
  "You receive SEVERAL edges. Judge EACH independently, using ONLY its own evidence quote and disclosed fields. No outside knowledge.",
  "Tiers:",
  '- "critical": filing discloses high dependency (revenue % >= 10, "substantial majority", "primarily", sole/single-source supplier).',
  '- "important": named material relationship, no dominance language.',
  '- "marginal": named only in a list (e.g. one of many competitors), no materiality signal.',
  "If disclosed_revenue_dependency_pct is set, still output the matching tier from that pct (>=10 critical, >=5 important, else marginal).",
  "Do not balance tiers across the batch — each edge stands alone.",
  'Output JSON only, one entry per edge, echoing its index: {"tiers": [{"index": number, "strength_tier": "critical"|"important"|"marginal"}]}',
  "Return an entry for EVERY index you were given.",
].join(" ");

const TIERS = new Set<StrengthTier>(["critical", "important", "marginal"]);

const CLASSIFY_CONCURRENCY = 4;

export function parseStrengthTier(raw: unknown): StrengthTier | null {
  if (typeof raw !== "string") return null;
  const t = raw.trim().toLowerCase() as StrengthTier;
  return TIERS.has(t) ? t : null;
}

/** Map disclosed revenue % to a display tier (numeric strength still uses pct/100). */
export function tierFromDisclosedPct(pct: number): StrengthTier {
  if (pct >= 10) return "critical";
  if (pct >= 5) return "important";
  return "marginal";
}

export function resolveEdgeStrength(input: {
  disclosed_revenue_dependency_pct?: number | null;
  strength_tier?: StrengthTier | null;
}): {
  strength: number;
  strength_tier: StrengthTier;
  strength_basis: StrengthBasis;
} {
  const pct = input.disclosed_revenue_dependency_pct;
  if (pct != null && Number.isFinite(pct)) {
    return {
      strength: Math.min(1, Math.max(0, pct / 100)),
      strength_tier: tierFromDisclosedPct(pct),
      strength_basis: "disclosed",
    };
  }
  const tier = input.strength_tier ?? "important";
  return {
    strength: STRENGTH_BY_TIER[tier],
    strength_tier: tier,
    strength_basis: "classified",
  };
}

/** Bottleneck tier along a path (lowest numeric strength wins). */
export function minStrengthTier(tiers: StrengthTier[]): StrengthTier {
  if (tiers.length === 0) return "important";
  let best: StrengthTier = tiers[0]!;
  for (const t of tiers) {
    if (STRENGTH_BY_TIER[t] < STRENGTH_BY_TIER[best]) best = t;
  }
  return best;
}

export function strengthChipLabel(tier: StrengthTier): string {
  if (tier === "critical") return "critical link";
  if (tier === "important") return "important link";
  return "marginal link";
}

function parseClassifyResponse(raw: string): StrengthTier | null {
  try {
    const cleaned = stripJsonFences(raw);
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const json = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
    const parsed = JSON.parse(json) as Record<string, unknown>;
    return parseStrengthTier(parsed.strength_tier);
  } catch {
    return null;
  }
}

export type StrengthClassifyInput = {
  counterparty_name: string;
  category: string;
  subtype: string;
  disclosed_revenue_dependency_pct: number | null;
  evidence_quote: string;
};

/** One LLM classification per edge. Disclosed % skips the LLM. */
export async function classifyEdgeStrength(
  edge: StrengthClassifyInput,
  usage?: TokenUsage,
): Promise<{ strength: number; strength_tier: StrengthTier; strength_basis: StrengthBasis }> {
  const pct = edge.disclosed_revenue_dependency_pct;
  if (pct != null && Number.isFinite(pct)) {
    return resolveEdgeStrength({ disclosed_revenue_dependency_pct: pct });
  }

  const user = [
    "Edge:",
    JSON.stringify({
      counterparty_name: edge.counterparty_name,
      category: edge.category,
      subtype: edge.subtype,
      disclosed_revenue_dependency_pct: edge.disclosed_revenue_dependency_pct,
      evidence_quote: edge.evidence_quote,
    }),
  ].join("\n");

  try {
    const raw = await callClaudeJson({
      system: STRENGTH_CLASSIFY_SYSTEM,
      user,
      maxTokens: 80,
      usage,
    });
    const tier = parseClassifyResponse(raw);
    if (!tier) {
      console.warn(
        `[strength] unparseable tier for ${edge.counterparty_name}; defaulting to important`,
      );
      return resolveEdgeStrength({ strength_tier: "important" });
    }
    return resolveEdgeStrength({ strength_tier: tier });
  } catch (err) {
    throw new Error(
      `strength classify failed for ${edge.counterparty_name}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Batch size for the classifier.
 *
 * An edge here is tiny — a name, a category and a quote — so the per-call
 * overhead (system prompt, connection, retry) dominated the payload completely:
 * one call per edge meant ~18 calls per company to move a few hundred tokens.
 * Twenty at a time keeps the output well inside a small `max_tokens` while
 * cutting the call count by an order of magnitude.
 */
export const STRENGTH_BATCH_SIZE = 20;

/** Parse `{"tiers":[{index, strength_tier}]}` into a by-index map. */
export function parseBatchTiers(raw: string, expected: number): Map<number, StrengthTier> {
  const out = new Map<number, StrengthTier>();
  let parsed: Record<string, unknown>;
  try {
    const cleaned = stripJsonFences(raw);
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    parsed = JSON.parse(
      start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned,
    ) as Record<string, unknown>;
  } catch {
    return out;
  }
  const rows = parsed.tiers;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const index = typeof r.index === "number" ? r.index : Number(r.index);
    if (!Number.isInteger(index) || index < 0 || index >= expected) continue;
    const tier = parseStrengthTier(r.strength_tier);
    if (tier) out.set(index, tier);
  }
  return out;
}

type Resolved = { strength: number; strength_tier: StrengthTier; strength_basis: StrengthBasis };

async function classifyBatch(
  batch: Array<{ edge: StrengthClassifyInput; slot: number }>,
  usage?: TokenUsage,
): Promise<Map<number, Resolved>> {
  const out = new Map<number, Resolved>();
  const user = [
    `Edges (${batch.length}). Return one tier per index.`,
    ...batch.map(({ edge }, i) =>
      JSON.stringify({
        index: i,
        counterparty_name: edge.counterparty_name,
        category: edge.category,
        subtype: edge.subtype,
        disclosed_revenue_dependency_pct: edge.disclosed_revenue_dependency_pct,
        evidence_quote: edge.evidence_quote,
      }),
    ),
  ].join("\n");

  const raw = await callClaudeJson({
    system: STRENGTH_CLASSIFY_BATCH_SYSTEM,
    model: getConfig().step1StrengthModel,
    user,
    maxTokens: 40 * batch.length + 80,
    usage,
  });
  const tiers = parseBatchTiers(raw, batch.length);
  batch.forEach(({ edge, slot }, i) => {
    const tier = tiers.get(i);
    if (!tier) {
      console.warn(
        `[strength] unparseable tier for ${edge.counterparty_name}; defaulting to important`,
      );
    }
    out.set(slot, resolveEdgeStrength({ strength_tier: tier ?? "important" }));
  });
  return out;
}

/**
 * Classify every edge, batched.
 *
 * Edges with a disclosed revenue percentage never reach the model — that tier
 * is arithmetic, not judgement — so they are resolved first and only the rest
 * are batched. Slots preserve input order regardless of which path an edge took.
 */
export async function classifyEdgesStrength(
  edges: StrengthClassifyInput[],
  onProgress?: (current: number, total: number) => void,
  usage?: TokenUsage,
): Promise<Resolved[]> {
  const results = new Array<Resolved | undefined>(edges.length);
  const needsModel: Array<{ edge: StrengthClassifyInput; slot: number }> = [];

  edges.forEach((edge, slot) => {
    const pct = edge.disclosed_revenue_dependency_pct;
    if (pct != null && Number.isFinite(pct)) {
      results[slot] = resolveEdgeStrength({ disclosed_revenue_dependency_pct: pct });
    } else {
      needsModel.push({ edge, slot });
    }
  });

  const batches: Array<Array<{ edge: StrengthClassifyInput; slot: number }>> = [];
  for (let i = 0; i < needsModel.length; i += STRENGTH_BATCH_SIZE) {
    batches.push(needsModel.slice(i, i + STRENGTH_BATCH_SIZE));
  }

  let done = edges.length - needsModel.length;
  onProgress?.(done, edges.length);

  const maps = await mapPool(batches, CLASSIFY_CONCURRENCY, async (batch) => {
    try {
      const map = await classifyBatch(batch, usage);
      done += batch.length;
      onProgress?.(done, edges.length);
      return map;
    } catch (err) {
      // A failed batch must not sink the run: every edge in it falls back to
      // the same default a single unparseable response would have produced.
      console.warn(
        `[strength] batch of ${batch.length} failed (${err instanceof Error ? err.message : String(err)}); defaulting to important`,
      );
      const map = new Map<number, Resolved>();
      for (const { slot } of batch) {
        map.set(slot, resolveEdgeStrength({ strength_tier: "important" }));
      }
      done += batch.length;
      onProgress?.(done, edges.length);
      return map;
    }
  });

  for (const map of maps) {
    for (const [slot, resolved] of map) results[slot] = resolved;
  }
  return results.map((r) => r ?? resolveEdgeStrength({ strength_tier: "important" }));
}
