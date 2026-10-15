import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
import { copyProblems, textProblems } from "../../../shared/copy-rules";
import type { CalendarCorporateEvent } from "../../../shared/calendar-events";
import type { EstimateRevisions, PeriodEstimates } from "../../../shared/estimate-revisions";
import type { GuidancePattern, GuidanceTrack } from "../../../shared/guidance-types";
import type { ImpliedMove } from "../../../shared/implied-move";
import type { ReadthroughRow, ReadthroughStats } from "../../../shared/readthrough-types";
import type { MessageKey } from "../../lib/i18n";
import { LANGUAGES, type LanguageCode } from "../../lib/i18n/languages";
import { translate } from "../../lib/i18n/translate";
import * as calendarArea from "../../lib/i18n/messages/areas/calendar";
import { corporateToCal, itemViewToCal, userEventToCal, type CalEvent } from "./calendar-model";
import { CARD_GUIDANCE_LINES, CARD_READTHROUGH_LINES, earningsFacts, earningsTarget, type Say } from "./earnings-facts";

/**
 * The Calendar tab's earnings card lines: which events get them, which
 * answers become which line, and that the words are the other modules' own.
 */

const sayIn = (language: LanguageCode): Say => (key, params) => translate(language, key as MessageKey, params);
const say = sayIn("en-US");
const TODAY = "2026-10-16";

function earnings(ticker: string, date: string): CalEvent {
  const e: CalendarCorporateEvent = { id: `earn:${ticker}:${date}`, kind: "earnings", ticker, date, title: `${ticker} earnings report`, detail: null, estimated: false };
  return corporateToCal(e, () => "Technology");
}

const IMPLIED: ImpliedMove = {
  ticker: "TSM",
  reportDate: "2026-10-20",
  reactionDay: "2026-10-20",
  spot: 200,
  expiry: "2026-10-23",
  nextExpiry: "2026-10-30",
  strike: 200,
  straddle: 14,
  raw: 0.07,
  move: 0.061,
  adjusted: true,
  sessions: 6,
  basis: "mid",
  quotedAt: "2026-10-16T14:00:00.000Z",
  history: { n: 12, above: 5, median: 0.052, from: "2023-10-19", to: "2026-07-17" },
};

function period(over: Partial<PeriodEstimates> = {}): PeriodEstimates {
  return {
    period: "0q",
    periodEnd: "2026-09-30",
    currency: "USD",
    analysts: 20,
    now: 2.6,
    ago30: 2.5,
    change7: null,
    change30: { kind: "pct", value: 0.04, from: 2.5, to: 2.6 },
    change90: null,
    up7: null,
    down7: null,
    up30: 9,
    down30: 1,
    revenue: null,
    ...over,
  } as PeriodEstimates;
}

const ESTIMATES: EstimateRevisions = { ticker: "TSM", readAt: "2026-10-16T14:00:00.000Z", periods: [period()] };

function pattern(metric: GuidancePattern["metric"], above: number): GuidancePattern {
  return { metric, basis: "unspecified", n: 8, above, inside: 8 - above, below: 0, atOrAboveMid: above, medianGap: 0.02, gapKind: "relative", point: false };
}

const TRACK = {
  ticker: "TSM",
  releases: 8,
  latest: "2026-07-17",
  rows: [{}] as unknown as GuidanceTrack["rows"],
  patterns: [pattern("revenue", 7), pattern("gross_margin", 5), pattern("eps", 4)],
} satisfies GuidanceTrack;

function stats(withIt: number, events: number): ReadthroughStats {
  return {
    events,
    withIt,
    avgAbsMove: 0.021,
    avgAbsAbnormal: 0.014,
    avgFollow: 0.006,
    avgNextFollow: 0.001,
    nextEvents: events,
    normalAbsAbnormal: 0.009,
    sensitivity: 1.6,
    surpriseEvents: 0,
    withSurprise: 0,
    beta: 1.2,
    betaFallback: false,
    from: "2024-10-17",
    to: "2026-07-17",
  };
}

