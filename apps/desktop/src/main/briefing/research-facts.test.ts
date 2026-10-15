import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FilingChangeItem, FilingChanges } from "../../shared/filing-changes";
import { buildTrack } from "../../shared/guidance-track";
import type { ActualFigure, GuidanceRelease, GuidanceTrack, GuideFigure } from "../../shared/guidance-types";
import type { InsiderActivityAnswer, InsiderEvent } from "../../shared/insider-types";
import type { ReadthroughResult, ReadthroughRow } from "../../shared/readthrough-types";
import {
  GUIDANCE_LOOKBACK_DAYS,
  INSIDER_MIN_SCORE,
  MAX_NAMED_PER_FILING,
  collectResearchFacts,
  factsFromFilings,
  factsFromGuidance,
  factsFromInsiders,
  factsFromReadthrough,
  type ResearchFactsDeps,
} from "./research-facts";

/** Thursday 2026-10-15, 08:00 New York: the pre-open of that session. */
const NOW = Date.parse("2026-10-15T12:00:00.000Z");
const TODAY = "2026-10-15";
const TARGET = "2026-10-15";
const SEC = "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/doc.htm";

function item(over: Partial<FilingChangeItem> & Pick<FilingChangeItem, "id" | "kind">): FilingChangeItem {
  return { form: "10-K", date: "2026-10-14", url: SEC, text: null, previous: null, name: null, pct: null, previousPct: null, detail: null, notable: true, repeat: false, ...over };
}

function changes(ticker: string, items: FilingChangeItem[]): FilingChanges {
  return { ticker, checkedAt: "2026-10-15T10:00:00.000Z", latest: null, previous: null, quarter: null, quarterRisk: null, riskCount: null, relationships: "compared", items, missing: [] };
}

function event(over: Partial<InsiderEvent> & Pick<InsiderEvent, "id" | "ticker" | "kind">): InsiderEvent {
  return {
    date: "2026-10-12",
    firstDate: "2026-10-01",
    insiders: 3,
    value: 2_500_000,
    roles: ["ceo", "director"],
    trades: [
      {
        name: "A. Person",
        role: "ceo",
        title: "CEO",
        code: "P",
        shares: 1000,
        value: 2_500_000,
        firstDate: "2026-10-12",
        lastDate: "2026-10-12",
        filedAt: "2026-10-14",
        accession: "0001",
        url: SEC,
        sharesBefore: 1000,
        sharesAfter: 2000,
        increase: 1,
        firstPosition: false,
        plan: false,
      },
    ],
    filing: null,
    scope: "held",
    via: null,
    score: 70,
    ...over,
  };
}

function row(over: Partial<ReadthroughRow> & Pick<ReadthroughRow, "counterparty" | "holding">): ReadthroughRow {
  return {
    id: `${over.counterparty}>${over.holding}`,
    counterpartyName: null,
    held: true,
    watchlist: false,
    relation: "supplier",
    tier: "critical",
    namedBy: over.holding,
    form: "10-K",
    filingDate: "2026-02-20",
    sourceUrl: SEC,
    kind: "upcoming",
    date: TARGET,
    time: "bmo",
    status: "confirmed",
    report: null,
    sample: 8,
    stats: {
      events: 8,
      withIt: 6,
      avgAbsMove: 0.0213,
      avgAbsAbnormal: 0.015,
      avgFollow: 0.004,
      avgNextFollow: null,
      nextEvents: 0,
      normalAbsAbnormal: 0.01,
      sensitivity: 1.5,
      surpriseEvents: 0,
      withSurprise: 0,
      beta: 1.1,
      betaFallback: false,
      from: "2024-10-01",
      to: "2026-07-20",
    },
    events: [],
    weight: 0.75,
    score: 1.1,
    ...over,
  };
}

const PR_JUL = "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000050/q1fy27pr.htm";
const PR_OCT = "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000100/q2fy27pr.htm";

