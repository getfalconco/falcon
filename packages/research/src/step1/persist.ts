import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import path from "node:path";
import type { MergedCandidate, RejectedCandidate, Step1Result, Step1Stats, ValidatedEdge } from "./types.js";
import { buildCacheKey } from "./cache.js";
import { resolveLatestAnnualFiling } from "./fetchFiling.js";

export function resolveResearchDataDir(baseDir?: string): string {
  if (baseDir) return baseDir;
  if (process.env.FALCON_RESEARCH_DATA_DIR) return process.env.FALCON_RESEARCH_DATA_DIR;
  return path.resolve(process.cwd(), "data", "research");
}

export async function saveStep1Result(
  result: Step1Result,
  dataDir?: string,
): Promise<{ validatedPath: string; rejectedPath: string }> {
  const dir = resolveResearchDataDir(dataDir);
  await mkdir(dir, { recursive: true });
  const ticker = result.ticker.toUpperCase();
  const validatedPath = path.join(dir, `${ticker}.json`);
  const rejectedPath = path.join(dir, `${ticker}.rejected.json`);

  await writeFile(validatedPath, JSON.stringify(result.validated, null, 2), "utf8");
  await writeFile(rejectedPath, JSON.stringify(result.rejected, null, 2), "utf8");
  await writeFile(
    path.join(dir, `${ticker}.merged.json`),
    JSON.stringify(result.merged, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(dir, `${ticker}.meta.json`),
    JSON.stringify(
      {
        ticker: result.ticker,
        companyName: result.companyName,
        form: result.form,
        filingDate: result.filingDate,
        sourceUrl: result.sourceUrl,
        generatedAt: result.generatedAt,
        cacheKey: result.cacheKey,
        accessionNumber: result.accessionNumber,
        validatedCount: result.validated.length,
        rejectedCount: result.rejected.length,
        mergedCount: result.merged.length,
      },
      null,
      2,
    ),
    "utf8",
  );
  await writeFile(
    path.join(dir, `${ticker}.stats.json`),
    JSON.stringify(result.stats, null, 2),
    "utf8",
  );

  return { validatedPath, rejectedPath };
}

export async function loadStep1Result(
  ticker: string,
  dataDir?: string,
): Promise<Step1Result | null> {
  const dir = resolveResearchDataDir(dataDir);
  const upper = ticker.trim().toUpperCase();
  try {
    const validatedRaw = await readFile(path.join(dir, `${upper}.json`), "utf8");
    const rejectedRaw = await readFile(path.join(dir, `${upper}.rejected.json`), "utf8").catch(
      () => "[]",
    );
    const mergedRaw = await readFile(path.join(dir, `${upper}.merged.json`), "utf8").catch(
      () => "[]",
    );
    const metaRaw = await readFile(path.join(dir, `${upper}.meta.json`), "utf8").catch(
      () => null,
    );
    const validated = JSON.parse(validatedRaw) as ValidatedEdge[];
    const rejected = JSON.parse(rejectedRaw) as RejectedCandidate[];
    const merged = JSON.parse(mergedRaw) as MergedCandidate[];
    const meta = metaRaw
      ? (JSON.parse(metaRaw) as {
          companyName?: string;
          form?: "10-K" | "20-F";
          filingDate?: string;
          sourceUrl?: string;
          generatedAt?: string;
          cacheKey?: string;
          accessionNumber?: string;
        })
      : {};

    const statsRaw = await readFile(path.join(dir, `${upper}.stats.json`), "utf8").catch(
      () => null,
    );
    const statsFromFile = statsRaw ? (JSON.parse(statsRaw) as Step1Stats) : null;
    const form = meta.form || statsFromFile?.form_type || "10-K";
    const filingDate = meta.filingDate || statsFromFile?.filing_date || "";

    const stats: Step1Stats = statsFromFile ?? {
      form_type: form,
      filing_date: filingDate,
      section_chars: 0,
      section_method: "fallback_60pct",
      section_extraction_failed: false,
      chunks: 0,
      api_errors: 0,
      parse_errors: 0,
      candidates_extracted: 0,
      candidates_per_chunk: [],
      dropped_low_confidence: rejected.filter((r) => r.reason === "confidence below 0.6").length,
      deduped: merged.length,
      rejected_quote_not_found: rejected.filter((r) => r.stage === "quote_check").length,
      rejected_by_auditor: rejected.filter((r) => r.stage === "audit").length,
      validated: validated.length,
    };

    return {
      ticker: upper,
      companyName: meta.companyName ?? upper,
      form,
      filingDate,
      sourceUrl: meta.sourceUrl ?? "",
      validated,
      rejected,
      merged,
      stats,
      generatedAt: meta.generatedAt ?? "",
      cacheKey: meta.cacheKey,
      accessionNumber: meta.accessionNumber,
    };
  } catch {
    return null;
  }
}

export async function tryLoadCachedResult(
  ticker: string,
  dataDir?: string,
): Promise<Step1Result | null> {
  const loaded = await loadStep1Result(ticker, dataDir);
  if (!loaded?.cacheKey) return null;

  const dir = resolveResearchDataDir(dataDir);
  const upper = ticker.trim().toUpperCase();
  try {
    await access(path.join(dir, `${upper}.json`));
  } catch {
    return null;
  }

  try {
    const meta = await resolveLatestAnnualFiling(upper);
    const expectedKey = buildCacheKey(meta.ticker, meta.accessionNumber);
    if (loaded.cacheKey !== expectedKey) return null;
    return { ...loaded, fromCache: true };
  } catch {
    return null;
  }
}
