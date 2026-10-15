import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkActual,
  checkGuide,
  matchForm,
  mergeReadings,
  printedAs,
  printedNumbers,
  quoteFound,
  verifyExtraction,
  type RawActual,
  type RawExtraction,
  type RawGuide,
} from "./guidance-verify";

/** Release text shaped like htmlToText output: prose, a bullet list, a table with cell separators. */
const RELEASE = [
  "NVIDIA Announces Financial Results for Second Quarter Fiscal 2026",
  "Revenue of $46.7 billion, up 6% from Q1 and up 56% from a year ago",
  "Outlook",
  "NVIDIA’s outlook for the third quarter of fiscal 2026 is as follows:",
  "• Revenue is expected to be $54.0 billion, plus or minus 2%.",
  "• GAAP and non-GAAP gross margins are expected to be 73.3% and 73.5%, respectively, plus or minus 50 basis points.",
  "• GAAP and non-GAAP operating expenses are expected to be approximately $5.9 billion and $4.2 billion, respectively.",
  "For the first quarter of 2025, AMD expects revenue to be approximately $7.1 billion, plus or minus $300 million.",
  "Revenue",
  "| $61.5 billion ± $1.5 billion | | $61.5 billion ± $1.5 billion |",
  "Diluted earnings per share | $1.08 | $0.81 | (0.12) |",
  "GAAP and non-GAAP gross margins were 72.4% and 72.7%, respectively.",
].join("\n");
const TEXT = matchForm(RELEASE);
const Q2: { fy: number; fq: 2 } = { fy: 2026, fq: 2 };

function guide(over: Partial<RawGuide>): RawGuide {
  return {
    metric: "revenue",
    basis: "unspecified",
    fiscal_year: 2026,
    fiscal_quarter: 3,
    low: 54.0,
    high: 54.0,
    plus_minus: 2,
    plus_minus_kind: "percent",
    plus_minus_scale: "one",
    scale: "billion",
    currency: "USD",
    quote: "Revenue is expected to be $54.0 billion, plus or minus 2%.",
    ...over,
  };
}

function actual(over: Partial<RawActual>): RawActual {
  return { metric: "revenue", basis: "unspecified", period: "quarter", value: 46.7, scale: "billion", currency: "USD", quote: "Revenue of $46.7 billion", ...over };
}

describe("guidance verify: quotes", () => {
  it("finds a quote with only whitespace, cell separators and quote marks told apart", () => {
    assert.ok(quoteFound(TEXT, "Revenue is expected to be $54.0 billion, plus or minus 2%."));
    assert.ok(quoteFound(TEXT, "NVIDIA's outlook for the third quarter"));
    assert.ok(quoteFound(TEXT, "Revenue $61.5 billion ± $1.5 billion"));
    assert.ok(quoteFound(TEXT, "Diluted earnings per share | $1.08"));
  });

  it("rejects a paraphrase, a join of two places, and quotes too short or too long", () => {
    assert.ok(!quoteFound(TEXT, "Revenue is expected to be about $54.0 billion"));
    assert.ok(!quoteFound(TEXT, "Revenue is expected to be $54.0 billion, plus or minus 2%. Revenue of $46.7 billion"));
    assert.ok(!quoteFound(TEXT, "2%"));
    assert.ok(!quoteFound(TEXT, "x".repeat(700)));
  });

  it("reads printed numbers with their decimals and scale word", () => {
    assert.deepEqual(printedNumbers("approximately $7.1 billion, plus or minus $300 million"), [
      { value: 7.1, decimals: 1, scale: 1e9 },
      { value: 300, decimals: 0, scale: 1e6 },
    ]);
    assert.deepEqual(printedNumbers("$1,234.50 in 2026"), [
      { value: 1234.5, decimals: 2, scale: 1 },
      { value: 2026, decimals: 0, scale: 1 },
    ]);
  });

  it("matches a figure as printed or as the same amount in another scale, never a figure not printed", () => {
    assert.deepEqual(printedAs("approximately $7.1 billion", 7.1, 1e9), { step: 1e8 });
    assert.deepEqual(printedAs("approximately $7.1 billion", 7100, 1e6), { step: 1e8 });
    assert.equal(printedAs("approximately $7.1 billion", 7.2, 1e9), null);
    assert.equal(printedAs("approximately $7.1 billion", 7000, 1e6), null);
    assert.deepEqual(printedAs("loss per share | (0.12)", -0.12), { step: 0.01 });
  });
});

