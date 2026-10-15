import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActualFigure, FiscalPeriod, GuidanceBasis, GuidanceMetric, GuidanceRelease, GuideFigure } from "./guidance-types";
import { buildTrack, dominantPosition, foldTwins, gapOf, guidancePatterns, guidanceRows, median, MIN_PATTERN, positionOf, revisionOf } from "./guidance-track";
import { figureText, gapText, guideText, patternText, resultKey, visibleRows, type Say } from "./guidance-view";
import { en } from "../renderer/lib/i18n/messages/areas/guidance";

const B = 1e9;

function g(metric: GuidanceMetric, period: FiscalPeriod, low: number, high: number, over: Partial<GuideFigure> = {}): GuideFigure {
  const unit = metric === "gross_margin" ? "percent" : metric === "eps" ? "per_share" : "currency";
  return { metric, basis: "unspecified", period, low, high, unit, currency: "USD", step: unit === "currency" ? 0.1 * B : 0.1, quote: `${metric} guide`, ...over };
}

function a(metric: GuidanceMetric, period: FiscalPeriod, value: number, basis: GuidanceBasis = "unspecified"): ActualFigure {
  const unit = metric === "gross_margin" ? "percent" : metric === "eps" ? "per_share" : "currency";
  return { metric, basis, period, value, unit, currency: "USD", quote: `${metric} actual` };
}

const q = (fy: number, fq: 1 | 2 | 3 | 4 | null): FiscalPeriod => ({ fy, fq });

/** One release per quarter: it reports `reported` and guides the next quarter's revenue. */
function release(filedAt: string, reported: FiscalPeriod, guides: GuideFigure[], actuals: ActualFigure[]): GuidanceRelease {
  return { accession: filedAt, filedAt, url: `https://sec.example/${filedAt}`, reported, guides, actuals };
}

/** Five quarters of revenue guides; actuals above the top four times, inside once. */
function revenueHistory(): GuidanceRelease[] {
  return [
    release("2025-02-01", q(2024, 4), [g("revenue", q(2025, 1), 9 * B, 10 * B)], [a("revenue", q(2024, 4), 9 * B)]),
    release("2025-05-01", q(2025, 1), [g("revenue", q(2025, 2), 10 * B, 11 * B)], [a("revenue", q(2025, 1), 10.5 * B)]),
    release("2025-08-01", q(2025, 2), [g("revenue", q(2025, 3), 11 * B, 12 * B)], [a("revenue", q(2025, 2), 11.6 * B)]),
    release("2025-11-01", q(2025, 3), [g("revenue", q(2025, 4), 12 * B, 13 * B)], [a("revenue", q(2025, 3), 12.65 * B)]),
    release("2026-02-01", q(2025, 4), [g("revenue", q(2026, 1), 13 * B, 14 * B)], [a("revenue", q(2025, 4), 13.7 * B)]),
    release("2026-05-01", q(2026, 1), [g("revenue", q(2026, 2), 14 * B, 15 * B)], [a("revenue", q(2026, 1), 13.6 * B)]),
  ];
}

const say: Say = (key, params) => {
  const text = (en as Record<string, string>)[key];
  assert.ok(text, `missing ${key}`);
  return text.replace(/\{(\w+)\}/g, (_m, name: string) => String(params?.[name] ?? `{${name}}`));
};

describe("guidance track: comparisons", () => {
  it("places a result against a range, ends inclusive", () => {
    assert.equal(positionOf(11, 10, 11, 0.1), "inside");
    assert.equal(positionOf(10, 10, 11, 0.1), "inside");
    assert.equal(positionOf(11.01, 10, 11, 0.1), "above");
    assert.equal(positionOf(9.99, 10, 11, 0.1), "below");
  });

  it("counts a single figure as met at the precision it was printed with", () => {
    // "approximately $9.2 billion": 9.17 and 9.24 round to it, 9.26 does not.
    assert.equal(positionOf(9.17 * B, 9.2 * B, 9.2 * B, 0.1 * B), "inside");
    assert.equal(positionOf(9.24 * B, 9.2 * B, 9.2 * B, 0.1 * B), "inside");
    assert.equal(positionOf(9.26 * B, 9.2 * B, 9.2 * B, 0.1 * B), "above");
    assert.equal(positionOf(85.94, 85.95, 85.95, 0.01), "below");
  });

  it("measures the gap as a share of the midpoint for money, in points for percent", () => {
    assert.equal(gapOf(11, 10, "currency"), 0.1);
    assert.equal(gapOf(74.6, 74, "percent"), 0.6);
    assert.equal(gapOf(1, 0, "currency"), null);
  });

  it("names a change of guide by its midpoint", () => {
    assert.equal(revisionOf({ low: 10, high: 12 }, { low: 11, high: 13 }), "raised");
    assert.equal(revisionOf({ low: 10, high: 12 }, { low: 9, high: 11 }), "cut");
    assert.equal(revisionOf({ low: 10, high: 12 }, { low: 10.5, high: 11.5 }), "kept");
  });

  it("takes the median of an even and an odd count", () => {
    assert.equal(median([3, 1, 2]), 2);
    assert.equal(median([4, 1, 2, 3]), 2.5);
    assert.equal(median([]), null);
  });
});