function row(counterparty: string, holding: string, over: Partial<ReadthroughRow> = {}): ReadthroughRow {
  return {
    id: `${counterparty}>${holding}`,
    counterparty,
    counterpartyName: null,
    holding,
    held: true,
    watchlist: false,
    relation: "supplier",
    tier: "critical",
    namedBy: holding,
    form: "10-K",
    filingDate: "2026-02-25",
    sourceUrl: null,
    kind: "upcoming",
    date: "2026-10-20",
    time: "bmo",
    status: "confirmed",
    report: null,
    sample: 8,
    stats: stats(6, 8),
    events: [],
    weight: 1,
    score: 1,
    ...over,
  };
}

describe("earningsTarget", () => {
  it("takes a company's earnings date from the market feeds", () => {
    const target = earningsTarget(earnings("tsm", "2026-10-20"), TODAY);
    assert.deepEqual(target, { ticker: "TSM", date: "2026-10-20", time: "unknown", upcoming: true, impliedAsk: { ticker: "TSM", date: "2026-10-20", time: "unknown" } });
  });

  it("asks the options only inside their window, and nothing upcoming for a past report", () => {
    const far = earningsTarget(earnings("TSM", "2026-11-20"), TODAY)!;
    assert.equal(far.impliedAsk, null);
    assert.equal(far.upcoming, true);
    const past = earningsTarget(earnings("TSM", "2026-10-14"), TODAY)!;
    assert.equal(past.upcoming, false);
    assert.equal(past.impliedAsk, null);
  });

  it("reads the report hour of a timed row in New York time", () => {
    const view = { id: "e1", kind: "earnings", title: "KO reports before the open", detail: null, importance: 3, kindLabel: "Earnings", timeLabel: "07:00", timeLine: null, tickers: ["KO"], sourceLabel: null };
    const timed = itemViewToCal(view as never, "2026-10-20", "2026-10-20T11:00:00.000Z", () => null);
    assert.equal(earningsTarget(timed, TODAY)?.time, "bmo");
    const after = itemViewToCal({ ...view, timeLabel: "16:05" } as never, "2026-10-20", "2026-10-20T20:05:00.000Z", () => null);
    assert.equal(earningsTarget(after, TODAY)?.time, "amc");
  });

  it("leaves out macro rows, dividends, several tickers and the reader's own events", () => {
    const fomc = itemViewToCal({ id: "f", kind: "fomc", title: "FOMC decision", detail: null, importance: 3, kindLabel: "Fed", timeLabel: null, timeLine: null, tickers: [], sourceLabel: null } as never, "2026-10-28", null, () => null);
    assert.equal(earningsTarget(fomc, TODAY), null);
    const div: CalendarCorporateEvent = { id: "d", kind: "ex_dividend", ticker: "KO", date: "2026-10-20", title: "KO ex-dividend date", detail: null, estimated: false };
    assert.equal(earningsTarget(corporateToCal(div, () => null), TODAY), null);
    assert.equal(earningsTarget({ ...earnings("TSM", "2026-10-20"), tickers: ["TSM", "ASML"] }, TODAY), null);
    const stamp = "2026-10-01T00:00:00.000Z";
    const own = userEventToCal(
      { id: "ue_1", title: "TSM earnings", all_day: true, date: "2026-10-20", end_date: null, start_at: null, end_at: null, ticker: "TSM", sector: null, color: "blue", notes: "", created_at: stamp, updated_at: stamp },
      () => null,
    );
    assert.equal(earningsTarget(own, TODAY), null);
  });
});

