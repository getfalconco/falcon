/**
 * One filing's HTML, read: the digest Filing changes keeps for good, and
 * the plain text of an annual report for name searches. The heavy part of
 * Filing changes (a 10-K of ten megabytes reads in about half a second), so
 * it runs in a worker thread (parse-worker.ts) and here, on the calling
 * thread, only when the worker cannot start.
 *
 * Pure: no Electron, no disk, no clock.
 */

import { searchableText } from "./diff";
import {
  auditorName,
  concentrationFacts,
  findSection,
  goingConcernSentence,
  materialWeaknessSentence,
  readDocument,
  riskHeadings,
  riskReadability,
  saysNoMaterialChanges,
  sectionText,
  soleSourceSentences,
  type ConcentrationFact,
  type RiskHeading,
} from "./parse";

/**
 * Bumped when the parser changes what a digest holds: older digests are read again.
 * 3: risk factors located through the table of contents, and guarded (`riskStatus`).
 * 4: customer concentration read from tables too, latest year only, unnamed shares compared by size.
 */
export const DIGEST_VERSION = 4;

/**
 * What the risk factors reader made of a filing:
 *   found       a section and its headings (none for a 10-Q that only refers back)
 *   missing     no risk factors section was found
 *   unreadable  a section was found but what it holds does not read as risk
 *               factors (parse.ts riskReadability): no heading, no section
 *               link and no "no material changes" reading is kept from it
 */
export type RiskStatus = "found" | "missing" | "unreadable";

/** The submissions index's entry for one filing (agents/sources.ts FilingRef). */
export type FilingLike = {
  cik: string;
  form: string;
  accession: string;
  filedAt: string;
  items: string[];
  primaryDocument: string | null;
  url: string;
};

/** What one filing says, read once and kept. */
export type FilingDigest = {
  v: number;
  accession: string;
  form: string;
  filedAt: string;
  url: string;
  anchor: string | null;
  /** `riskStatus === "found"`. */
  riskFound: boolean;
  riskStatus: RiskStatus;
  headings: RiskHeading[];
  noMaterialChanges: boolean;
  goingConcern: string | null;
  materialWeakness: string | null;
  auditor: string | null;
  concentration: ConcentrationFact[];
  soleSource: string[];
};

const ANNUAL_FORMS = new Set(["10-K", "10-KT", "10-K405", "20-F"]);

export function isAnnual(form: string): boolean {
  return ANNUAL_FORMS.has(form);
}

/** Reads one filing's HTML into a digest and its plain text. Pure. */
export function digestOf(filing: FilingLike, html: string): { digest: FilingDigest; text: string } {
  const doc = readDocument(html);
  const { blocks } = doc;
  const text = blocks.map((b) => b.text).join("\n");
  const annual = isAnnual(filing.form);
  const located = findSection(doc, "risk");
  const headings = located ? riskHeadings(blocks, located) : [];
  // Characters of block text, counted as Section.chars counts them (no line breaks).
  const totalChars = text.length - Math.max(0, blocks.length - 1);
  const riskStatus: RiskStatus = !located ? "missing" : riskReadability(located, headings, totalChars, annual).readable ? "found" : "unreadable";
  const risk = riskStatus === "found" ? located : null;
  const controls = findSection(doc, "controls");
  const riskText = sectionText(blocks, risk);
  return {
    text,
    digest: {
      v: DIGEST_VERSION,
      accession: filing.accession,
      form: filing.form,
      filedAt: filing.filedAt,
      url: filing.url,
      anchor: risk?.anchor ?? null,
      riskFound: riskStatus === "found",
      riskStatus,
      headings: risk ? headings : [],
      noMaterialChanges: saysNoMaterialChanges(riskText),
      goingConcern: goingConcernSentence(text),
      materialWeakness: materialWeaknessSentence(sectionText(blocks, controls)),
      auditor: annual ? auditorName(html, text) : null,
      concentration: annual ? concentrationFacts(text, blocks) : [],
      soleSource: annual ? soleSourceSentences(text) : [],
    },
  };
}

/** What a read hands back: the digest, and the searchable text (diff.ts) when asked for. */
export type ReadFiling = { digest: FilingDigest; searchable: string | null };

/** The whole read, as the worker runs it. Pure. */
export function readFiling(filing: FilingLike, html: string, keepText: boolean): ReadFiling {
  const { digest, text } = digestOf(filing, html);
  return { digest, searchable: keepText ? searchableText(text) : null };
}
