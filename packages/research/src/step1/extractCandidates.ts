import { getConfig } from "../config.js";
import { callClaudeJson, formatAnthropicError } from "./anthropicClient.js";
import { mapPool } from "./asyncPool.js";
import { stripJsonFences } from "./normalize.js";
import { EXTRACTION_SYSTEM_PROMPT } from "./prompts.js";
import type { TokenUsage } from "./tokenUsage.js";
import type { CandidateEdge, CounterpartyType, RelationshipCategory } from "./types.js";
import { RELATIONSHIP_CATEGORIES } from "./types.js";

const CATEGORIES = new Set<string>(RELATIONSHIP_CATEGORIES);
const TYPES = new Set([
  "public_company",
  "private_company",
  "product",
  "commodity",
  "government",
  "other",
]);

function parseCandidateItem(
  item: unknown,
  chunkIndex: number,
): CandidateEdge | null {
  if (!item || typeof item !== "object") return null;
  const r = item as Record<string, unknown>;
  const name = typeof r.counterparty_name === "string" ? r.counterparty_name.trim() : "";
  const category = typeof r.category === "string" ? r.category.trim().toLowerCase() : "";
  const ctype = typeof r.counterparty_type === "string" ? r.counterparty_type.trim() : "";
  const quote = typeof r.evidence_quote === "string" ? r.evidence_quote.trim() : "";
  const confidence = typeof r.confidence === "number" ? r.confidence : Number(r.confidence);
  if (!name || !CATEGORIES.has(category) || !TYPES.has(ctype) || !quote) return null;
  if (!Number.isFinite(confidence) || confidence < 0.6) return null;

  const words = quote.split(/\s+/);
  const evidence_quote = words.length > 40 ? words.slice(0, 40).join(" ") : quote;

  let pct: number | null = null;
  if (typeof r.disclosed_revenue_dependency_pct === "number") {
    pct = r.disclosed_revenue_dependency_pct;
  } else if (r.disclosed_revenue_dependency_pct === null) {
    pct = null;
  }

  return {
    counterparty_name: name,
    counterparty_type: ctype as CounterpartyType,
    category: category as RelationshipCategory,
    subtype: typeof r.subtype === "string" ? r.subtype : "",
    disclosed_revenue_dependency_pct: pct,
    evidence_quote,
    evidence_quotes: [evidence_quote],
    confidence,
    chunk_index: chunkIndex,
  };
}

function isIgnorableJsonlLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^```(?:json)?\s*$/i.test(trimmed)) return true;
  if (trimmed === "[" || trimmed === "]" || trimmed === ",") return true;
  return false;
}

export function parseCandidateJsonl(
  raw: string,
  chunkIndex: number,
): { candidates: CandidateEdge[]; unparseableLines: number } {
  const cleaned = stripJsonFences(raw);
  const lines = cleaned.split(/\n/);

  const candidates: CandidateEdge[] = [];
  let unparseableLines = 0;

  for (const line of lines) {
    if (isIgnorableJsonlLine(line)) continue;

    const jsonLine = line.trim().replace(/,\s*$/, "");
    try {
      const item = JSON.parse(jsonLine) as unknown;
      const edge = parseCandidateItem(item, chunkIndex);
      if (edge) candidates.push(edge);
    } catch {
      unparseableLines++;
      console.warn(
        `[step1] chunk ${chunkIndex} unparseable JSONL line:`,
        jsonLine.slice(0, 100),
      );
    }
  }

  return { candidates, unparseableLines };
}

export type ExtractionResult = {
  candidates: CandidateEdge[];
  candidatesPerChunk: number[];
  apiErrors: number;
  parseErrors: number;
  lastApiError: string | null;
};

const EXTRACT_CONCURRENCY = 4;

async function extractChunk(
  chunkIndex: number,
  chunk: string,
  companyName: string,
  ticker: string,
  usage?: TokenUsage,
): Promise<{ candidates: CandidateEdge[]; unparseableLines: number; apiError: string | null }> {
  const user = `ROOT company: ${companyName} (${ticker})\n\n"""${chunk}"""`;

  const callOnce = async () =>
    callClaudeJson({
      system: EXTRACTION_SYSTEM_PROMPT,
      model: getConfig().step1ExtractModel,
      user,
      maxTokens: 12000,
      usage,
    });

  try {
    let raw = await callOnce();
    let { candidates, unparseableLines } = parseCandidateJsonl(raw, chunkIndex);

    if (candidates.length === 0) {
      console.warn(`[step1] chunk ${chunkIndex}: zero parseable lines, retrying once`);
      raw = await callOnce();
      const retry = parseCandidateJsonl(raw, chunkIndex);
      candidates = retry.candidates;
      unparseableLines += retry.unparseableLines;
    }

    return { candidates, unparseableLines, apiError: null };
  } catch (err) {
    return {
      candidates: [],
      unparseableLines: 0,
      apiError: formatAnthropicError(err),
    };
  }
}

export async function extractCandidatesFromChunks(
  chunks: string[],
  companyName: string,
  ticker: string,
  onProgress?: (current: number, total: number) => void,
  usage?: TokenUsage,
): Promise<ExtractionResult> {
  const chunkResults = await mapPool(
    chunks,
    EXTRACT_CONCURRENCY,
    (chunk, i) => extractChunk(i, chunk, companyName, ticker, usage),
    onProgress,
  );

  const candidates: CandidateEdge[] = [];
  const candidatesPerChunk: number[] = [];
  let apiErrors = 0;
  let parseErrors = 0;
  let lastApiError: string | null = null;

  for (let i = 0; i < chunkResults.length; i++) {
    const result = chunkResults[i]!;

    if (result.apiError) {
      apiErrors++;
      lastApiError = result.apiError;
      candidatesPerChunk.push(0);
      console.warn(`[step1] chunk ${i} API error:`, result.apiError);
      continue;
    }

    parseErrors += result.unparseableLines;
    candidates.push(...result.candidates);
    candidatesPerChunk.push(result.candidates.length);
    console.info(`[step1] chunk ${i}: ${result.candidates.length} candidates`);
  }

  return { candidates, candidatesPerChunk, apiErrors, parseErrors, lastApiError };
}
