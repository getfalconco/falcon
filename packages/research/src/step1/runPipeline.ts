import { assignEvidenceGroups } from "./evidenceGroups.js";
import { auditCandidates } from "./audit.js";
import { pingAnthropicApi, formatAnthropicError } from "./anthropicClient.js";
import {
  buildCacheKey,
  loadCachedCandidates,
  loadCachedSection,
  resolveResearchCacheDir,
  saveCachedCandidates,
  saveCachedSection,
} from "./cache.js";
import { EXTRACTION_VERSION } from "./version.js";
import { dedupeCandidates } from "./dedupe.js";
import { extractCandidatesFromChunks } from "./extractCandidates.js";
import {
  buildFilingBundle,
  chunkText,
  extractItem4Through8For20F,
  fetchFilingDocument,
  locatedAtForForm,
  resolveLatestAnnualFiling,
  type FilingBundle,
  type SectionMethod,
} from "./fetchFiling.js";
import { preAuditCandidates } from "./preAudit.js";
import { saveStep1Result, tryLoadCachedResult } from "./persist.js";
import { fractionAllCapsQuotes, sectionLooksUnusable, shouldRetry20FWithItem4 } from "./sectionSanity.js";
import { classifyEdgesStrength } from "./strength.js";
import { matchCounterpartyTicker } from "./tickerMatch.js";
import { createTokenUsage, estimateCostUsd } from "./tokenUsage.js";
import type {
  AnnualFilingForm,
  CandidateEdge,
  RejectedCandidate,
  Step1Progress,
  Step1Result,
  Step1Stats,
  StrengthTier,
  ValidatedEdge,
} from "./types.js";

export type Step1ProgressCallback = (progress: Step1Progress) => void;

export type RunPipelineOptions = {
  onProgress?: Step1ProgressCallback;
  dataDir?: string;
  cacheDir?: string;
  force?: boolean;
  /** Delay after an EDGAR document fetch (batch seeding). */
  edgarDelayMs?: number;
};

const SECTION_MIN_CHARS = 5_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toValidated(
  edge: CandidateEdge,
  ticker: string,
  sourceUrl: string,
  filingDate: string,
  form: AnnualFilingForm,
  counterpartyTicker: string | null,
  sectionMethod: SectionMethod,
  strength: { strength: number; strength_tier: StrengthTier; strength_basis: "disclosed" | "classified" },
): ValidatedEdge {
  return {
    root_ticker: ticker,
    counterparty_name: edge.counterparty_name,
    counterparty_ticker: counterpartyTicker,
    counterparty_type: edge.counterparty_type,
    category: edge.category,
    subtype: edge.subtype,
    strength: strength.strength,
    strength_tier: strength.strength_tier,
    strength_basis: strength.strength_basis,
    epistemic_label: "VERIFIED",
    confidence: edge.confidence,
    evidence: (edge.evidence_quotes?.length ? edge.evidence_quotes : [edge.evidence_quote]).map(
      (quote) => ({
        quote,
        source_url: sourceUrl,
        located_at: locatedAtForForm(form, sectionMethod),
      }),
    ),
    valid_from: filingDate,
    shared_evidence_group: "",
  };
}

function countDedupeStats(
  rejected: RejectedCandidate[],
  merged: { length: number },
): {
  droppedLowConfidence: number;
  deduped: number;
} {
  let droppedLowConfidence = 0;
  for (const r of rejected) {
    if (r.reason === "confidence below 0.6") droppedLowConfidence++;
  }
  return { droppedLowConfidence, deduped: merged.length };
}

function countAuditStats(rejected: RejectedCandidate[]): {
  rejectedByAuditor: number;
} {
  let rejectedByAuditor = 0;
  for (const r of rejected) {
    if (r.stage === "audit") rejectedByAuditor++;
  }
  return { rejectedByAuditor };
}