describe("guidance verify: guides", () => {
  it("turns a plus or minus percent into a range in whole units", () => {
    const g = checkGuide(guide({}), TEXT, Q2);
    assert.ok(g);
    assert.equal(g.low, 52.92e9);
    assert.equal(g.high, 55.08e9);
    assert.equal(g.step, 1e8);
    assert.deepEqual(g.period, { fy: 2026, fq: 3 });
  });

  it("reads basis points on a margin, an amount tolerance in another scale, and a single figure", () => {
    const gm = checkGuide(
      guide({ metric: "gross_margin", basis: "gaap", low: 73.3, high: 73.3, plus_minus: 50, plus_minus_kind: "basis_points", scale: "one", quote: "GAAP and non-GAAP gross margins are expected to be 73.3% and 73.5%, respectively, plus or minus 50 basis points." }),
      TEXT,
      Q2,
    );
    assert.deepEqual([gm?.low, gm?.high, gm?.unit], [72.8, 73.8, "percent"]);
    const asPoints = checkGuide(
      guide({ metric: "gross_margin", basis: "gaap", low: 73.3, high: 73.3, plus_minus: 0.5, plus_minus_kind: "basis_points", scale: "one", quote: "GAAP and non-GAAP gross margins are expected to be 73.3% and 73.5%, respectively, plus or minus 50 basis points." }),
      TEXT,
      Q2,
    );
    assert.deepEqual([asPoints?.low, asPoints?.high], [72.8, 73.8], "50 basis points returned as 0.5");
    const amd = checkGuide(
      guide({ low: 7100, high: 7100, plus_minus: 300, plus_minus_kind: "amount", plus_minus_scale: "million", scale: "million", fiscal_year: 2026, quote: "AMD expects revenue to be approximately $7.1 billion, plus or minus $300 million." }),
      TEXT,
      Q2,
    );
    assert.deepEqual([amd?.low, amd?.high], [6.8e9, 7.4e9]);
    const opex = checkGuide(
      guide({ metric: "operating_expenses", basis: "non_gaap", low: 4.2, high: 4.2, plus_minus: 0, plus_minus_kind: "none", quote: "GAAP and non-GAAP operating expenses are expected to be approximately $5.9 billion and $4.2 billion, respectively." }),
      TEXT,
      Q2,
    );
    assert.deepEqual([opex?.low, opex?.high, opex?.step], [4.2e9, 4.2e9, 1e8]);
  });

  it("drops a guide whose quote, figure, unit or period does not hold", () => {
    assert.equal(checkGuide(guide({ quote: "Revenue is expected to be $55.0 billion, plus or minus 2%." }), TEXT, Q2), null, "quote not in the release");
    assert.equal(checkGuide(guide({ low: 55, high: 55 }), TEXT, Q2), null, "figure not in the quote");
    assert.equal(checkGuide(guide({ plus_minus: 3 }), TEXT, Q2), null, "tolerance not in the quote");
    assert.equal(checkGuide(guide({ fiscal_quarter: 2 }), TEXT, Q2), null, "the quarter the release reports");
    assert.equal(checkGuide(guide({ fiscal_year: 2025, fiscal_quarter: 4 }), TEXT, Q2), null, "an earlier quarter");
    assert.equal(checkGuide(guide({ metric: "gross_margin", scale: "billion" }), TEXT, Q2), null, "a percent with a scale word");
    assert.equal(checkGuide(guide({ metric: "segment_revenue" }), TEXT, Q2), null, "a metric outside the list");
    assert.equal(checkGuide(guide({ low: 55, high: 54 }), TEXT, Q2), null, "low above high");
    assert.equal(checkGuide(guide({ plus_minus_kind: "basis_points" }), TEXT, Q2), null, "basis points on money");
  });

  it("drops a margin outside -100% to 100%", () => {
    const text = matchForm("Gross margin is expected to be 740%.");
    assert.equal(checkGuide(guide({ metric: "gross_margin", low: 740, high: 740, plus_minus: 0, plus_minus_kind: "none", scale: "one", quote: "Gross margin is expected to be 740%." }), text, Q2), null);
  });

  it("allows a whole year guide for a year still under way, not one the release closes", () => {
    const fy = guide({ fiscal_year: 2026, fiscal_quarter: 0 });
    assert.ok(checkGuide(fy, TEXT, Q2));
    assert.equal(checkGuide(fy, TEXT, { fy: 2026, fq: 4 }), null);
  });
});

