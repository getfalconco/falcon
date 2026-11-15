/**
 * Forward studies (src/study/forward.ts, data/preregistration/events-v2-nt10k.json):
 * which events are tagged, that every one reaches the ledger (featured or
 * not, card or not), that NT 10-K cards stay Watch with no measured claim,
 * and how the runner counts and measures them.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import type { DetectorEvent } from "../src/detectors/types.ts";
import { ENGINE_ROOT } from "../src/http.ts";
import { memoryJudgmentStore, STUDY_ROWS_SQL, type ForecastRow } from "../src/ledger.ts";
import { runSightings, type RunOptions } from "../src/pipeline.ts";
import type { EvidenceRegistry } from "../src/quality.ts";
import { nyseSessions } from "../src/study/abnormal.ts";
import { PASS_BAR } from "../src/study/filing-events.ts";
import {
  alignBars,
  forwardStudyOf,
  measureStudyEvent,
  NT10K_STUDY,
  parseChart,
  reviewSample,
  runningCount,
  studyEventsFromLedger,
  studySummaryLine,
  tagStudyRows,
  windowClosed,
  type StudyLedgerRow,
} from "../src/study/forward.ts";
import { summaryLines } from "../src/summary.ts";
import { framingProblems } from "../src/validate.ts";

const LIQUID = { price: 24.5, medianDollarVolume20d: 12_000_000 };
const NEG = { period: "2015-01 to 2026-06", n: 263, nEvents: 115, windowDays: 20, meanAbnPct: -3.01, medianAbnPct: -2.88, tStat: -3.69, p: 0.0002, benchmark: "beta_x_spy", computedAt: "2026-11-15" };
/** A registry that would document late filings (F6 with a negative own estimate), to show the study cap holds anyway. */
const REGISTRY: EvidenceRegistry = {
  version: 1,
  families: {
    F6: { eventType: "distress_nt", label: "Late filing notice", match: "exact", citation: "Bartov & Konchitchki (2017)", url: "https://doi.org/10.2308/acch-51887", effect: "negative returns around NT filings", period: "2000-2008", expectedSign: -1, ownEstimate: NEG },
    F7: { eventType: "insider_cluster", label: "Insider purchase cluster", match: "exact", citation: "Cohen, Malloy & Pomorski (2012)", url: "https://doi.org/10.1111/j.1540-6261.2012.01740.x", effect: "abnormal returns", period: "1986-2007", ownEstimate: { ...NEG, meanAbnPct: 1, tStat: 2.5, p: 0.01 } },
  },
};

function nt(i: number, over: Partial<DetectorEvent> = {}): DetectorEvent {
  const acc = `0000000000-26-${String(900 + i).padStart(6, "0")}`;
  const ticker = `N${String.fromCharCode(65 + i)}`;
  return {
    id: `distress_nt-${acc}`,
    eventType: "distress_nt",
    family: "F6",
    cik: String(9000 + i).padStart(10, "0"),
    ticker,
    companyName: `Company ${ticker}`,
    acceptedAt: "2026-11-16T21:30:00Z",
    accession: acc,
    form: "NT 10-K",
    items: [],
    title: `Company ${ticker} filed a late-filing notice for its 10-K`,
    summary: [`Company ${ticker} told the SEC it will not file its 10-K on time (Form 12b-25).`],
    sign: -1,
    magnitude: null,
    facts: { lateReport: "10-K", significantChangeExpected: i % 2 === 0 },
    sources: [{ title: `NT 10-K: Company ${ticker}`, url: `https://www.sec.gov/Archives/edgar/data/${i}/${acc}-index.htm`, publisher: "SEC EDGAR", publishedAt: "2026-11-16T21:30:00Z" }],
    quotes: ["The Registrant needs additional time to complete the audit of its consolidated financial statements."],
    propagates: "own",
    watchOnlyReasons: [],
    ...over,
  };
}

