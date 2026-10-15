/**
 * Guidance track record: checking what the model read out of a release.
 *
 * The model (main/guidance) reads an earnings release and returns each
 * guided and reported figure as it is printed, with the sentence it came
 * from. Nothing it returns is taken on trust:
 *
 *   - the sentence has to be in the release. Matched exactly, with three
 *     allowances that change no word or figure: runs of whitespace are one
 *     space, table cell separators (the " | " the text conversion writes
 *     between cells) are a space, and curly quotes are straight. This is the
 *     rule step1 holds its evidence quotes to;
 *   - every figure has to be printed in that sentence (1,234.5 and 1234.5
 *     are the same figure; a loss printed in parentheses matches its negative;
 *     "$7.1 billion" may be returned as 7.1 billions or 7,100 millions, the
 *     same amount under the scale word printed with it);
 *   - the unit follows from the metric, a percent or per-share figure takes
 *     no scale word, and a margin outside -100% to 100% is a misread;
 *   - a guide for the quarter the release reports, or for an earlier one, is
 *     a misread: a release guides what is still ahead of it.
 *
 * A figure that fails any check is dropped; the rest of the release stands.
 * Pure: no fs, no network, no clock.
 */

import {
  GUIDANCE_METRICS,
  type ActualFigure,
  type FiscalPeriod,
  type GuidanceBasis,
  type GuidanceMetric,
  type GuidanceRelease,
  type GuidanceUnit,
  type GuideFigure,
} from "./guidance-types";

export const SCALES = { one: 1, thousand: 1e3, million: 1e6, billion: 1e9 } as const;
export type ScaleWord = keyof typeof SCALES;

/** One guided figure as the model returns it: the printed numbers, in the printed scale. */
export type RawGuide = {
  metric: string;
  basis: string;
  fiscal_year: number;
  /** 1 to 4, or 0 for the whole fiscal year. */
  fiscal_quarter: number;
  /** For a range, its ends; for a single figure or a "plus or minus" one, the figure twice. */
  low: number;
  high: number;
  /** The printed tolerance of a "plus or minus" figure; 0 when there is none. */
  plus_minus: number;
  plus_minus_kind: string;
  plus_minus_scale: string;
  scale: string;
  currency: string;
  quote: string;
};

export type RawActual = {
  metric: string;
  basis: string;
  period: string;
  value: number;
  scale: string;
  currency: string;
  quote: string;
};

export type RawExtraction = {
  reported_fiscal_year: number;
  /** 1 to 4; 0 when the release does not say. */
  reported_fiscal_quarter: number;
  guides: RawGuide[];
  actuals: RawActual[];
};

export const QUOTE_MIN = 6;
export const QUOTE_MAX = 600;

/** The release text and a quote, brought to the same spelling: whitespace, cell separators and quote marks only. */
export function matchForm(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/ /g, " ")
    .replace(/\s*\|\s*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** True when the quote is in the release (see the file note for the three allowances). */
export function quoteFound(matchText: string, quote: string): boolean {
  const q = matchForm(quote);
  if (q.length < QUOTE_MIN || q.length > QUOTE_MAX) return false;
  return matchText.includes(q);
}

export type PrintedNumber = {
  value: number;
  decimals: number;
  /** The scale word printed right after it ("7.1 billion", "$300 million"), 1 when there is none. */
  scale: number;
};

const SCALE_AFTER: ReadonlyArray<[RegExp, number]> = [
  [/^\s*(billion|bn)(?![a-z])/i, 1e9],
  [/^\s*(million|mn|mm)(?![a-z])/i, 1e6],
  [/^\s*(thousand)(?![a-z])/i, 1e3],
];

/** Every number printed in a quote, with its printed decimals and the scale word after it. */
export function printedNumbers(quote: string): PrintedNumber[] {
  const out: PrintedNumber[] = [];
  const text = matchForm(quote);
  for (const m of text.matchAll(/\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g)) {
    const raw = m[0].replace(/,/g, "");
    const value = Number(raw);
    if (!Number.isFinite(value)) continue;
    const dot = raw.indexOf(".");
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 12);
    const scale = SCALE_AFTER.find(([re]) => re.test(after))?.[1] ?? 1;
    out.push({ value, decimals: dot === -1 ? 0 : raw.length - dot - 1, scale });
  }
  return out;
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}

/**
 * Whether the quote prints `value` (in `scale`), sign aside: either as the
 * same digits ("$7.1 billion" read as 7.1 in billions, a table's "$7,658"
 * read as 7658 in millions) or as the same amount under the scale word
 * printed with it ("$7.1 billion" read as 7100 in millions). Returns the
 * precision it was printed at, in whole units; null when it is not printed.
 */
