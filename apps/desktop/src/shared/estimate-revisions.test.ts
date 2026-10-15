import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { textProblems } from "./copy-rules";
import * as area from "../renderer/lib/i18n/messages/areas/estimates";
import {
  ESTIMATES_REQUEST_CAP,
  buildEstimates,
  changeCell,
  epsChange,
  estimateHint,
  estimateLine,
  estimatesFreshUntil,
  isLopsided,
  isNotable,
  parseEstimatesRequest,
  periodLabel,
  readEarningsTrend,
  recordRevenue,
  reportPeriod,
  revenueChange,
  type PeriodEstimates,
  type RevenuePoint,
  type Say,
  type TrendRow,
} from "./estimate-revisions";

const n = (raw: number) => ({ raw, fmt: String(raw) });

/** MU's `earningsTrend` as Yahoo answered it on 2026-10-16 (trimmed to the fields read). */
const MU_REPLY = {
  earningsTrend: {
    trend: [
      {
        period: "0q",
        endDate: "2026-11-30",
        earningsEstimate: { avg: n(38.21235), numberOfAnalysts: n(29), earningsCurrency: "USD" },
        revenueEstimate: { avg: n(61666930780), numberOfAnalysts: n(33), revenueCurrency: "USD" },
        epsTrend: { current: n(38.21235), "7daysAgo": n(38.21061), "30daysAgo": n(34.92566), "60daysAgo": n(34.88285), "90daysAgo": n(34.87982), epsTrendCurrency: "USD" },
        epsRevisions: { upLast7days: n(26), upLast30days: n(26), downLast30days: n(2), downLast7Days: n(1) },
      },
      {
        period: "+1q",
        endDate: "2027-02-28",
        earningsEstimate: { numberOfAnalysts: n(28) },
        revenueEstimate: { avg: n(66772649650), numberOfAnalysts: n(31) },
        epsTrend: { current: n(41.97086), "7daysAgo": n(42.12014), "30daysAgo": n(37.8308), "90daysAgo": n(37.69482) },
        epsRevisions: { upLast7days: n(23), upLast30days: n(25), downLast30days: n(3), downLast7Days: n(4) },
      },
      {
        period: "0y",
        endDate: "2027-08-31",
        earningsEstimate: { numberOfAnalysts: n(35) },
        epsTrend: { current: n(176.54659), "7daysAgo": n(176.15115), "30daysAgo": n(156.51823), "90daysAgo": n(150.85753) },
        epsRevisions: { upLast30days: n(28), downLast30days: n(2) },
      },
      { period: "+1y", endDate: "2028-08-31", earningsEstimate: { numberOfAnalysts: n(35) }, epsTrend: { current: n(204.46593) } },
      { period: "-5y", growth: n(0.1) },
    ],
  },
};

function row(over: Partial<TrendRow>): TrendRow {
  return {
    period: "0q",
    periodEnd: "2026-09-30",
    currency: "USD",
    analysts: 20,
    now: 1,
    ago7: 1,
    ago30: 1,
    ago90: 1,
    up7: 0,
    down7: 0,
    up30: 0,
    down30: 0,
    revenue: null,
    revenueAnalysts: null,
    revenueCurrency: null,
    ...over,
  };
}

const say: Say = (key, params) => {
  let text = (area.en as Record<string, string>)[key] ?? key;
  for (const [k, v] of Object.entries(params ?? {})) text = text.replaceAll(`{${k}}`, String(v));
  return text;
};

function periodOf(over: Partial<TrendRow>): PeriodEstimates {
  const est = buildEstimates("X", [row(over)], [], "2026-10-16", "2026-10-16T20:00:00.000Z");
  assert.ok(est);
  return est.periods[0]!;
}

describe("estimate revisions: reading the reply", () => {
  it("reads the current and next quarter and the year, and nothing else", () => {
    const rows = readEarningsTrend(MU_REPLY);
    assert.deepEqual(
      rows.map((r) => r.period),
      ["0q", "+1q", "0y"],
    );
    const q = rows[0]!;
    assert.equal(q.periodEnd, "2026-11-30");
    assert.equal(q.currency, "USD");
    assert.equal(q.analysts, 29);
    assert.equal(q.now, 38.21235);
    assert.equal(q.ago30, 34.92566);
    assert.equal(q.ago90, 34.87982);
    assert.equal(q.up30, 26);
    assert.equal(q.down30, 2);
    assert.equal(q.down7, 1);
    assert.equal(q.revenue, 61666930780);
    assert.equal(q.revenueAnalysts, 33);
  });

  it("gives nothing for a reply without the module", () => {
    assert.deepEqual(readEarningsTrend(null), []);
    assert.deepEqual(readEarningsTrend({ earningsTrend: { trend: "x" } }), []);
  });
});