function insider(i: number): DetectorEvent {
  const acc = `0000000000-26-${String(i).padStart(6, "0")}`;
  const ticker = `T${String.fromCharCode(65 + i)}`;
  return {
    ...nt(0),
    id: `insider_cluster-${acc}`,
    eventType: "insider_cluster",
    family: "F7",
    cik: String(i).padStart(10, "0"),
    ticker,
    companyName: `Company ${ticker}`,
    accession: acc,
    form: "4",
    title: `2 insiders bought $${i + 1}00,000 of Company ${ticker} stock`,
    summary: ["Form 4 filings show open-market purchases."],
    sign: 1,
    magnitude: 0.5 + i,
    facts: {},
    quotes: [`DOE JANE (Chief Executive Officer): Common Stock, 2026-11-10, code P, ${i + 1}000 shares at 24.10`],
  };
}

const run = (events: DetectorEvent[], over: Partial<RunOptions> = {}) =>
  runSightings({
    sector: "semis",
    sinceMs: Date.parse("2026-11-14T00:00:00Z"),
    untilMs: Date.parse("2026-11-18T00:00:00Z"),
    maxCards: 2,
    judge: null,
    graph: { generatedAt: "2026-11-01", names: {}, edges: [] },
    judgments: memoryJudgmentStore(),
    legacyEvents: async () => [],
    detect: async () => events,
    liquidity: async () => LIQUID,
    registry: REGISTRY,
    familyStats: { version: 1, families: {} },
    interimDocumented: true,
    dryRun: true,
    ...over,
  });

describe("events-v2-nt10k pre-registration", () => {
  it("the engine's study matches the frozen file", () => {
    const pre = JSON.parse(fs.readFileSync(path.join(ENGINE_ROOT, NT10K_STUDY.preregistration), "utf8"));
    assert.equal(pre.id, NT10K_STUDY.id);
    assert.equal(pre.writtenAt, "2026-11-15");
    assert.equal(pre.sample.startDate, NT10K_STUDY.startDate);
    assert.equal(pre.outcomes.expectedSign, NT10K_STUDY.expectedSign);
    assert.match(pre.outcomes.primary, /L = 20 sessions/);
    assert.equal(NT10K_STUDY.windowDays, 20);
    assert.match(pre.event.form, /exactly "NT 10-K"/);
    assert.deepEqual(NT10K_STUDY.forms, ["NT 10-K"]);
    assert.ok(pre.passBar.rules.includes(`n >= ${NT10K_STUDY.minN} measured events`));
    assert.equal(NT10K_STUDY.minN, PASS_BAR.minN);
    assert.equal(PASS_BAR.maxOneSidedP, 0.05);
    assert.match(pre.reviewPoint.when, new RegExp(NT10K_STUDY.reviewBy));
    assert.match(pre.reviewPoint.sampleAtReview, new RegExp(NT10K_STUDY.lastEventDateAtReviewBy));
    assert.equal(NT10K_STUDY.status, "open");
  });
});

describe("which events are tagged (forwardStudyOf)", () => {
  it("NT 10-K accepted on or after the start (New York date), with a ticker", () => {
    assert.equal(forwardStudyOf(nt(0))?.id, "events-v2-nt10k");
    // 00:30 New York on the start date counts; 23:00 New York the day before does not.
    assert.equal(forwardStudyOf(nt(0, { acceptedAt: "2026-11-15T05:30:00Z" }))?.id, "events-v2-nt10k");
    assert.equal(forwardStudyOf(nt(0, { acceptedAt: "2026-11-15T04:00:00Z" })), null);
    assert.equal(forwardStudyOf(nt(0, { acceptedAt: "2026-11-13T21:00:00Z" })), null);
  });

  it("not NT 10-K/A, NT 10-Q, NT 20-F, other event types, no ticker or no time", () => {
    for (const form of ["NT 10-K/A", "NT 10-Q", "NT 20-F", "NT 11-K", "10-K"]) assert.equal(forwardStudyOf(nt(0, { form })), null, form);
    assert.equal(forwardStudyOf(nt(0, { form: " NT 10-K " }))?.id, "events-v2-nt10k");
    assert.equal(forwardStudyOf(nt(0, { eventType: "restatement_402" })), null);
    assert.equal(forwardStudyOf(nt(0, { ticker: null })), null);
    assert.equal(forwardStudyOf(nt(0, { acceptedAt: "" })), null);
  });
});