function guide(metric: GuideFigure["metric"], fq: 1 | 2 | 3 | 4 | null, low: number, high: number, unit: GuideFigure["unit"] = "currency"): GuideFigure {
  return { metric, basis: "unspecified", period: { fy: 2027, fq }, low, high, unit, currency: "USD", step: unit === "currency" ? 1e8 : 0.01, quote: `${metric} guide` };
}

function actual(metric: ActualFigure["metric"], fq: 1 | 2 | 3 | 4, value: number, unit: ActualFigure["unit"] = "currency"): ActualFigure {
  return { metric, basis: "unspecified", period: { fy: 2027, fq }, value, unit, currency: "USD", quote: `${metric} actual` };
}

/**
 * Two releases: July's guided Q2 revenue at $45B to $47B, EPS at $1.00 to
 * $1.10 and the year at $180B to $185B; October's reports Q2 revenue of $48B
 * (above) and EPS of $0.95 (below), and guides the year at $190B to $195B.
 */
function guidanceTrack(ticker = "NVDA", octoberFiled = "2026-10-14"): GuidanceTrack {
  const july: GuidanceRelease = {
    accession: "0001045810-26-000050",
    filedAt: "2026-07-20",
    url: PR_JUL,
    reported: { fy: 2027, fq: 1 },
    guides: [guide("revenue", 2, 45e9, 47e9), guide("eps", 2, 1.0, 1.1, "per_share"), guide("revenue", null, 180e9, 185e9)],
    actuals: [actual("revenue", 1, 44e9)],
  };
  const october: GuidanceRelease = {
    accession: "0001045810-26-000100",
    filedAt: octoberFiled,
    url: PR_OCT,
    reported: { fy: 2027, fq: 2 },
    guides: [guide("revenue", 3, 50e9, 52e9), guide("revenue", null, 190e9, 195e9)],
    actuals: [actual("revenue", 2, 48e9), actual("eps", 2, 0.95, "per_share")],
  };
  return buildTrack(ticker, [october, july]);
}

describe("factsFromGuidance", () => {
  it("lists a release filed in the last three days: its lead figure against the guide, and a guide raised against the earlier one", () => {
    const facts = factsFromGuidance(guidanceTrack(), "held", TODAY);
    assert.deepEqual(facts.map((f) => f.kind), ["guidance_result", "guidance_revision"]);
    const [result, revision] = facts;
    assert.ok(result && result.kind === "guidance_result");
    // Revenue leads, though EPS missed: the table's order, not the most dramatic line.
    assert.equal(result.metric, "revenue");
    assert.equal(result.position, "above");
    assert.equal(result.actual, 48e9);
    assert.equal(result.low, 45e9);
    assert.equal(result.high, 47e9);
    assert.equal(result.fiscal_quarter, 2);
    assert.equal(result.date, "2026-10-14");
    assert.equal(result.url, PR_OCT);
    assert.equal(result.form, "8-K");
    assert.ok(revision && revision.kind === "guidance_revision");
    assert.equal(revision.revision, "raised");
    assert.equal(revision.fiscal_quarter, null);
    assert.equal(revision.low, 190e9);
    assert.equal(revision.prior_low, 180e9);
    assert.equal(revision.prior_high, 185e9);
    assert.equal(revision.url, PR_OCT);
  });

  it(`says nothing of a release older than ${GUIDANCE_LOOKBACK_DAYS} days, or of a guide kept or given for the first time`, () => {
    assert.deepEqual(factsFromGuidance(guidanceTrack("NVDA", "2026-10-09"), "held", TODAY), []);
    const kept = guidanceTrack();
    const rows = kept.rows.map((r) => (r.revision === "raised" ? { ...r, revision: "kept" as const } : r));
    assert.deepEqual(factsFromGuidance({ ...kept, rows }, "held", TODAY).map((f) => f.kind), ["guidance_result"]);
  });

  it("names a cut guide and a quarter that came in below", () => {
    const track = guidanceTrack();
    const rows = track.rows.map((r) =>
      r.revision === "raised" ? { ...r, revision: "cut" as const } : r.metric === "revenue" && r.state === "resolved" ? { ...r, position: "below" as const, actual: 44e9 } : r,
    );
    const facts = factsFromGuidance({ ...track, rows }, "watchlist", TODAY);
    assert.equal(facts[0]!.kind === "guidance_result" && facts[0]!.position, "below");
    assert.equal(facts[1]!.kind === "guidance_revision" && facts[1]!.revision, "cut");
    assert.ok(facts.every((f) => f.scope === "watchlist"));
  });
});

