import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { translate } from "../renderer/lib/i18n/translate";
import type { LanguageCode } from "../renderer/lib/i18n/languages";
import type { MessageKey } from "../renderer/lib/i18n/messages";
import { en as earningsEn } from "../renderer/lib/i18n/messages/areas/earnings";
import { copyProblems, textProblems } from "./copy-rules";
import { CALENDAR_SECTORS } from "./calendar-events";
import type { EarningsRow } from "./earnings-types";
import {
  agentBrief,
  cardRows,
  consensusText,
  countText,
  countdownLine,
  dayMoveOf,
  degradedNoticeable,
  daysUntil,
  filterRows,
  filtersActive,
  formatEps,
  formatEpsIn,
  formatMove,
  formatRevenue,
  formatRevenueIn,
  formatRevenueMoney,
  formatSurprise,
  formatUsd,
  formatUsualMove,
  groupByDay,
  headerLine,
  isOut,
  pastDayText,
  releaseTimeText,
  reportedLine,
  sectionRows,
  shortCompanyName,
  nextReports,
  NO_FILTERS,
  nyToday,
  sectorsIn,
  whenText,
  type Say,
} from "./earnings-view";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TODAY = "2026-10-15";

const sayIn =
  (lang: LanguageCode): Say =>
  (key, params) =>
    translate(lang, key as MessageKey, params);
const say = sayIn("en-US");

function row(over: Partial<EarningsRow>): EarningsRow {
  return {
    ticker: "NVDA",
    company: "NVIDIA",
    date: "2026-10-27",
    windowEnd: null,
    time: "unknown",
    status: "confirmed",
    phase: "upcoming",
    releasedAt: null,
    fiscalPeriod: null,
    epsEstimate: null,
    epsActual: null,
    epsCurrency: null,
    consensus: null,
    revenueEstimate: null,
    revenueActual: null,
    revenueCurrency: null,
    revenueEstimateUsd: null,
    revenueActualUsd: null,
    fx: null,
    source: "yahoo",
    lastSurprise: null,
    sector: "Technology",
    held: false,
    watchlist: false,
    tracked: false,
    readsThrough: [],
    reason: null,
    marketCap: null,
    ...over,
  };
}

describe("countdown", () => {
  it("counts calendar days in New York", () => {
    assert.equal(daysUntil(TODAY, "2026-10-27"), 12);
    assert.equal(daysUntil(TODAY, "2026-11-02"), 18);
    assert.equal(nyToday(new Date("2026-10-16T02:30:00Z")), TODAY);
  });

  it("words the distance", () => {
    assert.equal(whenText(0, say, "en-US"), "today");
    assert.equal(whenText(1, say, "en-US"), "tomorrow");
    assert.equal(whenText(12, say, "en-US"), "in 12 days");
    assert.equal(countText(1, say, "en-US"), "1 report");
    assert.equal(countText(3, say, "en-US"), "3 reports");
  });

  it("says when in the day only when a provider said so", () => {
    assert.equal(countdownLine(row({}), TODAY, say, "en-US"), "NVDA reports in 12 days");
    assert.equal(countdownLine(row({ date: TODAY, time: "amc", ticker: "AAPL" }), TODAY, say, "en-US"), "AAPL reports today, after the close");
    assert.equal(countdownLine(row({ date: "2026-10-16", time: "bmo" }), TODAY, say, "en-US"), "NVDA reports tomorrow, before the open");
  });

  it("reads in other languages", () => {
    assert.equal(countdownLine(row({ time: "amc" }), TODAY, sayIn("tr-TR"), "tr-TR"), "NVDA 12 gün sonra kapanış sonrası bilanço açıklıyor");
    assert.equal(countdownLine(row({}), TODAY, sayIn("de-DE"), "de-DE"), "NVDA berichtet in 12 Tagen");
    assert.equal(countdownLine(row({}), TODAY, sayIn("ja-JP"), "ja-JP"), "NVDAの決算は12日後");
  });
});