describe("tagging the ledger (tagStudyRows)", () => {
  const row = (event_id: string, over: Partial<ForecastRow> = {}): ForecastRow => ({
    event_id, card_id: `all-${event_id}`, ticker: "X", tier: "watch", family: "F6", sign_pred: -1, window_days: 5, covariates: { relation: "self" }, model_version: "ripple-v1a/own", card_sha256: "a".repeat(64), published: true, ...over,
  });
  const ctx = { cardIdOf: (de: DetectorEvent) => `all-${de.id}`, modelVersion: () => "ripple-v1a/own", noCardWhy: new Map([[nt(2).id, "no filed quote of 20 characters or more"]]) };

  it("adds the study facts to every row of a study event and leaves other rows alone", () => {
    const other = row("insider_cluster-1", { family: "F7", sign_pred: 1 });
    const r = tagStudyRows([row(nt(1).id), row(nt(1).id, { published: false }), other], [nt(1), insider(1)], ctx);
    assert.equal(r.ledger.length, 3);
    for (const x of r.ledger.slice(0, 2)) {
      assert.equal(x.covariates.study, "events-v2-nt10k");
      assert.equal(x.covariates.studyForm, "NT 10-K");
      assert.equal(x.covariates.studyCik, nt(1).cik);
      assert.equal(x.covariates.studyAccession, nt(1).accession);
      assert.equal(x.covariates.studyAcceptedAt, nt(1).acceptedAt);
      assert.equal(x.covariates.studyWindowDays, 20);
      assert.equal(x.covariates.studySignificantChange, false);
      assert.equal(x.covariates.relation, "self");
    }
    assert.equal(r.ledger[2], other);
    assert.deepEqual(r.tagged["events-v2-nt10k"], { events: [nt(1).id], withoutCard: 0 });
  });

  it("logs a study event that has no card with a row of its own, once", () => {
    const r = tagStudyRows([], [nt(2), nt(2), nt(3, { form: "NT 10-Q" }), nt(6, { acceptedAt: "2026-11-13T21:00:00Z" })], ctx);
    assert.deepEqual(r.beforeStart, { "events-v2-nt10k": 1 });
    assert.equal(r.ledger.length, 1);
    const x = r.ledger[0]!;
    assert.equal(x.event_id, nt(2).id);
    assert.equal(x.card_id, `all-${nt(2).id}`);
    assert.equal(x.ticker, nt(2).ticker);
    assert.equal(x.tier, "watch");
    assert.equal(x.published, false);
    assert.equal(x.card_sha256, null);
    assert.equal(x.sign_pred, -1);
    assert.equal(x.window_days, 20);
    assert.equal(x.family, "F6");
    assert.equal(x.covariates.study, "events-v2-nt10k");
    assert.equal(x.covariates.noCard, "no filed quote of 20 characters or more");
    assert.deepEqual(r.tagged["events-v2-nt10k"], { events: [nt(2).id], withoutCard: 1 });
  });
});

