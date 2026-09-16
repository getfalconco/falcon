import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Verdict } from "../classifier/types.js";
import { classifiedSeverity, lookupFromVerdicts, propagationCandidatesFor, type MessageClassification } from "./classification.js";
import { DEFAULT_BASE_CONFIG, mergeBaseConfig } from "./config.js";
import {
  addDueAt,
  capPreEarningsPreview,
  earningsCalendarFromMessages,
  mergeCalendars,
  previewDueAt,
  withPreEarningsPreviewCap,
  type EarningsCalendar,
} from "./pre-earnings-preview.js";
import { replayBase } from "./replay.js";
import { newsItem, scheduledEvent } from "./test-fixtures.js";

const NVDA_DUE = "2026-08-26T20:00:00.000Z";
const config = DEFAULT_BASE_CONFIG;

function verdict(articleKey: string, eventType: Verdict["event_type"], materiality: "high" | "standard" | "low", ticker = "NVDA"): Verdict {
  return {
    schema_version: 1,
    prompt_version: "cls-1.0",
    model: "fixture",
    article_key: articleKey,
    kind: "news",
    event_type: eventType,
    event_label: `${eventType} label`,
    syndication_scope: 1,
    tickers: [{ ticker, relevance: "direct", materiality, direction: "positive" }],
    unassessed_tickers: [],
    status: "ok",
    metadata_missing: false,
    classified_at: "2026-08-24T12:00:00.000Z",
    failure_reason: null,
  };
}

function calendar(): EarningsCalendar {
  const c: EarningsCalendar = new Map();
  addDueAt(c, "NVDA", NVDA_DUE);
  return c;
}