describe("days", () => {
  it("groups by day, naming today and tomorrow", () => {
    const groups = groupByDay(
      [row({ ticker: "B", date: "2026-10-16" }), row({ ticker: "A", date: TODAY }), row({ ticker: "C", date: "2026-10-20" }), row({ ticker: "D", date: "2026-10-16" })],
      TODAY,
      say,
      "en-US",
    );
    assert.deepEqual(
      groups.map((g) => [g.title, g.subtitle, g.rows.map((r) => r.ticker).join("")]),
      [
        ["Today", "Thu, Oct 15", "A"],
        ["Tomorrow", "Fri, Oct 16", "BD"],
        ["Tue, Oct 20", null, "C"],
      ],
    );
  });
});

describe("filters", () => {
  const rows = [
    row({ ticker: "NVDA", time: "amc" }),
    row({ ticker: "XOM", company: "Exxon Mobil", sector: "Energy", time: "bmo", date: "2026-11-05" }),
    row({ ticker: "ZZ", company: null, sector: null }),
  ];

  it("filters by search, sector, time and range", () => {
    assert.deepEqual(filterRows(rows, { ...NO_FILTERS, query: "exx" }).map((r) => r.ticker), ["XOM"]);
    assert.deepEqual(filterRows(rows, { ...NO_FILTERS, query: "nv" }).map((r) => r.ticker), ["NVDA"]);
    assert.deepEqual(filterRows(rows, { ...NO_FILTERS, sector: "Unclassified" }).map((r) => r.ticker), ["ZZ"]);
    assert.deepEqual(filterRows(rows, { ...NO_FILTERS, time: "bmo" }).map((r) => r.ticker), ["XOM"]);
    assert.deepEqual(filterRows(rows, { ...NO_FILTERS, through: "2026-10-28" }).map((r) => r.ticker), ["NVDA", "ZZ"]);
    assert.equal(filtersActive(NO_FILTERS), false);
    assert.equal(filtersActive({ ...NO_FILTERS, through: "2026-10-28" }), false);
    assert.equal(filtersActive({ ...NO_FILTERS, time: "amc" }), true);
  });

  it("offers only the sectors present", () => {
    assert.deepEqual(sectorsIn(rows, CALENDAR_SECTORS), ["Technology", "Energy", "Unclassified"]);
  });
});

describe("numbers", () => {
  it("prints what was given and nothing else", () => {
    assert.equal(formatEps(2.87011, "en-US"), "2.87");
    assert.equal(formatEps(-0.5, "en-US"), "-0.50");
    assert.equal(formatEps(null, "en-US"), null);
    assert.equal(formatRevenue(16_833_801_490, "en-US"), "16.8B");
    assert.equal(formatRevenue(0, "en-US"), null);
    assert.equal(formatSurprise(5.45, "en-US"), "+5.5%");
    assert.equal(formatSurprise(-0.1, "en-US"), "-0.1%");
    assert.equal(formatSurprise(null, "en-US"), null);
  });
});

describe("the card and the agent", () => {
  it("lists the soonest reports, held names first on a day", () => {
    const out = nextReports(
      [row({ ticker: "B", date: "2026-10-20" }), row({ ticker: "A", date: "2026-10-20", held: true }), row({ ticker: "C", date: "2026-10-16" })],
      2,
    );
    assert.deepEqual(out.map((r) => r.ticker), ["C", "A"]);
  });

  it("prefills an earnings-watch brief", () => {
    assert.equal(
      agentBrief(row({}), say, "en-US"),
      "NVDA reports on Oct 27. When they publish earnings, tell me how EPS and revenue compare with the consensus and what they say about guidance.",
    );
  });
});

