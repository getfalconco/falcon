import { getConfig } from "../config.js";
import { callClaudeJson, type UserBlock } from "./anthropicClient.js";
import { buildEvidenceExcerpt } from "./evidenceWindow.js";
import { mapPool } from "./asyncPool.js";
import { stripJsonFences } from "./normalize.js";
import { AUDIT_BATCH_SYSTEM_PROMPT } from "./prompts.js";
import type { TokenUsage } from "./tokenUsage.js";
import type {
  AuditorVerdict,
  CandidateEdge,
  CounterpartyType,
  RejectedCandidate,
  RelationshipCategory,
} from "./types.js";
import { RELATIONSHIP_CATEGORIES } from "./types.js";

const CATEGORIES = new Set<string>(RELATIONSHIP_CATEGORIES);
const AUDIT_CONCURRENCY = 4;

function parseAuditor(raw: string): AuditorVerdict | null {
  try {
    const cleaned = stripJsonFences(raw);
    const start = cleaned.indexOf("{");
    const end = cleaned.lastIndexOf("}");
    const json = start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const verdict = parsed.verdict;
    if (verdict !== "approve" && verdict !== "fix" && verdict !== "reject") return null;
    const confidence =
      typeof parsed.confidence === "number" ? parsed.confidence : Number(parsed.confidence);
    if (!Number.isFinite(confidence)) return null;

    let corrected: AuditorVerdict["corrected"] = null;
    if (parsed.corrected && typeof parsed.corrected === "object") {
      const c = parsed.corrected as Record<string, unknown>;
      corrected = {
        counterparty_name: String(c.counterparty_name ?? ""),
        counterparty_type: String(c.counterparty_type ?? ""),
        category: String(c.category ?? ""),
        subtype: String(c.subtype ?? ""),
      };
    }

    return {
      verdict,
      reason: typeof parsed.reason === "string" ? parsed.reason : "",
      corrected,
      confidence,
    };
  } catch {
    return null;
  }
}

type AuditOutcome =
  | { kind: "approved"; edge: CandidateEdge }
  | { kind: "rejected"; rejected: RejectedCandidate };


/**
 * Maximum candidates judged in one call.
 *
 * Chunks are not evenly loaded — measured over 56 cached extractions the mean
 * is 4.1 candidates per chunk but the worst is 16.8, and one call carrying
 * seventeen verdicts is both a long output and a single point of failure for
 * all of them. Splitting at eight keeps the output bounded, and a chunk that
 * needs a second batch is exactly the case where caching its text pays.
 */
export const AUDIT_BATCH_SIZE = 8;

function chunksOf<T>(list: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

/** One batch: the chunk once, then the candidates that came out of it. */
type AuditBatch = {
  chunkIndex: number;
  chunk: string;
  candidates: CandidateEdge[];
  /** True when this chunk is split across batches, so its text WILL be re-sent. */
  cacheChunk: boolean;
};

export function planAuditBatches(
  candidates: CandidateEdge[],
  chunks: string[],
  batchSize = AUDIT_BATCH_SIZE,
): AuditBatch[] {
  const byChunk = new Map<number, CandidateEdge[]>();
  for (const edge of candidates) {
    const idx = edge.chunk_index ?? 0;
    const bucket = byChunk.get(idx);
    if (bucket) bucket.push(edge);
    else byChunk.set(idx, [edge]);
  }

  const batches: AuditBatch[] = [];
  for (const [chunkIndex, group] of [...byChunk.entries()].sort((a, b) => a[0] - b[0])) {
    const parts = chunksOf(group, batchSize);
    for (const part of parts) {
      batches.push({
        chunkIndex,
        chunk: chunks[chunkIndex] ?? "",
        candidates: part,
        // Only worth a cache write when a later batch re-sends the same chunk.
        cacheChunk: parts.length > 1,
      });
    }
  }
  return batches;
}

/** Shape sent to the model — index is the handle a verdict comes back on. */
function candidateLine(edge: CandidateEdge, index: number): string {
  return JSON.stringify({
    index,
    counterparty_name: edge.counterparty_name,
    counterparty_type: edge.counterparty_type,
    category: edge.category,
    subtype: edge.subtype,
    disclosed_revenue_dependency_pct: edge.disclosed_revenue_dependency_pct,
    evidence_quote: edge.evidence_quote,
    confidence: edge.confidence,
  });
}

/** Parse `{"verdicts":[{index, verdict, ...}]}` into a by-index map. */
export function parseBatchAuditor(raw: string, expected: number): Map<number, AuditorVerdict> {
  const out = new Map<number, AuditorVerdict>();
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
  const rows = parsed.verdicts;
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const index = typeof r.index === "number" ? r.index : Number(r.index);
    if (!Number.isInteger(index) || index < 0 || index >= expected) continue;
    const one = parseAuditor(JSON.stringify(r));
    if (one) out.set(index, one);
  }
  return out;
}

