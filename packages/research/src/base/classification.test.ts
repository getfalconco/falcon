/**
 * B9 — Base-side Classifier companion goldens (Classifier spec §3, §9, §10).
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Verdict } from "../classifier/types.js";
import {
  applyBudget,
  buildClassificationRequests,
  budgetRemaining,
  classificationKey,
  classifiedSeverity,
  consumeBudget,
  etDayOf,
  isClassifierBound,
  lookupFromVerdicts,
  propagationCandidatesFor,
} from "./classification.js";
import { DEFAULT_BASE_CONFIG, mergeBaseConfig, type BaseConfig } from "./config.js";
import { buildIncidents } from "./incident.js";
import { computePriority } from "./priority.js";
import { replayBase } from "./replay.js";
import { filingItem, newsItem, plusMinutes } from "./test-fixtures.js";

const AT = "2026-08-20T14:00:00.000Z";
const CONFIG = DEFAULT_BASE_CONFIG;
const RESCORE: BaseConfig = mergeBaseConfig({ classifier: { rescoreEnabled: true } as never });

function verdict(articleKey: string, tickers: Verdict["tickers"], overrides: Partial<Verdict> = {}): Verdict {
  return {
    schema_version: 1,
    prompt_version: "cls-1.0",
    model: "claude-haiku-4-5",
    article_key: articleKey,
    kind: "news",
    event_type: "contract_partnership",
    event_label: "label",
    syndication_scope: tickers.length,
    tickers,
    unassessed_tickers: [],
    status: "ok",
    metadata_missing: false,
    classified_at: AT,
    failure_reason: null,
    ...overrides,
  };
}

const ctx = (ticker: string) => ({
  ticker,
  official_name: null,
  sector: null,
  cap_bucket: null,
  metadata_missing: true,
});

describe("§10b severity mapping", () => {
  const table: Array<[Verdict["tickers"][number], number]> = [
    [{ ticker: "NVDA", relevance: "direct", materiality: "high", direction: "positive" }, 25],
    [{ ticker: "NVDA", relevance: "direct", materiality: "standard", direction: "positive" }, 12],
    [{ ticker: "NVDA", relevance: "direct", materiality: "low", direction: "positive" }, 2],
    [{ ticker: "NVDA", relevance: "indirect", materiality: "high", direction: "positive" }, 10],
    [{ ticker: "NVDA", relevance: "indirect", materiality: "standard", direction: "positive" }, 5],
    [{ ticker: "NVDA", relevance: "indirect", materiality: "low", direction: "positive" }, 0],
    [{ ticker: "NVDA", relevance: "none" }, 0],
  ];
  for (const [entry, expected] of table) {
    it(`${entry.relevance}/${"materiality" in entry ? entry.materiality : "-"} → ${expected}`, () => {
      const v = verdict("id:x", [entry]);
      assert.equal(classifiedSeverity({ state: "classified", verdict: v, entry }, CONFIG), expected);
    });
  }
  it("unassessed / failed / unclassified → base 5", () => {
    const v = verdict("id:x", []);
    assert.equal(classifiedSeverity({ state: "unassessed", verdict: v }, CONFIG), 5);
    assert.equal(classifiedSeverity({ state: "failed", verdict: { ...v, status: "failed" } }, CONFIG), 5);
    assert.equal(classifiedSeverity({ state: "unclassified" }, CONFIG), 5);
  });
});

describe("verdict lookup", () => {
  it("resolves by article key and ticker; failed and overflow states", () => {
    const ok = verdict("id:a", [{ ticker: "NVDA", relevance: "none" }], { unassessed_tickers: ["TSM"] });
    const failed = verdict("id:b", [], { status: "failed" });
    const lookup = lookupFromVerdicts([ok, failed], CONFIG);
    assert.equal(lookup(newsItem("n1", AT, { article_id: "a" }, { ticker: "NVDA" })).state, "classified");
    assert.equal(lookup(newsItem("n2", AT, { article_id: "a" }, { ticker: "TSM" })).state, "unassessed");
    assert.equal(lookup(newsItem("n3", AT, { article_id: "b" }, { ticker: "NVDA" })).state, "failed");
    assert.equal(lookup(newsItem("n4", AT, { article_id: "zzz" })).state, "unclassified");
    // Filing key.
    const f = filingItem("f1", AT, { item_codes: ["7.01"], accession_number: "0001-26-9" });
    assert.equal(classificationKey(f, CONFIG), "8k:0001-26-9");
    assert.equal(lookupFromVerdicts([verdict("8k:0001-26-9", [{ ticker: "NVDA", relevance: "none" }], { kind: "filing" })], CONFIG)(f).state, "classified");
  });

  it("prefers an ok verdict over a failed one for the same article", () => {
    const failed = verdict("id:a", [], { status: "failed", classified_at: "2026-08-21T00:00:00.000Z" });
    const ok = verdict("id:a", [{ ticker: "NVDA", relevance: "none" }]);
    const lookup = lookupFromVerdicts([failed, ok], CONFIG);
    assert.equal(lookup(newsItem("n1", AT, { article_id: "a" })).state, "classified");
  });
});

describe("re-score band migration (Phase B)", () => {
  const news = newsItem("n1", AT, { article_id: "a", published_at: AT });

  it("Phase A (rescore off): a verdict changes nothing", () => {
    const lookup = lookupFromVerdicts([verdict("id:a", [{ ticker: "NVDA", relevance: "none" }])], CONFIG);
    const off = computePriority({ messages: [news], composite_tags: [], user_proximity: "tracked", now: AT, config: CONFIG, verdictLookup: lookup });
    const none = computePriority({ messages: [news], composite_tags: [], user_proximity: "tracked", now: AT, config: CONFIG });
    assert.equal(off.priority, none.priority);
    assert.equal(off.severity, 5);
  });

  it("a `none` verdict demotes a lone-news P2 to P3", () => {
    const before = computePriority({ messages: [news], composite_tags: [], user_proximity: "tracked", now: AT, config: RESCORE });
    assert.equal(before.band, "P2"); // 5 + freshness 10 = 15
    const lookup = lookupFromVerdicts([verdict("id:a", [{ ticker: "NVDA", relevance: "none" }])], RESCORE);
    const after = computePriority({ messages: [news], composite_tags: [], user_proximity: "tracked", now: AT, config: RESCORE, verdictLookup: lookup });
    assert.equal(after.severity, 0);
    assert.equal(after.band, "P3");
  });

  it("a direct/high verdict promotes a held-ticker P2 to P1", () => {
    const before = computePriority({ messages: [news], composite_tags: [], user_proximity: "held", now: AT, config: RESCORE });
    assert.equal(before.band, "P2"); // 5*1.5 + 10 = 17.5 → 18
    const lookup = lookupFromVerdicts(
      [verdict("id:a", [{ ticker: "NVDA", relevance: "direct", materiality: "high", direction: "negative" }])],
      RESCORE,
    );
    const after = computePriority({ messages: [news], composite_tags: [], user_proximity: "held", now: AT, config: RESCORE, verdictLookup: lookup });
    assert.equal(after.severity, 25);
    assert.equal(after.priority, 48); // 25*1.5 + 10
    assert.equal(after.band, "P1");
  });

  it("severity is max of contributions: ten standard articles do not stack", () => {
    const items = Array.from({ length: 10 }, (_, i) =>
      newsItem(`n${i}`, plusMinutes(AT, i), { article_id: `a${i}`, published_at: plusMinutes(AT, i) }),
    );
    const verdicts = items.map((_, i) =>
      verdict(`id:a${i}`, [{ ticker: "NVDA", relevance: "direct", materiality: "standard", direction: "positive" }]),
    );
    const lookup = lookupFromVerdicts(verdicts, RESCORE);
    const r = computePriority({ messages: items, composite_tags: [], user_proximity: "tracked", now: plusMinutes(AT, 10), config: RESCORE, verdictLookup: lookup });
    assert.equal(r.severity, 12);
  });

  it("failed and unassessed verdicts keep the base 5", () => {
    const lookup = lookupFromVerdicts([verdict("id:a", [], { status: "failed" })], RESCORE);
    const r = computePriority({ messages: [news], composite_tags: [], user_proximity: "tracked", now: AT, config: RESCORE, verdictLookup: lookup });
    assert.equal(r.severity, 5);
  });

  it("replay reports promotions/demotions against the re-score-off baseline", () => {
    const a = newsItem("n1", AT, { article_id: "a", published_at: AT }, { ticker: "NVDA" });
    const b = newsItem("n2", AT, { article_id: "b", published_at: AT }, { ticker: "META" });
    const lookup = lookupFromVerdicts(
      [
        verdict("id:a", [{ ticker: "NVDA", relevance: "none" }]),
        verdict("id:b", [{ ticker: "META", relevance: "direct", materiality: "high", direction: "negative" }]),
      ],
      RESCORE,
    );
    const r = replayBase([a, b], { config: RESCORE, now: AT, verdictLookup: lookup, userContext: { held: ["META"], watchlist: [] } });
    assert.equal(r.summary.classification.rescore_applied, true);
    assert.equal(r.summary.classification.messages_with_verdict, 2);
    assert.equal(r.summary.classification.incidents_demoted, 1);
    assert.equal(r.summary.classification.incidents_promoted, 1);
    // Phase A: same verdicts, nothing moves.
    const off = replayBase([a, b], { config: CONFIG, now: AT, verdictLookup: lookup });
    assert.equal(off.summary.classification.rescore_applied, false);
    assert.equal(off.summary.classification.incidents_demoted, 0);
    assert.equal(off.summary.classification.messages_classified, 2);
  });
});

describe("§10c propagation candidates", () => {
  it("direct + ≥standard + network-relevant → candidate; others not; deduped per (ticker, article)", () => {
    const msgs = [
      newsItem("n1", AT, { article_id: "a" }, { ticker: "NVDA" }),
      newsItem("n1b", plusMinutes(AT, 1), { article_id: "a" }, { ticker: "NVDA" }), // redelivered article, same ticker
      newsItem("n2", AT, { article_id: "b" }, { ticker: "NVDA" }),
      newsItem("n3", AT, { article_id: "c" }, { ticker: "NVDA" }),
      newsItem("n4", AT, { article_id: "d" }, { ticker: "NVDA" }),
    ];
    const lookup = lookupFromVerdicts(
      [
        verdict("id:a", [{ ticker: "NVDA", relevance: "direct", materiality: "standard", direction: "positive" }], { event_type: "contract_partnership", event_label: "supply deal" }),
        verdict("id:b", [{ ticker: "NVDA", relevance: "direct", materiality: "low", direction: "positive" }], { event_type: "ma_activity" }),
        verdict("id:c", [{ ticker: "NVDA", relevance: "indirect", materiality: "high", direction: "positive" }], { event_type: "ma_activity" }),
        verdict("id:d", [{ ticker: "NVDA", relevance: "direct", materiality: "high", direction: "positive" }], { event_type: "analyst_action" }),
      ],
      CONFIG,
    );
    const out = propagationCandidatesFor(msgs, lookup, CONFIG);
    assert.deepEqual(out, [{ ticker: "NVDA", article_key: "id:a", event_type: "contract_partnership", event_label: "supply deal" }]);

    // Accumulated onto the incident regardless of the Phase A/B switch.
    const incidents = buildIncidents(msgs, { config: CONFIG, now: AT, verdictLookup: lookup });
    assert.equal(incidents.length, 1);
    assert.deepEqual(incidents[0].propagation_candidates, out);
  });
});

describe("§3 request building", () => {
  const none = () => null;

  it("one lead per article with the ticker set in arrival order; followers covered by the same request", () => {
    const msgs = ["AAPL", "MSFT", "NVDA", "SONY"].map((ticker, i) =>
      newsItem(`g${i}`, AT, { article_id: "gabelli", headline: "Gabelli 13F" }, { ticker }),
    );
    const r = buildClassificationRequests(msgs, { config: CONFIG, tickerContext: ctx, existingVerdict: none, now: AT });
    assert.equal(r.requests.length, 1);
    const req = r.requests[0];
    assert.equal(req.mode, "lead");
    assert.equal(req.kind, "news");
    assert.equal(req.article?.article_key, "id:gabelli");
    assert.deepEqual(req.tickers.map((t) => t.ticker), ["AAPL", "MSFT", "NVDA", "SONY"]);
    assert.equal(req.syndication_scope, 4);
    assert.deepEqual(req.unassessed_tickers, []);
    assert.equal(r.overflows, 0);
  });

  it("ticker cap: tickers beyond 8 are unassessed and the overflow is counted", () => {
    const tickers = ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"];
    const msgs = tickers.map((ticker, i) => newsItem(`s${i}`, AT, { article_id: "syn" }, { ticker }));
    const r = buildClassificationRequests(msgs, { config: CONFIG, tickerContext: ctx, existingVerdict: none, now: AT });
    assert.equal(r.requests[0].tickers.length, 8);
    assert.deepEqual(r.requests[0].unassessed_tickers, ["I", "J"]);
    assert.equal(r.requests[0].syndication_scope, 10);
    assert.equal(r.overflows, 1);
  });

  it("an existing verdict covering every ticker → no request; an uncovered follower → addendum for the new tickers only", () => {
    const msgs = [
      newsItem("l", AT, { article_id: "a" }, { ticker: "AVGO" }),
      newsItem("f1", plusMinutes(AT, 5), { article_id: "a" }, { ticker: "NVDA" }),
      newsItem("f2", plusMinutes(AT, 6), { article_id: "a" }, { ticker: "META" }),
    ];
    const covered = verdict("id:a", [
      { ticker: "AVGO", relevance: "direct", materiality: "standard", direction: "positive" },
      { ticker: "NVDA", relevance: "direct", materiality: "standard", direction: "negative" },
    ]);
    const r = buildClassificationRequests(msgs, { config: CONFIG, tickerContext: ctx, existingVerdict: () => covered, now: AT });
    assert.equal(r.requests.length, 1);
    assert.equal(r.requests[0].mode, "addendum");
    assert.deepEqual(r.requests[0].tickers.map((t) => t.ticker), ["META"]);
    assert.equal(r.requests[0].syndication_scope, 3);

    const full = verdict("id:a", [...covered.tickers, { ticker: "META", relevance: "none" }]);
    const r2 = buildClassificationRequests(msgs, { config: CONFIG, tickerContext: ctx, existingVerdict: () => full, now: AT });
    assert.equal(r2.requests.length, 0);
    assert.equal(r2.covered, 1);
  });

  it("a failed existing verdict is re-requested as a lead", () => {
    const msgs = [newsItem("l", AT, { article_id: "a" })];
    const failed = verdict("id:a", [], { status: "failed" });
    const r = buildClassificationRequests(msgs, { config: CONFIG, tickerContext: ctx, existingVerdict: () => failed, now: AT });
    assert.equal(r.requests.length, 1);
    assert.equal(r.requests[0].mode, "lead");
  });

  it("unmapped 8-Ks become filing requests with item descriptions; mapped ones and 10-Ks do not", () => {
    const unmapped = filingItem("u", AT, { item_codes: ["7.01", "9.01"], accession_number: "0001-26-7" });
    const mapped = filingItem("m", AT, { item_codes: ["2.02"], accession_number: "0001-26-2" });
    const tenK = filingItem("k", AT, { form_type: "10-K", item_codes: [], accession_number: "0001-26-10" });
    assert.equal(isClassifierBound(unmapped, CONFIG), true);
    assert.equal(isClassifierBound(mapped, CONFIG), false);
    assert.equal(isClassifierBound(tenK, CONFIG), false);
    const r = buildClassificationRequests([unmapped, mapped, tenK], { config: CONFIG, tickerContext: ctx, existingVerdict: none, now: AT });
    assert.equal(r.requests.length, 1);
    const req = r.requests[0];
    assert.equal(req.kind, "filing");
    assert.equal(req.filing?.article_key, "8k:0001-26-7");
    assert.deepEqual(req.filing?.item_descriptions, ["Regulation FD Disclosure", "Financial Statements and Exhibits"]);
    assert.equal(req.article, null);
  });

  it("request ids are deterministic", () => {
    const msgs = [newsItem("l", AT, { article_id: "a" })];
    const a = buildClassificationRequests(msgs, { config: CONFIG, tickerContext: ctx, existingVerdict: none, now: AT });
    const b = buildClassificationRequests(msgs, { config: CONFIG, tickerContext: ctx, existingVerdict: none, now: AT });
    assert.deepEqual(a.requests, b.requests);
    assert.equal(a.requests[0].request_id, "id:a|lead|NVDA");
  });
});

describe("§9 daily budget", () => {
  it("rolls over at ET midnight and queues by priority", () => {
    // 03:30Z on Aug 21 is 23:30 ET on Aug 20; 04:30Z is 00:30 ET on Aug 21.
    assert.equal(etDayOf("2026-08-21T03:30:00.000Z"), "2026-08-20");
    assert.equal(etDayOf("2026-08-21T04:30:00.000Z"), "2026-08-21");
    let ledger = consumeBudget(null, "2026-08-21T03:30:00.000Z", 498);
    assert.equal(budgetRemaining(ledger, "2026-08-21T03:30:00.000Z", CONFIG), 2);
    assert.equal(budgetRemaining(ledger, "2026-08-21T04:30:00.000Z", CONFIG), 500);
    ledger = consumeBudget(ledger, "2026-08-21T04:30:00.000Z", 1);
    assert.deepEqual(ledger, { day: "2026-08-21", used: 1 });

    const msgs = [
      newsItem("a", AT, { article_id: "a" }),
      newsItem("b", AT, { article_id: "b" }),
      newsItem("c", AT, { article_id: "c" }),
    ];
    const { requests } = buildClassificationRequests(msgs, { config: CONFIG, tickerContext: ctx, existingVerdict: () => null, now: AT });
    const prio: Record<string, number> = { "id:a": 10, "id:b": 50, "id:c": 50 };
    const { dispatch, deferred } = applyBudget(requests, (r) => prio[r.article!.article_key], 2);
    assert.deepEqual(dispatch.map((r) => r.article!.article_key), ["id:b", "id:c"]);
    assert.deepEqual(deferred.map((r) => r.article!.article_key), ["id:a"]);
  });
});
