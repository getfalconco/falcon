import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { AgentPushEvent } from "../../shared/agent-types";
import { en } from "../../renderer/lib/i18n/messages/areas/agents";
import { DIGEST_TIME, createDigestChannel, digestDue } from "./channels/digest";
import type { DigestItem, DigestOutcome } from "./channels/desktop";
import { AgentEngine, type AgentEngineDeps } from "./engine";
import { clarifyFor, endReached, endsFromWords, proposeEnds } from "./ends";
import { draftFromBriefWithModel, type AgentModelCaller } from "./llm";
import type { AgentDataSources } from "./sources";
import { AgentStore } from "./store";
import { agentFixture, fakeSources, filing, sequentialIds } from "./test-fakes";
import { validateDraft, validateEnds, validatePatch } from "./validate";

/**
 * Create Agent v2 on the engine side: the starter sentences read into agent
 * records, an end on every new agent, the one question for vague words, the
 * next check exposed, an end that completes the agent, and the daily digest.
 * No model is called: the heuristic path, or a scripted reply.
 */

function engineFor(over: Partial<AgentEngineDeps> = {}, sources: Partial<AgentDataSources> = {}) {
  const events: AgentPushEvent[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-agents-v2-"));
  let now = new Date("2026-10-15T14:00:00.000Z");
  const engine = new AgentEngine({
    root,
    userKey: () => "anon",
    userId: () => undefined,
    sources: fakeSources(sources),
    caller: () => null,
    channels: () => [],
    emit: (e) => events.push(e),
    now: () => now,
    newId: sequentialIds("agent"),
    log: () => {},
    ...over,
  });
  return { engine, events, root, store: () => new AgentStore(root, "anon"), setNow: (d: Date) => (now = d) };
}

/** A starter's English brief with its ticker filled in, as the create flow puts it in. */
const starter = (id: "earnings" | "filings" | "insider", ticker: string) => en[`agents.starter.${id}.brief`].split("{ticker}").join(ticker);

describe("the starter sentences, read into agent records", () => {
  it("results of a holding: an earnings watch, one report, ending after the release, metrics named", async () => {
    const { engine } = engineFor({}, { earningsDates: async () => ({ dates: ["2026-11-19"], estimated: false }) });
    const res = await engine.draftFromBrief(starter("earnings", "NVDA"));
    assert.ok(res.ok);
    const d = res.data;
    assert.equal(d.ticker, "NVDA");
    assert.deepEqual(d.triggers, [{ kind: "earnings", ticker: "NVDA", moment: "release" }]);
    assert.equal(d.oneShot, true);
    assert.deepEqual(d.ends, { kind: "earnings", ticker: "NVDA" });
    assert.equal(d.endsProposed, true);
    assert.deepEqual(d.metrics.map((m) => m.label), ["Revenue", "Gross margin", "Next-quarter guidance"]);
    assert.deepEqual(d.channels, ["digest"]);
    assert.equal(d.nextExpectedAt, "2026-11-19T13:00:00.000Z", "the results date, for When");
    assert.equal(d.clarify, undefined);
  });

  it("filings on a holding: a standing 8-K, 10-Q and 10-K watch with a dated end", async () => {
    const { engine } = engineFor();
    const res = await engine.draftFromBrief(starter("filings", "AAPL"));
    assert.ok(res.ok);
    assert.deepEqual(res.data.triggers, [{ kind: "filing", ticker: "AAPL", forms: ["8-K", "10-Q", "10-K"] }]);
    assert.equal(res.data.oneShot, false);
    assert.deepEqual(res.data.ends, { kind: "date", date: "2027-01-13" });
  });

  it("insider purchases: Form 4, open-market purchases only", async () => {
    const { engine } = engineFor();
    const res = await engine.draftFromBrief(starter("insider", "MSFT"));
    assert.ok(res.ok);
    assert.deepEqual(res.data.triggers, [{ kind: "filing", ticker: "MSFT", forms: ["4"], insiderBuysOnly: true }]);
    assert.equal(res.data.ends?.kind, "date");
  });

  it("creates the agent with its end and its first check due now", async () => {
    const { engine } = engineFor();
    const res = await engine.draftFromBrief(starter("filings", "AAPL"));
    assert.ok(res.ok);
    const created = await engine.create(res.data);
    assert.ok(created.ok);
    assert.deepEqual(created.data.ends, { kind: "date", date: "2027-01-13" });
    assert.equal(created.data.nextCheckAt, "2026-10-15T14:00:00.000Z");
    assert.deepEqual(created.data.channels, ["digest"]);
  });
});

describe("an end on every new agent", () => {
  it("is proposed for any draft that names none", async () => {
    const { engine } = engineFor();
    for (const brief of [
      "Tell me when NVDA reports.",
      "Keep me posted on AMZN news that mentions antitrust.",
      "After every CPI release give me a brief note.",
      "Every Monday at 08:00, a digest on MSFT.",
      "If TSLA moves more than 7% in a day, tell me.",
    ]) {
      const res = await engine.draftFromBrief(brief);
      assert.ok(res.ok, brief);
      assert.ok(res.data.ends, `no end for: ${brief}`);
    }
  });

  it("is filled in on create even when the draft arrives without one", async () => {
    const { engine } = engineFor();
    const created = await engine.create({ name: "AAPL filings", brief: "AAPL filings", triggers: [{ kind: "filing", ticker: "AAPL", forms: ["8-K"] }], metrics: [], channels: ["digest"], oneShot: false });
    assert.ok(created.ok);
    assert.deepEqual(created.data.ends, { kind: "date", date: "2027-01-13" });
  });

  it("takes the reader's own words over a proposal", () => {
    assert.deepEqual(endsFromWords("Watch AAPL filings until 2026-12-31.", "AAPL"), { kind: "date", date: "2026-12-31" });
    assert.deepEqual(endsFromWords("Watch NVDA news until they report.", "NVDA"), { kind: "earnings", ticker: "NVDA" });
    assert.deepEqual(endsFromWords("Watch AAPL news until the 10-K.", "AAPL"), { kind: "filing", ticker: "AAPL", form: "10-K" });
    assert.equal(endsFromWords("Watch AAPL news.", "AAPL"), undefined);
  });

  it("proposes by kind: one-report watches end with their event, standing ones on a date", () => {
    const base = { ticker: "NVDA", oneShot: true };
    assert.deepEqual(proposeEnds({ ...base, triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }] }, "2026-10-15"), { kind: "earnings", ticker: "NVDA" });
    assert.deepEqual(proposeEnds({ ...base, triggers: [{ kind: "filing", ticker: "NVDA", forms: ["10-K"] }] }, "2026-10-15"), { kind: "filing", ticker: "NVDA", form: "10-K" });
    assert.deepEqual(proposeEnds({ ...base, oneShot: false, triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }] }, "2026-10-15"), { kind: "date", date: "2027-04-17" });
  });

  it("validates ends on create and on edit", () => {
    assert.deepEqual(validateEnds({ kind: "earnings" }, "NVDA"), { kind: "earnings", ticker: "NVDA" });
    assert.deepEqual(validateEnds({ kind: "filing", ticker: "aapl", form: "10k" }), { kind: "filing", ticker: "AAPL", form: "10-K" });
    assert.throws(() => validateEnds({ kind: "date", date: "2026-02-30" }), /must be a date/);
    assert.throws(() => validateEnds({ kind: "soon" }), /date, a results release or a filing/);
    const draft = validateDraft({ brief: "b", ticker: "NVDA", triggers: [{ kind: "earnings" }], ends: { kind: "earnings" } });
    assert.deepEqual(draft.ends, { kind: "earnings", ticker: "NVDA" });
    assert.deepEqual(validatePatch({ ends: { kind: "date", date: "2027-01-01" } }, "NVDA").ends, { kind: "date", date: "2027-01-01" });
  });
});

