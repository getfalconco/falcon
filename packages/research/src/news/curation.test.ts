import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { NewsArticle } from "./article-store.js";
import type { TickerVerdict, Verdict } from "../classifier/types.js";
import {
  curateArticle,
  curateNewsFeed,
  isMaterialVerdict,
  junkReason,
  materialEntries,
  primaryHeadline,
  primarySource,
  verdictIndex,
} from "./curation.js";

const T0 = 1_760_500_000; // unix seconds

function article(id: number, headline: string, over: Partial<NewsArticle> = {}): NewsArticle {
  return {
    id,
    headline,
    summary: "",
    url: `https://finance.yahoo.com/news/${id}`,
    source: "Yahoo",
    datetime: T0,
    tickers: ["NVDA"],
    event: null,
    first_seen: "2026-10-15T00:00:00Z",
    ...over,
  };
}

function verdict(id: number, tickers: TickerVerdict[], over: Partial<Verdict> = {}): Verdict {
  return {
    schema_version: 1,
    prompt_version: "cls-1.0",
    model: "claude-haiku-5-5",
    article_key: `id:${id}`,
    kind: "news",
    event_type: "contract_partnership",
    event_label: "Nvidia signs supply agreement with CoreWeave",
    syndication_scope: tickers.length,
    tickers,
    unassessed_tickers: [],
    status: "ok",
    metadata_missing: false,
    classified_at: "2026-10-15T12:00:00.000Z",
    failure_reason: null,
    ...over,
  };
}

const direct = (ticker: string, materiality: "high" | "standard" | "low", direction: "positive" | "negative" | "mixed" | "unclear" = "positive"): TickerVerdict => ({
  ticker,
  relevance: "direct",
  materiality,
  direction,
});
const indirect = (ticker: string, materiality: "high" | "standard" | "low"): TickerVerdict => ({
  ticker,
  relevance: "indirect",
  materiality,
  direction: "negative",
});

function lookup(...vs: Verdict[]) {
  return { verdictFor: verdictIndex(vs), companyName: (t: string) => (t === "NVDA" ? "NVIDIA Corp" : null) };
}

const headline = (text: string) => ({ text, prompt_version: "hl-1.0", model: "m", written_at: "2026-10-15T12:01:00.000Z" });

describe("curation: the materiality bar", () => {
  it("direct standard or high clears it; low and none never do", () => {
    assert.equal(isMaterialVerdict(verdict(1, [direct("NVDA", "standard")])), true);
    assert.equal(isMaterialVerdict(verdict(1, [direct("NVDA", "high")])), true);
    assert.equal(isMaterialVerdict(verdict(1, [direct("NVDA", "low")])), false);
    assert.equal(isMaterialVerdict(verdict(1, [{ ticker: "NVDA", relevance: "none" }])), false);
  });

  it("indirect needs high", () => {
    assert.equal(isMaterialVerdict(verdict(1, [indirect("AMD", "standard")])), false);
    assert.equal(isMaterialVerdict(verdict(1, [indirect("AMD", "high")])), true);
  });

  it("analyst actions, ownership flows and thematic pieces need high even when direct", () => {
    for (const event_type of ["analyst_action", "ownership_flows", "macro_sector"] as const) {
      assert.equal(isMaterialVerdict(verdict(1, [direct("NVDA", "standard")], { event_type })), false, event_type);
      assert.equal(isMaterialVerdict(verdict(1, [direct("NVDA", "high")], { event_type })), true, event_type);
    }
  });

  it("a failed verdict clears nothing", () => {
    assert.equal(isMaterialVerdict(verdict(1, [direct("NVDA", "high")], { status: "failed" })), false);
  });

  it("orders the material names strongest first, direct before indirect", () => {
    const names = materialEntries(
      verdict(1, [indirect("AMD", "high"), direct("NVDA", "standard"), direct("AVGO", "high"), direct("INTC", "low")]),
    ).map((t) => t.ticker);
    assert.deepEqual(names, ["AVGO", "AMD", "NVDA"]);
  });
});

