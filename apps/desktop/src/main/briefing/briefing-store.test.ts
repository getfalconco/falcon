import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { BRIEFING_SCHEMA_VERSION, type BriefingNarrative, type BriefingPhase, type BriefingReport, type Story } from "../../shared/briefing-types";
import {
  BriefingStore,
  MAX_GENERATIONS_PER_SESSION,
  MIN_GENERATION_GAP_MS,
  REPORT_MAX_AGE_MS,
  bookHash,
  cacheUsable,
  holdingsHash,
  narrativeBudget,
  reportTtlMs,
  type ReportKey,
} from "./briefing-store";

const MINUTE = 60_000;
const NOW = Date.parse("2026-09-21T11:00:00.000Z");

function narrative(overrides: Partial<BriefingNarrative> = {}): BriefingNarrative {
  return {
    text: "Overnight markets show S&P 500 futures up 0.4%.",
    source: "template",
    model: null,
    generated_at: "2026-09-21T11:00:00.000Z",
    facts_hash: "abc123",
    pending: true,
    reason: null,
    ...overrides,
  };
}

function story(id: string, source: Story["source"] = "model"): Story {
  return {
    id,
    scope: "market",
    at: "2026-09-21T08:00:00.000Z",
    what: "A headline about the tape came out overnight.",
    reaction: "Futures are down 0.5% into the open.",
    reactions: [{ label: "S&P futures", symbol: "ES=F", move: -0.5, unit: "pct" }],
    meaning: null,
    tickers: [],
    evidence: ["h1"],
    source,
  };
}

/** Only the fields the store reads; the rest of a report is opaque to it. */
function report(overrides: { phase?: BriefingPhase; degraded?: BriefingReport["degraded"]; factsHash?: string; schema?: number } = {}): BriefingReport {
  return {
    schema_version: overrides.schema ?? BRIEFING_SCHEMA_VERSION,
    generated_at: "2026-09-21T11:00:00.000Z",
    demo: false,
    synthetic_now: false,
    window: { target_session_ymd: "2026-09-21", phase: overrides.phase ?? "pre_open" },
    degraded: overrides.degraded ?? [],
    narrative: narrative({ facts_hash: overrides.factsHash ?? "abc123" }),
    facts_hash: overrides.factsHash ?? "abc123",
  } as unknown as BriefingReport;
}

const KEY: ReportKey = { userKey: "user-1", targetYmd: "2026-09-21", bookHash: "h1", synthetic: false };