describe("earningsFacts", () => {
  const target = earningsTarget(earnings("TSM", "2026-10-20"), TODAY)!;

  it("is empty while nothing has answered", () => {
    assert.deepEqual(earningsFacts(target, {}, say, "en-US"), []);
    assert.deepEqual(earningsFacts(target, { implied: null, estimates: null, guidance: null, readthrough: [] }, say, "en-US"), []);
  });

  it("sets the lines in a fixed order, each in its module's own words", () => {
    const lines = earningsFacts(target, { implied: IMPLIED, estimates: ESTIMATES, guidance: TRACK, readthrough: [row("TSM", "NVDA")] }, say, "en-US");
    assert.deepEqual(
      lines.map((l) => l.id),
      ["implied", "estimates", "guidance:revenue|unspecified", "guidance:gross_margin|unspecified", "readthrough:TSM>NVDA"],
    );
    assert.equal(lines[0]!.text, "Options price a move of 6.1% on this report; TSM moved more than that in 5 of its last 12 reports (median 5.2%).");
    assert.equal(lines[1]!.text, "EPS estimate for this report rose 4.0% over the last 30 days; 9 raised, 1 lowered.");
    assert.match(lines[2]!.text, /^Revenue came in above the top of guidance in 7 of the last 8 quarters\./);
    assert.equal(lines[4]!.text, "NVDA moved with it 6 of the last 8 times · average 2.1% on the day, market included");
    assert.match(lines[4]!.hint ?? "", /^Supplier to NVDA\n10-K filed/);
    assert.ok(lines.length <= 1 + 1 + CARD_GUIDANCE_LINES + CARD_READTHROUGH_LINES);
  });

  it("keeps the read-through to held names measured on this company, one line per name", () => {
    const rows = [
      row("TSM", "AAPL", { held: false, watchlist: true }),
      row("TSM", "AMD", { stats: null, sample: 2 }),
      row("ASML", "NVDA"),
      row("TSM", "NVDA"),
      row("TSM", "NVDA", { id: "TSM>NVDA:2" }),
      row("TSM", "AVGO", { relation: "customer" }),
      row("TSM", "MU", { relation: "competitor" }),
    ];
    const lines = earningsFacts(target, { readthrough: rows }, say, "en-US");
    assert.deepEqual(lines.map((l) => l.id), ["readthrough:TSM>NVDA", "readthrough:TSM>AVGO"]);
  });

  it("drops the options and estimates lines for a past report, and a move read for another name", () => {
    const past = earningsTarget(earnings("TSM", "2026-10-14"), TODAY)!;
    assert.deepEqual(earningsFacts(past, { implied: IMPLIED, estimates: ESTIMATES }, say, "en-US"), []);
    assert.deepEqual(earningsFacts(target, { implied: { ...IMPLIED, ticker: "ASML" } }, say, "en-US"), []);
  });

  it("leaves out a guidance track without figures", () => {
    assert.deepEqual(earningsFacts(target, { guidance: { ...TRACK, rows: [] } }, say, "en-US"), []);
  });

  it("speaks the reader's language", () => {
    const lines = earningsFacts(target, { implied: IMPLIED, estimates: ESTIMATES, guidance: TRACK, readthrough: [row("TSM", "NVDA")] }, sayIn("tr-TR"), "tr-TR");
    assert.equal(lines.length, 5);
    assert.match(lines[0]!.text, /^Opsiyonlar bu rapor için/);
    for (const l of lines) assert.doesNotMatch(l.text, /\{|\}/, l.text);
  });
});

describe("the card's copy", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));

  it("follows the house copy rules", () => {
    for (const file of ["EarningsFacts.tsx", "earnings-facts.ts"]) {
      const src = fs.readFileSync(path.join(HERE, file), "utf8");
      assert.deepEqual(copyProblems(src, { riskWords: true, jsxText: true }), [], file);
    }
    const lines = earningsFacts(earningsTarget(earnings("TSM", "2026-10-20"), TODAY)!, { implied: IMPLIED, estimates: ESTIMATES, guidance: TRACK, readthrough: [row("TSM", "NVDA")] }, say, "en-US");
    for (const l of lines) assert.deepEqual(textProblems(l.text), [], l.text);
  });

  it("has the Stock tab link in every language", () => {
    const tables = Object.values(calendarArea).filter((v): v is Record<string, string> => typeof v === "object" && v !== null);
    assert.equal(tables.length, LANGUAGES.length);
    for (const table of tables) {
      const text = table["calendar.detail.openInStockTab"];
      assert.ok(text && text.length > 0);
      assert.deepEqual(textProblems(text), [], text);
    }
  });
});