const reply = (over: Record<string, unknown>) =>
  JSON.stringify({
    name: "Model name",
    ticker: null,
    companyName: null,
    triggers: [],
    metrics: [],
    instructions: null,
    oneShot: false,
    ends: "",
    clarify: "none",
    notes: [],
    ...over,
  });
const NULLS = { ticker: null, moment: null, forms: null, insiderBuysOnly: null, thresholdPct: null, window: null, keywords: null, event: null, cadence: null, time: null, weekday: null };

describe("agents about no one company", () => {
  it("a topic: news that mentions it, no question asked", async () => {
    const { engine } = engineFor();
    const res = await engine.draftFromBrief("watch tech");
    assert.ok(res.ok);
    assert.equal(res.data.ticker, undefined);
    assert.deepEqual(res.data.triggers, [{ kind: "news", keywords: ["tech"] }]);
    assert.equal(res.data.clarify, undefined);
    assert.ok(res.data.ends);
  });

  it("a scheduled topic digest: the placeholder's own example", async () => {
    const { engine } = engineFor();
    const res = await engine.draftFromBrief("Every weekday morning, tell me which semiconductor suppliers had material news overnight");
    assert.ok(res.ok);
    assert.deepEqual(res.data.triggers, [{ kind: "schedule", cadence: "weekdays", time: "08:00", keywords: ["semiconductor", "suppliers"] }]);
    assert.equal(res.data.ticker, undefined);
    assert.equal(res.data.clarify, undefined);
    assert.deepEqual(res.data.metrics, []);
  });

  it("a macro release and market-wide news validate without a ticker", () => {
    assert.deepEqual(validateDraft({ brief: "b", triggers: [{ kind: "macro", event: "CPI" }] }).triggers, [{ kind: "macro", event: "CPI" }]);
    assert.deepEqual(validateDraft({ brief: "b", triggers: [{ kind: "news", keywords: [] }] }).triggers, [{ kind: "news", keywords: [] }]);
    assert.deepEqual(
      validateDraft({ brief: "b", triggers: [{ kind: "schedule", cadence: "daily", time: "07:30", keywords: ["Chip", " foundry "] }] }).triggers,
      [{ kind: "schedule", cadence: "daily", time: "07:30", keywords: ["chip", "foundry"] }],
    );
  });

  it("the model may set up a theme as keywords, and its wish to ask is not enough on its own", async () => {
    const caller: AgentModelCaller = async () =>
      reply({ triggers: [{ ...NULLS, kind: "news", keywords: ["semiconductor", "foundry"] }], clarify: "subject" });
    const draft = await draftFromBriefWithModel("Semiconductor supply chain news", { caller, sources: fakeSources(), today: "2026-10-15" });
    assert.deepEqual(draft.triggers, [{ kind: "news", keywords: ["semiconductor", "foundry"] }]);
    assert.equal(draft.clarify, undefined);
  });

  it("asks only when there is nothing to act on, and about what is missing", async () => {
    const { engine } = engineFor();
    const res = await engine.draftFromBrief("help me out please");
    assert.ok(res.ok);
    assert.deepEqual(res.data.clarify, { field: "subject", question: "What to watch, and when?" });
    assert.equal(clarifyFor({ ticker: "NVDA", triggers: [] })?.field, "trigger");
    assert.equal(clarifyFor({ triggers: [{ kind: "macro", event: "CPI" }] }), null);
    assert.equal(clarifyFor({ triggers: [{ kind: "schedule", cadence: "daily", time: "08:00" }] }), null);
  });

  it("company-less agents run and write reports: topic news, market news, a macro release, a topic digest", async () => {
    const at = "2026-10-15T15:00:00.000Z";
    const headlines = [
      { id: "a", title: "Foundry supplier raises capacity guide", url: "https://example.com/a", publishedAt: "2026-10-15T14:30:00.000Z", source: "Wire" },
      { id: "b", title: "Retail sales beat estimates", url: "https://example.com/b", publishedAt: "2026-10-15T14:40:00.000Z", source: "Wire" },
    ];
    const { engine, store, setNow } = engineFor(
      { caller: () => null },
      {
        marketNews: async () => headlines,
        macroEvents: () => [{ code: "CPI", title: "CPI", date: "2026-10-15", timeEt: "08:30", period: "Sep" }] as never,
      },
    );
    setNow(new Date(at));
    const make = async (triggers: unknown[]) => {
      const res = await engine.create({ name: "Mine", brief: "b", triggers, metrics: [], channels: [], oneShot: false });
      assert.ok(res.ok, JSON.stringify(res));
      return res.data.id;
    };
    // Created a moment before the headlines, so they are new to the agents.
    setNow(new Date("2026-10-15T14:00:00.000Z"));
    const topic = await make([{ kind: "news", keywords: ["foundry"] }]);
    const market = await make([{ kind: "news", keywords: [] }]);
    const macro = await make([{ kind: "macro", event: "CPI" }]);
    // The digest runs on the local clock: made before 10:00 local, due at 10:00.
    setNow(new Date(2026, 9, 15, 9, 0));
    const digest = await make([{ kind: "schedule", cadence: "daily", time: "10:00", keywords: ["foundry"] }]);
    setNow(new Date(at));
    // No model here: the write-up is tried and, after its attempts, sent from the facts alone.
    const runToReport = async (id: string) => {
      let run = await engine.runAgent(id, false);
      for (let i = 0; i < 3 && !run.fired; i++) run = await engine.runAgent(id, false);
      return run;
    };
    for (const id of [topic, market, macro]) {
      const run = await runToReport(id);
      assert.equal(run.fired, true, `${id}: ${run.note}`);
      assert.ok(run.report && run.report.headline, id);
      assert.equal(store().get(id)!.unread, 1);
    }
    const topicReport = store().reports(topic)[0]!;
    assert.ok(topicReport.sources.every((src) => /Foundry/i.test(src.title)), "a topic watch reports the headlines that mention it");
    // The digest fires at its time with the topic's headlines.
    setNow(new Date(new Date(2026, 9, 15, 10, 5).getTime()));
    const run = await runToReport(digest);
    assert.equal(run.fired, true, run.note);
    assert.ok(run.report!.sources.some((src) => /Foundry/.test(src.title)));
    assert.ok(run.report!.sources.every((src) => !/Retail sales/.test(src.title)), "headlines off the topic are left out");
  });
});