describe("a Sightings run logs every NT 10-K, featured or not, card or not", () => {
  it("tags featured, unfeatured and card-less NT 10-K events; not NT 10-Q; NT 10-K cards stay Watch", async () => {
    const noQuote = nt(4, { quotes: [] });
    const tenQ = nt(5, { form: "NT 10-Q" });
    const events = [nt(1), nt(2), nt(3), noQuote, tenQ, insider(1), insider(2), insider(3)];
    const r = await run(events);
    // Two cards featured (Documented ones outrank Watch): no NT 10-K among them.
    assert.equal(r.feed.cards.length, 2);
    const ntK = new Set([nt(1).id, nt(2).id, nt(3).id, noQuote.id]);
    assert.ok(r.feed.cards.every((c) => c.tier === "documented" && !ntK.has(c.event.id)));
    const ledger = r.ledger ?? [];
    const tagged = ledger.filter((x) => x.covariates.study === "events-v2-nt10k");
    assert.deepEqual(new Set(tagged.map((x) => x.event_id)), ntK);
    assert.ok(tagged.every((x) => x.published === false && x.tier === "watch" && x.sign_pred === -1));
    assert.equal(tagged.find((x) => x.event_id === noQuote.id)?.covariates.noCard, "no filed quote of 20 characters or more");
    assert.equal(tagged.find((x) => x.event_id === noQuote.id)?.card_sha256, null);
    assert.ok(tagged.filter((x) => x.event_id !== noQuote.id).every((x) => x.card_sha256?.length === 64));
    // The NT 10-Q is logged as an ordinary card row, without the study tag.
    const q = ledger.filter((x) => x.event_id === tenQ.id);
    assert.equal(q.length, 1);
    assert.equal(q[0]!.covariates.study, undefined);
    assert.deepEqual(r.studies?.["events-v2-nt10k"], { events: [nt(1).id, nt(2).id, nt(3).id, noQuote.id], withoutCard: 1 });
    // The registry here would document late filings; the NT 10-Q is Documented, the NT 10-K capped at Watch.
    assert.equal(q[0]!.tier, "documented");
    assert.equal(r.analysis?.tiers.documented, 4);
  });

  it("an NT 10-K card is Watch, not an opportunity, and its text claims no measured effect", async () => {
    const r = await run([nt(1)], { maxCards: 5 });
    const c = r.feed.cards[0]!;
    const h = c.hits[0]!;
    assert.equal(c.tier, "watch");
    assert.equal(h.tier, "watch");
    assert.equal(h.documentedBy, undefined);
    assert.equal(h.opportunityEligible, false);
    assert.equal(h.direction, "down");
    assert.match(h.scoreReason ?? "", /no measured effect for it yet/);
    // Featured: its ledger row is published and tagged.
    assert.deepEqual(r.ledger?.map((x) => [x.event_id, x.published, x.covariates.study]), [[nt(1).id, true, "events-v2-nt10k"]]);
    for (const text of [h.mechanism, h.scoreReason ?? "", h.invalidatedBy ?? "", c.event.headline, c.event.summary]) {
      assert.doesNotMatch(text, /\d+(\.\d+)?\s*%|backed by|on average|historically|tends? to|research (shows|documents)|documented/i, text);
      assert.deepEqual(framingProblems(text, "t"), []);
    }
    const line = summaryLines({ run: r, judged: 0, judgeName: "none", publish: { state: "dry-run" }, exitCode: 0, studyLedger: { "events-v2-nt10k": { events: 7, duplicates: 1, windowClosed: 2 } } }).find((l) => l.startsWith("forward study"));
    assert.equal(line, "forward study events-v2-nt10k (NT 10-K from 2026-11-15, open): 1 events tagged this run; running n 7 in the ledger (1 repeats within 30 days left out), 2 past the 20-session window; bar n >= 100 measured, review at n 100 or 2027-12-31");
  });
});