describe("earnings copy", () => {
  it("the English table follows the copy rules", () => {
    const problems = Object.entries(earningsEn).flatMap(([key, text]) => textProblems(text).map((p) => `${key}: ${p}`));
    assert.deepEqual(problems, []);
  });

  it("the components carry no sentence of their own that breaks the rules", () => {
    const files = [
      path.join(HERE, "..", "renderer", "components", "earnings", "EarningsTab.tsx"),
      path.join(HERE, "..", "renderer", "components", "earnings", "earnings-ui.tsx"),
      path.join(HERE, "..", "renderer", "components", "earnings", "EarningsDrawer.tsx"),
      path.join(HERE, "..", "renderer", "components", "earnings", "EarningsLogo.tsx"),
      path.join(HERE, "..", "renderer", "components", "dashboard", "EarningsCard.tsx"),
    ];
    for (const file of files) {
      const problems = copyProblems(fs.readFileSync(file, "utf8"), { jsxText: true });
      assert.deepEqual(problems, [], file);
    }
  });
});

// ---------------------------------------------------------------------------
// v2
// ---------------------------------------------------------------------------

const link = (ticker: string, heldName = true) => ({
  ticker,
  held: heldName,
  watchlist: !heldName,
  category: "supplier",
  tier: "important" as const,
  namedBy: ticker,
  named: "TSM",
  form: "10-K" as const,
  filingDate: "2026-02-25",
  sourceUrl: "https://www.sec.gov/",
});

describe("short company names", () => {
  it("drops the listing's suffixes and a dangling connector", () => {
    assert.equal(shortCompanyName("Taiwan Semiconductor Manufacturing Company Ltd."), "Taiwan Semiconductor Manufacturing");
    assert.equal(shortCompanyName("NVIDIA Corporation"), "NVIDIA");
    assert.equal(shortCompanyName("Apple Inc."), "Apple");
    assert.equal(shortCompanyName("JPMorgan Chase & Co."), "JPMorgan Chase");
    assert.equal(shortCompanyName("Eli Lilly and Company"), "Eli Lilly");
    assert.equal(shortCompanyName("The Coca-Cola Company"), "Coca-Cola");
    assert.equal(shortCompanyName("The Trade Desk"), "The Trade Desk", "an article with no tail stays");
    assert.equal(shortCompanyName("argenx SE American Depositary Shares"), "argenx");
    assert.equal(shortCompanyName("Tesla, Inc."), "Tesla");
    assert.equal(shortCompanyName("NVIDIA Corporation - Common Stock"), "NVIDIA");
    assert.equal(shortCompanyName("Group"), "Group", "never shorter than one word");
    assert.equal(shortCompanyName(null), null);
  });
});

describe("sections", () => {
  it("orders reported this week, today, then upcoming by day", () => {
    const rows = [
      row({ ticker: "MSFT", date: "2026-10-28" }),
      row({ ticker: "AAPL", date: TODAY, time: "amc" }),
      row({ ticker: "JPM", date: "2026-10-13", phase: "reported" }),
      row({ ticker: "TSM", date: TODAY, phase: "reported", releasedAt: "2026-10-15T06:08:00.000Z" }),
      row({ ticker: "WFC", date: "2026-10-14", phase: "pending" }),
      row({ ticker: "IBM", date: TODAY, time: "bmo" }),
    ];
    const s = sectionRows(rows, TODAY, say, "en-US");
    assert.deepEqual(
      s.map((x) => [x.key, x.title, x.rows.map((r) => r.ticker)]),
      [
        ["reported", "Reported this week", ["TSM", "WFC", "JPM"]],
        ["today", "Today", ["IBM", "AAPL"]],
        ["upcoming", "Upcoming", ["MSFT"]],
      ],
    );
    assert.deepEqual(s[2]!.days.map((d) => d.date), ["2026-10-28"]);
    assert.equal(isOut(row({ phase: "pending" })), true);
    assert.equal(isOut(row({ phase: "upcoming" })), false);
  });
});