export function printedAs(quote: string, value: number, scale = 1): { step: number } | null {
  if (!Number.isFinite(value)) return null;
  const target = Math.abs(value);
  const printed = printedNumbers(quote);
  const same = printed.find((p) => near(p.value, target));
  if (same) return { step: 10 ** -same.decimals * scale };
  const amount = printed.find((p) => p.scale !== 1 && near(p.value * p.scale, target * scale));
  if (amount) return { step: 10 ** -amount.decimals * amount.scale };
  return null;
}

const METRICS: ReadonlySet<string> = new Set(GUIDANCE_METRICS);
const PERCENT_METRICS: ReadonlySet<GuidanceMetric> = new Set(["gross_margin", "operating_margin", "tax_rate"]);

export function unitOf(metric: GuidanceMetric): GuidanceUnit {
  if (PERCENT_METRICS.has(metric)) return "percent";
  if (metric === "eps") return "per_share";
  return "currency";
}

function metricOf(raw: unknown): GuidanceMetric | null {
  return typeof raw === "string" && METRICS.has(raw) ? (raw as GuidanceMetric) : null;
}

/** Revenue is one figure whatever a table's column says: a release's GAAP and non-GAAP revenue columns repeat it. */
function basisOf(raw: unknown, metric: GuidanceMetric): GuidanceBasis {
  if (metric === "revenue") return "unspecified";
  return raw === "gaap" || raw === "non_gaap" ? raw : "unspecified";
}

function scaleOf(raw: unknown): number | null {
  return typeof raw === "string" && raw in SCALES ? SCALES[raw as ScaleWord] : null;
}

function currencyOf(raw: unknown): string {
  return typeof raw === "string" && /^[A-Z]{3}$/.test(raw.trim()) ? raw.trim() : "USD";
}

function fiscalYear(raw: unknown): number | null {
  return typeof raw === "number" && Number.isInteger(raw) && raw >= 1990 && raw <= 2100 ? raw : null;
}

function periodOf(fy: unknown, fq: unknown): FiscalPeriod | null {
  const year = fiscalYear(fy);
  if (year === null || typeof fq !== "number" || !Number.isInteger(fq) || fq < 0 || fq > 4) return null;
  return { fy: year, fq: fq === 0 ? null : (fq as 1 | 2 | 3 | 4) };
}

/** Sort key: quarters in order, the whole year after its fourth quarter. */
export function periodKey(p: FiscalPeriod): number {
  return p.fy * 10 + (p.fq ?? 5);
}

export function samePeriod(a: FiscalPeriod, b: FiscalPeriod): boolean {
  return a.fy === b.fy && a.fq === b.fq;
}

/** A guide a release could not have given: its own quarter, an earlier one, or the year it closes. */
function behindRelease(period: FiscalPeriod, reported: FiscalPeriod | null): boolean {
  if (!reported || reported.fq === null) return false;
  if (period.fq === null) return period.fy < reported.fy || (period.fy === reported.fy && reported.fq === 4);
  return periodKey(period) <= periodKey(reported);
}

function plausible(unit: GuidanceUnit, ...values: number[]): boolean {
  if (unit === "percent") return values.every((v) => v >= -100 && v <= 100);
  return values.every((v) => Number.isFinite(v));
}

/** One guided figure, checked and put in whole units; null when any check fails. */
export function checkGuide(raw: RawGuide, matchText: string, reported: FiscalPeriod | null): GuideFigure | null {
  const metric = metricOf(raw?.metric);
  if (!metric) return null;
  const period = periodOf(raw.fiscal_year, raw.fiscal_quarter);
  if (!period || behindRelease(period, reported)) return null;
  const unit = unitOf(metric);
  const scale = scaleOf(raw.scale);
  if (scale === null || (unit !== "currency" && scale !== 1)) return null;
  if (typeof raw.quote !== "string" || !quoteFound(matchText, raw.quote)) return null;
  if (typeof raw.low !== "number" || typeof raw.high !== "number" || raw.low > raw.high) return null;
  const lowP = printedAs(raw.quote, raw.low, scale);
  const highP = printedAs(raw.quote, raw.high, scale);
  if (!lowP || !highP) return null;
  // Whole units from here on.
  let low = raw.low * scale;
  let high = raw.high * scale;
  const pm = typeof raw.plus_minus === "number" && raw.plus_minus > 0 ? raw.plus_minus : 0;
  if (pm > 0) {
    if (raw.low !== raw.high) return null;
    const c = low;
    if (raw.plus_minus_kind === "basis_points") {
      if (unit !== "percent") return null;
      // "plus or minus 50 basis points" may come back as 50, or already as 0.5 points.
      const bp = printedAs(raw.quote, pm) ? pm : printedAs(raw.quote, pm * 100) ? pm * 100 : null;
      if (bp === null) return null;
      low = c - bp / 100;
      high = c + bp / 100;
    } else if (raw.plus_minus_kind === "percent") {
      if (!printedAs(raw.quote, pm)) return null;
      // On a percent figure "plus or minus 1%" is a point either side; on money it is a share of the figure.
      if (unit === "percent") {
        low = c - pm;
        high = c + pm;
      } else {
        low = c - Math.abs(c) * (pm / 100);
        high = c + Math.abs(c) * (pm / 100);
      }
    } else if (raw.plus_minus_kind === "amount") {
      const pmScale = unit === "currency" ? scaleOf(raw.plus_minus_scale) : 1;
      if (pmScale === null || !printedAs(raw.quote, pm, pmScale)) return null;
      low = c - pm * pmScale;
      high = c + pm * pmScale;
    } else {
      return null;
    }
  }
  if (!plausible(unit, low, high)) return null;
  return {
    metric,
    basis: basisOf(raw.basis, metric),
    period,
    low: round(low),
    high: round(high),
    unit,
    currency: currencyOf(raw.currency),
    step: round(Math.max(lowP.step, highP.step)),
    quote: raw.quote.trim(),
  };
}