describe("estimate revisions: changes", () => {
  it("is a percent of the earlier mean", () => {
    const c = epsChange(34.92566, 38.21235);
    assert.equal(c?.kind, "pct");
    assert.ok(Math.abs(c!.value - 0.0941) < 0.0001);
  });

  it("is an amount when the earlier mean is tiny", () => {
    assert.deepEqual(epsChange(0.04, 0.07), { kind: "amount", value: 0.03, from: 0.04, to: 0.07 });
    assert.equal(epsChange(-0.08, -0.05)?.kind, "amount");
  });

  it("is an amount when the mean crosses zero", () => {
    const c = epsChange(-0.25, 0.3);
    assert.equal(c?.kind, "amount");
    assert.equal(c?.value, 0.55);
  });

  it("measures a loss narrowing against the size of the loss", () => {
    const c = epsChange(-1, -0.8);
    assert.equal(c?.kind, "pct");
    assert.equal(c?.value, 0.2);
  });

  it("needs both readings", () => {
    assert.equal(epsChange(null, 1), null);
    assert.equal(epsChange(1, null), null);
  });
});

describe("estimate revisions: figures", () => {
  it("builds every period with three analysts or more", () => {
    const est = buildEstimates("MU", readEarningsTrend(MU_REPLY), [], "2026-10-16", "2026-10-16T20:00:00.000Z");
    assert.ok(est);
    assert.deepEqual(
      est.periods.map((p) => p.period),
      ["0q", "+1q", "0y"],
    );
    assert.equal(est.periods[0]!.revenue?.change30, null);
  });

  it("gives no figures for a period under three analysts", () => {
    const est = buildEstimates("X", [row({ analysts: 2 }), row({ period: "0y", analysts: 5 })], [], "2026-10-16", "t");
    assert.deepEqual(
      est?.periods.map((p) => p.period),
      ["0y"],
    );
    assert.equal(buildEstimates("X", [row({ analysts: 2 })], [], "2026-10-16", "t"), null);
    assert.equal(buildEstimates("X", [row({ analysts: null })], [], "2026-10-16", "t"), null);
  });

  it("drops the revenue figure under three analysts", () => {
    assert.equal(periodOf({ revenue: 1e9, revenueAnalysts: 2 }).revenue, null);
    assert.equal(periodOf({ revenue: 1e9, revenueAnalysts: 3 }).revenue?.now, 1e9);
  });

  it("picks the quarter the report covers", () => {
    const est = buildEstimates("MU", readEarningsTrend(MU_REPLY), [], "2026-10-16", "t");
    assert.equal(reportPeriod(est, "2026-12-23")?.period, "0q");
    assert.equal(reportPeriod(est, "2027-03-20")?.period, "+1q");
    // The provider has moved past the quarter: no line rather than the wrong quarter.
    assert.equal(reportPeriod(est, "2026-11-01"), null);
    assert.equal(reportPeriod(null, "2026-12-23"), null);
  });
});

describe("estimate revisions: what is notable", () => {
  it("a 30 day move of 3% or more", () => {
    assert.equal(isNotable(periodOf({ now: 1.03, ago30: 1 })), true);
    assert.equal(isNotable(periodOf({ now: 0.97, ago30: 1 })), true);
    assert.equal(isNotable(periodOf({ now: 1.02, ago30: 1 })), false);
  });

  it("an amount of five cents or more on a tiny base", () => {
    assert.equal(isNotable(periodOf({ now: 0.09, ago30: 0.04 })), true);
    assert.equal(isNotable(periodOf({ now: 0.06, ago30: 0.04 })), false);
  });

  it("revisions five to one or more, with five on the busy side", () => {
    assert.equal(isLopsided(5, 0), true);
    assert.equal(isLopsided(10, 2), true);
    assert.equal(isLopsided(0, 6), true);
    assert.equal(isLopsided(4, 0), false);
    assert.equal(isLopsided(9, 2), false);
    assert.equal(isLopsided(null, null), false);
    assert.equal(isNotable(periodOf({ now: 1.001, ago30: 1, up30: 14, down30: 0 })), true);
  });
});

describe("estimate revisions: revenue readings kept by the app", () => {
  const rows = [row({ period: "0q", periodEnd: "2026-11-30", revenue: 62e9 }), row({ period: "+1q", periodEnd: "2027-02-28", revenue: 66e9 })];

  it("keeps one reading a day per period and drops the old ones", () => {
    const before: RevenuePoint[] = [
      { d: "2026-05-01", p: "0q", e: "2026-05-31", v: 1 },
      { d: "2026-10-16", p: "0q", e: "2026-11-30", v: 61e9 },
    ];
    const kept = recordRevenue(before, "2026-10-16", rows);
    assert.deepEqual(kept, [
      { d: "2026-10-16", p: "+1q", e: "2027-02-28", v: 66e9 },
      { d: "2026-10-16", p: "0q", e: "2026-11-30", v: 62e9 },
    ]);
  });

  it("compares with the reading closest to thirty days back, same quarter only", () => {
    const history: RevenuePoint[] = [
      { d: "2026-09-10", p: "0q", e: "2026-11-30", v: 59e9 },
      { d: "2026-09-17", p: "0q", e: "2026-11-30", v: 60e9 },
      { d: "2026-09-16", p: "0q", e: "2026-08-31", v: 50e9 },
    ];
    const c = revenueChange(history, "0q", "2026-11-30", "2026-10-16", 62e9);
    assert.equal(c?.fromDate, "2026-09-17");
    assert.ok(Math.abs(c!.pct - 2 / 60) < 1e-6);
  });

  it("gives nothing without a reading 26 to 45 days back", () => {
    const history: RevenuePoint[] = [{ d: "2026-10-01", p: "0q", e: "2026-11-30", v: 60e9 }];
    assert.equal(revenueChange(history, "0q", "2026-11-30", "2026-10-16", 62e9), null);
  });
});

