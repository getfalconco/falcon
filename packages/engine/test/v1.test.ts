/**
 * Ripple Engine v1a (docs/design/ripple-engine-v1.md): tiers, judge once,
 * own-firm cards, expiry, the Opportunities interim rule and the contract's
 * fallbacks for unknown values.
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  anyClearsBar,
  cardLive,
  cardTier,
  eventTypeLabel,
  isWeakSignal,
  opportunityCard,
  opportunityCards,
  tierLabel,
  DOCUMENTED_LABEL,
  type RippleCard,
  type RippleHit,
} from "@falcon/ripple";
import type { DetectorEvent } from "../src/detectors/types.ts";
import type { DetectedEvent } from "../src/events.ts";
import type { Graph } from "../src/graph.ts";
import { recordEvents, type Move } from "../src/history.ts";
import { checkAnswer, SYSTEM_PROMPT, type Judge, type JudgeRequest } from "../src/judge.ts";
import { candidatesHash, canonicalJson, fileJudgmentStore, memoryJudgmentStore } from "../src/ledger.ts";
import { fromDetector, ownFirmCard, runSightings } from "../src/pipeline.ts";
import {
  assignTier,
  expiresAtOf,
  familyPasses,
  interimDocumentedFlag,
  isLiquid,
  loadEvidenceRegistry,
  loadFamilyStats,
  windowSessions,
  type EvidenceRegistry,
  type FamilyStats,
  type QualityContext,
  type QualityInput,
} from "../src/quality.ts";
import { MARK_STALE_SQL } from "../src/supabase.ts";
import { cardProblems, hitProblems } from "../src/validate.ts";
import { allowedCalls, callBudget } from "../src/vote.ts";

// ---------------------------------------------------------------------------
// Fixtures

const OWN_ESTIMATE = { period: "2015-01 to 2026-06", n: 1234, nEvents: 980, windowDays: 20, meanAbnPct: 1.1, medianAbnPct: 0.4, tStat: 3.1, p: 0.001, benchmark: "market_model", computedAt: "2026-11-15" };

const REGISTRY: EvidenceRegistry = {
  version: 1,
  families: {
    F7: { eventType: "insider_cluster", label: "Insider purchase cluster", match: "exact", citation: "Cohen, Malloy & Pomorski (2012), Journal of Finance", url: "https://www.nber.org/papers/w16454", effect: "opportunistic insider purchases earned about 82 bp/month value-weighted", period: "1986-2007", ownEstimate: OWN_ESTIMATE },
    F1: { eventType: "guidance_down", label: "Customer guidance cut", match: "analogous", citation: "Cohen & Frazzini (2008)", url: "https://ideas.repec.org/a/bla/jfinan/v63y2008i4p1977-2011.html", effect: "customer momentum", period: "1981-2004", ownEstimate: { ...OWN_ESTIMATE, p: 0.3 } },
    F2: { eventType: "guidance_up", label: "Customer guidance raise", match: "analogous", citation: "Cohen & Frazzini (2008)", url: "https://ideas.repec.org/a/bla/jfinan/v63y2008i4p1977-2011.html", effect: "customer momentum", period: "1981-2004", ownEstimate: { ...OWN_ESTIMATE, p: 0.1 } },
    F6: { eventType: "distress_nt", label: "Late filing", match: "exact", citation: "Bartov & Konchitchki (2017)", url: "https://example.org/paper", effect: "negative returns after NT filings", period: "2001-2012", ownEstimate: null },
    F8: { eventType: "activist_stake", label: "Activist", match: "exact", citation: "Brav et al. (2008)", url: "https://example.org/brav", effect: "about 7% around filing", period: "2001-2006", ownEstimate: { ...OWN_ESTIMATE, meanAbnPct: -0.2 } },
    F5: { eventType: "customer_bankruptcy", label: "Bankruptcy", match: "exact", citation: "Jorion & Zhang (2009)", url: "https://example.org/jz", effect: "creditor losses", period: "1999-2005", ownEstimate: { ...OWN_ESTIMATE, period: "2005-01 to 2014-12" } },
  },
};

const PASSING: FamilyStats = { version: 1, families: { F7: { bhQ: 0.05, calendarT: 2.2, validationMeanY: 0.4, n: 500, nEvents: 210 } } };
const LIQUID = { price: 24.5, medianDollarVolume20d: 12_000_000 };

const ctx = (over: Partial<QualityContext> = {}): QualityContext => ({ registry: REGISTRY, stats: { version: 1, families: {} }, interimDocumented: true, ...over });
const own = (over: Partial<QualityInput> = {}): QualityInput => ({ family: "F7", direction: "up", relation: "self", liquidity: LIQUID, pricedIn: false, watchOnlyReasons: [], linkTier: null, quoted: true, ...over });

function insider(over: Partial<DetectorEvent> = {}): DetectorEvent {
  return {
    id: "insider_cluster-0001127602-26-000123",
    eventType: "insider_cluster",
    family: "F7",
    cik: "0000000001",
    ticker: "ACME",
    companyName: "Acme Semiconductor",
    acceptedAt: "2026-11-12T21:05:00Z",
    accession: "0001127602-26-000123",
    form: "4",
    items: [],
    title: "3 insiders bought $1.2M of Acme Semiconductor stock between Nov 10 and Nov 12",
    summary: ["Form 4 filings show open-market purchases by three officers.", "In all, 50,000 shares for $1.2M."],
    sign: 1,
    magnitude: 0.4,
    facts: { insiders: 3 },
    sources: [{ title: "Form 4: Jane Doe, Acme", url: "https://www.sec.gov/Archives/edgar/data/1/000112760226000123/0001127602-26-000123-index.htm", publisher: "SEC EDGAR", publishedAt: "2026-11-12T21:05:00Z" }],
    quotes: ["DOE JANE (Chief Executive Officer): Common Stock, 2026-11-10, code P, 20000 shares at 24.10"],
    propagates: "own",
    watchOnlyReasons: [],
    ...over,
  };
}

function hit(over: Partial<RippleHit> = {}): RippleHit {
  return {
    ticker: "KLAC",
    companyName: "KLA",
    relation: "supplier",
    degree: 1,
    direction: "up",
    confidence: "medium",
    window: "1 to 4 weeks",
    mechanism: "A test mechanism that is long enough to pass the length check.",
    evidence: [{ quote: "TSMC is our sole manufacturing partner for our integrated circuits.", form: "10-K", filedAt: "2026-02-20", url: "https://www.sec.gov/Archives/edgar/data/1/x.htm" }],
    history: null,
    ...over,
  };
}

function card(hits: RippleHit[], over: Partial<RippleCard> = {}): RippleCard {
  return {
    id: "semis-X-1",
    sector: "semis",
    generatedAt: "2026-11-12T16:00:00Z",
    event: { id: "X-1", ticker: "TSM", companyName: "TSMC", kind: "filing", headline: "TSMC October revenue", occurredAt: "2026-11-10T12:01:33Z", summary: "Revenue rose.", source: { title: "6-K", url: "https://www.sec.gov/x", publisher: "SEC EDGAR" } },
    hits,
    ...over,
  };
}

const DOC_BY = { citation: "Cohen, Malloy & Pomorski (2012)", url: "https://www.nber.org/papers/w16454", effect: "x", period: "1986-2007", match: "exact" as const };
const selfDoc = (over: Partial<RippleHit> = {}) => hit({ ticker: "ACME", relation: "self", tier: "documented", documentedBy: DOC_BY, opportunityEligible: true, ...over });

// ---------------------------------------------------------------------------

describe("tiers (src/quality.ts)", () => {
  it("nothing is Documented or Measured without the registry and the family statistics", () => {
    const empty: QualityContext = { registry: { version: 1, families: {} }, stats: { version: 1, families: {} }, interimDocumented: true };
    assert.equal(assignTier(own(), empty).tier, "watch");
    assert.deepEqual(loadEvidenceRegistry(path.join(os.tmpdir(), "no-such-registry.json")).families, {});
    assert.deepEqual(loadFamilyStats(path.join(os.tmpdir(), "no-such-stats.json")).families, {});
  });

  it("reads a registry file in the agreed schema", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-registry-"));
    const file = path.join(dir, "evidence-registry.json");
    fs.writeFileSync(file, JSON.stringify(REGISTRY));
    assert.equal(loadEvidenceRegistry(file).families.F7?.ownEstimate?.meanAbnPct, 1.1);
    fs.writeFileSync(file, "{not json");
    assert.deepEqual(loadEvidenceRegistry(file).families, {});
  });

  it("Documented: exact evidence with a positive post-2015 own estimate, liquid, directional", () => {
    const t = assignTier(own(), ctx());
    assert.equal(t.tier, "documented");
    assert.equal(t.documentedBy?.match, "exact");
    assert.equal(t.opportunityEligible, true);
  });

  it("analogous evidence needs the own estimate's p below 0.20", () => {
    assert.equal(assignTier(own({ family: "F1", relation: "supplier", linkTier: "named" }), ctx()).tier, "watch");
    assert.equal(assignTier(own({ family: "F2", relation: "supplier", linkTier: "named" }), ctx()).tier, "documented");
  });

  it("no own estimate, a non-positive one or a pre-2015 one is Watch", () => {
    assert.equal(assignTier(own({ family: "F6" }), ctx()).tier, "watch");
    assert.equal(assignTier(own({ family: "F8" }), ctx()).tier, "watch");
    assert.equal(assignTier(own({ family: "F5" }), ctx()).tier, "watch");
    assert.equal(assignTier(own({ family: "F10" }), ctx()).tier, "watch");
  });

  it("unclear, illiquid, unknown price, priced in, watch-only flags and list links are Watch", () => {
    assert.equal(assignTier(own({ direction: "unclear" }), ctx()).tier, "watch");
    assert.equal(assignTier(own({ liquidity: { price: 4.5, medianDollarVolume20d: null } }), ctx()).tier, "watch");
    assert.equal(assignTier(own({ liquidity: { price: 20, medianDollarVolume20d: 1_000_000 } }), ctx()).tier, "watch");
    assert.equal(assignTier(own({ liquidity: null }), ctx()).tier, "watch");
    assert.equal(assignTier(own({ pricedIn: true }), ctx()).tier, "watch");
    assert.equal(assignTier(own({ watchOnlyReasons: ["shell company"] }), ctx()).tier, "watch");
    assert.equal(assignTier(own({ family: "F2", relation: "supplier", linkTier: "list" }), ctx()).tier, "watch");
    assert.equal(isLiquid({ price: 6, medianDollarVolume20d: null }), true);
  });

  it("Measured needs the family statistical pass; degree never caps it", () => {
    assert.equal(familyPasses(PASSING.families.F7), true);
    assert.equal(familyPasses({ ...PASSING.families.F7!, n: 299 }), false);
    assert.equal(familyPasses({ ...PASSING.families.F7!, bhQ: 0.2 }), false);
    assert.equal(familyPasses({ ...PASSING.families.F7!, calendarT: 1.6 }), false);
    const t = assignTier(own(), ctx({ stats: PASSING }));
    assert.equal(t.tier, "measured");
    assert.equal(t.opportunityEligible, true);
    assert.equal(assignTier(own({ relation: "supplier", linkTier: "named" }), ctx({ stats: PASSING })).tier, "measured");
    assert.equal(assignTier(own({ liquidity: null }), ctx({ stats: PASSING })).tier, "watch");
  });

  it("opportunityEligible: Measured, or Documented own-firm exact under the interim flag only", () => {
    assert.equal(assignTier(own(), ctx({ interimDocumented: false })).opportunityEligible, false);
    assert.equal(assignTier(own({ family: "F2", relation: "supplier", linkTier: "named" }), ctx()).opportunityEligible, false);
    assert.equal(interimDocumentedFlag(undefined), true);
    assert.equal(interimDocumentedFlag("0"), false);
    assert.equal(interimDocumentedFlag("false"), false);
    assert.equal(interimDocumentedFlag("1"), true);
  });
});

describe("expiry (expiresAt)", () => {
  it("is publish time plus the longest hit window, sessions x1.5 in calendar days", () => {
    assert.equal(windowSessions("1 to 5 trading days"), 5);
    assert.equal(windowSessions("1 to 4 weeks"), 20);
    assert.equal(windowSessions("1 to 3 months"), 63);
    assert.equal(expiresAtOf("2026-11-12T16:00:00.000Z", ["1 to 5 trading days"]), "2026-11-20T16:00:00.000Z");
    assert.equal(expiresAtOf("2026-11-12T16:00:00.000Z", ["1 to 5 trading days", "1 to 4 weeks"]), "2026-12-12T16:00:00.000Z");
    assert.equal(expiresAtOf("2026-11-12T16:00:00.000Z", ["1 to 3 months"]), "2027-02-15T16:00:00.000Z");
  });

  it("serves by expiresAt, and an older card for 7 days after its event", () => {
    const now = Date.parse("2026-11-20T00:00:00Z");
    assert.equal(cardLive(card([hit()], { expiresAt: "2026-12-12T16:00:00Z" }), now), true);
    assert.equal(cardLive(card([hit()], { expiresAt: "2026-11-19T16:00:00Z" }), now), false);
    assert.equal(cardLive(card([hit()]), now), false); // event 2026-11-10 + 7 days
    assert.equal(cardLive(card([hit()]), Date.parse("2026-11-16T00:00:00Z")), true);
  });

  it("marks stale by expiresAt with the old event-age rule as a fallback", () => {
    assert.match(MARK_STALE_SQL, /expiresAt/);
    assert.match(MARK_STALE_SQL, /event_at < \$2/);
  });
});

describe("Opportunities interim rule (design 7.3)", () => {
  it("lists a Documented own-firm exact hit while no hit is Measured, labelled as documented", () => {
    const c = card([selfDoc()], { id: "a", tier: "documented", event: { ...card([]).event, ticker: "ACME" } });
    assert.deepEqual(opportunityCards([c]).map((x) => x.id), ["a"]);
    assert.equal(DOCUMENTED_LABEL, "Documented in published research; Falcon's own record is building.");
  });

  it("is off with the flag, for linked or analogous Documented hits, and once any hit is Measured", () => {
    const c = card([selfDoc()], { id: "a", tier: "documented", event: { ...card([]).event, ticker: "ACME" } });
    assert.deepEqual(opportunityCards([c], undefined, { interimDocumented: false }), []);
    const linked = card([hit({ tier: "documented", documentedBy: DOC_BY, opportunityEligible: true })], { id: "b", tier: "documented" });
    assert.deepEqual(opportunityCards([linked]), []);
    const analogous = card([selfDoc({ documentedBy: { ...DOC_BY, match: "analogous" } })], { id: "c", tier: "documented", event: { ...card([]).event, ticker: "ACME" } });
    assert.deepEqual(opportunityCards([analogous]), []);
    const measured = card([hit({ ticker: "NVMI", tier: "measured", opportunityEligible: true })], { id: "m", tier: "measured" });
    assert.deepEqual(opportunityCards([c, measured]).map((x) => x.id), ["m"]);
  });

  it("never lists a Watch card or a held ticker, and keeps the v0 rule for cards without tiers", () => {
    const watch = card([hit({ tier: "watch", opportunityEligible: true })], { tier: "watch" });
    assert.equal(opportunityCard(watch), null);
    const c = card([selfDoc()], { tier: "documented", event: { ...card([]).event, ticker: "ACME" } });
    assert.equal(opportunityCard(c, new Set(["ACME"])), null);
    const v0 = card([hit({ opportunityEligible: true, history: { sample: 14, hitRate: 11 / 14, avgMovePct: 2, windowDays: 5 } })]);
    assert.deepEqual(opportunityCard(v0)?.hits.map((h) => h.ticker), ["KLAC"]);
  });
});

describe("contract fallbacks", () => {
  it("tiers decide weak signals; cards without tiers keep the confidence rule", () => {
    assert.equal(isWeakSignal(card([hit({ tier: "watch", confidence: "high" })])), true);
    assert.equal(isWeakSignal(card([hit({ tier: "documented", documentedBy: DOC_BY, confidence: "low" })])), false);
    assert.equal(isWeakSignal(card([hit({ confidence: "low" })])), true);
    assert.equal(isWeakSignal(card([hit({ confidence: "medium" })])), false);
    assert.equal(cardTier(card([hit({ tier: "watch" }), hit({ ticker: "B", tier: "measured" })])), "measured");
    assert.equal(cardTier(card([hit()])), null);
    assert.equal(anyClearsBar([card([hit({ tier: "watch" })])]), false);
  });

  it("an unknown event type or tier gets a fallback label, never a crash", () => {
    assert.equal(eventTypeLabel({ eventType: "insider_cluster" }), "Insider purchase cluster");
    assert.equal(eventTypeLabel({ eventType: "something_new" }), null);
    assert.equal(eventTypeLabel({ eventType: "something_new", eventLabel: "Something new" }), "Something new");
    assert.equal(eventTypeLabel({}), null);
    assert.equal(tierLabel("documented"), "Documented");
    assert.equal(tierLabel("platinum"), "");
    assert.equal(tierLabel(undefined), "");
  });
});

describe("own-firm cards", () => {
  const quality = ctx();
  it("builds one hit, the company itself, from the filed quotes, with no judge", () => {
    const item = fromDetector(insider())!;
    const built = ownFirmCard(item, { sector: "all", generatedAt: "2026-11-13T12:30:00.000Z", liquidity: LIQUID, quality });
    assert.ok(!("error" in built));
    const c = built.card;
    assert.equal(c.hits.length, 1);
    const h = c.hits[0]!;
    assert.equal(h.relation, "self");
    assert.equal(h.ticker, "ACME");
    assert.equal(h.degree, 1);
    assert.equal(h.direction, "up");
    assert.equal(h.tier, "documented");
    assert.equal(h.confidence, "medium");
    assert.equal(h.opportunityEligible, true);
    assert.equal(h.documentedBy?.match, "exact");
    assert.equal(c.tier, "documented");
    assert.equal(c.event.eventType, "insider_cluster");
    assert.equal(c.event.eventLabel, "Insider purchase cluster");
    assert.equal(c.expiresAt, "2026-12-13T12:30:00.000Z");
    assert.deepEqual(cardProblems(c), []);
  });

  it("bad news is a risk item pointing down, never a call to act", () => {
    const item = fromDetector(insider({ id: "distress_nt-1", eventType: "distress_nt", family: "F6", sign: -1, form: "NT 10-Q" }))!;
    const built = ownFirmCard(item, { sector: "all", generatedAt: "2026-11-13T12:30:00.000Z", liquidity: LIQUID, quality });
    assert.ok(!("error" in built));
    assert.equal(built.card.hits[0]!.direction, "down");
    assert.equal(built.card.hits[0]!.tier, "watch");
    assert.match(built.card.hits[0]!.mechanism, /risk item for holders/);
    assert.doesNotMatch(built.card.hits[0]!.mechanism, /short/i);
    assert.deepEqual(cardProblems(built.card), []);
  });

  it("needs a ticker and a filed quote", () => {
    assert.equal(fromDetector(insider({ ticker: null })), null);
    const item = fromDetector(insider({ quotes: ["too short"] }))!;
    assert.ok("error" in ownFirmCard(item, { sector: "all", generatedAt: "2026-11-13T12:30:00.000Z", liquidity: LIQUID, quality }));
  });

  it("the contract allows a self hit only for the event company", () => {
    const ok = card([selfDoc()], { event: { ...card([]).event, ticker: "ACME" } });
    assert.deepEqual(cardProblems(ok).filter((p) => /self|own hit/.test(p)), []);
    assert.ok(cardProblems(card([selfDoc()])).some((p) => /self hit must be the event company/.test(p)));
    assert.ok(cardProblems(card([hit({ ticker: "TSM" })])).some((p) => /its own hit/.test(p)));
    assert.ok(hitProblems(hit({ tier: "documented" }), "h").some((p) => /documentedBy/.test(p)));
    assert.ok(hitProblems(hit({ tier: "watch", opportunityEligible: true }), "h").some((p) => /watch hit/.test(p)));
  });
});

describe("judge prompt and dollar cap", () => {
  const req: JudgeRequest = {
    eventId: "NVDA-1",
    event: { ticker: "NVDA", companyName: "NVIDIA", kind: "earnings_surprise", headline: "NVIDIA beat", occurredAt: "2026-11-09T21:08:00Z", summary: "NVIDIA reported EPS above consensus." },
    candidates: [{ key: "C1", ticker: "AMKR", companyName: "Amkor", degree: 2, via: "TSM", viaName: "TSMC", relation: "supplier", viaRelation: "supplier", links: [] }],
  };
  const base = { key: "C1", include: true, direction: "up", confidence: "high", window: "1 to 4 weeks", mechanism: "Amkor packages chips that TSMC makes for NVIDIA, so NVIDIA's quarter reaches Amkor's packaging lines." };

  it("no longer forces degree 2 to low; linkClarity is a closed answer set", () => {
    assert.doesNotMatch(SYSTEM_PROMPT, /all degree 2 links/);
    assert.match(SYSTEM_PROMPT, /linkClarity/);
    assert.deepEqual(checkAnswer(req, { ...base, linkClarity: "inferred" })?.problems, []);
    assert.equal(checkAnswer(req, { ...base, linkClarity: "inferred" })?.linkClarity, "inferred");
    assert.ok(checkAnswer(req, { ...base, linkClarity: "sure" })?.problems.includes("bad linkClarity"));
  });

  it("stops asking once the dollars are spent, from measured usage", () => {
    let spent = 0;
    const b = callBudget(40, { maxUsd: 0.75, spentUsd: () => spent });
    assert.equal(allowedCalls(b, 3), 3);
    b.used = 3;
    spent = 0.6; // 0.20 per call: 0.15 left buys none
    assert.equal(allowedCalls(b, 3), 0);
    spent = 0.3; // 0.10 per call: 0.45 left buys 4
    assert.equal(allowedCalls(b, 3), 3);
    spent = 0.75;
    assert.equal(allowedCalls(b, 1), 0);
  });
});

describe("judge once (runSightings)", () => {
  const QUOTE = "We rely on Taiwan Semiconductor Manufacturing Company Limited to produce our wafers.";
  const graph: Graph = {
    generatedAt: "2026-11-01",
    names: { NVDA: "NVIDIA", TSM: "TSMC" },
    edges: [{ id: "e1", from: "NVDA", to: "TSM", toName: "TSMC", category: "supplier", tier: "critical", disclosedSharePct: null, quote: QUOTE, form: "10-K", filedAt: "2026-02-25", url: "https://www.sec.gov/Archives/edgar/data/1045810/x.htm", origin: "test" }],
  };
  const earnings: DetectedEvent = {
    event: { id: "NVDA-0001045810-26-000200", ticker: "NVDA", companyName: "NVIDIA", kind: "earnings_surprise", headline: "NVIDIA reports results", occurredAt: "2026-11-12T21:20:00Z", summary: "NVIDIA reported EPS above consensus.", source: { title: "8-K", url: "https://www.sec.gov/Archives/edgar/data/1045810/y.htm", publisher: "SEC EDGAR" } },
    magnitudePct: 5,
    pendingAcquisition: false,
    filing: { cik: "1045810", companyName: "NVIDIA", form: "8-K", accession: "0001045810-26-000200", filedAt: "2026-11-12", acceptedAt: "2026-11-12T21:20:00Z", items: ["2.02"], primaryDocument: "y.htm", primaryDocDescription: "", url: "https://www.sec.gov/y", indexUrl: "https://www.sec.gov/y-index.htm" } as DetectedEvent["filing"],
    basis: { kind: "earnings", sign: 1 },
  };

  function fakeJudge(): Judge & { calls: number } {
    const j = {
      name: "fake",
      calls: 0,
      async judge() {
        j.calls++;
        return { hits: [{ key: "C1", include: true, direction: "up", confidence: "medium", window: "1 to 4 weeks", linkClarity: "direct", mechanism: "NVIDIA relies on TSMC to produce its wafers, so NVIDIA's results speak to TSMC's foundry business." }] };
      },
    };
    return j;
  }

  const runOnce = (judge: Judge, store: ReturnType<typeof memoryJudgmentStore> | ReturnType<typeof fileJudgmentStore>) =>
    runSightings({
      sector: "semis",
      sinceMs: Date.parse("2026-11-06T00:00:00Z"),
      untilMs: Date.parse("2026-11-13T00:00:00Z"),
      maxCards: 3,
      judge,
      graph,
      judgments: store,
      legacyEvents: async () => [earnings],
      detect: async () => [insider()],
      liquidity: async () => LIQUID,
      registry: REGISTRY,
      familyStats: { version: 1, families: {} },
      interimDocumented: true,
      dryRun: true,
    });

  it("a second run on the same window makes no judge call and builds the same cards", async () => {
    const store = memoryJudgmentStore();
    const j1 = fakeJudge();
    const first = await runOnce(j1, store);
    assert.equal(j1.calls, 3);
    assert.equal(first.analysis?.judged, 1);
    assert.equal(store.rows.size, 1);
    const j2 = fakeJudge();
    const second = await runOnce(j2, store);
    assert.equal(j2.calls, 0);
    assert.equal(second.analysis?.reused, 1);
    assert.equal(second.analysis?.judged, 0);
    assert.deepEqual(second.feed.cards.map((c) => c.id), first.feed.cards.map((c) => c.id));
  });

  it("the file cache makes dry runs idempotent too", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-judgments-"));
    await runOnce(fakeJudge(), fileJudgmentStore(dir));
    const j2 = fakeJudge();
    await runOnce(j2, fileJudgmentStore(dir));
    assert.equal(j2.calls, 0);
  });

  it("features own-firm Documented cards first, gives linked hits a tier and linkClarity, and writes a forecast row per hit", async () => {
    const run = await runOnce(fakeJudge(), memoryJudgmentStore());
    const [first, second] = run.feed.cards;
    assert.equal(first?.tier, "documented");
    assert.equal(first?.hits[0]?.relation, "self");
    assert.equal(second?.tier, "watch"); // F10 is not in the registry
    assert.equal(second?.hits[0]?.linkClarity, "direct");
    assert.equal(second?.hits[0]?.family, "F10");
    assert.equal(second?.hits[0]?.opportunityEligible, false);
    assert.ok(second?.expiresAt);
    assert.deepEqual(run.analysis?.tiers, { measured: 0, documented: 1, watch: 1 });
    assert.equal(run.ledger?.length, 2);
    assert.ok(run.ledger?.every((r) => r.published && r.card_sha256?.length === 64));
  });

  it("--max limits what is featured, not what is analysed", async () => {
    const store = memoryJudgmentStore();
    const run = await runSightings({
      sector: "semis", sinceMs: 0, untilMs: Date.parse("2026-11-13T00:00:00Z"), maxCards: 1, judge: fakeJudge(), graph, judgments: store,
      legacyEvents: async () => [earnings], detect: async () => [insider()], liquidity: async () => LIQUID, registry: REGISTRY, familyStats: { version: 1, families: {} }, interimDocumented: true,
    });
    assert.equal(run.feed.cards.length, 1);
    assert.equal(store.rows.size, 1);
    assert.equal(run.ledger?.filter((r) => !r.published).length, 1);
  });

  it("the candidates hash ignores key order and changes with the candidates", () => {
    const req: JudgeRequest = { eventId: "e", event: earnings.event, candidates: [] };
    assert.equal(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] }), '{"a":[2,{"c":4,"d":3}],"b":1}');
    assert.notEqual(candidatesHash(req), candidatesHash({ ...req, candidates: [{ key: "C1", ticker: "TSM", companyName: "TSMC", degree: 1, relation: "supplier", links: [] }] }));
  });
});

describe("the record's events (src/history.ts)", () => {
  it("lists each past event behind the record with the hit's and the benchmark's moves", () => {
    const m: Move = { reactionDate: "2025-02-27", fromDate: "2025-02-26", toDate: "2025-03-05", hitPct: 3.456, benchPct: 1.111, adjustedPct: 2.345 };
    const rows = recordEvents([m], new Map([[m, { accession: "0001045810-25-000023", eventDate: "2025-02-26" }]]));
    assert.deepEqual(rows, [{ accession: "0001045810-25-000023", eventDate: "2025-02-26", reactionDate: "2025-02-27", movePct: 3.46, benchmarkPct: 1.11 }]);
  });
});

describe("framing and company names", () => {
  it("a company named like an advice word does not fail its own card", () => {
    const item = fromDetector(insider({ companyName: "Target Hospitality Corp" }))!;
    const built = ownFirmCard(item, { sector: "all", generatedAt: "2026-11-13T12:30:00.000Z", liquidity: LIQUID, quality: ctx() });
    assert.ok(!("error" in built));
    assert.deepEqual(cardProblems(built.card), []);
    assert.ok(hitProblems(hit({ mechanism: "This sets a price target for the company, a test sentence." }), "h").some((p) => /advice/.test(p)));
  });
});

it("own-firm events fold to one per company and event type, keeping the largest", async () => {
  const { dedupeOwnByCompany } = await import("../src/pipeline.ts");
  const mk = (id: string, ticker: string, eventType: string, magnitudePct: number | null, occurredAt: string) => ({ eventType, magnitudePct, event: { id, ticker, occurredAt } });
  const items = [
    mk("a", "FUN", "insider_cluster", 0.4, "2026-11-12T20:00:00Z"),
    mk("b", "FUN", "insider_cluster", 0.7, "2026-11-10T20:00:00Z"),
    mk("c", "FUN", "distress_nt", null, "2026-11-10T20:00:00Z"),
    mk("d", "HPP", "insider_cluster", null, "2026-11-12T20:00:00Z"),
    mk("e", "HPP", "insider_cluster", null, "2026-11-13T20:00:00Z"),
  ];
  assert.deepEqual(dedupeOwnByCompany(items).map((i) => i.event.id), ["b", "c", "e"]);
});