/** One reported figure, checked and put in whole units; null when any check fails. */
export function checkActual(raw: RawActual, matchText: string, reported: FiscalPeriod | null): ActualFigure | null {
  const metric = metricOf(raw?.metric);
  if (!metric || !reported || reported.fq === null) return null;
  const period: FiscalPeriod | null =
    raw.period === "quarter" ? reported : raw.period === "full_year" && reported.fq === 4 ? { fy: reported.fy, fq: null } : null;
  if (!period) return null;
  const unit = unitOf(metric);
  const scale = scaleOf(raw.scale);
  if (scale === null || (unit !== "currency" && scale !== 1)) return null;
  if (typeof raw.value !== "number" || typeof raw.quote !== "string") return null;
  if (!quoteFound(matchText, raw.quote) || !printedAs(raw.quote, raw.value, scale)) return null;
  if (!plausible(unit, raw.value)) return null;
  return {
    metric,
    basis: basisOf(raw.basis, metric),
    period,
    value: round(raw.value * scale),
    unit,
    currency: currencyOf(raw.currency),
    quote: raw.quote.trim(),
  };
}

/** Floating point noise off a product (54.0 * 1e9), without touching real decimals. */
function round(v: number): number {
  return Number(v.toPrecision(12));
}

/**
 * The model's reading of one release, checked against the release's text.
 * The first figure wins when the model returns the same one twice.
 */
export function verifyExtraction(
  raw: RawExtraction,
  text: string,
  release: { accession: string; filedAt: string; url: string },
): GuidanceRelease {
  const matchText = matchForm(text);
  const rq = raw?.reported_fiscal_quarter;
  const reported = typeof rq === "number" && rq >= 1 && rq <= 4 ? periodOf(raw.reported_fiscal_year, rq) : null;
  const guides: GuideFigure[] = [];
  const seenGuide = new Set<string>();
  for (const g of Array.isArray(raw?.guides) ? raw.guides : []) {
    const fig = checkGuide(g, matchText, reported);
    if (!fig) continue;
    const key = `${fig.metric}|${fig.basis}|${periodKey(fig.period)}`;
    if (seenGuide.has(key)) continue;
    seenGuide.add(key);
    guides.push(fig);
  }
  const actuals: ActualFigure[] = [];
  const seenActual = new Set<string>();
  for (const a of Array.isArray(raw?.actuals) ? raw.actuals : []) {
    const fig = checkActual(a, matchText, reported);
    if (!fig) continue;
    const key = `${fig.metric}|${fig.basis}|${periodKey(fig.period)}`;
    if (seenActual.has(key)) continue;
    seenActual.add(key);
    actuals.push(fig);
  }
  return { accession: release.accession, filedAt: release.filedAt, url: release.url, reported, guides, actuals };
}

function figureKey(f: { metric: string; basis: string; period: FiscalPeriod }): string {
  return `${f.metric}|${f.basis}|${periodKey(f.period)}`;
}

/**
 * Two checked readings of the same release, as one: every figure either kept,
 * the first reading's where both have it. Each figure already passed the
 * checks on its own, so the union only adds what one reading missed. A second
 * reading that places the release in another quarter adds nothing.
 */
export function mergeReadings(a: GuidanceRelease, b: GuidanceRelease): GuidanceRelease {
  const reported = a.reported ?? b.reported;
  const agree = !!a.reported && !!b.reported && samePeriod(a.reported, b.reported);
  if (!agree) return a.reported ? a : b;
  const guides = [...a.guides];
  const seenG = new Set(guides.map(figureKey));
  for (const g of b.guides) if (!seenG.has(figureKey(g))) guides.push(g);
  const actuals = [...a.actuals];
  const seenA = new Set(actuals.map(figureKey));
  for (const x of b.actuals) if (!seenA.has(figureKey(x))) actuals.push(x);
  return { ...a, reported, guides, actuals };
}