describe("guidance track: rows", () => {
  it("matches each guide to the release that reports its period, and leaves the newest guide open", () => {
    const rows = guidanceRows(revenueHistory());
    assert.equal(rows.length, 6);
    const q1 = rows.find((r) => r.period.fy === 2025 && r.period.fq === 1)!;
    assert.equal(q1.state, "resolved");
    assert.equal(q1.actual, 10.5 * B);
    assert.equal(q1.position, "above");
    assert.equal(q1.reported?.filedAt, "2025-05-01");
    assert.equal(q1.guide.filedAt, "2025-02-01");
    const open = rows.find((r) => r.period.fy === 2026 && r.period.fq === 2)!;
    assert.equal(open.state, "open");
    assert.equal(open.actual, null);
    assert.equal(open.position, null);
  });

  it("calls a figure missing when its period's release is on hand but states none", () => {
    const rels = revenueHistory();
    rels[0]!.guides.push(g("eps", q(2025, 1), 1.0, 1.1));
    const eps = guidanceRows(rels).find((r) => r.metric === "eps")!;
    assert.equal(eps.state, "missing");
    assert.deepEqual(visibleRows([eps]), []);
  });

  it("uses the last guide before the report and marks it against the earlier one", () => {
    const rels = [
      release("2026-02-01", q(2025, 4), [g("revenue", q(2026, null), 40 * B, 42 * B)], []),
      release("2026-05-01", q(2026, 1), [g("revenue", q(2026, null), 42 * B, 44 * B)], []),
      release("2026-08-01", q(2026, 2), [g("revenue", q(2026, null), 41 * B, 43 * B)], []),
      release("2027-02-01", q(2026, 4), [g("revenue", q(2026, null), 50 * B, 60 * B)], [a("revenue", q(2026, null), 43.5 * B)]),
    ];
    // The guide in the release that reports the year is not guidance for it (and the reader drops such a guide anyway).
    const [row] = guidanceRows(rels);
    assert.equal(row!.low, 41 * B);
    assert.equal(row!.revision, "cut");
    assert.deepEqual(row!.prior, { low: 42 * B, high: 44 * B, filedAt: "2026-05-01" });
    assert.equal(row!.position, "above");
  });

  it("reads a GAAP guide's result under GAAP, then unlabelled; a non-GAAP guide only under non-GAAP", () => {
    const rels = [
      release("2026-02-01", q(2025, 4), [g("gross_margin", q(2026, 1), 70, 71, { basis: "gaap" }), g("gross_margin", q(2026, 1), 72, 73, { basis: "non_gaap" })], []),
      release("2026-05-01", q(2026, 1), [], [a("gross_margin", q(2026, 1), 70.5)]),
    ];
    const rows = guidanceRows(rels);
    assert.equal(rows.find((r) => r.basis === "gaap")!.actual, 70.5);
    assert.equal(rows.find((r) => r.basis === "non_gaap")!.state, "missing");
  });

  it("folds GAAP and non-GAAP rows with the same figures into one", () => {
    const rels = [
      release("2026-02-01", q(2025, 4), [g("gross_margin", q(2026, 1), 73.5, 74.5, { basis: "gaap" }), g("gross_margin", q(2026, 1), 73.5, 74.5, { basis: "non_gaap" })], []),
      release("2026-05-01", q(2026, 1), [], [a("gross_margin", q(2026, 1), 75, "gaap"), a("gross_margin", q(2026, 1), 75, "non_gaap")]),
    ];
    const folded = foldTwins(guidanceRows(rels));
    assert.equal(folded.length, 1);
    assert.equal(folded[0]!.basis, "both");
    const apart = [
      release("2026-02-01", q(2025, 4), [g("gross_margin", q(2026, 1), 73.5, 74.5, { basis: "gaap" }), g("gross_margin", q(2026, 1), 73.5, 74.5, { basis: "non_gaap" })], []),
      release("2026-05-01", q(2026, 1), [], [a("gross_margin", q(2026, 1), 75, "gaap"), a("gross_margin", q(2026, 1), 75.2, "non_gaap")]),
    ];
    assert.equal(foldTwins(guidanceRows(apart)).length, 2);
  });
});