/** Apply one parsed verdict to its candidate — the per-edge decision, unchanged. */
function applyVerdict(edge: CandidateEdge, verdict: AuditorVerdict): AuditOutcome {
  if (verdict.verdict === "reject") {
    return {
      kind: "rejected",
      rejected: {
        counterparty_name: edge.counterparty_name,
        category: edge.category,
        subtype: edge.subtype,
        evidence_quote: edge.evidence_quote,
        confidence: edge.confidence,
        reason: verdict.reason || "auditor rejected",
        stage: "audit",
      },
    };
  }
  let next = { ...edge, confidence: verdict.confidence };
  if (verdict.verdict === "fix" && verdict.corrected) {
    const cat = verdict.corrected.category.toLowerCase();
    next = {
      ...next,
      counterparty_name: verdict.corrected.counterparty_name || next.counterparty_name,
      counterparty_type: (verdict.corrected.counterparty_type ||
        next.counterparty_type) as CounterpartyType,
      category: (CATEGORIES.has(cat) ? cat : next.category) as RelationshipCategory,
      subtype: verdict.corrected.subtype || next.subtype,
    };
  }
  return { kind: "approved", edge: next };
}

function rejectedFor(edge: CandidateEdge, reason: string): RejectedCandidate {
  return {
    counterparty_name: edge.counterparty_name,
    category: edge.category,
    subtype: edge.subtype,
    evidence_quote: edge.evidence_quote,
    confidence: edge.confidence,
    reason,
    stage: "audit",
  };
}

/**
 * Audit one chunk's candidates in a single call.
 *
 * The chunk block comes FIRST and the candidates last. That ordering is the
 * whole cache design: caching is a prefix match, so a varying block in front of
 * the chunk (which is what the per-candidate version did) guarantees the prefix
 * diverges before it reaches the reusable text and nothing is ever read back.
 */
async function auditBatch(
  batch: AuditBatch,
  companyName: string,
  ticker: string,
  usage?: TokenUsage,
): Promise<AuditOutcome[]> {
  // The auditor needs each quote in context, not the whole chunk the extractor
  // was reading. Falls back to the full chunk if any quote cannot be located.
  const excerpt = buildEvidenceExcerpt(
    batch.chunk,
    batch.candidates.map((c) => c.evidence_quote),
  );
  if (excerpt.missing.length > 0) {
    console.warn(
      `[audit] ${excerpt.missing.length} quote(s) not found verbatim in chunk ${batch.chunkIndex}; sending full chunk`,
    );
  }

  const user: UserBlock[] = [
    {
      text: [
        `ROOT company: ${companyName} (${ticker})`,
        "",
        excerpt.trimmed
          ? "Source excerpt (passages around each quote; […] marks omitted text):"
          : "Source chunk:",
        `"""${excerpt.excerpt}"""`,
      ].join("\n"),
      cache: batch.cacheChunk,
    },
    {
      text: [
        `Candidate edges (${batch.candidates.length}). Return one verdict per index.`,
        ...batch.candidates.map((edge, i) => candidateLine(edge, i)),
      ].join("\n"),
    },
  ];

  try {
    const raw = await callClaudeJson({
      system: AUDIT_BATCH_SYSTEM_PROMPT,
      model: getConfig().step1AuditModel,
      user,
      // 600 was the per-edge budget; a verdict is the same size either way.
      maxTokens: 600 * batch.candidates.length,
      usage,
    });
    const verdicts = parseBatchAuditor(raw, batch.candidates.length);
    return batch.candidates.map((edge, i) => {
      const verdict = verdicts.get(i);
      if (!verdict) {
        return { kind: "rejected", rejected: rejectedFor(edge, "unparseable auditor output") };
      }
      return applyVerdict(edge, verdict);
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return batch.candidates.map((edge) => ({
      kind: "rejected" as const,
      rejected: rejectedFor(edge, `auditor call failed: ${message}`),
    }));
  }
}

/**
 * LLM auditor only — programmatic checks run in preAuditCandidates before dedupe.
 *
 * Batched by chunk. The per-candidate version re-sent the whole 24,000-char
 * chunk once for every candidate found in it: at the measured 4.1 candidates
 * per chunk that uploaded the same text 5.1 times, and CAT's worst chunk went
 * up 17.8 times. Grouping by chunk sends it once.
 */
export async function auditCandidates(
  candidates: CandidateEdge[],
  chunks: string[],
  companyName: string,
  ticker: string,
  onProgress?: (current: number, total: number) => void,
  usage?: TokenUsage,
): Promise<{ approved: CandidateEdge[]; rejected: RejectedCandidate[] }> {
  const batches = planAuditBatches(candidates, chunks);

  // Progress is still reported in candidates, not batches — the caller's
  // message says "auditing N candidates" and that number should not change.
  let done = 0;
  const results = await mapPool(batches, AUDIT_CONCURRENCY, async (batch) => {
    const outcomes = await auditBatch(batch, companyName, ticker, usage);
    done += batch.candidates.length;
    onProgress?.(done, candidates.length);
    return outcomes;
  });

  const approved: CandidateEdge[] = [];
  const rejected: RejectedCandidate[] = [];
  for (const outcomes of results) {
    for (const outcome of outcomes) {
      if (outcome.kind === "approved") approved.push(outcome.edge);
      else rejected.push(outcome.rejected);
    }
  }

  return { approved, rejected };
}