describe("pre-earnings preview cap (Base, deterministic)", () => {
  it("1. NVDA due 26 Aug 20:00Z; an earnings_results/high article on 24 Aug → capped low, flagged, no candidate", () => {
    const m = newsItem("a", "2026-08-24T13:00:00.000Z", { article_id: "1", published_at: "2026-08-24T13:00:00.000Z" });
    const base = lookupFromVerdicts([verdict("id:1", "earnings_results", "high")], config);
    const capped = withPreEarningsPreviewCap(base, calendar(), config);
    const c = capped(m);
    assert.equal(c.state, "classified");
    if (c.state !== "classified" || c.entry.relevance === "none") throw new Error("unexpected");
    assert.equal(c.entry.materiality, "low");
    assert.equal(c.pre_earnings_preview, true);
    assert.equal(classifiedSeverity(c, config), config.classifier.severityMapping.direct.low);
    assert.deepEqual(propagationCandidatesFor([m], capped, config), []);
    // Without the cap the same verdict would be a candidate.
    assert.equal(propagationCandidatesFor([m], base, config).length, 1);
  });

  it("2. an article published after due_at (26 Aug 21:00Z) → no cap, normal flow", () => {
    const m = newsItem("b", "2026-08-26T21:00:00.000Z", { article_id: "2", published_at: "2026-08-26T21:00:00.000Z" });
    const base = lookupFromVerdicts([verdict("id:2", "earnings_results", "high")], config);
    const capped = withPreEarningsPreviewCap(base, calendar(), config);
    const c = capped(m);
    if (c.state !== "classified" || c.entry.relevance === "none") throw new Error("unexpected");
    assert.equal(c.entry.materiality, "high");
    assert.equal(c.pre_earnings_preview, undefined);
    assert.equal(propagationCandidatesFor([m], capped, config).length, 1);
  });

  it("3. a ticker with no known due_at → no cap (the rule only runs on a known calendar)", () => {
    const m = newsItem("c", "2026-08-24T13:00:00.000Z", { article_id: "3", published_at: "2026-08-24T13:00:00.000Z" }, { ticker: "PLTR" });
    const base = lookupFromVerdicts([verdict("id:3", "earnings_results", "high", "PLTR")], config);
    const capped = withPreEarningsPreviewCap(base, calendar(), config);
    const c = capped(m);
    if (c.state !== "classified" || c.entry.relevance === "none") throw new Error("unexpected");
    assert.equal(c.entry.materiality, "high");
    assert.equal(c.pre_earnings_preview, undefined);
  });

  it("4. guidance is exempt — a company's own pre-announcement is a real event", () => {
    const m = newsItem("d", "2026-08-24T13:00:00.000Z", { article_id: "4", published_at: "2026-08-24T13:00:00.000Z" });
    const base = lookupFromVerdicts([verdict("id:4", "guidance", "high")], config);
    const capped = withPreEarningsPreviewCap(base, calendar(), config);
    const c = capped(m);
    if (c.state !== "classified" || c.entry.relevance === "none") throw new Error("unexpected");
    assert.equal(c.entry.materiality, "high");
    assert.equal(c.pre_earnings_preview, undefined);
    assert.equal(propagationCandidatesFor([m], capped, config).length, 1);
  });

  it("window: beyond windowDays before due_at → no cap; the window is config", () => {
    const m = newsItem("e", "2026-08-19T13:00:00.000Z", { article_id: "5", published_at: "2026-08-19T13:00:00.000Z" }); // 7.3 days before
    const base = lookupFromVerdicts([verdict("id:5", "earnings_results", "high")], config);
    assert.equal(previewDueAt(calendar(), "NVDA", "2026-08-19T13:00:00.000Z", 5), null);
    const c5 = withPreEarningsPreviewCap(base, calendar(), config)(m);
    if (c5.state !== "classified" || c5.entry.relevance === "none") throw new Error("unexpected");
    assert.equal(c5.entry.materiality, "high");
    const wide = mergeBaseConfig({ classifier: { preEarningsPreview: { windowDays: 10 } } } as never);
    const c10 = withPreEarningsPreviewCap(base, calendar(), wide)(m);
    if (c10.state !== "classified" || c10.entry.relevance === "none") throw new Error("unexpected");
    assert.equal(c10.entry.materiality, "low");
    const off = mergeBaseConfig({ classifier: { preEarningsPreview: { enabled: false } } } as never);
    const cOff = withPreEarningsPreviewCap(base, calendar(), off)(m);
    if (cOff.state !== "classified" || cOff.entry.relevance === "none") throw new Error("unexpected");
    assert.equal(cOff.entry.materiality, "high");
  });

  it("calendar comes from scheduled_event messages (T5 ledger) and merges with an explicit map", () => {
    const s = scheduledEvent("s1", "2026-08-18T12:00:00.000Z", NVDA_DUE);
    const fromStream = earningsCalendarFromMessages([s, newsItem("n", "2026-08-18T13:00:00.000Z")]);
    assert.deepEqual(fromStream.get("NVDA"), [NVDA_DUE]);
    const explicit: EarningsCalendar = new Map([["WMT", ["2026-08-21T11:00:00.000Z"]]]);
    const merged = mergeCalendars(fromStream, explicit, null);
    assert.equal(merged.size, 2);
    assert.deepEqual(mergeCalendars(fromStream, fromStream).get("NVDA"), [NVDA_DUE]);
  });

  it("replayBase applies the cap from the stream's own scheduled_event: the preview incident carries no candidate", () => {
    const sched = scheduledEvent("s1", "2026-08-18T12:00:00.000Z", NVDA_DUE);
    const preview = newsItem("p1", "2026-08-24T13:00:00.000Z", { article_id: "9", published_at: "2026-08-24T13:00:00.000Z" });
    const lookup = lookupFromVerdicts([verdict("id:9", "earnings_results", "high")], config);
    const withCap = replayBase([sched, preview], { config, now: "2026-08-24T14:00:00.000Z", verdictLookup: lookup });
    const inc = withCap.incidents.find((r) => r.incident.messages.some((m) => m.id === "p1"))!;
    assert.equal(inc.incident.propagation_candidates.length, 0);
    assert.equal(withCap.summary.classification.propagation_candidates, 0);
    const off = mergeBaseConfig({ classifier: { preEarningsPreview: { enabled: false } } } as never);
    const noCap = replayBase([sched, preview], { config: off, now: "2026-08-24T14:00:00.000Z", verdictLookup: lookup });
    assert.equal(noCap.summary.classification.propagation_candidates, 1);
  });

  it("capPreEarningsPreview is idempotent and leaves non-classified states alone", () => {
    const m = newsItem("z", "2026-08-24T13:00:00.000Z", { article_id: "z", published_at: "2026-08-24T13:00:00.000Z" });
    const un: MessageClassification = { state: "unclassified" };
    assert.deepEqual(capPreEarningsPreview(m, un, calendar(), config), un);
    const once = capPreEarningsPreview(m, lookupFromVerdicts([verdict("id:z", "earnings_results", "high")], config)(m), calendar(), config);
    assert.deepEqual(capPreEarningsPreview(m, once, calendar(), config), once);
  });
});