describe("estimate revisions: reading clock", () => {
  it("reuses a reading thirty minutes while the session is open", () => {
    const at = Date.parse("2026-10-15T15:00:00Z");
    assert.equal(estimatesFreshUntil(at), at + 30 * 60_000);
  });

  it("holds a reading taken after the close until the next open", () => {
    assert.equal(estimatesFreshUntil(Date.parse("2026-10-16T22:00:00Z")), Date.parse("2026-10-19T13:30:00Z"));
    assert.equal(estimatesFreshUntil(Date.parse("2026-10-15T11:00:00Z")), Date.parse("2026-10-15T13:30:00Z"));
  });
});

describe("estimate revisions: request", () => {
  it("cleans, de-duplicates and caps", () => {
    assert.deepEqual(parseEstimatesRequest([" mu", "MU", "brk.b", "", 7, "../etc", "TOOLONGTICKER1"]), ["MU", "BRK.B"]);
    assert.equal(parseEstimatesRequest("MU"), null);
    assert.equal(parseEstimatesRequest(Array.from({ length: 80 }, (_, i) => `T${i}`))?.length, ESTIMATES_REQUEST_CAP);
  });
});

describe("estimate revisions: copy", () => {
  const est = buildEstimates("MU", readEarningsTrend(MU_REPLY), [], "2026-10-16", "t")!;

  it("reads as the factual sentence", () => {
    assert.equal(estimateLine(est.periods[0]!, say, "en-US"), "EPS estimate for this report rose 9.4% over the last 30 days; 26 raised, 2 lowered.");
    assert.equal(estimateLine(periodOf({ now: 0.9, ago30: 1, up30: 1, down30: 7 }), say, "en-US"), "EPS estimate for this report fell 10.0% over the last 30 days; 1 raised, 7 lowered.");
    assert.equal(estimateLine(periodOf({ now: 1, ago30: 1, up30: null, down30: null }), say, "en-US"), "EPS estimate for this report was unchanged over the last 30 days.");
  });

  it("gives a tiny or crossed base in cents", () => {
    assert.equal(estimateLine(periodOf({ now: -0.02, ago30: 0.04, up30: 0, down30: 3 }), say, "en-US"), "EPS estimate for this report fell 6 cents over the last 30 days; 0 raised, 3 lowered.");
    assert.equal(estimateLine(periodOf({ now: 0.05, ago30: 0.04, up30: 1, down30: 0 }), say, "en-US"), "EPS estimate for this report rose 1 cent over the last 30 days; 1 raised, 0 lowered.");
    assert.equal(changeCell(epsChange(0.04, -0.02), "USD", "en-US"), "-$0.06");
  });

  it("signs the cells and labels the periods", () => {
    assert.equal(changeCell(est.periods[0]!.change30, "USD", "en-US"), "+9.4%");
    assert.equal(changeCell(est.periods[1]!.change7, "USD", "en-US"), "-0.4%");
    assert.equal(changeCell(null, "USD", "en-US"), null);
    assert.equal(periodLabel(est.periods[0]!, say, "en-US"), "Quarter to Nov 2026");
    assert.equal(periodLabel(est.periods[2]!, say, "en-US"), "Year to Aug 2027");
  });

  it("says what the figure is drawn from", () => {
    assert.equal(estimateHint(est.periods[0]!, say, "en-US"), "Mean EPS estimate 38.21, from 29 analysts.\n30 days ago: 34.93.");
  });

  it("the English lines follow the copy rules, risk words included", () => {
    const problems = Object.entries(area.en).flatMap(([key, text]) => textProblems(text, { riskWords: true }).map((p) => `${key}: ${p}`));
    assert.deepEqual(problems, []);
  });

  it("every language has every line, keeps the placeholders, and uses no dashes", () => {
    const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const lang of ["tr", "de", "fr", "es", "it", "ptBR", "ja", "zhCN", "ko"] as const) {
      const table = area[lang] as Record<string, string | undefined>;
      for (const [key, text] of Object.entries(area.en)) {
        const tr = table[key];
        assert.ok(tr, `${lang} ${key} missing`);
        assert.equal(placeholders(tr!), placeholders(text), `${lang} ${key}`);
        assert.ok(!/[‒–—―－〜～⸺⸻]/.test(tr!), `${lang} ${key} has a dash`);
        assert.ok(!/[!！]/.test(tr!), `${lang} ${key} has an exclamation mark`);
      }
    }
  });
});