let dir = "";
let store: BriefingStore;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-briefing-"));
  store = new BriefingStore(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("holdingsHash", () => {
  it("is the same for the same book in another order and another case", () => {
    const a = holdingsHash([
      { symbol: "NVDA", shares: 10 },
      { symbol: "AAPL", shares: 5 },
    ]);
    const b = holdingsHash([
      { symbol: "aapl", shares: 5 },
      { symbol: "nvda", shares: 10 },
    ]);
    assert.equal(a, b);
    assert.match(a, /^[a-z0-9]{1,16}$/);
  });

  it("merges lots of one name and ignores float dust in their sum", () => {
    assert.equal(
      holdingsHash([{ symbol: "AAPL", shares: 0.1 }, { symbol: "AAPL", shares: 0.2 }]),
      holdingsHash([{ symbol: "AAPL", shares: 0.3 }]),
    );
  });

  it("moves when a position changes size or side, or a name is added", () => {
    const base = holdingsHash([{ symbol: "AAPL", shares: 5 }]);
    assert.notEqual(base, holdingsHash([{ symbol: "AAPL", shares: 6 }]));
    assert.notEqual(base, holdingsHash([{ symbol: "AAPL", shares: -5 }]));
    assert.notEqual(base, holdingsHash([{ symbol: "AAPL", shares: 5 }, { symbol: "MSFT", shares: 1 }]));
  });

  it("does not count a flat position as part of the book", () => {
    assert.equal(holdingsHash([{ symbol: "AAPL", shares: 5 }, { symbol: "MSFT", shares: 0 }]), holdingsHash([{ symbol: "AAPL", shares: 5 }]));
  });
});

describe("bookHash", () => {
  it("moves when cash moves, with the positions unchanged", () => {
    const holdings = [{ symbol: "AAPL", shares: 5 }];
    assert.notEqual(bookHash(holdings, 0), bookHash(holdings, 100_000));
    assert.notEqual(bookHash([], 0), bookHash([], 100_000));
    assert.match(bookHash(holdings, 100_000), /^[a-z0-9]{1,16}$/);
  });

  it("holds still for float residue under a dollar and for another lot order", () => {
    assert.equal(
      bookHash([{ symbol: "AAPL", shares: 5 }, { symbol: "MSFT", shares: 1 }], 1000.004),
      bookHash([{ symbol: "MSFT", shares: 1 }, { symbol: "AAPL", shares: 5 }], 999.996),
    );
  });

  it("keeps an unknown cash apart from a book that holds none", () => {
    assert.notEqual(bookHash([], Number.NaN), bookHash([], 0));
  });
});

describe("reportTtlMs", () => {
  it("is ten minutes before the open and thirty at any other hour", () => {
    assert.equal(reportTtlMs(report({ phase: "pre_open" })), 10 * MINUTE);
    assert.equal(reportTtlMs(report({ phase: "in_session" })), 30 * MINUTE);
    assert.equal(reportTtlMs(report({ phase: "between_sessions" })), 30 * MINUTE);
  });

  it("drops to one minute when any chain section is degraded", () => {
    for (const section of ["chain_news", "quant", "risk"] as const) {
      assert.equal(reportTtlMs(report({ phase: "between_sessions", degraded: [{ section, detail: "request failed" }] })), MINUTE);
    }
  });

  it("is not shortened by a degraded section outside the chain", () => {
    const degraded: BriefingReport["degraded"] = [
      { section: "markets", detail: "timed out", symbols: ["^HSI"] },
      { section: "corporate_actions", detail: "request failed" },
    ];
    assert.equal(reportTtlMs(report({ phase: "pre_open", degraded })), 10 * MINUTE);
  });
});

describe("cacheUsable", () => {
  const stored = (savedAt: number, r = report()) => ({ saved_at: new Date(savedAt).toISOString(), report: r });

  it("serves a report inside its lifetime and refuses it at the boundary", () => {
    assert.equal(cacheUsable(stored(NOW - 9 * MINUTE), NOW, "pre_open"), true);
    assert.equal(cacheUsable(stored(NOW - 10 * MINUTE), NOW, "pre_open"), false);
  });

  it("refuses a report from another phase even when it is fresh", () => {
    assert.equal(cacheUsable(stored(NOW - MINUTE, report({ phase: "between_sessions" })), NOW, "pre_open"), false);
  });

  it("never serves a report from the schema before this one, however fresh", () => {
    const stored = { saved_at: new Date(NOW).toISOString(), report: report({ schema: BRIEFING_SCHEMA_VERSION - 1 }) };
    assert.equal(cacheUsable(stored, NOW + 1, "pre_open"), false);
    assert.equal(cacheUsable({ ...stored, report: report() }, NOW + 1, "pre_open"), true);
  });

  it("refuses a report saved in the future, another schema, or nothing at all", () => {
    assert.equal(cacheUsable(stored(NOW + MINUTE), NOW, "pre_open"), false);
    assert.equal(cacheUsable(stored(NOW - MINUTE, report({ schema: 99 })), NOW, "pre_open"), false);
    assert.equal(cacheUsable(null, NOW, "pre_open"), false);
    assert.equal(cacheUsable({ saved_at: "not a date", report: report() }, NOW, "pre_open"), false);
  });
});

describe("narrativeBudget", () => {
  it("allows the first call and every call spaced past the gap, up to the cap", () => {
    assert.deepEqual(narrativeBudget(null, NOW), { allowed: true });
    const spaced = { generated: MAX_GENERATIONS_PER_SESSION - 1, last_generated_at: new Date(NOW - MIN_GENERATION_GAP_MS).toISOString() };
    assert.deepEqual(narrativeBudget(spaced, NOW), { allowed: true });
  });

  it("refuses inside the gap and at the cap, with a fixed reason", () => {
    const recent = narrativeBudget({ generated: 1, last_generated_at: new Date(NOW - MIN_GENERATION_GAP_MS + 1).toISOString() }, NOW);
    assert.equal(recent.allowed, false);
    const spent = narrativeBudget({ generated: MAX_GENERATIONS_PER_SESSION, last_generated_at: new Date(NOW - 10 * MIN_GENERATION_GAP_MS).toISOString() }, NOW);
    assert.deepEqual(spent, { allowed: false, reason: "model budget for this session is used up" });
  });
});

describe("BriefingStore reports", () => {
  it("round-trips a report and stamps it with the clock it was given", () => {
    store.writeReport(KEY, report(), NOW);
    const back = store.readReport(KEY);
    assert.equal(back?.saved_at, "2026-09-21T11:00:00.000Z");
    assert.equal(back?.report.facts_hash, "abc123");
    assert.deepEqual(fs.readdirSync(dir), ["report.user-1.2026-09-21.h1.json"]);
  });

  it("writes through a temp file and leaves none behind", () => {
    store.writeReport(KEY, report(), NOW);
    store.writeReport(KEY, report({ factsHash: "def456" }), NOW + MINUTE);
    assert.equal(store.readReport(KEY)?.report.facts_hash, "def456");
    assert.deepEqual(fs.readdirSync(dir).filter((name) => name.endsWith(".tmp")), []);
  });

  it("keeps one file per user, session and book", () => {
    store.writeReport(KEY, report(), NOW);
    store.writeReport({ ...KEY, userKey: "user-2" }, report(), NOW);
    store.writeReport({ ...KEY, bookHash: "h2" }, report(), NOW);
    store.writeReport({ ...KEY, targetYmd: "2026-09-22" }, report(), NOW);
    assert.equal(fs.readdirSync(dir).length, 4);
  });

  it("files a developer-clock report under _dev, out of the real ones' way", () => {
    store.writeReport({ ...KEY, synthetic: true }, report(), NOW);
    assert.equal(store.readReport(KEY), null);
    assert.deepEqual(fs.readdirSync(path.join(dir, "_dev")), ["report.user-1.2026-09-21.h1.json"]);
    assert.equal(store.findReportByFacts("user-1", "2026-09-21", "abc123"), null);
  });

  it("refuses a key that could name a path", () => {
    assert.throws(() => store.writeReport({ ...KEY, userKey: "../evil" }, report(), NOW));
    assert.throws(() => store.readReport({ ...KEY, targetYmd: "2026-09-21/.." }));
    assert.throws(() => store.readReport({ ...KEY, bookHash: "" }));
  });

  it("reads a corrupt file as nothing stored", () => {
    fs.writeFileSync(path.join(dir, "report.user-1.2026-09-21.h1.json"), "{ not json", "utf8");
    assert.equal(store.readReport(KEY), null);
  });

  it("finds the newest report written from the asked-for facts, for this user only", () => {
    store.writeReport(KEY, report({ factsHash: "abc123" }), NOW - 5 * MINUTE);
    store.writeReport({ ...KEY, bookHash: "h2" }, report({ factsHash: "abc123" }), NOW);
    store.writeReport({ ...KEY, bookHash: "h3" }, report({ factsHash: "zzz" }), NOW + MINUTE);
    store.writeReport({ ...KEY, userKey: "user-2", bookHash: "h4" }, report({ factsHash: "abc123" }), NOW + 2 * MINUTE);

    assert.equal(store.findReportByFacts("user-1", "2026-09-21", "abc123")?.key.bookHash, "h2");
    assert.equal(store.findReportByFacts("user-1", "2026-09-21", "nope"), null);
    assert.equal(store.findReportByFacts("user-1", "2026-09-22", "abc123"), null);
  });

  it("replaces a stored narrative without renewing the report's lifetime", () => {
    store.writeReport(KEY, report(), NOW);
    store.replaceNarrative(KEY, narrative({ source: "model", model: "m", pending: false, text: "Model text. Second sentence." }));
    const back = store.readReport(KEY);
    assert.equal(back?.report.narrative.source, "model");
    assert.equal(back?.report.narrative.pending, false);
    assert.equal(back?.saved_at, "2026-09-21T11:00:00.000Z");
  });

  it("replaces the stories with the narrative when given them, and leaves them alone otherwise", () => {
    store.writeReport(KEY, { ...report(), stories: [story("market:h1", "template")] }, NOW);
    const model = narrative({ source: "model", model: "m", pending: false, text: "Model text. Second sentence." });
    store.replaceNarrative(KEY, model);
    assert.equal(store.readReport(KEY)?.report.stories[0]?.source, "template");
    store.replaceNarrative(KEY, model, [story("market:h1")]);
    const back = store.readReport(KEY);
    assert.equal(back?.report.stories[0]?.source, "model");
    assert.equal(back?.saved_at, "2026-09-21T11:00:00.000Z");
  });
});

describe("BriefingStore prune", () => {
  const age = (file: string, ms: number): void => {
    const at = new Date(NOW - ms);
    fs.utimesSync(file, at, at);
  };

  it("removes old reports and stale temp files, and nothing it does not own", () => {
    const old = path.join(dir, "report.user-1.2026-09-01.h1.json");
    const fresh = path.join(dir, "report.user-1.2026-09-18.h1.json");
    const staleTmp = path.join(dir, "report.user-1.2026-09-01.h1.json.4242.tmp");
    const corporate = path.join(dir, "corporate-actions.json");
    const override = path.join(dir, "macro-calendar.override.json");
    fs.mkdirSync(path.join(dir, "_dev"));
    const oldDev = path.join(dir, "_dev", "report.user-1.2026-09-01.h1.json");
    for (const file of [old, fresh, staleTmp, corporate, override, oldDev]) fs.writeFileSync(file, "{}", "utf8");
    for (const file of [old, staleTmp, corporate, override, oldDev]) age(file, REPORT_MAX_AGE_MS + MINUTE);
    age(fresh, REPORT_MAX_AGE_MS - MINUTE);

    store.writeReport(KEY, report(), NOW);

    const left = fs.readdirSync(dir).sort();
    assert.deepEqual(left, [
      "_dev",
      "corporate-actions.json",
      "macro-calendar.override.json",
      "report.user-1.2026-09-18.h1.json",
      "report.user-1.2026-09-21.h1.json",
    ]);
    assert.deepEqual(fs.readdirSync(path.join(dir, "_dev")), []);
  });
});

describe("BriefingStore narratives", () => {
  const model = narrative({ source: "model", model: "claude-test", pending: false, text: "Model text. Second sentence." });

  it("keeps a model narrative per user, session and facts hash", () => {
    store.putNarrative("user-1", "2026-09-21", "abc123", model, NOW);
    assert.equal(store.getNarrative("user-1", "2026-09-21", "abc123")?.text, "Model text. Second sentence.");
    assert.equal(store.getNarrative("user-2", "2026-09-21", "abc123"), null);
    assert.equal(store.getNarrative("user-1", "2026-09-22", "abc123"), null);
    assert.equal(store.getNarrative("user-1", "2026-09-21", "other"), null);
  });

  it("keeps the stories beside the model narrative, by the same facts hash, and never without it", () => {
    store.putNarrative("user-1", "2026-09-21", "abc123", model, NOW, [story("market:h1")]);
    assert.deepEqual(store.getStories("user-1", "2026-09-21", "abc123"), [story("market:h1")]);
    assert.equal(store.getStories("user-1", "2026-09-21", "other"), null);
    assert.equal(store.getStories("user-2", "2026-09-21", "abc123"), null);
    // A narrative kept without stories answers alone.
    store.putNarrative("user-1", "2026-09-21", "def456", model, NOW);
    assert.equal(store.getNarrative("user-1", "2026-09-21", "def456")?.text, model.text);
    assert.equal(store.getStories("user-1", "2026-09-21", "def456"), null);
    // Stories beside a template narrative are not served: the two go together.
    store.putNarrative("user-1", "2026-09-21", "ghi789", narrative(), NOW, [story("market:h1")]);
    assert.equal(store.getStories("user-1", "2026-09-21", "ghi789"), null);
  });

  it("never serves a stored template as a model narrative", () => {
    store.putNarrative("user-1", "2026-09-21", "abc123", narrative(), NOW);
    assert.equal(store.getNarrative("user-1", "2026-09-21", "abc123"), null);
  });

  it("counts generations per session and remembers the last one", () => {
    assert.equal(store.narrativeSession("user-1", "2026-09-21"), null);
    store.noteGeneration("user-1", "2026-09-21", NOW);
    store.noteGeneration("user-1", "2026-09-21", NOW + 25 * MINUTE);
    store.putNarrative("user-1", "2026-09-21", "abc123", model, NOW + 26 * MINUTE);
    assert.deepEqual(store.narrativeSession("user-1", "2026-09-21"), {
      generated: 2,
      last_generated_at: new Date(NOW + 25 * MINUTE).toISOString(),
    });
    assert.equal(store.narrativeSession("user-1", "2026-09-22"), null);
  });

  it("drops sessions older than the reports they belong to", () => {
    store.putNarrative("user-1", "2026-09-01", "old", model, NOW);
    store.putNarrative("user-1", "2026-09-21", "abc123", model, NOW);
    assert.equal(store.getNarrative("user-1", "2026-09-01", "old"), null);
    assert.notEqual(store.getNarrative("user-1", "2026-09-21", "abc123"), null);
  });

  it("starts over from a corrupt narratives file instead of failing", () => {
    fs.writeFileSync(path.join(dir, "narratives.json"), "][", "utf8");
    assert.equal(store.getNarrative("user-1", "2026-09-21", "abc123"), null);
    store.noteGeneration("user-1", "2026-09-21", NOW);
    assert.equal(store.narrativeSession("user-1", "2026-09-21")?.generated, 1);
  });
});