async function loadOrFetchFiling(
  ticker: string,
  options: RunPipelineOptions,
): Promise<{ filing: FilingBundle; edgarFetched: boolean }> {
  const cacheDir = resolveResearchCacheDir(options.cacheDir);
  const meta = await resolveLatestAnnualFiling(ticker);

  const cachedSection =
    options.force === true
      ? null
      : await loadCachedSection(meta.ticker, meta.accessionNumber, cacheDir);
  if (cachedSection) {
    const filing: FilingBundle = {
      ...meta,
      plainText: "",
      itemSpan: cachedSection.itemSpan,
      sectionMethod: cachedSection.sectionMethod as SectionMethod,
      contentSuspect: cachedSection.contentSuspect ?? false,
    };
    return { filing, edgarFetched: false };
  }

  const plainText = await fetchFilingDocument(meta);
  const filing = buildFilingBundle(meta, plainText);
  await saveCachedSection(
    meta.ticker,
    meta.accessionNumber,
    filing.itemSpan,
    filing.sectionMethod,
    plainText.length,
    cacheDir,
    filing.contentSuspect,
  );

  if (options.edgarDelayMs && options.edgarDelayMs > 0) {
    await sleep(options.edgarDelayMs);
  }

  return { filing, edgarFetched: true };
}

/**
 * Falcon deep-research step 1: 10-K Item 1/1A relationship extraction + audit.
 */