describe("the header line", () => {
  it("counts the reader's names ahead and names the report that reads through to the most of them", () => {
    const rows = [
      row({ ticker: "TSM", date: TODAY, phase: "reported", watchlist: true, readsThrough: [link("NVDA"), link("AMD")] }),
      row({ ticker: "AAPL", date: TODAY, held: true }),
      row({ ticker: "AMD", date: "2026-10-27", held: true }),
      row({ ticker: "MSFT", date: "2026-10-28", watchlist: true }),
      row({ ticker: "NVDA", date: "2026-11-11", held: true }),
      row({ ticker: "IBM", date: "2026-10-21" }),
    ];
    assert.equal(headerLine(rows, TODAY, say, "en-US"), "3 of your names report in the next 2 weeks. TSM reported today; it reads through to 2 of your names.");
  });

  it("says so when none of the reader's names report, and words a report not yet in", () => {
    const rows = [row({ ticker: "JPM", date: "2026-10-14", phase: "pending", held: true }), row({ ticker: "IBM", date: "2026-10-21" })];
    assert.equal(headerLine(rows, TODAY, say, "en-US"), "None of your names report in the next 2 weeks. JPM was due yesterday; the figures are not in yet.");
    assert.equal(headerLine([row({ ticker: "IBM", date: "2026-10-21" })], TODAY, say, "en-US"), null);
  });

  it("follows the copy rules in every language it is built in", () => {
    const rows = [
      row({ ticker: "TSM", date: "2026-10-13", phase: "reported", watchlist: true, readsThrough: [link("NVDA")] }),
      row({ ticker: "AMD", date: "2026-10-27", held: true }),
    ];
    for (const lang of ["en-US", "tr-TR", "de-DE", "fr-FR", "ja-JP"] as LanguageCode[]) {
      const line = headerLine(rows, TODAY, sayIn(lang), lang)!;
      assert.ok(line && !line.includes("{"), `${lang}: ${line}`);
      assert.deepEqual(textProblems(line), [], `${lang}: ${line}`);
    }
  });
});

describe("figures", () => {
  it("prints the range of a thin consensus instead of its mean", () => {
    assert.deepEqual(consensusText(row({ epsEstimate: -9.775, consensus: { analysts: 2, low: -27.83, high: 8.28, thin: true } }), say, "en-US"), { text: "-27.83 to 8.28", thin: true });
    assert.deepEqual(consensusText(row({ epsEstimate: 1.77, consensus: { analysts: 28, low: 1.68, high: 1.84, thin: false } }), say, "en-US"), { text: "1.77", thin: false });
  });

  it("names a currency that is not the dollar", () => {
    assert.equal(formatRevenueIn(1_494_243_000_000, "TWD", "en-US"), "1.5T TWD");
    assert.equal(formatRevenueIn(16.8e9, "USD", "en-US"), "16.8B");
    assert.equal(formatEpsIn(4.6, "USD", "en-US"), "4.60");
    assert.equal(formatUsd(46_132_854_936, "en-US"), "$46.1B");
    assert.equal(formatRevenueMoney(57e9, "USD", "en-US"), "$57.0B");
    assert.equal(formatRevenueMoney(96.2e9, null, "en-US"), "$96.2B");
    assert.equal(formatRevenueMoney(1_494_243_000_000, "TWD", "en-US"), "NT$1.5T");
    assert.equal(formatRevenueMoney(0, "USD", "en-US"), null);
  });

  it("prints moves signed and the usual move either way", () => {
    assert.equal(formatMove(-0.0295, "en-US"), "-3.0%");
    assert.equal(formatMove(0.031, "en-US"), "+3.1%");
    assert.equal(formatUsualMove(0.041, "en-US"), "±4.1%");
    assert.equal(formatUsualMove(null, "en-US"), null);
  });

  it("prints a release on record in New York time", () => {
    assert.equal(releaseTimeText("2026-10-15T06:08:27.000Z", say), "02:08 ET");
    assert.equal(releaseTimeText(null, say), null);
  });

  it("judges a reported row by its reaction session: closes once over, the live quote while today", () => {
    const reaction = { moves: [{ date: "2026-10-13", reactionDay: "2026-10-13", releasedAt: null, move: -0.034 }] };
    assert.deepEqual(dayMoveOf("2026-10-13", TODAY, reaction, 0.004), { move: -0.034, live: false });
    assert.deepEqual(dayMoveOf(TODAY, TODAY, reaction, -0.0295), { move: -0.0295, live: true });
    assert.deepEqual(dayMoveOf("2026-10-14", TODAY, reaction, 0.01), { move: null, live: false });
  });

  it("the card lists a report out today first", () => {
    const rows = [row({ ticker: "AMD", date: "2026-10-27" }), row({ ticker: "TSM", date: TODAY, phase: "reported" }), row({ ticker: "JPM", date: "2026-10-13", phase: "reported" })];
    assert.deepEqual(cardRows(rows, TODAY, 6).map((r) => r.ticker), ["TSM", "AMD"]);
    assert.equal(reportedLine(rows[1]!, TODAY, say, "en-US"), "TSM reported today");
    assert.equal(pastDayText("2026-10-13", TODAY, say, "en-US"), "on Tuesday");
  });
});

