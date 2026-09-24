import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { NarrativeCaller } from "@meridian/research/briefing";
import type { BriefingPorts, BriefingReport, BriefingRequest } from "../../shared/briefing-types";
import { createBriefingBuilder } from "./briefing-build";
import { BriefingStore, MIN_GENERATION_GAP_MS } from "./briefing-store";
import { createNarrativeService } from "./narrative-service";

const MINUTE = 60_000;
const PRE_OPEN = new Date("2026-09-21T11:00:00.000Z");
const TARGET = "2026-09-21";

const REQUEST: BriefingRequest = { holdings: [{ symbol: "AAPL", shares: 10, cost_usd: 3000 }], cash: 1000 };

/** Two clean sentences with no figure in them, so they pass the engine's validator against any facts. */
const MODEL_TEXT = "Markets abroad were quiet through the night. The calendar for this session is light.";

const ports: BriefingPorts = {
  async marketSnapshot(symbol) {
    return { symbol, price: 101, previous_close: 100, market_time: "2026-09-21T10:55:00.000Z", in_regular_session: false };
  },
  async heldQuote(symbol) {
    return { symbol, price: 102, regular_price: 100, previous_close: 99, session: "pre", as_of: "2026-09-21T10:59:00.000Z" };
  },
  async quant() {
    return null;
  },
  async chainSlice(ticker) {
    return { ticker, coverage: "tracked", news: [], filings: [], measurements: [], scheduled_earnings: [] };
  },
  async riskLatest() {
    return null;
  },
  async corporateCalendar(symbol) {
    return { symbol, available: false, ex_dividend_date: null, dividend_date: null, dividend_rate: null, earnings_dates: [], earnings_estimated: null, recent_dividends: [], recent_splits: [] };
  },
  async marketNews() {
    return [];
  },
};

let dir = "";
let store: BriefingStore;
let realNow = 0;
let user = "user-1";
let configured = true;
let synthetic = false;
let modelCalls: Array<{ model: string; user: string }> = [];
let modelAnswer: () => Promise<string>;

const caller: NarrativeCaller = async (input) => {
  modelCalls.push({ model: input.model, user: input.user });
  return { text: await modelAnswer() } as Awaited<ReturnType<NarrativeCaller>>;
};

function service() {
  return createNarrativeService({
    store,
    userKey: () => user,
    modelConfigured: () => configured,
    caller,
    model: () => "claude-test",
    realNowMs: () => realNow,
  });
}

