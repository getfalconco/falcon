/**
 * cardExplain (@falcon/ripple): every card reads as four plain answers built
 * from templates and filed facts, inside the framing rules.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { describe, it } from "node:test";
import { cardExplain, type RippleCard, type RippleHit } from "@falcon/ripple";
import { framingProblems, withoutName } from "../src/validate.ts";

const own = { n: 2844, meanAbnPct: 0.96, windowDays: 20, period: "2015-01 to 2026-06" };

function hit(over: Partial<RippleHit> = {}): RippleHit {
  return {
    ticker: "KGS",
    companyName: "Kodiak Gas Services, Inc.",
    relation: "self",
    degree: 1,
    direction: "up",
    confidence: "medium",
    window: "1 to 4 weeks",
    mechanism: "m",
    evidence: [],
    history: null,
    tier: "documented",
    documentedBy: { citation: "Cohen, Malloy & Pomorski (2012)", url: "https://doi.org/x", effect: "e", period: "1986-2007", match: "exact", ownEstimate: own },
    ...over,
  };
}

function card(over: Partial<RippleCard["event"]> = {}, hits: RippleHit[] = [hit()], extra: Partial<RippleCard> = {}): RippleCard {
  return {
    id: "c",
    sector: "semis",
    generatedAt: "2026-11-14T12:00:00Z",
    tier: hits[0]?.tier,
    hits,
    event: {
      id: "e",
      ticker: "KGS",
      companyName: "Kodiak Gas Services, Inc.",
      kind: "filing",
      headline: "raw headline",
      occurredAt: "2026-11-13T21:00:00Z",
      summary: "raw summary",
      source: { title: "Form 4", url: "https://www.sec.gov/x", publisher: "SEC EDGAR" },
      eventType: "insider_cluster",
      details: { insiders: 3, insiderNames: "Jane Roe (Director); John Doe (Chief Executive Officer, Director); Ann Lee (CFO)", totalUsd: 544115, totalShares: 12145, firstTradeDate: "2026-11-11", lastTradeDate: "2026-11-12", marketValueUsd: 5e9 },
      ...over,
    },
    ...extra,
  };
}

function framed(x: ReturnType<typeof cardExplain>, name: string): string[] {
  return [x.title, x.what, x.why, x.past, x.caution, x.whyShort, x.pastShort ?? ""].flatMap((t, i) => framingProblems(withoutName(t, name), `part ${i}`));
}

describe("cardExplain", () => {
  it("writes an insider cluster in plain words with Falcon's own estimate", () => {
    const x = cardExplain(card());
    assert.equal(x.kicker, "Insider buying");
    assert.equal(x.title, "3 Kodiak Gas Services insiders bought $544K of stock");
    assert.match(x.what, /^3 insiders, including Jane Roe \(director\) and John Doe \(CEO\), bought 12,145 shares for \$544K on the open market between Nov 11 and Nov 12/);
    assert.match(x.past, /Since 2015, Falcon found 2,844 similar purchases\. On average the stock beat the market by about 1\.0% over the next 20 trading days/);
    assert.equal(x.pastShort, "Similar cases: avg +1.0% vs market over 20 trading days (2,844 since 2015)");
    assert.equal(x.strength.label, "Backed by research");
    assert.equal(x.signal, "positive");
    assert.match(x.caution, /^For information only, not investment advice\./);
    assert.deepEqual(framed(x, "Kodiak Gas Services"), []);
  });

  it("names a single insider by role, with the right article and possessive", () => {
    const one = (names: string, co: string) =>
      cardExplain(card({ companyName: co, details: { insiders: 1, insiderNames: names, totalUsd: 150000 } })).title;
    assert.equal(one("Travis Dalton (Pres., CEO & Executive Chair, Director)", "Claritev Corp"), "Claritev's CEO bought $150K of stock");
    assert.equal(one("Mike Spanos (CEO, Director)", "Bloomin' Brands, Inc."), "Bloomin' Brands' CEO bought $150K of stock");
    assert.equal(one("Elton Parker (Director)", "Investors Title Co"), "An Investors Title director bought $150K of stock");
  });

  it("drops the late-filing form's stock sentence and keeps a real reason", () => {
    const nt = (reason: string) =>
      cardExplain(card({ eventType: "distress_nt", companyName: "KALA BIO, Inc.", details: { lateReport: "10-Q", reason } }, [hit({ tier: "watch", direction: "down", documentedBy: undefined })])).what;
    assert.equal(nt("The Company will not, without unreasonable effort and expense, be able to file its Quarterly Report"), "KALA BIO told the SEC it needs more time to file its 10-Q.");
    assert.match(nt("The Company filed for Chapter 11 on November 2."), /Its stated reason: "The Company filed for Chapter 11 on November 2\."/);
  });

  it("explains a linked card through the lead hit's relation and record", () => {
    const linked = hit({
      ticker: "CRDO",
      companyName: "Credo Technology Group Holding Ltd",
      relation: "customer",
      tier: "watch",
      documentedBy: undefined,
      history: { sample: 48, hitRate: 26 / 48, avgMovePct: 0.4, windowDays: 20, benchmark: "SPY" } as RippleHit["history"],
    });
    const x = cardExplain(card({ eventType: "monthly_revenue", ticker: "TSM", companyName: "TSMC", headline: "TSMC October revenue up 59.7%", summary: "Revenue rose." }, [linked]));
    assert.equal(x.kicker, "Monthly sales");
    assert.match(x.why, /^Credo Technology Group Holding is a customer of TSMC\./);
    assert.match(x.past, /^In 26 of 48 similar past events, CRDO moved the expected way over the next 20 trading days/);
    assert.equal(x.strength.level, "watching");
    assert.match(x.caution, /no evidence yet/);
    assert.deepEqual(framed(x, "TSMC"), []);
  });

  it("treats an older card without a tier as watching and still answers all four questions", () => {
    const old = card({ eventType: undefined, kind: "earnings_surprise" }, [hit({ tier: undefined, documentedBy: undefined, relation: "competitor" })], { tier: undefined });
    const x = cardExplain(old);
    assert.equal(x.kicker, "Earnings");
    assert.equal(x.strength.level, "watching");
    for (const t of [x.title, x.what, x.why, x.past, x.caution]) assert.ok(t.length > 10);
  });

  it("stays inside the framing rules on the last dry-run feed, when one is present", () => {
    const file = process.env.FALCON_EXPLAIN_FEED;
    if (!file || !fs.existsSync(file)) return;
    const feed = JSON.parse(fs.readFileSync(file, "utf8")) as { cards: RippleCard[] };
    for (const c of feed.cards) assert.deepEqual(framed(cardExplain(c), shortName(c.event.companyName)), [], c.id);
  });
});

function shortName(n: string): string {
  return n.replace(/,?\s+(Inc\.?|Corp\.?|Corporation|Ltd\.?|Co\.?)$/i, "");
}