describe("the next check and the end, as the engine runs them", () => {
  it("shows when it looks again after each check", async () => {
    const { engine, store } = engineFor();
    const created = await engine.create({ name: "AAPL filings", brief: "b", triggers: [{ kind: "filing", ticker: "AAPL", forms: ["8-K"] }], metrics: [], channels: [], oneShot: false });
    assert.ok(created.ok);
    await engine.runAgent(created.data.id, false);
    const agent = store().get(created.data.id)!;
    assert.ok(agent.lastCheckedAt);
    assert.ok(agent.nextCheckAt && Date.parse(agent.nextCheckAt) > Date.parse(agent.lastCheckedAt!), agent.nextCheckAt);
  });

  it("completes the agent once its end date has passed", async () => {
    const { engine, store, setNow } = engineFor();
    const created = await engine.create({
      name: "AAPL filings",
      brief: "b",
      triggers: [{ kind: "filing", ticker: "AAPL", forms: ["8-K"] }],
      metrics: [],
      channels: [],
      oneShot: false,
      ends: { kind: "date", date: "2026-10-20" },
    });
    assert.ok(created.ok);
    await engine.runAgent(created.data.id, false);
    assert.equal(store().get(created.data.id)!.status, "active");
    // A dated end gets a last look as it passes.
    assert.ok(Date.parse(store().get(created.data.id)!.nextCheckAt!) <= Date.parse("2026-10-21T04:01:00.000Z"));
    setNow(new Date("2026-10-21T05:00:00.000Z"));
    const run = await engine.runAgent(created.data.id, false);
    const agent = store().get(created.data.id)!;
    assert.equal(agent.status, "completed");
    assert.equal(agent.nextCheckAt, undefined);
    assert.deepEqual(run.noteLines, [{ code: "activity.endedDate", params: { date: "2026-10-20" } }]);
    assert.ok(store().activity(agent.id).some((a) => a.kind === "completed"));
  });

  it("ends a results watch after its own results report, not before (a call write-up is not cut short)", async () => {
    const agent = agentFixture({ ends: { kind: "earnings", ticker: "NVDA" }, triggers: [{ kind: "earnings", ticker: "NVDA", moment: "call" }] });
    const sources = fakeSources({ filings: async () => [filing()] });
    const now = new Date("2026-11-19T22:00:00.000Z");
    assert.equal(await endReached(agent, { failures: 0, firedKeys: [], lastFiredByTrigger: {} }, sources, now), false);
    assert.equal(await endReached(agent, { failures: 0, firedKeys: [`earnings:NVDA:${filing().accession}`], lastFiredByTrigger: {} }, sources, now), true);
    // Without its own results trigger, any release after creation ends it.
    assert.equal(await endReached({ ...agent, triggers: [{ kind: "news", ticker: "NVDA", keywords: [] }] }, { failures: 0, firedKeys: [], lastFiredByTrigger: {} }, sources, now), true);
  });
});