describe("curation: shapes that are never news", () => {
  it("catches roundups, lists, recaps, opinion and questions", () => {
    for (const line of [
      "Stay informed about the most active stocks in the S&P500 index on Thursday's session.",
      "Sector Update: Tech Stocks Fall Thursday Afternoon",
      "Stock Market Today: Nasdaq Pares Loss As Yields Dive",
      "Why Walmart (WMT) Stock Is Up Today",
      "FormFactor, Teradyne, Applied Materials, AMD, and Intel Shares Plummet, What You Need To Know",
      "I'd Suggest Rethinking Retiring in 2027 if Any of These 3 Things Apply to You",
      "Is Costco Stock Increasing Your Market Risk?",
      "Stocks making big moves yesterday: Cullen/Frost Bankers, Bank of America",
      "3 Stocks To Watch After The Fed Decision",
      "These S&P500 stocks are gapping in today's session",
      "1 Reason to Buy and Hold This Dividend Stock for the Next 10 Years",
      "Why The RealReal Stock Popped on Thursday",
      "ServiceNow Climbs 5% After Denying Decagon Acquisition Interest; Salesforce Rises 4%, Palantir Dips",
      "I’m Simply Not Worried About Broadcom’s Multi-Segment Drag",
      "Prediction: Broadcom Could Be the AI Winner After Nvidia",
      "AbbVie vs. Pfizer: Which Healthcare Stock Is a Better Buy in 2026",
    ]) {
      assert.ok(junkReason(line), line);
    }
  });

  it("leaves event headlines alone", () => {
    for (const line of [
      "Micron's New Taiwan Plant Is Sold Out for 2027",
      "Nvidia's Huang Signals CoreWeave Financials Improving",
      "Apple COO Jeff Williams to retire at year end",
      "FDA approves Lilly's obesity pill",
      "Taiwan Semiconductor Q3 Earnings & Revenues Top Estimates, Margins Up",
      "Constellation Energy (CEG) Boosts Guidance and Expands Nuclear Deals with Tech Giants",
      "FMC Stock Plummets 35% on Horrendous Guidance",
    ]) {
      assert.equal(junkReason(line), null, line);
    }
  });
});

describe("curation: one story", () => {
  it("shows a material story under Falcon's headline", () => {
    const a = article(1, "Nvidia SHOCKS Wall Street With CoreWeave Mega Deal!!", { summary: "Nvidia agreed to supply CoreWeave." });
    const v = verdict(1, [direct("NVDA", "high", "positive"), { ticker: "AMD", relevance: "none" }], {
      headline: headline("Nvidia agrees to supply CoreWeave with data center chips"),
    });
    const c = curateArticle(a, lookup(v));
    assert.equal(c.decision, "show");
    assert.equal(c.headline, "Nvidia agrees to supply CoreWeave with data center chips");
    assert.equal(c.headline_source, "falcon");
    assert.deepEqual(c.tickers, ["NVDA"]);
    assert.equal(c.materiality, "high");
    assert.equal(c.direction, "positive");
  });

  it("falls back to the classifier's label when there is no Falcon headline, if the label passes the rules", () => {
    const c = curateArticle(article(2, "Nvidia inks CoreWeave pact"), lookup(verdict(2, [direct("NVDA", "standard")])));
    assert.equal(c.decision, "show");
    assert.equal(c.headline_source, "label");
    assert.equal(c.headline, "Nvidia signs supply agreement with CoreWeave");
  });

  it("waits when neither headline nor label passes the rules (never the publisher's line)", () => {
    const v = verdict(3, [direct("NVDA", "high")], {
      event_label: "Nvidia soars on deal",
      headline: headline("Nvidia will soar on a $40 billion deal"),
    });
    const c = curateArticle(article(3, "Nvidia soars on deal"), lookup(v));
    assert.equal(c.decision, "pending");
    assert.equal(c.reason, "awaiting_headline");
    assert.equal(c.headline, null);
  });

  it("re-checks a stored headline's figures against the article", () => {
    const v = verdict(4, [direct("NVDA", "high")], {
      event_label: "",
      headline: headline("Nvidia agrees to a $40 billion supply deal with CoreWeave"),
    });
    const c = curateArticle(article(4, "Nvidia and CoreWeave sign supply deal", { summary: "Terms were not disclosed." }), lookup(v));
    assert.equal(c.decision, "pending");
  });

  it("hides low materiality and none relevance", () => {
    const low = curateArticle(article(5, "Nvidia mentioned in fund letter"), lookup(verdict(5, [direct("NVDA", "low")])));
    assert.deepEqual([low.decision, low.reason], ["hide", "not_material"]);
    const none = curateArticle(article(6, "Funds that hold Nvidia"), lookup(verdict(6, [{ ticker: "NVDA", relevance: "none" }])));
    assert.deepEqual([none.decision, none.reason], ["hide", "not_material"]);
  });

  it("hides junk even with a material verdict", () => {
    const c = curateArticle(article(7, "Why Nvidia Stock Is Up Today"), lookup(verdict(7, [direct("NVDA", "high")])));
    assert.deepEqual([c.decision, c.reason], ["hide", "junk"]);
  });

  it("keeps unclassified third-party coverage back until it has a verdict", () => {
    const c = curateArticle(article(8, "Nvidia and CoreWeave sign supply deal"), lookup());
    assert.deepEqual([c.decision, c.reason, c.headline], ["pending", "unclassified", null]);
  });

  it("hides a story the classifier failed on", () => {
    const c = curateArticle(article(9, "Nvidia and CoreWeave sign supply deal"), lookup(verdict(9, [], { status: "failed" })));
    assert.deepEqual([c.decision, c.reason], ["hide", "failed"]);
  });
});