describe("guidance track: patterns", () => {
  it("counts where the figure landed over the resolved quarters, with the median gap", () => {
    const [p] = guidancePatterns(guidanceRows(revenueHistory()));
    assert.ok(p);
    assert.equal(p.n, 5);
    assert.equal(p.above, 4);
    assert.equal(p.inside, 1);
    assert.equal(p.below, 0);
    assert.equal(p.atOrAboveMid, 5);
    assert.equal(p.gapKind, "relative");
    // Gaps: 10.5/9.5, 11.6/10.5, 12.65/11.5, 13.7/12.5, 13.6/13.5, less one; the median is 12.65/11.5 - 1.
    assert.equal(p.medianGap, 0.1);
    assert.equal(dominantPosition(p), "above");
  });

  it("gives no pattern under MIN_PATTERN quarters", () => {
    const rels = revenueHistory().slice(0, MIN_PATTERN);
    assert.equal(guidancePatterns(guidanceRows(rels)).length, 0);
    assert.equal(guidancePatterns(guidanceRows(revenueHistory().slice(0, MIN_PATTERN + 1))).length, 1);
  });

  it("builds the whole track: sorted newest first, latest release and count", () => {
    const track = buildTrack("TEST", revenueHistory());
    assert.equal(track.releases, 6);
    assert.equal(track.latest, "2026-05-01");
    assert.deepEqual(track.rows[0]!.period, q(2026, 2));
    assert.deepEqual(track.rows.at(-1)!.period, q(2025, 1));
  });

  it("is empty for a company whose releases guide nothing", () => {
    const track = buildTrack("BRK.B", [release("2026-05-01", q(2026, 1), [], [a("revenue", q(2026, 1), 90 * B)])]);
    assert.deepEqual(track.rows, []);
    assert.deepEqual(track.patterns, []);
  });
});

describe("guidance view", () => {
  it("writes the pattern with its sample size", () => {
    const [p] = guidancePatterns(guidanceRows(revenueHistory()));
    assert.equal(
      patternText(p!, "en-US", say),
      "Revenue came in above the top of guidance in 4 of the last 5 quarters. At or above the midpoint 5 of 5 times, median gap +10.0%.",
    );
  });

  it("writes a single figure pattern without a midpoint line, and a percent gap in points", () => {
    const text = patternText(
      { metric: "gross_margin", basis: "non_gaap", n: 7, above: 1, inside: 6, below: 0, atOrAboveMid: 7, medianGap: 0, gapKind: "points", point: true },
      "en-US",
      say,
    );
    assert.equal(text, "Gross margin, non-GAAP matched the guided figure in 6 of the last 7 quarters. Median gap to the guided figure 0.0 pts.");
    assert.equal(gapText(0.6, "points", "en-US", say), "+0.6 pts");
    assert.equal(gapText(-0.0108, "relative", "en-US", say), "-1.1%");
  });

  it("formats figures and ranges", () => {
    assert.equal(figureText(108e9, "currency", "USD", "en-US"), "$108.0B");
    assert.equal(figureText(52.92e9, "currency", "USD", "en-US"), "$52.92B");
    assert.equal(figureText(1.5, "per_share", "USD", "en-US"), "$1.50");
    assert.equal(figureText(73.5, "percent", "USD", "en-US"), "73.5%");
    assert.equal(guideText({ low: 1.5, high: 1.6, unit: "per_share", currency: "USD" }, "en-US", say), "$1.50 to $1.60");
    assert.equal(guideText({ low: 9.2e9, high: 9.2e9, unit: "currency", currency: "USD" }, "en-US", say), "$9.2B");
  });

  it("picks the result word", () => {
    assert.equal(resultKey({ state: "resolved", position: "inside", point: true }), "guidance.result.met");
    assert.equal(resultKey({ state: "resolved", position: "inside", point: false }), "guidance.result.inside");
    assert.equal(resultKey({ state: "resolved", position: "above", point: false }), "guidance.result.above");
    assert.equal(resultKey({ state: "open", position: null, point: false }), "guidance.result.open");
    assert.equal(resultKey({ state: "missing", position: null, point: false }), "guidance.result.missing");
  });
});