describe("reading the ledger (runner)", () => {
  const lrow = (eventId: string, cik: string, acceptedAt: string, over: Partial<StudyLedgerRow> = {}): StudyLedgerRow => ({
    event_id: eventId, ticker: "X", created_at: "2026-11-20T12:00:00.000Z", published: false,
    covariates: { study: "events-v2-nt10k", studyCik: cik, studyAcceptedAt: acceptedAt, studyAccession: eventId, studySignificantChange: true },
    ...over,
  });

  it("selects only the study's rows, read-only", () => {
    assert.match(STUDY_ROWS_SQL, /covariates->>'study' = \$1/);
    assert.doesNotMatch(STUDY_ROWS_SQL, /insert|update|delete/i);
  });

  it("one event per id (published if any run featured it), one per issuer per 30 days, from the start date", () => {
    const rows = [
      lrow("a", "1", "2026-11-16T21:30:00Z"),
      lrow("a", "1", "2026-11-16T21:30:00Z", { published: true, created_at: "2026-11-21T12:00:00.000Z" }),
      lrow("b", "1", "2026-12-01T21:30:00Z"), // same issuer, 15 days later: a repeat
      lrow("c", "1", "2026-12-20T21:30:00Z"), // 34 days after a: kept
      lrow("d", "2", "2026-11-10T21:30:00Z"), // before the start
      lrow("e", "3", "2026-11-17T21:30:00Z", { covariates: { study: "events-v2-nt10k" } }), // no facts
      lrow("f", "4", "2026-11-18T21:30:00Z", { covariates: { study: "other" } }),
    ];
    const r = studyEventsFromLedger(rows, NT10K_STUDY);
    assert.deepEqual(r.events.map((e) => e.eventId), ["a", "c"]);
    assert.equal(r.events[0]!.published, true);
    assert.equal(r.events[0]!.date, "2026-11-16");
    assert.equal(r.duplicates, 1);
    assert.equal(r.unreadable, 1);
    assert.deepEqual(runningCount(rows, NT10K_STUDY, Date.parse("2026-12-16T00:00:00Z")), { events: 2, duplicates: 1, windowClosed: 1 });
  });

  it("a window closes at the close of its 20th session from the first open after acceptance", () => {
    // Accepted Monday 2026-11-16 after the close: entry Tuesday 11-17; 20 sessions (Thanksgiving closed) end Tuesday 12-15.
    const at = "2026-11-16T21:30:00Z";
    assert.equal(windowClosed(at, 20, Date.parse("2026-12-15T20:59:00Z")), false);
    assert.equal(windowClosed(at, 20, Date.parse("2026-12-15T21:01:00Z")), true);
    assert.equal(windowClosed(at, 20, Date.parse("2026-11-20T21:01:00Z")), false);
  });

  it("the review sample: the first 100 measured, else every measured one at the review date", () => {
    const evs = Array.from({ length: 130 }, (_, i) => ({ date: i < 120 ? "2027-03-01" : "2027-12-10", measured: i % 10 !== 0 }));
    const first = reviewSample(evs, NT10K_STUDY, "2027-06-01");
    assert.equal(first.reviewDue, true);
    assert.equal(first.sample.length, 100);
    const few = evs.slice(0, 50);
    const running = reviewSample(few, NT10K_STUDY, "2027-06-01");
    assert.equal(running.reviewDue, false);
    assert.equal(running.sample.length, 45);
    const late = [...few, { date: "2027-12-10", measured: true }];
    const atDate = reviewSample(late, NT10K_STUDY, "2027-12-31");
    assert.equal(atDate.reviewDue, true);
    assert.equal(atDate.sample.length, 45);
  });

  it("the runner's summary line says when the ledger could not be read", () => {
    assert.match(studySummaryLine(NT10K_STUDY, { events: 0, withoutCard: 0 }, null), /running n not read \(no database\)/);
    assert.match(studySummaryLine(NT10K_STUDY, { events: 2, withoutCard: 1 }, { error: "42P01 relation missing" }), /2 events tagged this run \(1 without a card\); running n unreadable \(42P01/);
  });
});

describe("measuring a study event (events-v1 gate and primary column)", () => {
  const sessions = nyseSessions("2025-10-01", "2026-12-31");
  const entryAt = "2026-11-16T21:30:00Z";
  /** SPY with deterministic returns; the stock 1.2 x SPY before entry, then 0.1% a session below that. Opens equal the previous close. */
  function series(price0: number, volume: number) {
    const n = sessions.length;
    const spyC: number[] = [];
    const stC: number[] = [];
    const entry = sessions.indexOf("2026-11-17");
    for (let i = 0; i < n; i++) {
      const rm = 0.004 * Math.sin(i * 1.7) + 0.002 * Math.cos(i * 0.31);
      spyC.push(i ? spyC[i - 1]! * (1 + rm) : 400);
      stC.push(i ? stC[i - 1]! * (1 + 1.2 * rm - (i >= entry ? 0.001 : 0)) : price0);
    }
    const open = (c: number[]) => c.map((x, i) => (i ? c[i - 1]! : x));
    const toBars = (c: number[], v: number) => ({ dates: [...sessions], open: open(c), close: c, adjClose: c, volume: c.map(() => v), splits: [] });
    return { spy: alignBars(toBars(spyC, 1e8), sessions), stock: alignBars(toBars(stC, volume), sessions) };
  }

  it("beta x SPY over 20 sessions from the entry open", () => {
    const { spy, stock } = series(30, 1_000_000);
    const m = measureStudyEvent(sessions, stock, spy, entryAt, 20);
    assert.ok(m.ok);
    if (!m.ok) return;
    assert.equal(m.entryDate, "2026-11-17");
    assert.ok(Math.abs(m.beta - 1.2) < 0.01, String(m.beta));
    assert.ok(m.betaSpyPct < -1.9 && m.betaSpyPct > -2.1, String(m.betaSpyPct));
  });

  it("the $5 price and $5M dollar-volume gates, and an open window", () => {
    const cheap = series(3, 10_000_000);
    assert.deepEqual(measureStudyEvent(sessions, cheap.stock, cheap.spy, entryAt, 20), { ok: false, reason: "below_price" });
    const thin = series(30, 100_000);
    assert.deepEqual(measureStudyEvent(sessions, thin.stock, thin.spy, entryAt, 20), { ok: false, reason: "below_volume" });
    const short = nyseSessions("2025-10-01", "2026-11-30");
    const s = series(30, 1_000_000);
    const cut = (a: { open: ArrayLike<number>; close: ArrayLike<number>; raw: number[]; dv: number[] }) => ({ open: Array.from(a.open).slice(0, short.length), close: Array.from(a.close).slice(0, short.length), raw: a.raw.slice(0, short.length), dv: a.dv.slice(0, short.length) });
    assert.deepEqual(measureStudyEvent(short, cut(s.stock), cut(s.spy), entryAt, 20), { ok: false, reason: "window_open" });
  });

  it("parses Yahoo's chart answer", () => {
    const json = {
      chart: {
        result: [
          {
            meta: { gmtoffset: -18000 },
            timestamp: [Date.parse("2026-11-16T14:30:00Z") / 1000, Date.parse("2026-11-17T14:30:00Z") / 1000],
            events: { splits: { x: { date: Date.parse("2026-11-17T14:30:00Z") / 1000, numerator: 2, denominator: 1 } } },
            indicators: { quote: [{ open: [10, null], close: [11, 12], volume: [100, 200] }], adjclose: [{ adjclose: [10.5, 12] }] },
          },
        ],
      },
    };
    const b = parseChart(json)!;
    assert.deepEqual(b.dates, ["2026-11-16"]);
    assert.deepEqual(b.splits, [{ date: "2026-11-17", ratio: 2 }]);
    const a = alignBars(b, ["2026-11-16", "2026-11-17"]);
    assert.equal(a.close[0], 10.5);
    assert.ok(Math.abs(a.open[0]! - 10 * (10.5 / 11)) < 1e-9);
    assert.equal(a.raw[0], 22);
    assert.equal(a.dv[0], 1100);
    assert.ok(Number.isNaN(a.close[1]));
    assert.equal(parseChart({}), null);
  });
});
