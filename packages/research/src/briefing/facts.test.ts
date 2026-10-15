import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MAX_BRIEFING_FACTS, factTier, rankBriefingFacts, secUrl } from "./facts.js";
import type { BriefingFact } from "./types.js";

const SEC = "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/doc.htm";

function redFlag(ticker: string, date: string, over: Partial<BriefingFact> = {}): BriefingFact {
  return { id: `red:${ticker}:${date}`, kind: "red_flag", flag: "restatement", ticker, scope: "held", date, url: SEC, form: "8-K", name: null, previous: null, ...over } as BriefingFact;
}

function insider(ticker: string, event: "purchase_cluster" | "large_purchase", date: string, score = 60, over: Partial<BriefingFact> = {}): BriefingFact {
  return {
    id: `ins:${ticker}:${event}:${date}`,
    kind: "insider",
    event,
    ticker,
    scope: "held",
    date,
    url: SEC,
    form: "4",
    insiders: event === "purchase_cluster" ? 3 : 1,
    value_usd: 1_000_000,
    role: null,
    filer: null,
    score,
    ...over,
  } as BriefingFact;
}

function linked(ticker: string, counterparty: string, onSession: boolean, date: string): BriefingFact {
  return {
    id: `linked:${counterparty}>${ticker}`,
    kind: "linked_report",
    ticker,
    scope: "held",
    date,
    url: SEC,
    form: "10-K",
    counterparty,
    relation: "supplier",
    time: "bmo",
    on_session: onSession,
    sample: 8,
    with_it: 6,
    avg_abs_move_pct: 2.1,
  };
}

function risk(ticker: string, date: string, scope: "held" | "watchlist" = "held"): BriefingFact {
  return { id: `risk:${ticker}:${date}`, kind: "risk_factor", ticker, scope, date, url: SEC, form: "10-Q", count: 2, heading: "We depend on one foundry" };
}

function named(ticker: string, date: string): BriefingFact {
  return { id: `named:${ticker}:${date}`, kind: "counterparty_named", ticker, scope: "held", date, url: SEC, form: "10-K", role: "customer", name: "Acme Corp", pct: null };
}

describe("rankBriefingFacts: the fixed order", () => {
  it("lists red flags, then insider clusters, then linked reports on the session, then new risk factors, then the rest", () => {
    const input = [
      named("AAA", "2026-10-15"),
      risk("BBB", "2026-10-15"),
      linked("CCC", "TSM", true, "2026-10-16"),
      insider("DDD", "purchase_cluster", "2026-10-14"),
      redFlag("EEE", "2026-10-10"),
    ];
    assert.deepEqual(
      rankBriefingFacts(input).map((f) => f.kind),
      ["red_flag", "insider", "linked_report", "risk_factor", "counterparty_named"],
    );
  });

  it("puts a single insider's trade and a next-session linked report with the rest, not with clusters", () => {
    assert.equal(factTier(insider("A", "large_purchase", "2026-10-14")), 4);
    assert.equal(factTier(insider("A", "purchase_cluster", "2026-10-14")), 1);
    assert.equal(factTier(linked("A", "TSM", false, "2026-10-19")), 4);
    assert.equal(factTier(linked("A", "TSM", true, "2026-10-16")), 2);
    const ranked = rankBriefingFacts([insider("A", "large_purchase", "2026-10-15"), risk("B", "2026-10-01")]);
    assert.deepEqual(ranked.map((f) => f.kind), ["risk_factor", "insider"]);
  });

  it("puts held names before watched ones, then the later date, inside one rank", () => {
    const ranked = rankBriefingFacts([
      risk("WAT", "2026-10-15", "watchlist"),
      risk("OLD", "2026-10-09"),
      risk("NEW", "2026-10-14"),
    ]);
    assert.deepEqual(ranked.map((f) => f.ticker), ["NEW", "OLD", "WAT"]);
  });

  it("orders insider clusters on the same day by the insider module's score", () => {
    const ranked = rankBriefingFacts([insider("LOW", "purchase_cluster", "2026-10-14", 61), insider("HIGH", "purchase_cluster", "2026-10-14", 80)]);
    assert.deepEqual(ranked.map((f) => f.ticker), ["HIGH", "LOW"]);
  });

  it("gives the same order whatever order the facts arrive in", () => {
    const input = [
      redFlag("A", "2026-10-12"),
      redFlag("B", "2026-10-12"),
      insider("C", "purchase_cluster", "2026-10-13"),
      risk("D", "2026-10-13"),
      named("E", "2026-10-13"),
      linked("F", "TSM", true, "2026-10-16"),
    ];
    const forward = rankBriefingFacts(input).map((f) => f.id);
    const backward = rankBriefingFacts([...input].reverse()).map((f) => f.id);
    assert.deepEqual(forward, backward);
  });
});

describe("rankBriefingFacts: the cap", () => {
  it(`keeps at most ${MAX_BRIEFING_FACTS}, the highest ranked`, () => {
    const input = [
      ...["A", "B", "C", "D", "E", "F"].map((t) => named(t, "2026-10-13")),
      redFlag("Z", "2026-10-01"),
    ];
    const ranked = rankBriefingFacts(input);
    assert.equal(ranked.length, MAX_BRIEFING_FACTS);
    assert.equal(ranked[0]!.kind, "red_flag");
  });

  it("honours a smaller cap and never a negative one", () => {
    assert.equal(rankBriefingFacts([risk("A", "2026-10-13"), risk("B", "2026-10-13")], 1).length, 1);
    assert.equal(rankBriefingFacts([risk("A", "2026-10-13")], -3).length, 0);
  });

  it("keeps one fact per id", () => {
    assert.equal(rankBriefingFacts([risk("A", "2026-10-13"), risk("A", "2026-10-13")]).length, 1);
  });
});

describe("rankBriefingFacts: what reaches the panel", () => {
  it("drops malformed entries instead of throwing", () => {
    const ranked = rankBriefingFacts([null, 3, {}, { ...risk("A", "2026-10-13"), date: "Oct 13" }, { ...risk("B", "2026-10-13"), ticker: "bad ticker" }, risk("C", "2026-10-13")]);
    assert.deepEqual(ranked.map((f) => f.ticker), ["C"]);
    assert.deepEqual(rankBriefingFacts(undefined as unknown as unknown[]), []);
  });

  it("keeps only https links on sec.gov", () => {
    assert.equal(secUrl(SEC), SEC);
    assert.equal(secUrl("https://sec.gov/x"), "https://sec.gov/x");
    assert.equal(secUrl("http://www.sec.gov/x"), null);
    assert.equal(secUrl("https://www.sec.gov.example.com/x"), null);
    assert.equal(secUrl("javascript:alert(1)"), null);
    assert.equal(secUrl(42), null);
    const [fact] = rankBriefingFacts([{ ...risk("A", "2026-10-13"), url: "https://example.com/a" }]);
    assert.equal(fact!.url, null);
  });
});
