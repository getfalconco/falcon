import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CandidateEdge } from "./types.js";
import { EXTRACTION_VERSION, PIPELINE_VERSION } from "./version.js";

export function buildCacheKey(ticker: string, accessionNumber: string): string {
  return `${ticker.trim().toUpperCase()}|${accessionNumber}|${PIPELINE_VERSION}`;
}

export function cacheFileBase(ticker: string, accessionNumber: string): string {
  const upper = ticker.trim().toUpperCase();
  const safeAccession = accessionNumber.replace(/[^\w.-]/g, "_");
  return `${upper}.${safeAccession}`;
}

export function resolveResearchCacheDir(baseDir?: string): string {
  if (baseDir) return baseDir;
  if (process.env.FALCON_RESEARCH_CACHE_DIR) return process.env.FALCON_RESEARCH_CACHE_DIR;
  return path.resolve(process.cwd(), "data", "cache");
}

export function sectionCachePath(
  ticker: string,
  accessionNumber: string,
  cacheDir?: string,
): string {
  const dir = resolveResearchCacheDir(cacheDir);
  return path.join(dir, `${cacheFileBase(ticker, accessionNumber)}.txt`);
}

export function candidatesCachePath(
  ticker: string,
  accessionNumber: string,
  cacheDir?: string,
): string {
  const dir = resolveResearchCacheDir(cacheDir);
  return path.join(dir, `${cacheFileBase(ticker, accessionNumber)}.candidates.json`);
}

export type CachedSection = {
  itemSpan: string;
  sectionMethod: string;
  plainTextLength: number;
  contentSuspect?: boolean;
};

export async function loadCachedSection(
  ticker: string,
  accessionNumber: string,
  cacheDir?: string,
): Promise<CachedSection | null> {
  try {
    const raw = await readFile(sectionCachePath(ticker, accessionNumber, cacheDir), "utf8");
    const newline = raw.indexOf("\n");
    if (newline < 0) return null;
    const header = JSON.parse(raw.slice(0, newline)) as {
      sectionMethod?: string;
      plainTextLength?: number;
      pipelineVersion?: number;
      contentSuspect?: boolean;
    };
    if (header.pipelineVersion !== PIPELINE_VERSION) return null;
    const itemSpan = raw.slice(newline + 1);
    if (!itemSpan.trim()) return null;
    return {
      itemSpan,
      sectionMethod: header.sectionMethod ?? "fallback_60pct",
      plainTextLength: header.plainTextLength ?? 0,
      contentSuspect: header.contentSuspect ?? false,
    };
  } catch {
    return null;
  }
}

export async function saveCachedSection(
  ticker: string,
  accessionNumber: string,
  itemSpan: string,
  sectionMethod: string,
  plainTextLength: number,
  cacheDir?: string,
  contentSuspect = false,
): Promise<void> {
  const dir = resolveResearchCacheDir(cacheDir);
  await mkdir(dir, { recursive: true });
  const header = JSON.stringify({
    sectionMethod,
    plainTextLength,
    pipelineVersion: PIPELINE_VERSION,
    contentSuspect,
  });
  await writeFile(
    sectionCachePath(ticker, accessionNumber, cacheDir),
    `${header}\n${itemSpan}`,
    "utf8",
  );
}

export type CachedCandidates = {
  extractionVersion: number;
  sectionChars: number;
  chunks: number;
  candidates: CandidateEdge[];
  candidatesPerChunk: number[];
  parseErrors: number;
  apiErrors: number;
  inputTokens: number;
  outputTokens: number;
  /**
   * Cache spend, recorded separately because a write costs 1.25x and a read
   * 0.1x — folding either into `inputTokens` hides exactly the mistake this
   * field exists to catch. Optional: records written before cache accounting
   * existed have neither.
   */
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
};

export async function loadCachedCandidates(
  ticker: string,
  accessionNumber: string,
  cacheDir?: string,
  expected?: { sectionChars: number; chunks: number },
): Promise<CachedCandidates | null> {
  try {
    const raw = await readFile(candidatesCachePath(ticker, accessionNumber, cacheDir), "utf8");
    const parsed = JSON.parse(raw) as CachedCandidates;
    if (parsed.extractionVersion !== EXTRACTION_VERSION) return null;
    if (!Array.isArray(parsed.candidates)) return null;
    if (expected) {
      if (parsed.sectionChars !== expected.sectionChars) return null;
      if (parsed.chunks !== expected.chunks) return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function saveCachedCandidates(
  ticker: string,
  accessionNumber: string,
  data: CachedCandidates,
  cacheDir?: string,
): Promise<void> {
  const dir = resolveResearchCacheDir(cacheDir);
  await mkdir(dir, { recursive: true });
  await writeFile(
    candidatesCachePath(ticker, accessionNumber, cacheDir),
    JSON.stringify({ ...data, extractionVersion: EXTRACTION_VERSION }, null, 2),
    "utf8",
  );
}

export type Step1Meta = {
  ticker?: string;
  companyName?: string;
  form?: "10-K" | "20-F";
  filingDate?: string;
  sourceUrl?: string;
  generatedAt?: string;
  cacheKey?: string;
  accessionNumber?: string;
  validatedCount?: number;
  rejectedCount?: number;
  mergedCount?: number;
};