export async function runStep1Pipeline(
  ticker: string,
  options?: RunPipelineOptions,
): Promise<Step1Result> {
  const onProgress = options?.onProgress;
  const emit = (stage: string, current?: number, total?: number) => {
    onProgress?.({
      stage,
      progress: current != null && total != null ? { current, total } : null,
      done: false,
      error: null,
    });
  };

  if (!options?.force) {
    const cached = await tryLoadCachedResult(ticker, options?.dataDir);
    if (cached) {
      emit("Cached result");
      onProgress?.({
        stage: "Cached result",
        progress: null,
        done: true,
        error: null,
      });
      return cached;
    }
  }

  const tokenUsage = createTokenUsage();

  emit("Checking Anthropic API");
  try {
    await pingAnthropicApi();
  } catch (err) {
    throw new Error(formatAnthropicError(err));
  }

  emit("Fetching latest 10-K from SEC EDGAR");
  const fetchStarted = performance.now();
  let { filing } = await loadOrFetchFiling(ticker, options ?? {});
  const fetchSeconds = (performance.now() - fetchStarted) / 1000;
  const cacheKey = buildCacheKey(filing.ticker, filing.accessionNumber);
  const cacheDir = resolveResearchCacheDir(options?.cacheDir);

  // Swap a visibly unusable 20-F section BEFORE extracting it. The post-hoc
  // retry below still exists for the case only the candidates reveal, but that
  // path throws a whole extraction pass away — so anything detectable from the
  // text alone is caught here, where it costs nothing.
  if (filing.form === "20-F" && sectionLooksUnusable(filing.itemSpan)) {
    if (!filing.plainText) {
      filing = { ...filing, plainText: await fetchFilingDocument(filing) };
    }
    const upfront = extractItem4Through8For20F(filing.plainText);
    if (upfront.sectionMethod === "item4_span_20f" && upfront.text.length > SECTION_MIN_CHARS) {
      console.info(
        `[step1] 20-F ${filing.ticker}: unusable section detected before extraction — using Item 4–8 (saved one full pass)`,
      );
      emit("20-F section corrected before extraction (Item 4–8)");
      filing = {
        ...filing,
        itemSpan: upfront.text,
        sectionMethod: upfront.sectionMethod,
        contentSuspect: upfront.contentSuspect,
      };
    }
  }

  let sectionMethod = filing.sectionMethod;
  let contentSuspect = filing.contentSuspect;
  let sectionChars = filing.itemSpan.length;
  let chunks = chunkText(filing.itemSpan, 24_000, 1_000);

  let candidates: CandidateEdge[];
  let candidatesPerChunk: number[];
  let parseErrors: number;
  let apiErrors: number;

  let extractSeconds = 0;

  async function runExtraction(
    chars: number,
    chunkList: string[],
  ): Promise<{
    candidates: CandidateEdge[];
    candidatesPerChunk: number[];
    parseErrors: number;
    apiErrors: number;
    extractSeconds: number;
  }> {
    const cached = options?.force
      ? null
      : await loadCachedCandidates(
          filing.ticker,
          filing.accessionNumber,
          cacheDir,
          { sectionChars: chars, chunks: chunkList.length },
        );
    if (cached) {
      emit("Using cached extraction");
      return {
        candidates: cached.candidates,
        candidatesPerChunk: cached.candidatesPerChunk,
        parseErrors: cached.parseErrors,
        apiErrors: cached.apiErrors,
        extractSeconds: 0,
      };
    }

    emit("Extracting candidate relationships", 0, chunkList.length);
    const extractStarted = performance.now();
    const extraction = await extractCandidatesFromChunks(
      chunkList,
      filing.companyName,
      filing.ticker,
      (current, total) => {
        emit(`Extracting candidate relationships (chunk ${current}/${total})`, current, total);
      },
      tokenUsage,
    );
    const elapsed = (performance.now() - extractStarted) / 1000;

    if (chunkList.length > 0 && extraction.apiErrors === chunkList.length) {
      throw new Error(
        extraction.lastApiError ??
          `All ${chunkList.length} extraction API calls failed — check Anthropic API key, billing, and rate limits`,
      );
    }

    await saveCachedCandidates(
      filing.ticker,
      filing.accessionNumber,
      {
        extractionVersion: EXTRACTION_VERSION,
        sectionChars: chars,
        chunks: chunkList.length,
        candidates: extraction.candidates,
        candidatesPerChunk: extraction.candidatesPerChunk,
        parseErrors: extraction.parseErrors,
        apiErrors: extraction.apiErrors,
        inputTokens: tokenUsage.inputTokens,
        outputTokens: tokenUsage.outputTokens,
        cacheCreationTokens: tokenUsage.cacheCreationTokens,
        cacheReadTokens: tokenUsage.cacheReadTokens,
      },
      cacheDir,
    );

    return {
      candidates: extraction.candidates,
      candidatesPerChunk: extraction.candidatesPerChunk,
      parseErrors: extraction.parseErrors,
      apiErrors: extraction.apiErrors,
      extractSeconds: elapsed,
    };
  }

  let extractionResult = await runExtraction(sectionChars, chunks);
  extractSeconds = extractionResult.extractSeconds;
  candidates = extractionResult.candidates;
  candidatesPerChunk = extractionResult.candidatesPerChunk;
  parseErrors = extractionResult.parseErrors;
  apiErrors = extractionResult.apiErrors;

  if (
    filing.form === "20-F" &&
    candidates.length > 0 &&
    shouldRetry20FWithItem4(candidates, filing.itemSpan)
  ) {
    console.warn(
      `[step1] 20-F ${filing.ticker}: exhibit/TOC section detected (${Math.round(fractionAllCapsQuotes(candidates) * 100)}% ALL-CAPS quotes) — retrying Item 4–8 section`,
    );
    if (!filing.plainText) {
      filing = { ...filing, plainText: await fetchFilingDocument(filing) };
    }
    const alt = extractItem4Through8For20F(filing.plainText);
    if (alt.sectionMethod === "item4_span_20f" && alt.text.length > SECTION_MIN_CHARS) {
      emit("20-F section retry (Item 4–8)");
      filing = {
        ...filing,
        itemSpan: alt.text,
        sectionMethod: alt.sectionMethod,
        contentSuspect: alt.contentSuspect,
      };
      sectionMethod = alt.sectionMethod;
      contentSuspect = alt.contentSuspect;
      sectionChars = alt.text.length;
      chunks = chunkText(alt.text, 24_000, 1_000);
      extractionResult = await runExtraction(sectionChars, chunks);
      extractSeconds += extractionResult.extractSeconds;
      candidates = extractionResult.candidates;
      candidatesPerChunk = extractionResult.candidatesPerChunk;
      parseErrors = extractionResult.parseErrors;
      apiErrors = extractionResult.apiErrors;
      await saveCachedSection(
        filing.ticker,
        filing.accessionNumber,
        filing.itemSpan,
        filing.sectionMethod,
        filing.plainText.length,
        cacheDir,
        contentSuspect,
      );
    }
  }

  const sectionExtractionFailed = sectionChars < SECTION_MIN_CHARS;
  if (sectionExtractionFailed) {
    console.warn(
      `[step1] section extraction likely failed for ${filing.ticker}: only ${sectionChars} chars (expected ≥${SECTION_MIN_CHARS})`,
    );
  }

  emit("Running programmatic checks", 0, candidates.length);
  const { survivors: preAuditSurvivors, rejected: preAuditRejected } = preAuditCandidates(
    candidates,
    chunks,
  );

  const { kept, rejected: dedupeRejected, merged } = dedupeCandidates(preAuditSurvivors);
  const dedupeCounts = countDedupeStats(dedupeRejected, merged);

  emit("Auditing candidates", 0, kept.length);
  const auditStarted = performance.now();
  const { approved, rejected: auditRejected } = await auditCandidates(
    kept,
    chunks,
    filing.companyName,
    filing.ticker,
    (current, total) => {
      emit(`Auditing candidates (${current}/${total})`, current, total);
    },
    tokenUsage,
  );
  const auditSeconds = (performance.now() - auditStarted) / 1000;
  const auditCounts = countAuditStats(auditRejected);
  const allRejected = [...preAuditRejected, ...dedupeRejected, ...auditRejected];
  const rejectedQuoteNotFound = allRejected.filter((r) => r.stage === "quote_check").length;

  emit("Classifying edge strength", 0, approved.length);
  const strengthResults = await classifyEdgesStrength(
    approved.map((edge) => ({
      counterparty_name: edge.counterparty_name,
      category: edge.category,
      subtype: edge.subtype,
      disclosed_revenue_dependency_pct: edge.disclosed_revenue_dependency_pct,
      evidence_quote: edge.evidence_quote,
    })),
    (current, total) => {
      emit(`Classifying edge strength (${current}/${total})`, current, total);
    },
    tokenUsage,
  );

  const validatedRaw: ValidatedEdge[] = [];
  for (let i = 0; i < approved.length; i++) {
    const edge = approved[i]!;
    const strength = strengthResults[i]!;
    let counterpartyTicker: string | null = null;
    if (edge.counterparty_type === "public_company") {
      counterpartyTicker = await matchCounterpartyTicker(edge.counterparty_name);
    }
    validatedRaw.push(
      toValidated(
        edge,
        filing.ticker,
        filing.sourceUrl,
        filing.filingDate,
        filing.form,
        counterpartyTicker,
        sectionMethod,
        strength,
      ),
    );
  }

  const validated = assignEvidenceGroups(validatedRaw);
  const estimatedCost = estimateCostUsd(tokenUsage);

  const stats: Step1Stats = {
    form_type: filing.form,
    filing_date: filing.filingDate,
    section_chars: sectionChars,
    section_method: sectionMethod,
    section_extraction_failed: sectionExtractionFailed,
    content_suspect: contentSuspect,
    chunks: chunks.length,
    api_errors: apiErrors,
    parse_errors: parseErrors,
    candidates_extracted: candidates.length,
    candidates_per_chunk: candidatesPerChunk,
    dropped_low_confidence: dedupeCounts.droppedLowConfidence,
    deduped: dedupeCounts.deduped,
    rejected_quote_not_found: rejectedQuoteNotFound,
    rejected_by_auditor: auditCounts.rejectedByAuditor,
    validated: validated.length,
    input_tokens: tokenUsage.inputTokens,
    output_tokens: tokenUsage.outputTokens,
    estimated_cost_usd: estimatedCost,
    fetch_seconds: Math.round(fetchSeconds * 10) / 10,
    extract_seconds: Math.round(extractSeconds * 10) / 10,
    audit_seconds: Math.round(auditSeconds * 10) / 10,
  };

  const result: Step1Result = {
    ticker: filing.ticker,
    companyName: filing.companyName,
    form: filing.form,
    filingDate: filing.filingDate,
    sourceUrl: filing.sourceUrl,
    validated,
    rejected: allRejected,
    merged,
    stats,
    generatedAt: new Date().toISOString(),
    cacheKey,
    accessionNumber: filing.accessionNumber,
    fromCache: false,
  };

  await saveStep1Result(result, options?.dataDir);

  onProgress?.({
    stage: "done",
    progress: null,
    done: true,
    error: null,
  });

  return result;
}

/** @deprecated Prefer runStep1Pipeline — kept for research-worker import name. */
export async function runFalconPipeline(
  _openai: unknown,
  companyOrTicker: string,
  onProgress?: (event: { type: string; [key: string]: unknown }) => void,
): Promise<Step1Result | null> {
  const ticker = companyOrTicker.trim().split(/\s+/).pop() ?? companyOrTicker;
  try {
    return await runStep1Pipeline(ticker, {
      onProgress: (p) => {
        onProgress?.({
          type: p.done ? "done" : p.error ? "error" : "phase",
          label: p.stage,
          message: p.error ?? undefined,
          progress: p.progress,
        });
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ type: "error", message });
    return null;
  }
}