describe("guidance verify: actuals and the whole release", () => {
  it("places an actual in the reported quarter, a whole year only in a fourth quarter release", () => {
    assert.deepEqual(checkActual(actual({}), TEXT, Q2)?.period, Q2);
    assert.equal(checkActual(actual({}), TEXT, null), null);
    assert.equal(checkActual(actual({ period: "full_year" }), TEXT, Q2), null);
    assert.deepEqual(checkActual(actual({ period: "full_year" }), TEXT, { fy: 2026, fq: 4 })?.period, { fy: 2026, fq: null });
    assert.equal(checkActual(actual({ value: 46.8 }), TEXT, Q2), null);
    assert.equal(checkActual(actual({ metric: "eps", value: -0.12, scale: "one", quote: "| (0.12) |" }), TEXT, Q2)?.value, -0.12);
  });

  it("keeps the checked figures, the first of a repeat, and revenue under one basis", () => {
    const raw: RawExtraction = {
      reported_fiscal_year: 2026,
      reported_fiscal_quarter: 2,
      guides: [guide({ basis: "gaap" }), guide({ basis: "non_gaap" }), guide({ low: 99, high: 99 })],
      actuals: [actual({}), actual({ value: 46.7, quote: "Revenue of $46.7 billion, up 6%" }), actual({ metric: "gross_margin", basis: "gaap", value: 72.4, scale: "one", quote: "gross margins were 72.4% and 72.7%" })],
    };
    const r = verifyExtraction(raw, RELEASE, { accession: "a", filedAt: "2025-08-27", url: "u" });
    assert.deepEqual(r.reported, Q2);
    assert.equal(r.guides.length, 1);
    assert.equal(r.guides[0]!.basis, "unspecified");
    assert.equal(r.actuals.length, 2);
    assert.equal(r.actuals[0]!.quote, "Revenue of $46.7 billion");
  });

  it("reads no quarter when the release does not say, and so keeps no actual", () => {
    const r = verifyExtraction({ reported_fiscal_year: 2026, reported_fiscal_quarter: 0, guides: [], actuals: [actual({})] }, RELEASE, { accession: "a", filedAt: "x", url: "u" });
    assert.equal(r.reported, null);
    assert.equal(r.actuals.length, 0);
  });

  it("merges two readings: the union, the first one's figure where both have it, nothing from a reading in another quarter", () => {
    const meta = { accession: "a", filedAt: "2025-08-27", url: "u" };
    const a = verifyExtraction({ reported_fiscal_year: 2026, reported_fiscal_quarter: 2, guides: [guide({})], actuals: [] }, RELEASE, meta);
    const b = verifyExtraction(
      {
        reported_fiscal_year: 2026,
        reported_fiscal_quarter: 2,
        guides: [guide({ low: 54.0, high: 54.0, plus_minus: 0, plus_minus_kind: "none", quote: "Revenue is expected to be $54.0 billion" }), guide({ metric: "operating_expenses", basis: "gaap", low: 5.9, high: 5.9, plus_minus: 0, plus_minus_kind: "none", quote: "approximately $5.9 billion" })],
        actuals: [actual({})],
      },
      RELEASE,
      meta,
    );
    const m = mergeReadings(a, b);
    assert.equal(m.guides.length, 2);
    assert.equal(m.guides[0]!.low, 52.92e9);
    assert.equal(m.actuals.length, 1);
    const other = { ...b, reported: { fy: 2026, fq: 3 as const } };
    assert.equal(mergeReadings(a, other), a);
  });
});