describe("factsFromFilings", () => {
  it("keeps a new red flag and leaves out one the filing before already carried", () => {
    const facts = factsFromFilings(
      changes("ACME", [
        item({ id: "restatement:1", kind: "restatement", form: "8-K", detail: "4.02" }),
        item({ id: "going_concern:1", kind: "going_concern", repeat: true, notable: false }),
      ]),
      "held",
      TODAY,
    );
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.kind, "red_flag");
    assert.equal(facts[0]!.kind === "red_flag" && facts[0]!.flag, "restatement");
    assert.equal(facts[0]!.url, SEC);
  });

  it("only lists what was filed in the last week", () => {
    const facts = factsFromFilings(changes("ACME", [item({ id: "auditor_change:old", kind: "auditor_change", form: "8-K", date: "2026-09-30" })]), "held", TODAY);
    assert.deepEqual(facts, []);
  });

  it("makes one fact of a filing's new risk factors, with their count and the first heading", () => {
    const facts = factsFromFilings(
      changes("ACME", [
        item({ id: "quarter_risk_new:a:0", kind: "quarter_risk_new", form: "10-Q", text: "We depend on one foundry" }),
        item({ id: "quarter_risk_new:a:1", kind: "quarter_risk_new", form: "10-Q", text: "Export rules" }),
        item({ id: "risk_reworded:a:0", kind: "risk_reworded", notable: false }),
      ]),
      "watchlist",
      TODAY,
    );
    assert.equal(facts.length, 1);
    const [fact] = facts;
    assert.ok(fact && fact.kind === "risk_factor");
    assert.equal(fact.count, 2);
    assert.equal(fact.heading, "We depend on one foundry");
    assert.equal(fact.scope, "watchlist");
  });

  it("keeps at most two first-time names per filing, and a share only when it moved", () => {
    const facts = factsFromFilings(
      changes("ACME", [
        ...["One", "Two", "Three"].map((name, i) => item({ id: `customer_named:a:${i}`, kind: "customer_named", name })),
        item({ id: "customer_share:a", kind: "customer_share", name: "Big Co", pct: 18, previousPct: 11, detail: "revenue" }),
        item({ id: "customer_share:b", kind: "customer_share", name: "Small Co", pct: 10, previousPct: 9, detail: "revenue", notable: false }),
      ]),
      "held",
      TODAY,
    );
    assert.equal(facts.filter((f) => f.kind === "counterparty_named").length, MAX_NAMED_PER_FILING);
    const share = facts.find((f) => f.kind === "share_change");
    assert.ok(share && share.kind === "share_change");
    assert.equal(share.pct, 18);
    assert.equal(share.previous_pct, 11);
    assert.equal(share.basis, "revenue");
  });
});

