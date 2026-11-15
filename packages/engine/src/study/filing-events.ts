/**
 * Event samples from the EDGAR full index for the events-v1 study
 * (data/preregistration/events-v1.json): late-filing notices (NT 10-K /
 * NT 10-Q), initial Schedule 13D stakes and 8-K item 4.02 restatements, plus
 * the pre-registered pass bar. Pure; the runner is scripts/events-study.ts.
 */

import { tOneSidedP } from "./stats.ts";
import type { StudySummary } from "./abnormal.ts";

/** One row of an EDGAR full-index master.idx: CIK|Company Name|Form Type|Date Filed|Filename. */
export type IndexRow = { cik: string; name: string; form: string; date: string; accession: string };

/**
 * Rows of a master.idx whose form type is in `forms` (exact match, so "/A"
 * amendments are left out unless listed). CIKs without leading zeros. Pure.
 */
export function parseMasterIndex(text: string, forms: ReadonlySet<string>): IndexRow[] {
  const out: IndexRow[] = [];
  for (const line of text.split("\n")) {
    const parts = line.split("|");
    if (parts.length !== 5) continue;
    const form = parts[2]!.trim();
    if (!forms.has(form)) continue;
    const date = parts[3]!.trim();
    const acc = /(\d{10}-\d{2}-\d{6})\.txt\s*$/.exec(parts[4]!)?.[1];
    if (!acc || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({ cik: String(Number(parts[0]!.trim())), name: parts[1]!.trim(), form, date, accession: acc });
  }
  return out;
}

/** Rows grouped by accession (an accession appears once per CIK it involves). Pure. */
export function byAccession(rows: readonly IndexRow[]): Map<string, IndexRow[]> {
  const out = new Map<string, IndexRow[]>();
  for (const r of rows) {
    let a = out.get(r.accession);
    if (!a) out.set(r.accession, (a = []));
    if (!a.some((x) => x.cik === r.cik)) a.push(r);
  }
  return out;
}

export type SubjectRead =
  | { kind: "subject"; cik: string }
  | { kind: "self_filed" }
  | { kind: "no_listed_cik" }
  | { kind: "ambiguous"; ciks: string[] };

/**
 * The subject company of a Schedule 13D from the CIKs its accession lists
 * (events-v1 F8): at least two CIKs (else the issuer filed it itself, or the
 * subject is not on EDGAR), exactly one of them with a ticker; several with
 * a ticker need the SEC header. Pure.
 */
export function subjectOf13D(ciks: readonly string[], hasTicker: (cik: string) => boolean): SubjectRead {
  const uniq = [...new Set(ciks)];
  if (uniq.length < 2) return { kind: "self_filed" };
  const listed = uniq.filter(hasTicker);
  if (listed.length === 0) return { kind: "no_listed_cik" };
  if (listed.length === 1) return { kind: "subject", cik: listed[0]! };
  return { kind: "ambiguous", ciks: listed };
}

/** SUBJECT COMPANY and FILED BY CIKs from an SEC header (.hdr.sgml or -index-headers.html). Pure. */
export function headerParties(header: string): { subject: string | null; filers: string[] } {
  const t = header.replace(/&lt;/g, "<").replace(/&gt;/g, ">");
  const cikAfter = (label: RegExp): string[] => {
    const out: string[] = [];
    const re = new RegExp(`${label.source}[\\s\\S]*?CENTRAL INDEX KEY:\\s*(\\d+)`, "g");
    for (const m of t.matchAll(re)) out.push(String(Number(m[1])));
    return out;
  };
  return { subject: cikAfter(/SUBJECT COMPANY:/)[0] ?? null, filers: cikAfter(/FILED BY:/) };
}

const DAY_MS = 86_400_000;

/**
 * One event per issuer per `days` calendar days: items in date order, an
 * item within `days` of the issuer's previous kept event is a duplicate.
 * Pure; returns the kept items in date order and the number dropped.
 */
export function dedupeByIssuer<T extends { issuer: string; date: string }>(items: readonly T[], days = 30): { kept: T[]; dropped: number } {
  const sorted = [...items].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const last = new Map<string, number>();
  const kept: T[] = [];
  let dropped = 0;
  for (const x of sorted) {
    const t = Date.parse(`${x.date}T00:00:00Z`);
    const prev = last.get(x.issuer);
    if (prev !== undefined && t - prev < days * DAY_MS) {
      dropped++;
      continue;
    }
    last.set(x.issuer, t);
    kept.push(x);
  }
  return { kept, dropped };
}

/**
 * Whether an issuer was exchange-listed at the event although it is not
 * today: a Form 25 / 25-NSE (sorted dates) filed after the event date. Pure.
 */
export function delistedAfter(form25Dates: readonly string[] | undefined, eventDate: string): boolean {
  return !!form25Dates?.some((d) => d > eventDate);
}

/** Item codes of an efts record ("4.02") include 4.02. Pure. */
export function hasItem402(items: readonly string[] | null | undefined): boolean {
  return !!items?.some((i) => i.trim() === "4.02");
}

// ---------------------------------------------------------------------------
// Pass bar (events-v1 passBar, the F7 bar)

export const PASS_BAR = { maxOneSidedP: 0.05, minN: 100 } as const;

/** One-sided p of a t statistic in the expected direction (H1: mean has sign `expected`). Pure. */
export function oneSidedPIn(t: number, df: number, expected: 1 | -1): number {
  return tOneSidedP(expected * t, df);
}

export type BarRead = {
  pass: boolean;
  /** Why it failed, plain phrases; empty when it passed. */
  why: string[];
  pTwoWay: number;
  pDate: number;
};

/** The pre-registered pass bar on the primary summary (beta x SPY, L = 20). Pure. */
export function passesBar(s: StudySummary | null, expected: 1 | -1, bar = PASS_BAR): BarRead {
  if (!s) return { pass: false, why: ["no measured events"], pTwoWay: 1, pDate: 1 };
  const pTwoWay = oneSidedPIn(s.twoWay.t, s.twoWay.df, expected);
  const pDate = oneSidedPIn(s.byDate.t, s.byDate.df, expected);
  const why: string[] = [];
  if (!(Math.sign(s.mean) === expected)) why.push(`mean ${s.mean.toFixed(2)} is not ${expected > 0 ? "above" : "below"} 0`);
  if (!(pTwoWay < bar.maxOneSidedP)) why.push(`two-way one-sided p ${pTwoWay.toFixed(3)} >= ${bar.maxOneSidedP}`);
  if (!(pDate < bar.maxOneSidedP)) why.push(`date-clustered one-sided p ${pDate.toFixed(3)} >= ${bar.maxOneSidedP}`);
  if (!(s.n >= bar.minN)) why.push(`n ${s.n} < ${bar.minN}`);
  return { pass: why.length === 0, why, pTwoWay, pDate };
}