describe("the daily digest", () => {
  const item = (agentId: string, at: string) => ({ id: `d-${agentId}`, at, agentId, reportId: `r-${agentId}`, title: `${agentId} watch`, body: "Headline" });

  it(`sends at ${DIGEST_TIME} what was held from before then, once a day`, () => {
    const at = (h: number, m = 0) => new Date(2026, 9, 15, h, m);
    const file = { version: 1 as const, entries: [item("a", at(7, 30).toISOString()), item("b", at(9).toISOString())] };
    assert.deepEqual(digestDue(file, at(7, 59)), [], "not before the time");
    assert.deepEqual(digestDue(file, at(8, 1)).map((e) => e.agentId), ["a"], "a report after the time waits for tomorrow");
    assert.deepEqual(digestDue({ ...file, lastSentDay: "2026-10-15" }, at(10)), [], "once a day");
    assert.deepEqual(digestDue({ version: 1, entries: [] }, at(10)), []);
  });

  it("holds a report on the digest channel instead of notifying", () => {
    const held: unknown[] = [];
    const ch = createDigestChannel({ append: (e) => held.push(e), newId: sequentialIds("dg"), now: () => new Date("2026-10-15T15:00:00.000Z") });
    const out = ch.deliver({ agent: agentFixture(), report: { id: "r1" } as never, title: "NVDA earnings watch", body: "Results are out" });
    assert.equal(out.status, "queued");
    assert.equal(held.length, 1);
  });

  it("flushes through the desktop notification, keeps it through quiet hours, and lets the day pass when sent", async () => {
    const sent: DigestItem[][] = [];
    let outcome: DigestOutcome = "held";
    const { engine, store, setNow } = engineFor({
      sendDigest: (items) => {
        sent.push([...items]);
        return outcome;
      },
    });
    const s = store();
    s.appendDigest(item("agent-a", new Date(2026, 9, 15, 6).toISOString()));
    s.appendDigest(item("agent-b", new Date(2026, 9, 15, 7).toISOString()));
    setNow(new Date(2026, 9, 15, 8, 5));
    engine.flushDigest();
    assert.equal(sent.length, 1);
    assert.equal(store().digest().entries.length, 2, "quiet hours hold it");
    outcome = "shown";
    engine.flushDigest();
    assert.deepEqual(sent[1]!.map((i) => i.agentId), ["agent-a", "agent-b"]);
    assert.equal(store().digest().entries.length, 0);
    assert.equal(store().digest().lastSentDay, "2026-10-15");
    engine.flushDigest();
    assert.equal(sent.length, 2, "once a day");
  });
});
