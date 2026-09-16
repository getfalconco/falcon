import type { CandidateEdge } from "./types.js";

const COMPET_EXTEND = 100_000;

/** /compet/i plus supplier|customer — used for content-suspect badge. */
export function countContentSignals(text: string): number {
  const compet = (text.match(/compet/gi) ?? []).length;
  const trade = (text.match(/supplier|customer/gi) ?? []).length;
  return compet + trade;
}

export function countCompetMentions(text: string): number {
  return (text.match(/compet/gi) ?? []).length;
}

/**
 * Extend end if content signals are sparse; flag contentSuspect if still failing.
 * Proceeds either way (badge only).
 */
export function applyCompetSanity(
  fullText: string,
  start: number,
  end: number,
): { text: string; end: number; contentSuspect: boolean } {
  let currentEnd = Math.min(end, fullText.length);
  let slice = fullText.slice(start, currentEnd);
  if (countContentSignals(slice) >= 2) {
    return { text: slice.trim(), end: currentEnd, contentSuspect: false };
  }

  currentEnd = Math.min(currentEnd + COMPET_EXTEND, fullText.length);
  slice = fullText.slice(start, currentEnd);
  const ok = countContentSignals(slice) >= 2;
  if (!ok) {
    console.warn(
      `[step1] section has ${countContentSignals(slice)} content signals ` +
        `(compet/supplier/customer; expected ≥2); flagging content suspect`,
    );
  }
  return { text: slice.trim(), end: currentEnd, contentSuspect: !ok };
}

export function isAllCapsExhibitLine(line: string): boolean {
  const letters = line.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 8) return false;
  const upper = (line.match(/[A-Z]/g) ?? []).length;
  return upper / letters.length >= 0.85;
}

export function fractionAllCapsQuotes(candidates: CandidateEdge[]): number {
  if (candidates.length === 0) return 0;
  const caps = candidates.filter((c) => isAllCapsExhibitLine(c.evidence_quote)).length;
  return caps / candidates.length;
}

/** Fraction of non-empty lines that look like exhibit headers (ALL-CAPS). */
export function fractionAllCapsLines(text: string): number {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
  if (lines.length === 0) return 0;
  const caps = lines.filter((l) => isAllCapsExhibitLine(l)).length;
  return caps / lines.length;
}

/** TOC pages list multiple item headings with page numbers in quick succession. */
export function isTocLikeSection(head: string): boolean {
  const sample = head.slice(0, 2_000);
  return /item\s*3\b[\s\S]{0,120}item\s*4\b[\s\S]{0,120}item\s*5\b/i.test(sample);
}

export function shouldRetry20FWithItem4(
  candidates: CandidateEdge[],
  sectionText: string,
): boolean {
  if (fractionAllCapsQuotes(candidates) > 0.3) return true;
  if (fractionAllCapsLines(sectionText) > 0.3) return true;
  if (isTocLikeSection(sectionText)) return true;
  return false;
}

/**
 * Can we tell the section is wrong BEFORE spending anything on it?
 *
 * `shouldRetry20FWithItem4` answers the same question but needs candidates, so
 * by the time it says yes the filing has already been extracted once and that
 * whole pass is discarded. Two of its three signals — all-caps line ratio and
 * the TOC shape — read the section text alone, so they can run first.
 *
 * Measured over the cached extractions, 16 of 58 filings burned 2–5.5x the
 * median tokens, and re-extraction is the largest part of that. Moving the
 * cheap half of the check upstream is what stops paying for a pass we already
 * know will be thrown away.
 */
export function sectionLooksUnusable(sectionText: string): boolean {
  if (fractionAllCapsLines(sectionText) > 0.3) return true;
  if (isTocLikeSection(sectionText)) return true;
  return false;
}