/** A real stored report, built the way the app builds one. */
async function storedReport(request: BriefingRequest = REQUEST): Promise<BriefingReport> {
  const builder = createBriefingBuilder({
    store,
    ports: () => ports,
    clock: () => ({ now: PRE_OPEN, synthetic }),
    realNowMs: () => realNow,
    userKey: () => user,
    modelConfigured: () => configured,
  });
  return (await builder.build({ ...request, force: true })).report;
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-briefing-narrative-"));
  store = new BriefingStore(dir);
  realNow = PRE_OPEN.getTime();
  user = "user-1";
  configured = true;
  synthetic = false;
  modelCalls = [];
  // The model answers the lead and a list of rewritten stories; an empty list leaves every story as its template.
  modelAnswer = async () => JSON.stringify({ lead: MODEL_TEXT, stories: [] });
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("narrative service", () => {
  it("refuses a malformed request with the fixed code", async () => {
    assert.deepEqual(await service().getNarrative({ target_session_ymd: "today", facts_hash: "x" }), { ok: false, error: "invalid_request" });
    assert.deepEqual(await service().getNarrative(null), { ok: false, error: "invalid_request" });
  });

  it("answers not_found when this user has no stored report written from those facts", async () => {
    const report = await storedReport();
    assert.deepEqual(await service().getNarrative({ target_session_ymd: TARGET, facts_hash: "zzzz" }), { ok: false, error: "not_found" });
    assert.deepEqual(await service().getNarrative({ target_session_ymd: "2026-09-22", facts_hash: report.facts_hash }), { ok: false, error: "not_found" });
    user = "user-2";
    assert.deepEqual(await service().getNarrative({ target_session_ymd: TARGET, facts_hash: report.facts_hash }), { ok: false, error: "not_found" });
    assert.equal(modelCalls.length, 0);
  });

  it("writes a model narrative from the stored report, keeps it, and puts it into the stored report", async () => {
    const report = await storedReport();
    assert.equal(report.narrative.pending, true);

    const result = await service().getNarrative({ target_session_ymd: TARGET, facts_hash: report.facts_hash });
    assert.ok(result.ok);
    assert.equal(result.narrative.source, "model");
    assert.equal(result.narrative.model, "claude-test");
    assert.equal(result.narrative.text, MODEL_TEXT);
    assert.equal(result.narrative.pending, false);
    assert.equal(result.narrative.facts_hash, report.facts_hash);
    assert.ok(Array.isArray(result.stories));
    assert.equal(modelCalls.length, 1);

    // The second reader, and the next process, are served from disk, stories included.
    const again = await service().getNarrative({ target_session_ymd: TARGET, facts_hash: report.facts_hash });
    assert.ok(again.ok);
    assert.equal(again.narrative.text, MODEL_TEXT);
    assert.deepEqual(again.stories, result.stories);
    assert.equal(modelCalls.length, 1);

    const onDisk = store.findReportByFacts("user-1", TARGET, report.facts_hash);
    assert.equal(onDisk?.stored.report.narrative.source, "model");
    assert.equal(onDisk?.stored.report.narrative.pending, false);
    assert.deepEqual(onDisk?.stored.report.stories, result.stories);
  });

  it("serves the stored stories to the next briefing:get of the same facts", async () => {
    const report = await storedReport();
    const result = await service().getNarrative({ target_session_ymd: TARGET, facts_hash: report.facts_hash });
    assert.ok(result.ok && result.narrative.source === "model");

    // A rebuild of the same book inside the cache window: the stored model
    // narrative and stories are spliced over the fresh template.
    const rebuilt = await storedReport();
    assert.equal(rebuilt.facts_hash, report.facts_hash);
    assert.equal(rebuilt.narrative.source, "model");
    assert.equal(rebuilt.narrative.pending, false);
    assert.deepEqual(rebuilt.stories, result.stories);
  });

  it("sends the model percentages and tickers, and no account dollars", async () => {
    const report = await storedReport();
    await service().getNarrative({ target_session_ymd: TARGET, facts_hash: report.facts_hash });
    const sent = modelCalls[0]!.user;
    assert.ok(sent.includes("AAPL"));
    assert.equal(sent.includes("$"), false);
    // 10 shares at 102 plus 1000 cash: none of the book's dollar figures is in the prompt.
    for (const figure of ["2020", "1020", "3000", "1000"]) assert.equal(sent.includes(figure), false, figure);
  });

  it("shares one model call between readers that ask together", async () => {
    const report = await storedReport();
    const s = service();
    const ask = { target_session_ymd: TARGET, facts_hash: report.facts_hash };
    const [a, b] = await Promise.all([s.getNarrative(ask), s.getNarrative(ask)]);
    assert.ok(a.ok && b.ok);
    assert.equal(modelCalls.length, 1);
  });

  it("returns the template with a reason when the model fails, and keeps nothing", async () => {
    const report = await storedReport();
    modelAnswer = async () => {
      throw new Error("401 invalid x-api-key sk-ant-secret");
    };
    const result = await service().getNarrative({ target_session_ymd: TARGET, facts_hash: report.facts_hash });
    assert.ok(result.ok);
    assert.equal(result.narrative.source, "template");
    assert.equal(result.narrative.pending, false);
    assert.equal(result.narrative.reason, "model call failed");
    assert.ok(Array.isArray(result.stories));
    assert.equal(JSON.stringify(result).includes("sk-ant"), false);
    assert.equal(store.getNarrative("user-1", TARGET, report.facts_hash), null);
    // The stored report stops advertising a model version that is not coming.
    assert.equal(store.findReportByFacts("user-1", TARGET, report.facts_hash)?.stored.report.narrative.pending, false);
  });

  it("spends at most three model calls per session, twenty minutes apart", async () => {
    const s = service();
    const hashes: string[] = [];
    // Four different books give four different sets of facts for one session.
    for (const shares of [10, 20, 30, 40]) {
      const report = await storedReport({ holdings: [{ symbol: "AAPL", shares, cost_usd: 3000 }, { symbol: `T${shares}`, shares: 1, cost_usd: 1 }], cash: 1000 });
      hashes.push(report.facts_hash);
    }
    assert.equal(new Set(hashes).size, 4);

    const first = await s.getNarrative({ target_session_ymd: TARGET, facts_hash: hashes[0] });
    assert.ok(first.ok && first.narrative.source === "model");

    realNow += MIN_GENERATION_GAP_MS - MINUTE;
    const tooSoon = await s.getNarrative({ target_session_ymd: TARGET, facts_hash: hashes[1] });
    assert.ok(tooSoon.ok);
    assert.equal(tooSoon.narrative.source, "template");
    assert.equal(tooSoon.narrative.reason, "a model narrative was written less than 20 minutes ago");
    assert.equal(modelCalls.length, 1);

    realNow += 2 * MINUTE;
    assert.ok((await s.getNarrative({ target_session_ymd: TARGET, facts_hash: hashes[1] })).ok);
    realNow += MIN_GENERATION_GAP_MS;
    assert.ok((await s.getNarrative({ target_session_ymd: TARGET, facts_hash: hashes[2] })).ok);
    assert.equal(modelCalls.length, 3);

    realNow += 10 * MIN_GENERATION_GAP_MS;
    const spent = await s.getNarrative({ target_session_ymd: TARGET, facts_hash: hashes[3] });
    assert.ok(spent.ok);
    assert.equal(spent.narrative.source, "template");
    assert.equal(spent.narrative.reason, "model budget for this session is used up");
    assert.equal(modelCalls.length, 3);
  });

  it("counts a failed call against the budget: it was still spent", async () => {
    const report = await storedReport();
    modelAnswer = async () => {
      throw new Error("timeout");
    };
    await service().getNarrative({ target_session_ymd: TARGET, facts_hash: report.facts_hash });
    assert.equal(store.narrativeSession("user-1", TARGET)?.generated, 1);
  });

  it("answers with the template and spends nothing when no model is configured", async () => {
    const report = await storedReport();
    configured = false;
    const result = await service().getNarrative({ target_session_ymd: TARGET, facts_hash: report.facts_hash });
    assert.ok(result.ok);
    assert.equal(result.narrative.source, "template");
    assert.equal(result.narrative.reason, "model is not configured");
    // The report keeps its own stories, and the answer carries them. A report
    // that carries no list at all (built before the assembly wrote one) is
    // answered with an empty list, the service's own rule.
    const own = report.stories ?? [];
    assert.deepEqual(result.stories, own);
    assert.deepEqual(store.findReportByFacts("user-1", TARGET, report.facts_hash)?.stored.report.stories, report.stories);
    assert.equal(modelCalls.length, 0);
    assert.equal(store.narrativeSession("user-1", TARGET), null);
  });

  it("never narrates a developer-clock report", async () => {
    synthetic = true;
    const report = await storedReport();
    assert.deepEqual(await service().getNarrative({ target_session_ymd: TARGET, facts_hash: report.facts_hash }), { ok: false, error: "not_found" });
    assert.equal(modelCalls.length, 0);
  });

  it("never narrates a demo book: it was never stored", async () => {
    const report = await storedReport({ ...REQUEST, demo: true });
    assert.deepEqual(await service().getNarrative({ target_session_ymd: TARGET, facts_hash: report.facts_hash }), { ok: false, error: "not_found" });
    assert.equal(modelCalls.length, 0);
  });
});