describe("factsFromInsiders", () => {
  it(`keeps the reader's own names' events at a score of ${INSIDER_MIN_SCORE} or more, filed in the last three days`, () => {
    const facts = factsFromInsiders(
      [
        event({ id: "a", ticker: "AAA", kind: "purchase_cluster" }),
        event({ id: "b", ticker: "BBB", kind: "purchase_cluster", score: INSIDER_MIN_SCORE - 1 }),
        event({ id: "c", ticker: "CCC", kind: "purchase_cluster", scope: "linked" }),
        event({ id: "d", ticker: "DDD", kind: "purchase_cluster", trades: [{ ...event({ id: "x", ticker: "X", kind: "purchase_cluster" }).trades[0]!, filedAt: "2026-10-09" }] }),
      ],
      TODAY,
    );
    assert.deepEqual(facts.map((f) => f.ticker), ["AAA"]);
    const [fact] = facts;
    assert.ok(fact && fact.kind === "insider");
    assert.equal(fact.date, "2026-10-14", "dated by the filing, the day it became public");
    assert.equal(fact.role, "ceo");
    assert.equal(fact.form, "Form 4");
  });

  it("dates and links a 13D by its own filing", () => {
    const facts = factsFromInsiders(
      [event({ id: "13d", ticker: "AAA", kind: "activist_13d", trades: [], insiders: 0, value: null, filing: { form: "SC 13D", filer: "Holder LP", filedAt: "2026-10-15", accession: "9", url: SEC, percent: 7.2 } })],
      TODAY,
    );
    assert.equal(facts.length, 1);
    assert.equal(facts[0]!.form, "SC 13D");
    assert.equal(facts[0]!.kind === "insider" && facts[0]!.filer, "Holder LP");
  });
});

describe("factsFromReadthrough", () => {
  it("keeps held names' linked reports on this session and the next, with the measured line", () => {
    const facts = factsFromReadthrough(
      [
        row({ counterparty: "TSM", holding: "NVDA" }),
        row({ counterparty: "MU", holding: "NVDA", date: "2026-10-16", time: "amc" }),
        row({ counterparty: "ASML", holding: "NVDA", date: "2026-10-20" }),
        row({ counterparty: "AVGO", holding: "AMD", held: false, watchlist: true }),
        row({ counterparty: "INTC", holding: "AMD", kind: "recent", date: "2026-10-14" }),
      ],
      TODAY,
      TARGET,
    );
    assert.deepEqual(facts.map((f) => f.kind === "linked_report" && f.counterparty), ["TSM", "MU"]);
    const [tsm, mu] = facts;
    assert.ok(tsm && tsm.kind === "linked_report" && mu && mu.kind === "linked_report");
    assert.equal(tsm.on_session, true);
    assert.equal(mu.on_session, false);
    assert.equal(tsm.with_it, 6);
    assert.equal(tsm.sample, 8);
    assert.equal(tsm.avg_abs_move_pct, 2.1);
  });

  it("carries the sample size and no figure under three measured reports", () => {
    const [fact] = factsFromReadthrough([row({ counterparty: "TSM", holding: "NVDA", sample: 2, stats: null })], TODAY, TARGET);
    assert.ok(fact && fact.kind === "linked_report");
    assert.equal(fact.sample, 2);
    assert.equal(fact.with_it, null);
    assert.equal(fact.avg_abs_move_pct, null);
  });
});