describe("the card, filled from For you", () => {
  it("lists the reader's names first, then the rest of For you by reason, up to the card's size", () => {
    const rows = [
      row({ ticker: "KO", date: "2026-10-20", reason: "large" }),
      row({ ticker: "IBM", date: "2026-10-28", reason: "sector" }),
      row({ ticker: "QCOM", date: "2026-11-02", reason: "linked" }),
      row({ ticker: "AMD", date: "2026-10-27", held: true, reason: "held" }),
      row({ ticker: "MSFT", date: "2026-10-29", watchlist: true, reason: "watchlist" }),
    ];
    assert.deepEqual(cardRows(rows, TODAY, 4).map((r) => r.ticker), ["AMD", "MSFT", "QCOM", "IBM"]);
    assert.deepEqual(cardRows(rows.filter((r) => !r.held && !r.watchlist), TODAY, 6).map((r) => r.ticker), ["QCOM", "IBM", "KO"]);
  });
});

describe("degraded footnote", () => {
  it("stays quiet for one missing sector, speaks for what the reader would notice", () => {
    assert.equal(degradedNoticeable({ degraded: [], degradedCounts: {} }), false);
    assert.equal(degradedNoticeable({ degraded: ["sectors"], degradedCounts: { sectors: 1 } }), false);
    assert.equal(degradedNoticeable({ degraded: ["sectors", "fx"], degradedCounts: { sectors: 2, fx: 1 } }), false);
    assert.equal(degradedNoticeable({ degraded: ["sectors"], degradedCounts: { sectors: 3 } }), true);
    assert.equal(degradedNoticeable({ degraded: ["fx"], degradedCounts: { fx: 4 } }), true);
    assert.equal(degradedNoticeable({ degraded: ["caps"], degradedCounts: { caps: 120 } }), true);
    assert.equal(degradedNoticeable({ degraded: ["caps"], degradedCounts: { caps: 1 } }), false);
    for (const whole of ["names", "links", "foryou"] as const) {
      assert.equal(degradedNoticeable({ degraded: [whole], degradedCounts: { [whole]: 1 } }), true, whole);
    }
  });

  it("reads an answer from an older main process without counts", () => {
    assert.equal(degradedNoticeable({ degraded: ["sectors"] }), false);
    assert.equal(degradedNoticeable({ degraded: ["fx"] }), false);
    assert.equal(degradedNoticeable({ degraded: ["caps"] }), true);
    assert.equal(degradedNoticeable({ degraded: ["names"] }), true);
    assert.equal(degradedNoticeable({}), false);
    assert.equal(degradedNoticeable({ degraded: null, degradedCounts: null }), false);
  });
});
