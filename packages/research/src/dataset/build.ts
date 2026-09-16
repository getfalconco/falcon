/**
 * Falcon's own extraction dataset.
 *
 * Every cost change so far has been argued from token counts, because there was
 * nothing else to argue from. "Cheaper without losing quality" is a claim about
 * OUTPUT, and until now we could not check it — the only way to know whether a
 * prompt change lost a relationship was to notice it missing in production
 * weeks later.
 *
 * The material was already on disk: 58 cached extractions, ~1,700 candidates,
 * paired with the exact filing text they came from. This turns that into a
 * fixed set of (chunk → expected relationships) cases that any change can be
 * replayed against.
 *
 * Two things it deliberately is NOT. It is not ground truth — these are the
 * pipeline's own past outputs, so it measures *drift from today's behaviour*,
 * not correctness. And it is not a benchmark to maximise: a change that scores
 * 100% has changed nothing. It answers one question, which is the one we keep
 * needing: did this edit quietly stop finding things?
 */

import fs from "node:fs";
import path from "node:path";
import type { CandidateEdge } from "../step1/types.js";

export const DATASET_SCHEMA_VERSION = 1;

/** One chunk, and what the pipeline found in it. */
export type DatasetCase = {
  case_id: string;
  ticker: string;
  accession_number: string;
  chunk_index: number;
  /** The exact text sent to the model. */
  chunk: string;
  /**
   * Relationships found in this chunk. An EMPTY list is a real case, not a
   * missing one — 21% of chunks legitimately contain nothing, and a change
   * that starts inventing relationships there is exactly as broken as one that
   * stops finding them.
   */
  expected: Array<{
    counterparty_name: string;
    counterparty_type: string;
    category: string;
    evidence_quote: string;
  }>;
};

export type Dataset = {
  schema_version: number;
  built_at: string;
  /** Where the cases came from, so a stale set is obvious. */
  source: { filings: number; chunks: number; candidates: number };
  cases: DatasetCase[];
};

type CachedShape = {
  candidates?: CandidateEdge[];
  candidatesPerChunk?: number[];
  chunks?: number;
};

const CHUNK_SIZE = 24_000;
const CHUNK_STRIDE = 23_000;

/** Rebuild the chunk list exactly as the pipeline cut it. */
export function rebuildChunks(text: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += CHUNK_STRIDE) out.push(text.slice(i, i + CHUNK_SIZE));
  return out;
}

export function buildDataset(cacheDir: string): Dataset {
  const cases: DatasetCase[] = [];
  let filings = 0;
  let candidates = 0;

  const files = fs.existsSync(cacheDir)
    ? fs.readdirSync(cacheDir).filter((f) => f.endsWith(".candidates.json"))
    : [];

  for (const file of files) {
    let meta: CachedShape;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(cacheDir, file), "utf8")) as CachedShape;
    } catch {
      continue;
    }
    if (!Array.isArray(meta.candidates)) continue;

    const textFile = path.join(cacheDir, file.replace(".candidates.json", ".txt"));
    if (!fs.existsSync(textFile)) continue;

    const [ticker, ...rest] = file.split(".");
    const accession = rest.slice(0, -2).join(".");
    const chunks = rebuildChunks(fs.readFileSync(textFile, "utf8"));

    const byChunk = new Map<number, DatasetCase["expected"]>();
    for (const c of meta.candidates) {
      const idx = c.chunk_index ?? 0;
      const row = {
        counterparty_name: c.counterparty_name,
        counterparty_type: String(c.counterparty_type),
        category: String(c.category),
        evidence_quote: c.evidence_quote,
      };
      const bucket = byChunk.get(idx);
      if (bucket) bucket.push(row);
      else byChunk.set(idx, [row]);
      candidates += 1;
    }

    // Every chunk becomes a case, including the ones that found nothing.
    const chunkCount = meta.chunks ?? chunks.length;
    for (let i = 0; i < Math.min(chunkCount, chunks.length); i++) {
      const chunk = chunks[i];
      if (!chunk) continue;
      cases.push({
        case_id: `${ticker}-${i}`,
        ticker: ticker ?? "",
        accession_number: accession,
        chunk_index: i,
        chunk,
        expected: byChunk.get(i) ?? [],
      });
    }
    filings += 1;
  }

  cases.sort((a, b) => a.case_id.localeCompare(b.case_id));
  return {
    schema_version: DATASET_SCHEMA_VERSION,
    built_at: new Date().toISOString(),
    source: { filings, chunks: cases.length, candidates },
    cases,
  };
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

/** Loose match: the same counterparty, however the name was spelled that day. */
function nameKey(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^\w\s]/g, " ")
    .replace(/\b(inc|corp|corporation|ltd|limited|llc|plc|co|company|holdings|group)\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type CaseScore = {
  case_id: string;
  /** Expected relationships the run found again. */
  kept: number;
  /** Expected relationships it no longer finds — the number that matters. */
  lost: number;
  /** Relationships it found that the baseline did not. Not automatically bad. */
  added: number;
  /** Same counterparty, different category — a silent meaning change. */
  recategorised: number;
};

export type DatasetScore = {
  cases: number;
  kept: number;
  lost: number;
  added: number;
  recategorised: number;
  /** kept ÷ (kept + lost). 1.0 means nothing the baseline found went missing. */
  retention: number | null;
  /** Cases where something was lost, worst first — where to actually look. */
  regressions: CaseScore[];
};

export function scoreCase(
  expected: DatasetCase["expected"],
  actual: DatasetCase["expected"],
): CaseScore & { case_id: string } {
  const actualByName = new Map(actual.map((a) => [nameKey(a.counterparty_name), a]));
  const expectedNames = new Set(expected.map((e) => nameKey(e.counterparty_name)));

  let kept = 0;
  let lost = 0;
  let recategorised = 0;
  for (const e of expected) {
    const hit = actualByName.get(nameKey(e.counterparty_name));
    if (!hit) {
      lost += 1;
      continue;
    }
    kept += 1;
    if (hit.category !== e.category) recategorised += 1;
  }
  const added = actual.filter((a) => !expectedNames.has(nameKey(a.counterparty_name))).length;
  return { case_id: "", kept, lost, added, recategorised };
}

export function scoreDataset(
  results: Array<{ case_id: string; expected: DatasetCase["expected"]; actual: DatasetCase["expected"] }>,
): DatasetScore {
  let kept = 0;
  let lost = 0;
  let added = 0;
  let recategorised = 0;
  const regressions: CaseScore[] = [];

  for (const r of results) {
    const s = { ...scoreCase(r.expected, r.actual), case_id: r.case_id };
    kept += s.kept;
    lost += s.lost;
    added += s.added;
    recategorised += s.recategorised;
    if (s.lost > 0) regressions.push(s);
  }

  regressions.sort((a, b) => b.lost - a.lost);
  return {
    cases: results.length,
    kept,
    lost,
    added,
    recategorised,
    retention: kept + lost > 0 ? kept / (kept + lost) : null,
    regressions,
  };
}