describe("collectResearchFacts", () => {
  const filings = () => ({
    cached: (t: string) => (t === "ACME" ? changes("ACME", [item({ id: "restatement:1", kind: "restatement", form: "8-K" }), item({ id: "risk_new:1", kind: "risk_new" })]) : null),
  });
  const insiders = () => ({
    peek: (): InsiderActivityAnswer => ({ ok: true, today: TODAY, events: [event({ id: "a", ticker: "NVDA", kind: "purchase_cluster" })], companies: 2, pending: 0, checkedAt: null }),
  });
  const readthrough = () => ({
    radar: async (): Promise<ReadthroughResult> => ({ ok: true, today: TODAY, builtAt: "", rows: [row({ counterparty: "TSM", holding: "NVDA" })], links: 1, truncated: false, degraded: [] }),
  });
  const names = { held: ["NVDA"], watchlist: ["ACME"], positions: [{ ticker: "NVDA", shares: 10 }] };

  it("ranks across sources: red flag, insider cluster, linked report, new risk factor", async () => {
    const out = await collectResearchFacts({ filings, insiders, readthrough, now: () => NOW }, names, TARGET);
    assert.deepEqual(out.facts.map((f) => f.kind), ["red_flag", "insider", "linked_report", "risk_factor"]);
    assert.deepEqual(out.unavailable, []);
  });

  it("goes on without a source that throws, and names it", async () => {
    const deps: ResearchFactsDeps = {
      filings: () => {
        throw new Error("disk gone");
      },
      insiders: () => ({
        peek: () => {
          throw new Error("unreadable");
        },
      }),
      readthrough,
      now: () => NOW,
    };
    const out = await collectResearchFacts(deps, names, TARGET);
    assert.deepEqual(out.facts.map((f) => f.kind), ["linked_report"]);
    assert.deepEqual(out.unavailable.sort(), ["filings", "insiders"]);
  });

  it("goes on without a source that does not answer in time", async () => {
    const slow = () => ({ radar: () => new Promise<ReadthroughResult>(() => {}) });
    const out = await collectResearchFacts({ filings, readthrough: slow, now: () => NOW, timeoutMs: 20 }, names, TARGET);
    assert.deepEqual(out.unavailable, ["readthrough"]);
    assert.equal(out.facts[0]!.kind, "red_flag");
  });

  it("counts a read-through answer that is not ok as unavailable", async () => {
    const failing = () => ({ radar: async (): Promise<ReadthroughResult> => ({ ok: false, error: "unavailable" }) });
    const out = await collectResearchFacts({ readthrough: failing, now: () => NOW }, names, TARGET);
    assert.deepEqual(out, { facts: [], unavailable: ["readthrough"] });
  });

  it("asks nothing when the reader has no names, and nothing of the read-through without a held one", async () => {
    let asked = 0;
    const counting = () => {
      asked += 1;
      return readthrough();
    };
    assert.deepEqual(await collectResearchFacts({ readthrough: counting, now: () => NOW }, { held: [], watchlist: [], positions: [] }, TARGET), { facts: [], unavailable: [] });
    await collectResearchFacts({ readthrough: counting, now: () => NOW }, { held: [], watchlist: ["ACME"], positions: [] }, TARGET);
    assert.equal(asked, 0);
  });

  it("reads guidance with peek alone, ranks it after red flags and clusters beside linked reports, and keeps the cap", async () => {
    let peeked: string[] = [];
    let tracked = 0;
    const guidance = () => ({
      peek: (t: string) => {
        peeked.push(t);
        return t === "NVDA" ? guidanceTrack() : null;
      },
      track: async () => {
        tracked += 1;
        throw new Error("the briefing never fetches guidance");
      },
    });
    const out = await collectResearchFacts({ filings, insiders, readthrough, guidance, now: () => NOW }, names, TARGET);
    assert.equal(tracked, 0);
    assert.deepEqual(peeked.sort(), ["ACME", "NVDA"]);
    assert.deepEqual(out.facts.map((f) => f.kind), ["red_flag", "insider", "linked_report", "guidance_result", "guidance_revision"]);
    assert.equal(out.facts.length, 5, "the new risk factor falls under the cap");
    assert.deepEqual(out.unavailable, []);
    for (const f of out.facts) assert.ok(f.url === null || f.url.startsWith("https://www.sec.gov/"), f.url ?? "");

    peeked = [];
    const failing = () => ({
      peek: () => {
        throw new Error("disk gone");
      },
    });
    const without = await collectResearchFacts({ filings, guidance: failing, now: () => NOW }, names, TARGET);
    assert.deepEqual(without.unavailable, ["guidance"]);
    assert.deepEqual(without.facts.map((f) => f.kind), ["red_flag", "risk_factor"]);
  });

  it("caps the list", async () => {
    const many = () => ({
      cached: (t: string) => changes(t, [item({ id: `restatement:${t}`, kind: "restatement", form: "8-K" })]),
    });
    const tickers = ["A", "B", "C", "D", "E", "F", "G"];
    const out = await collectResearchFacts({ filings: many, now: () => NOW }, { held: tickers, watchlist: [], positions: [] }, TARGET);
    assert.equal(out.facts.length, 5);
  });
});
