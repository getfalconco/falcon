/**
 * Guidance track record: what a company's earnings releases said the next
 * period would bring, against what the release for that period then reported.
 *
 * Every figure comes from an SEC filing: the press release exhibit (EX-99.1)
 * of an 8-K with item 2.02, read once per accession by the main process
 * (main/guidance). A figure is kept only when the sentence it was read from
 * is found in the exhibit's text, so each one carries that sentence and the
 * exhibit's address. The comparison itself is deterministic
 * (shared/guidance-track.ts).
 *
 *   stocktab:guidance        ticker   the track record for one company
 *   stocktab:guidancePeek    ticker   the same from disk only (no EDGAR read, no model call)
 */

/** What a company guides, in the order the table lists them. */
export const GUIDANCE_METRICS = [
  "revenue",
  "gross_margin",
  "operating_expenses",
  "operating_income",
  "operating_margin",
  "eps",
  "net_income",
  "tax_rate",
  "other_income",
  "ebitda",
  "capex",
  "free_cash_flow",
] as const;

export type GuidanceMetric = (typeof GUIDANCE_METRICS)[number];

/** As the release labels the figure; "unspecified" when it gives no label (revenue, mostly). */
export type GuidanceBasis = "gaap" | "non_gaap" | "unspecified";

/** Currency figures are in whole units (dollars), percent figures in percent (74.5 is 74.5%), per share in currency per share. */
export type GuidanceUnit = "currency" | "percent" | "per_share";

/** A fiscal quarter, or the whole fiscal year when `fq` is null. As the company numbers its fiscal years. */
export type FiscalPeriod = { fy: number; fq: 1 | 2 | 3 | 4 | null };

/** One guided figure, as read from one release. A single figure ("approximately 17%") has low = high. */
export type GuideFigure = {
  metric: GuidanceMetric;
  basis: GuidanceBasis;
  period: FiscalPeriod;
  low: number;
  high: number;
  unit: GuidanceUnit;
  currency: string;
  /** The precision the figure was printed at, in the same units (0.1e9 for "$9.2 billion", 0.01 for "85.95%"). */
  step: number;
  /** The sentence it was read from, exactly as the exhibit prints it. */
  quote: string;
};

/** One reported figure, as read from one release. */
export type ActualFigure = {
  metric: GuidanceMetric;
  basis: GuidanceBasis;
  period: FiscalPeriod;
  value: number;
  unit: GuidanceUnit;
  currency: string;
  quote: string;
};

/** One earnings release, read and checked. */
export type GuidanceRelease = {
  accession: string;
  /** The 8-K's filing date, YYYY-MM-DD. */
  filedAt: string;
  /** The press release exhibit on SEC.gov. */
  url: string;
  /** The fiscal quarter the release reports; null when it could not be read. */
  reported: FiscalPeriod | null;
  guides: GuideFigure[];
  actuals: ActualFigure[];
};

export type GuidancePosition = "above" | "inside" | "below";
export type GuidanceRevision = "raised" | "cut" | "kept";

/** Where a figure was read: the sentence, the exhibit, the filing date. */
export type GuidanceSource = { quote: string; url: string; filedAt: string };

/** A guided figure for one period, against what was reported for that period. */
export type GuidanceRow = {
  period: FiscalPeriod;
  metric: GuidanceMetric;
  /** "both" when the GAAP and non-GAAP guides and results were the same figures. */
  basis: GuidanceBasis | "both";
  unit: GuidanceUnit;
  currency: string;
  low: number;
  high: number;
  mid: number;
  /** A single figure rather than a range. */
  point: boolean;
  /**
   *   resolved  the period was reported and the figure read
   *   open      no release in the window reports the period yet
   *   missing   the period's release is in the window but states no such figure
   */
  state: "resolved" | "open" | "missing";
  actual: number | null;
  position: GuidancePosition | null;
  /** Actual against the midpoint: a fraction of it for money, percentage points for percent figures. */
  gap: number | null;
  /** Against the guide the company gave for the same period in an earlier release, when it gave one. */
  revision: GuidanceRevision | null;
  prior: { low: number; high: number; filedAt: string } | null;
  guide: GuidanceSource;
  reported: GuidanceSource | null;
};

/** How one guided figure has landed against its guide, over the quarters in the window. */
export type GuidancePattern = {
  metric: GuidanceMetric;
  basis: GuidanceBasis | "both";
  /** Quarters with a guide and a reported figure. */
  n: number;
  above: number;
  inside: number;
  below: number;
  /** At or above the guide's midpoint. */
  atOrAboveMid: number;
  medianGap: number | null;
  gapKind: "relative" | "points";
  /** Every guide in the sample was a single figure. */
  point: boolean;
};

export type GuidanceTrack = {
  ticker: string;
  /** Item 2.02 releases read. */
  releases: number;
  /** The newest release read, YYYY-MM-DD. */
  latest: string | null;
  rows: GuidanceRow[];
  patterns: GuidancePattern[];
};

export type GuidanceTrackResult =
  | { ok: true; track: GuidanceTrack }
  | { ok: false; error: "invalid_request" | "unavailable" };

/**
 * stocktab:guidancePeek: the track record from what main already keeps on
 * disk, never a fresh read (for views that must not start one, the Calendar
 * tab's event card). `track` is null when nothing for the company is kept.
 */
export type GuidancePeekResult =
  | { ok: true; track: GuidanceTrack | null }
  | { ok: false; error: "invalid_request" | "unavailable" };