describe("curation: primary sources", () => {
  it("recognises filings and newswire press releases by host or source", () => {
    assert.equal(primarySource({ source: "SEC", url: "" })?.kind, "sec_filing");
    assert.equal(primarySource({ source: "", url: "https://www.sec.gov/Archives/edgar/data/1/x.htm" })?.kind, "sec_filing");
    assert.deepEqual(primarySource({ source: "Business Wire", url: "" }), { kind: "press_release", wire: "Business Wire" });
    assert.deepEqual(primarySource({ source: "", url: "https://www.prnewswire.com/news-releases/x.html" }), {
      kind: "press_release",
      wire: "PR Newswire",
    });
    assert.equal(primarySource({ source: "Yahoo", url: "https://finance.yahoo.com/x" }), null);
  });

  it("builds the neutral title from the filing type and the company", () => {
    assert.equal(primaryHeadline("sec_filing", "NVIDIA Corp", { headline: "NVIDIA CORP files 8-K" }, ""), "NVIDIA Corp files Form 8-K");
    assert.equal(primaryHeadline("sec_filing", "NVIDIA Corp", { headline: "Form 4 filed by director" }, ""), "NVIDIA Corp files Form 4");
    assert.equal(primaryHeadline("sec_filing", "NVIDIA Corp", { headline: "Filing" }, ""), "NVIDIA Corp files with the SEC");
    assert.equal(
      primaryHeadline("press_release", "NVIDIA Corp", { headline: "NVIDIA Unveils Revolutionary Platform" }, "GlobeNewswire"),
      "NVIDIA Corp issues a press release via GlobeNewswire",
    );
  });

  it("shows a primary source at once, before any verdict", () => {
    const pr = article(10, "NVIDIA Unveils Groundbreaking Platform", { source: "GlobeNewswire" });
    const c = curateArticle(pr, lookup());
    assert.deepEqual([c.decision, c.reason, c.headline_source, c.primary], ["show", "primary_source", "primary", "press_release"]);
    assert.equal(c.headline, "NVIDIA Corp issues a press release via GlobeNewswire");
    assert.deepEqual(c.tickers, ["NVDA"]);
  });

  it("holds a primary source to the bar once its verdict is in", () => {
    const pr = article(11, "NVIDIA to present at investor conference", { source: "Business Wire" });
    const c = curateArticle(pr, lookup(verdict(11, [direct("NVDA", "low")])));
    assert.deepEqual([c.decision, c.reason], ["hide", "not_material"]);
  });
});

