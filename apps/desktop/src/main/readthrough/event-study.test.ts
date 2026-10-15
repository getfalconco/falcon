import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  alignCloses,
  olsSlope,
  reactionIndex,
  reportEvents,
  studyPair,
  type Bar,
  type ReportEvent,
} from "./event-study";
import { nyMinutesOf, nyYmdOf } from "../../shared/earnings-time";
import { releasesFromSubmissions } from "./releases";

/** Weekday dates from `start`. */
function weekdays(start: string, count: number): string[] {
  const out: string[] = [];
  const d = new Date(`${start}T12:00:00Z`);
  while (out.length < count) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

/** Closes from daily returns: `ret(day, i)` is the return into that day. */
function series(days: readonly string[], ret: (day: string, i: number) => number): Bar[] {
  let c = 100;
  return days.map((d, i) => {
    if (i > 0) c *= 1 + ret(d, i);
    return { d, c };
  });
}

/** A small deterministic wiggle, so beta has something to fit. */
const wiggle = (i: number) => Math.sin(i * 1.7) * 0.004 + Math.cos(i * 0.9) * 0.003;

const DAYS = weekdays("2024-06-03", 560);
const TODAY = "2026-12-31";
/** Eight report days, one a quarter, oldest first (all session days in the list). */
const REPORT_DAYS = [60, 125, 190, 255, 320, 385, 450, 515].map((i) => DAYS[i]!);
const event = (date: string, surprisePct: number | null = null): ReportEvent => ({ date, hour: "bmo", surprisePct });

describe("alignCloses and reactionIndex", () => {
  it("keeps only sessions all three closed, before today", () => {
    const h = [{ d: "2026-01-05", c: 1 }, { d: "2026-01-06", c: 2 }, { d: "2026-01-07", c: 3 }, { d: "2026-01-08", c: 4 }];
    const c = h.filter((b) => b.d !== "2026-01-06");
    const m = h;
    const a = alignCloses(h, c, m, "2026-01-08");
    assert.deepEqual(a.days, ["2026-01-05", "2026-01-07"]);
  });

  it("reads after the close as the next session and anything else as the same one", () => {
    const days = ["2026-01-05", "2026-01-06", "2026-01-07"];
    assert.equal(reactionIndex(days, { date: "2026-01-05", hour: "amc" }), 1);
    assert.equal(reactionIndex(days, { date: "2026-01-05", hour: "bmo" }), 0);
    assert.equal(reactionIndex(days, { date: "2026-01-05", hour: null }), 0);
    // A Sunday report is first traded on Monday.
    assert.equal(reactionIndex(["2026-01-05"], { date: "2026-01-04", hour: null }), 0);
    // Closes that skip far past the report do not stand in for it.
    assert.equal(reactionIndex(["2026-03-02"], { date: "2026-01-05", hour: null }), -1);
  });

  it("fits a slope", () => {
    assert.equal(olsSlope([2, 4, 6], [1, 2, 3]), 2);
    assert.equal(olsSlope([1, 2, 3], [1, 1, 1]), null);
  });
});

describe("studyPair", () => {
  it("measures abnormal moves against SPY with the fitted beta", () => {
    const reportSet = new Set(REPORT_DAYS);
    const market = series(DAYS, (_d, i) => wiggle(i));
    // H is 1.5x the market every day, plus +3% on C's report days.
    const holding = series(DAYS, (d, i) => 1.5 * wiggle(i) + (reportSet.has(d) ? 0.03 : 0));
    // C is the market plus +5% on its own report days.
    const counterparty = series(DAYS, (d, i) => wiggle(i) + (reportSet.has(d) ? 0.05 : 0));
    const study = studyPair({ holding, counterparty, market, events: REPORT_DAYS.map((d) => event(d, 4)), today: TODAY });

    assert.equal(study.sample, 8);
    assert.ok(study.stats);
    const s = study.stats!;
    assert.ok(Math.abs(s.beta - 1.5) < 1e-3, `beta ${s.beta}`);
    assert.equal(s.betaFallback, false);
    assert.equal(s.events, 8);
    assert.equal(s.withIt, 8);
    for (const e of study.events) {
      assert.ok(Math.abs(e.holdingAbnormal - 0.03) < 1e-4, `abnormal ${e.holdingAbnormal}`);
      assert.ok(Math.abs(e.counterpartyAbnormal - 0.05) < 1e-4);
      assert.equal(e.withIt, true);
    }
    assert.ok(Math.abs(s.avgAbsAbnormal - 0.03) < 1e-4);
    assert.ok(Math.abs(s.avgFollow - 0.03) < 1e-4);
    // Ordinary days carry no abnormal move at all here.
    assert.ok(s.normalAbsAbnormal !== null && s.normalAbsAbnormal < 1e-6);
    assert.equal(s.surpriseEvents, 8);
    assert.equal(s.withSurprise, 8);
    // Newest first, and the window is named.
    assert.equal(study.events[0]!.reactionDay, REPORT_DAYS[7]);
    assert.equal(s.from, REPORT_DAYS[0]);
    assert.equal(s.to, REPORT_DAYS[7]);
  });

  it("counts sign agreement: H against C, not against the market", () => {
    const signs = [1, 1, -1, 1, -1, 1, 1, 1];
    const byDay = new Map(REPORT_DAYS.map((d, k) => [d, k]));
    const market = series(DAYS, (_d, i) => wiggle(i));
    // C goes up on every report; H goes the way of `signs`.
    const counterparty = series(DAYS, (d, i) => wiggle(i) + (byDay.has(d) ? 0.04 : 0));
    const holding = series(DAYS, (d, i) => wiggle(i) + (byDay.has(d) ? 0.02 * signs[byDay.get(d)!]! : 0));
    const s = studyPair({ holding, counterparty, market, events: REPORT_DAYS.map((d) => event(d)), today: TODAY }).stats!;
    assert.equal(s.withIt, 6);
    assert.equal(s.events, 8);
    // Mean of (+2% x6, -2% x2) signed by C's direction: +1%.
    assert.ok(Math.abs(s.avgFollow - 0.01) < 1e-4, `follow ${s.avgFollow}`);
    assert.ok(Math.abs(s.avgAbsAbnormal - 0.02) < 1e-4);
    assert.equal(s.surpriseEvents, 0);
  });

  it("gives no figures below three reports, but keeps the count and the moves", () => {
    const market = series(DAYS, (_d, i) => wiggle(i));
    const study = studyPair({
      holding: market,
      counterparty: market,
      market,
      events: REPORT_DAYS.slice(0, 2).map((d) => event(d)),
      today: TODAY,
    });
    assert.equal(study.sample, 2);
    assert.equal(study.stats, null);
    assert.equal(study.events.length, 2);
  });

  it("takes at most the last eight reports", () => {
    const extra = [20, 40].map((i) => DAYS[i]!);
    const market = series(DAYS, (_d, i) => wiggle(i));
    const study = studyPair({ holding: market, counterparty: market, market, events: [...extra, ...REPORT_DAYS].map((d) => event(d)), today: TODAY });
    assert.equal(study.sample, 8);
    assert.equal(study.stats!.from, REPORT_DAYS[0]);
  });

  it("leaves out a report first traded the same session as H's own", () => {
    const market = series(DAYS, (_d, i) => wiggle(i));
    const study = studyPair({
      holding: market,
      counterparty: market,
      market,
      events: REPORT_DAYS.map((d) => event(d)),
      holdingEvents: [event(REPORT_DAYS[3]!)],
      today: TODAY,
    });
    assert.equal(study.overlapping, 1);
    assert.equal(study.sample, 7);
    assert.ok(!study.events.some((e) => e.reactionDay === REPORT_DAYS[3]));
  });

  it("falls back to beta 1 with too few sessions, and counts no session from today on", () => {
    const short = DAYS.slice(0, 40);
    const days = [short[5]!, short[15]!, short[25]!, short[35]!];
    const market = series(short, (_d, i) => wiggle(i));
    const holding = series(short, (d, i) => 2 * wiggle(i) + (days.includes(d) ? 0.01 : 0));
    const study = studyPair({ holding, counterparty: market, market, events: days.map((d) => event(d)), today: short[35]! });
    // The fourth report is today: not measured.
    assert.equal(study.sample, 3);
    assert.equal(study.stats!.betaFallback, true);
    assert.equal(study.stats!.beta, 1);
    // 40 sessions are too few for the normal move, so no ratio.
    assert.equal(study.stats!.sensitivity, null);
    assert.ok(study.events.every((e) => e.holdingNextAbnormal !== null));
  });

  it("measures the ratio to a usual day", () => {
    const reportSet = new Set(REPORT_DAYS);
    const market = series(DAYS, (_d, i) => wiggle(i));
    // H's own noise of about 1% a day, and 3% on C's report days.
    const holding = series(DAYS, (d, i) => wiggle(i) + (reportSet.has(d) ? 0.03 : (i % 2 === 0 ? 0.01 : -0.01)));
    const s = studyPair({ holding, counterparty: market, market, events: REPORT_DAYS.map((d) => event(d)), today: TODAY }).stats!;
    assert.ok(s.normalAbsAbnormal !== null && Math.abs(s.normalAbsAbnormal - 0.01) < 0.002, `normal ${s.normalAbsAbnormal}`);
    assert.ok(s.sensitivity !== null && s.sensitivity > 2.5 && s.sensitivity < 3.5, `ratio ${s.sensitivity}`);
  });
});

describe("report dates", () => {
  it("reads a rebuilt file's stamps as New York's offset added a second time", () => {
    // Read on 2026-10-15: every one of these entries is old, and NVDA's file was rebuilt since SEC's change.
    const at = Date.parse("2026-10-15T20:00:00Z");
    const [, winter, nvda] = releasesFromSubmissions(
      "0001045810",
      {
        form: ["8-K", "8-K", "8-K"],
        items: ["2.02,9.01", "2.02,9.01", "2.02,9.01"],
        filingDate: ["2026-08-26", "2026-02-25", "2025-11-19"],
        // NVDA's 8-K of 2026-08-26, accepted 16:21:19 New York: stamped 00:21Z the next day.
        // Winter: NVDA's of 2026-02-25, accepted 16:31:25 New York, stamped 02:31Z the next day.
        acceptanceDateTime: ["2026-08-27T00:21:19.000Z", "2026-02-26T02:31:25.000Z", "2025-11-20T02:20:44.000Z"],
        accessionNumber: ["0001045810-26-000073", "0001045810-26-000019", "0001045810-25-000228"],
      },
      at,
    );
    const ms = (f: { acceptedAt: string | null }) => Date.parse(f.acceptedAt!);
    assert.equal(nvda!.acceptedAtUtc, true);
    assert.equal(nyYmdOf(ms(nvda!)), "2026-08-26");
    assert.equal(nyMinutesOf(ms(nvda!)), 16 * 60 + 21);
    assert.equal(nyYmdOf(ms(winter!)), "2026-02-25");
    assert.equal(nyMinutesOf(ms(winter!)), 16 * 60 + 31);
  });

  /**
   * Morning, midday and evening releases in daylight time and in winter, as
   * an older entry of a file rebuilt since SEC's change (shifted), of one not
   * rebuilt since (true), a same-day entry (true) and a stamp kept raw from a
   * read before the change (true). The evening one is dated the next business
   * day and is first traded that session. Read as UTC the 13:00 release was
   * "amc" and moved a session late.
   */
  const CASES = [
    { name: "summer 06:30", filedAt: "2026-07-14", old: "2026-07-14T14:30:38.000Z", current: "2026-07-14T10:30:38.000Z", date: "2026-07-14", hour: "bmo" },
    { name: "summer 13:00", filedAt: "2026-07-14", old: "2026-07-14T21:00:00.000Z", current: "2026-07-14T17:00:00.000Z", date: "2026-07-14", hour: "dmh" },
    { name: "summer 20:30", filedAt: "2026-07-15", old: "2026-07-15T04:30:00.000Z", current: "2026-07-15T00:30:00.000Z", date: "2026-07-14", hour: "amc" },
    { name: "winter 06:30", filedAt: "2026-01-13", old: "2026-01-13T16:30:38.000Z", current: "2026-01-13T11:30:38.000Z", date: "2026-01-13", hour: "bmo" },
    { name: "winter 13:00", filedAt: "2026-01-13", old: "2026-01-13T23:00:00.000Z", current: "2026-01-13T18:00:00.000Z", date: "2026-01-13", hour: "dmh" },
    { name: "winter 20:30", filedAt: "2026-01-14", old: "2026-01-14T06:30:00.000Z", current: "2026-01-14T01:30:00.000Z", date: "2026-01-13", hour: "amc" },
  ] as const;
  const index = (stamp: string, filedAt: string) => ({ form: ["8-K"], items: ["2.02"], filingDate: [filedAt], acceptanceDateTime: [stamp], accessionNumber: ["a-1"] });
  /** With a Form 4 dated 2026-10-13: the file was rebuilt since SEC's change. */
  const rebuilt = (stamp: string, filedAt: string) => ({
    form: ["4", "8-K"],
    items: ["", "2.02"],
    filingDate: ["2026-10-13", filedAt],
    acceptanceDateTime: ["2026-10-14T01:09:29.000Z", stamp],
    accessionNumber: ["a-0", "a-1"],
  });
  const OCT15 = Date.parse("2026-10-15T21:15:00Z");
  const days = ["2026-01-12", "2026-01-13", "2026-01-14", "2026-01-15", "2026-07-13", "2026-07-14", "2026-07-15", "2026-07-16"];
  for (const c of CASES) {
    it(`${c.name}: the release's date, hour and first session`, () => {
      const trueMs = Date.parse(c.current);
      const reads = [
        releasesFromSubmissions("1", rebuilt(c.old, c.filedAt), OCT15),
        releasesFromSubmissions("1", index(c.current, c.filedAt), OCT15),
        releasesFromSubmissions("1", index(c.current, c.filedAt), trueMs + 20 * 60_000),
        [{ filedAt: c.filedAt, acceptedAt: c.current }],
      ];
      for (const filings of reads) {
        const [e] = reportEvents([], filings);
        assert.deepEqual([e!.date, e!.hour], [c.date, c.hour]);
        const first = days[reactionIndex(days, e!)];
        assert.equal(first, c.hour === "amc" ? days[days.indexOf(c.date) + 1] : c.date);
      }
    });
  }

  it("merges the provider's quarters with older EDGAR releases, one per report", () => {
    const quarters = [
      { reportedAt: "2026-08-26T20:20:00.000Z", reportedYmd: "2026-08-26", epsActual: 1.2, epsEstimate: 1.0 },
      { reportedAt: null, reportedYmd: "2026-05-20", epsActual: 0.9, epsEstimate: 1.0 },
      { reportedAt: null, reportedYmd: "2026-11-19", epsActual: null, epsEstimate: 1.1 },
    ];
    const filings = [
      { filedAt: "2026-08-26", acceptedAt: "2026-08-27T00:21:19.000Z" },
      { filedAt: "2026-05-20", acceptedAt: "2026-05-21T00:21:19.000Z" },
      { filedAt: "2026-02-25", acceptedAt: "2026-02-26T02:31:25.000Z" },
      { filedAt: "2025-11-19", acceptedAt: null },
    ];
    const events = reportEvents(quarters, filings);
    assert.deepEqual(
      events.map((e) => [e.date, e.hour, e.surprisePct]),
      [
        ["2025-11-19", null, null],
        ["2026-02-25", "amc", null],
        ["2026-05-20", "amc", -10],
        ["2026-08-26", "amc", 20],
      ],
    );
  });

  it("leaves out item 2.02 filings that are not a quarter's report", () => {
    // HPE: reports early in the third month of its quarters; its analyst day outlook (Oct 15, 2025) went out under item 2.02 too.
    const hpe = [
      { reportedAt: "2025-12-04T21:05:00.000Z", reportedYmd: "2025-12-04", epsActual: 0.62, epsEstimate: 0.58 },
      { reportedAt: "2026-03-09T20:05:00.000Z", reportedYmd: "2026-03-09", epsActual: 0.65, epsEstimate: 0.59 },
      { reportedAt: "2026-06-01T20:05:00.000Z", reportedYmd: "2026-06-01", epsActual: 0.79, epsEstimate: 0.53 },
      { reportedAt: "2026-09-02T20:05:00.000Z", reportedYmd: "2026-09-02", epsActual: 1.11, epsEstimate: 0.94 },
    ];
    const hpeFilings = [
      { filedAt: "2025-09-03", acceptedAt: "2025-09-03T20:08:08.000Z", acceptedAtUtc: true },
      { filedAt: "2025-10-15", acceptedAt: "2025-10-15T20:47:46.000Z", acceptedAtUtc: true },
      { filedAt: "2025-12-04", acceptedAt: "2025-12-04T21:07:19.000Z", acceptedAtUtc: true },
    ];
    assert.deepEqual(
      reportEvents(hpe, hpeFilings).map((e) => e.date),
      ["2025-09-03", "2025-12-04", "2026-03-09", "2026-06-01", "2026-09-02"],
    );
    // Tesla: delivery figures two days into each quarter, the report about three weeks later.
    const tsla = [
      { reportedAt: "2026-04-22T20:05:00.000Z", reportedYmd: "2026-04-22", epsActual: 0.41, epsEstimate: 0.35 },
      { reportedAt: "2026-07-22T20:30:00.000Z", reportedYmd: "2026-07-22", epsActual: 0.33, epsEstimate: 0.54 },
    ];
    const tslaFilings = [
      { filedAt: "2026-01-02", acceptedAt: "2026-01-02T14:20:13.000Z", acceptedAtUtc: true },
      { filedAt: "2026-01-28", acceptedAt: "2026-01-28T21:11:04.000Z", acceptedAtUtc: true },
      { filedAt: "2026-04-02", acceptedAt: "2026-04-02T13:07:13.000Z", acceptedAtUtc: true },
      { filedAt: "2026-07-02", acceptedAt: "2026-07-02T13:01:26.000Z", acceptedAtUtc: true },
    ];
    assert.deepEqual(
      reportEvents(tsla, tslaFilings).map((e) => e.date),
      ["2026-01-28", "2026-04-22", "2026-07-22"],
    );
  });
});