describe("curation: the feed", () => {
  it("folds reports of one event into the most material, then earliest, story", () => {
    const first = article(20, "Nvidia, CoreWeave sign deal", { datetime: T0 });
    const later = article(21, "CoreWeave deal for Nvidia", { datetime: T0 + 3600, source: "SeekingAlpha" });
    const stronger = article(22, "Nvidia CoreWeave agreement detailed", { datetime: T0 + 7200 });
    const feed = curateNewsFeed([stronger, later, first], lookup(
      verdict(20, [direct("NVDA", "standard")], { headline: headline("Nvidia signs a supply agreement with CoreWeave") }),
      verdict(21, [direct("NVDA", "standard")], { headline: headline("CoreWeave and Nvidia agree on chip supply terms") }),
      verdict(22, [direct("NVDA", "high")], { headline: headline("Nvidia details the CoreWeave supply agreement") }),
    ));
    const byId = new Map(feed.map((a) => [a.id, a.falcon]));
    assert.equal(byId.get(22)!.decision, "show");
    assert.deepEqual([byId.get(20)!.reason, byId.get(20)!.duplicate_of], ["duplicate", 22]);
    assert.deepEqual([byId.get(21)!.reason, byId.get(21)!.duplicate_of], ["duplicate", 22]);
    // Order is the feed's own.
    assert.deepEqual(feed.map((a) => a.id), [22, 21, 20]);
  });

  it("keeps same-type stories on one name apart when they are more than a day apart, or on different names", () => {
    const a = article(30, "Nvidia signs CoreWeave deal", { datetime: T0 });
    const b = article(31, "Nvidia signs xAI deal", { datetime: T0 + 2 * 86_400 });
    const c = article(32, "AMD signs OpenAI deal", { datetime: T0, tickers: ["AMD"] });
    const feed = curateNewsFeed([a, b, c], lookup(
      verdict(30, [direct("NVDA", "standard")], { headline: headline("Nvidia signs a supply agreement with CoreWeave") }),
      verdict(31, [direct("NVDA", "standard")], { headline: headline("Nvidia signs a supply agreement with xAI") }),
      verdict(32, [direct("AMD", "standard")], { headline: headline("AMD signs a supply agreement with OpenAI") }),
    ));
    assert.deepEqual(feed.map((x) => x.falcon.decision), ["show", "show", "show"]);
  });

  it("folds two stories whose Falcon headlines read the same, whatever their labels", () => {
    const a = article(40, "Lilly pill approved", { datetime: T0, tickers: ["LLY"] });
    const b = article(41, "FDA clears Lilly pill", { datetime: T0 + 60, tickers: ["LLY"] });
    const feed = curateNewsFeed([b, a], lookup(
      verdict(40, [direct("LLY", "high")], { event_type: "regulatory_decision", headline: headline("FDA approves Lilly's obesity pill") }),
      verdict(41, [direct("LLY", "high")], { event_type: "product_clinical", headline: headline("FDA approves Lilly's obesity pill.") }),
    ));
    assert.deepEqual(feed.map((x) => x.falcon.reason), ["duplicate", "material"]);
  });

  it("prefers an ok verdict over a failed one, then the latest, then one with a headline", () => {
    const failed = verdict(50, [], { status: "failed", classified_at: "2026-10-15T13:00:00.000Z" });
    const ok = verdict(50, [direct("NVDA", "high")], { classified_at: "2026-10-15T11:00:00.000Z" });
    assert.equal(verdictIndex([failed, ok])("id:50")?.status, "ok");
    const withHeadline = { ...ok, model: "other", headline: headline("Nvidia signs a supply agreement with CoreWeave") };
    assert.ok(verdictIndex([ok, withHeadline])("id:50")?.headline);
    assert.equal(verdictIndex([ok])("id:51"), null);
  });
});
