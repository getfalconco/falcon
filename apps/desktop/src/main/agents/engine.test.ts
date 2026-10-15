import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { EM_DASH } from "../../shared/copy-rules";
import { DEFAULT_NOTIFICATION_SETTINGS, type NotificationSettings } from "../../shared/notification-settings";
import type { AgentDraft, AgentPushEvent } from "../../shared/agent-types";
import { createDesktopChannel } from "./channels/desktop";
import { MOBILE_PENDING_STATUS, createMobilePushChannel } from "./channels/mobile-push";
import type { DeliveryChannel } from "./channels/types";
import { AgentEngine, backoffMs } from "./engine";
import { gatherMaterial } from "./gather";
import { callJson, draftFromBriefWithModel, finalizeReport, writeReply, writeReport, type AgentModelCall, type AgentModelCaller } from "./llm";
import type { AgentDataSources } from "./sources";
import { EMPTY_STATE, AgentStore } from "./store";
import { agentFixture, fakeSources, filing, sequentialIds } from "./test-fakes";
import type { TriggerEvent } from "./triggers";

/** A caller that answers from a script, recording what it was asked. */
function scripted(replies: Array<string | Error>): AgentModelCaller & { calls: AgentModelCall[] } {
  const calls: AgentModelCall[] = [];
  const fn = (async (call: AgentModelCall) => {
    calls.push(call);
    const next = replies.shift();
    if (next === undefined) throw new Error("no scripted reply left");
    if (next instanceof Error) throw next;
    return next;
  }) as AgentModelCaller & { calls: AgentModelCall[] };
  fn.calls = calls;
  return fn;
}

const RELEASE_TEXT =
  "NVIDIA Announces Financial Results for Third Quarter Fiscal 2027. Revenue of $57,006 million, up 62% from a year ago. " +
  "Data Center revenue was $51,215 million. GAAP gross margin was 73.4%. For the fourth quarter, revenue is guided to $65.0 billion.";

const releaseSources = (over: Partial<AgentDataSources> = {}) =>
  fakeSources({
    earningsDates: async () => ({ dates: ["2026-11-19"], estimated: false }),
    filings: async () => [filing()],
    filingText: async (f) => ({ title: f.form, url: f.url, text: RELEASE_TEXT }),
    ...over,
  });

const GOOD_REPORT = JSON.stringify({
  headline: `Data center revenue $51.2 billion ${EM_DASH} above the bar!`,
  summary: "NVIDIA reported revenue of $57.0 billion, up 62%. Investors should buy the dip.\n\nGross margin was 73.4%.",
  readings: [
    { metricId: "m1", value: "$51.2 billion", verdict: "above", comparison: null },
    { metricId: "m2", value: "75.0%", verdict: "inline", comparison: null },
  ],
  sources: [1],
});

function earningsEvent(): TriggerEvent {
  return {
    keys: [`earnings:NVDA:${filing().accession}`],
    kind: "earnings",
    trigger: { kind: "earnings", ticker: "NVDA", moment: "release" },
    title: "NVDA published quarterly results (8-K item 2.02, filed 2026-11-19).",
    at: "2026-11-19T21:30:00.000Z",
    ticker: "NVDA",
    filings: [filing()],
  };
}

describe("model output parsing", () => {
  it("asks again once when the reply is not valid JSON", async () => {
    const caller = scripted(["Sure, here it is: {not json", '{"reply": "ok", "reportIds": []}']);
    const out = await callJson(caller, { purpose: "reply", system: "s", user: "u", schema: {}, maxTokens: 10, timeoutMs: 10 }, (v) => v as { reply: string });
    assert.equal(out.reply, "ok");
    assert.match(caller.calls[1]!.user, /REJECTED: the reply was not valid JSON/);
  });

  it("gives up after the retry with a readable error", async () => {
    const caller = scripted(["nope", "still nope"]);
    await assert.rejects(
      callJson(caller, { purpose: "reply", system: "s", user: "u", schema: {}, maxTokens: 10, timeoutMs: 10 }, (v) => v),
      /could not be read/,
    );
  });

  it("turns a draft reply into a validated draft with the catalog's name", async () => {
    const caller = scripted([
      JSON.stringify({
        name: "NVDA earnings watch",
        ticker: "nvda",
        companyName: "Nvidia",
        triggers: [
          { kind: "earnings", ticker: null, moment: "release", forms: null, insiderBuysOnly: null, thresholdPct: null, window: null, keywords: null, event: null, cadence: null, time: null, weekday: null },
          { kind: "price_move", ticker: "ZZZZ", moment: null, forms: null, insiderBuysOnly: null, thresholdPct: 5, window: "1d", keywords: null, event: null, cadence: null, time: null, weekday: null },
          { kind: "schedule", ticker: null, moment: null, forms: null, insiderBuysOnly: null, thresholdPct: null, window: null, keywords: null, event: null, cadence: "daily", time: "8am", weekday: null },
        ],
        metrics: [{ label: "Data center revenue", expectation: null }, { label: "Gross margin", expectation: "over 75%" }],
        instructions: null,
        oneShot: true,
        notes: [`Assumed the next report ${EM_DASH} the date is not given.`],
      }),
    ]);
    const draft = await draftFromBriefWithModel("NVDA reports next week. Tell me how data center revenue and gross margin came in.", {
      caller,
      sources: fakeSources(),
      today: "2026-11-12",
    });
    assert.equal(draft.ticker, "NVDA");
    assert.equal(draft.companyName, "NVDA Corp");
    assert.deepEqual(draft.triggers, [{ kind: "earnings", ticker: "NVDA", moment: "release" }]);
    assert.deepEqual(draft.metrics.map((m) => m.id), ["m1", "m2"]);
    assert.equal(draft.oneShot, true);
    assert.deepEqual(draft.channels, ["digest"], "in the app, plus the daily digest");
    assert.equal(draft.brief, "NVDA reports next week. Tell me how data center revenue and gross margin came in.");
    const notes = draft.notes ?? [];
    assert.ok(notes.some((n) => /ZZZZ is not in the US stock list/.test(n)), notes.join(" | "));
    assert.ok(notes.some((n) => /One trigger was left out: Schedule trigger needs a time/.test(n)), notes.join(" | "));
    assert.ok(notes.every((n) => !n.includes(EM_DASH)));
  });

  it("drafts without the model when it cannot be reached", async () => {
    const { AgentEngine: Engine } = await import("./engine");
    const engine = new Engine({
      root: fs.mkdtempSync(path.join(os.tmpdir(), "falcon-agent-draft-")),
      userKey: () => "anon",
      userId: () => undefined,
      sources: fakeSources(),
      caller: () => scripted([new Error("The model rejected the credentials.")]),
      channels: () => [],
      emit: () => {},
      log: () => {},
    });
    const res = await engine.draftFromBrief(
      "NVDA reports next week. When they publish earnings, tell me. I care about data center revenue, gross margin and next-quarter guidance.",
    );
    assert.ok(res.ok);
    assert.deepEqual(res.data.triggers, [{ kind: "earnings", ticker: "NVDA", moment: "release" }]);
    assert.deepEqual(res.data.metrics.map((m) => m.label), ["Data center revenue", "Gross margin", "Next-quarter guidance"]);
    assert.equal(res.data.oneShot, true);
    assert.match(res.data.notes?.[0] ?? "", /without the model/);
  });

  it("keeps sourced figures, removes unsourced ones, and enforces the copy rules", async () => {
    const agent = agentFixture();
    const event = earningsEvent();
    const material = await gatherMaterial(event, agent, EMPTY_STATE, releaseSources(), new Date("2026-11-19T21:30:00Z"));
    // The rewrite request fails, so the deterministic pass alone has to hold the line.
    const caller = scripted([GOOD_REPORT, new Error("busy")]);
    const report = await writeReport(agent, event, material, { caller, newId: sequentialIds("rep"), now: new Date("2026-11-19T21:31:00Z") });
    assert.equal(caller.calls.length, 2);
    assert.match(caller.calls[1]!.user, /BROKE THESE RULES/);
    assert.match(caller.calls[1]!.user, /figures not in the material: 75\.0/);
    assert.equal(report.headline, "Data center revenue $51.2 billion, above the bar.");
    assert.equal(report.summary, "NVIDIA reported revenue of $57.0 billion, up 62%.\n\nGross margin was 73.4%.");
    assert.deepEqual(
      report.readings.map((r) => [r.metricId, r.value, r.verdict]),
      [
        ["m1", "$51.2 billion", "above"],
        ["m2", "Not in the material", "unclear"],
      ],
    );
    assert.equal(report.readings[0]!.expectation, "above $50B");
    assert.equal(report.sources.length, 1);
    assert.equal(report.read, false);
  });

  it("fills metrics the model left out as unclear", () => {
    const agent = agentFixture();
    const report = finalizeReport(
      { headline: "Results are out.", summary: "Revenue rose.", readings: [], sources: [] },
      agent,
      earningsEvent(),
      { facts: [], documents: [], sources: [], corpus: "" },
      { newId: () => "rep-1", now: new Date("2026-11-19T21:31:00Z") },
    );
    assert.deepEqual(report.readings.map((r) => r.verdict), ["unclear", "unclear"]);
  });

  it("answers chat from the material, dropping unsourced figures", async () => {
    const caller = scripted([
      JSON.stringify({ reply: "Data center revenue was $51.2 billion. It will grow to $80 billion next year!", reportIds: ["rep-000001", "made-up"] }),
      JSON.stringify({ reply: "Data center revenue was $51.2 billion. Margins hit 99.9%.", reportIds: ["rep-000001"] }),
    ]);
    const out = await writeReply(
      {
        agent: agentFixture(),
        reports: [{ id: "rep-000001", agentId: "agent-0001", at: "2026-11-19T21:31:00.000Z", trigger: "earnings", headline: "Data center revenue $51.2 billion", summary: "Revenue $57.0 billion.", readings: [], sources: [], read: true }],
        history: [],
        freshFacts: [],
        question: "How did data center do?",
      },
      caller,
    );
    assert.equal(out.text, "Data center revenue was $51.2 billion.");
    assert.deepEqual(out.reportIds, ["rep-000001"]);
  });
});

describe("delivery channels", () => {
  const delivery = { agent: agentFixture(), report: { id: "rep-1" } as never, title: "NVDA earnings watch", body: "Results are out." };

  function desktopWith(settings: NotificationSettings, now: Date) {
    const shown: string[] = [];
    const opened: string[] = [];
    const channel = createDesktopChannel({
      readSettings: () => settings,
      supported: () => true,
      show: (content, onClick) => {
        shown.push(content.body);
        onClick();
        return true;
      },
      onOpen: (agentId, reportId) => opened.push(`${agentId}/${reportId}`),
      now: () => now,
    });
    return { channel, shown, opened };
  }

  it("shows a notification and opens the agent on click", () => {
    const { channel, shown, opened } = desktopWith(DEFAULT_NOTIFICATION_SETTINGS, new Date(2026, 10, 19, 12, 0));
    assert.equal(channel.deliver(delivery).status, "shown");
    assert.deepEqual(shown, ["Results are out."]);
    assert.deepEqual(opened, ["agent-0001/rep-1"]);
  });

  it("respects the agents switch", () => {
    const off = { ...DEFAULT_NOTIFICATION_SETTINGS, categories: { ...DEFAULT_NOTIFICATION_SETTINGS.categories, agents: false } };
    assert.equal(desktopWith(off, new Date()).channel.deliver(delivery).status, "off");
  });

  it("holds through quiet hours and shows once they end", () => {
    const quiet = { ...DEFAULT_NOTIFICATION_SETTINGS, quietHours: { enabled: true, start: "22:00", end: "07:00" } };
    let now = new Date(2026, 10, 19, 23, 0);
    const shown: string[] = [];
    const channel = createDesktopChannel({ readSettings: () => quiet, supported: () => true, show: (c) => (shown.push(c.body), true), onOpen: () => {}, now: () => now });
    const held = channel.deliver(delivery);
    assert.equal(held.status, "held");
    assert.equal(held.line?.code, "delivery.desktopHeld");
    assert.equal(channel.flushHeld(), 0);
    now = new Date(2026, 10, 20, 7, 5);
    assert.equal(channel.flushHeld(), 1);
    assert.deepEqual(shown, ["Results are out."]);
  });

  it("records mobile pushes in the outbox and sends nothing", () => {
    const outbox: unknown[] = [];
    const result = createMobilePushChannel({ append: (e) => outbox.push(e), newId: () => "o1" }).deliver(delivery);
    assert.equal(result.status, "queued");
    assert.equal((outbox[0] as { status: string }).status, MOBILE_PENDING_STATUS);
  });
});

describe("AgentEngine", () => {
  function setup(opts: { sources?: AgentDataSources; replies?: Array<string | Error>; now?: string } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-agent-engine-"));
    const events: AgentPushEvent[] = [];
    const desktopShown: string[] = [];
    let now = new Date(opts.now ?? "2026-11-19T21:30:00Z");
    const caller = scripted(opts.replies ?? [GOOD_REPORT, GOOD_REPORT]);
    const desktop: DeliveryChannel = {
      channel: "desktop",
      deliver: (d) => {
        desktopShown.push(`${d.title}: ${d.body}`);
        return { channel: "desktop", status: "shown", note: "Desktop notification sent.", line: { code: "delivery.desktopShown" } };
      },
    };
    const engine = new AgentEngine({
      root,
      userKey: () => "anon",
      userId: () => undefined,
      sources: opts.sources ?? releaseSources(),
      caller: () => caller,
      channels: (store) => [desktop, createMobilePushChannel({ append: (e) => store.appendOutbox(e), newId: sequentialIds("out") })],
      emit: (e) => events.push(e),
      now: () => now,
      newId: sequentialIds("id"),
      log: () => {},
    });
    return { engine, events, desktopShown, caller, store: () => new AgentStore(root, "anon"), setNow: (iso: string) => (now = new Date(iso)) };
  }

  const draft: AgentDraft = {
    name: "NVDA earnings watch",
    brief: "Tell me when NVDA reports. I care about data center revenue and gross margin.",
    ticker: "NVDA",
    triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }],
    metrics: [
      { id: "m1", label: "Data center revenue", expectation: "above $50B" },
      { id: "m2", label: "Gross margin" },
    ],
    channels: ["desktop", "mobile_push"],
    oneShot: true,
  };

  it("creates, fires once on results, notifies, and completes a one-shot agent", async () => {
    const { engine, events, desktopShown, store } = setup();
    const created = await engine.create(draft);
    assert.ok(created.ok);
    const agent = created.data;
    assert.equal(agent.companyName, "NVDA Corp");
    assert.equal(agent.status, "active");

    const run = await engine.runNow(agent.id);
    assert.ok(run.ok);
    assert.equal(run.data.fired, true);
    assert.ok(run.data.report);

    const detail = engine.get(agent.id);
    assert.ok(detail.ok);
    assert.equal(detail.data.agent.status, "completed");
    assert.equal(detail.data.agent.unread, 1);
    assert.equal(detail.data.agent.latestReport?.id, run.data.report!.id);
    assert.equal(detail.data.reports.length, 1);
    assert.deepEqual(
      detail.data.activity.map((a) => a.kind).reverse(),
      ["created", "fired", "notified", "completed"],
    );
    // Every timeline line also comes as codes the renderer can say in the reader's language.
    assert.deepEqual(
      detail.data.activity.map((a) => a.lines?.map((l) => l.code)).reverse(),
      [["activity.created"], ["activity.reported"], ["delivery.desktopShown", "delivery.mobileQueued"], ["activity.completed"]],
    );
    assert.deepEqual(detail.data.activity.at(-1)?.lines?.[0]?.triggers, draft.triggers);
    assert.deepEqual(detail.data.agent.nextActionLines, [{ code: "next.done" }]);
    assert.equal(desktopShown.length, 1);
    assert.match(desktopShown[0]!, /^NVDA earnings watch: /);
    assert.equal(store().outbox().length, 1);
    assert.ok(events.some((e) => e.type === "report"));

    // The same release never fires twice.
    const again = await engine.runNow(agent.id);
    assert.ok(again.ok);
    assert.equal(again.data.fired, false);
    assert.equal(engine.get(agent.id).ok && (engine.get(agent.id) as { data: { reports: unknown[] } }).data.reports.length, 1);

    const read = engine.markRead(agent.id);
    assert.ok(read.ok);
    const after = engine.get(agent.id);
    assert.ok(after.ok);
    assert.equal(after.data.agent.unread, 0);
    assert.equal(after.data.agent.latestReport?.read, true);
    assert.equal(after.data.reports[0]!.read, true);
    assert.equal(events.at(-1)?.type, "agent-updated");
  });

  it("refuses tickers that are not listed", async () => {
    const { engine } = setup();
    const res = await engine.create({ ...draft, ticker: "ZZZZ", triggers: [{ kind: "earnings", ticker: "ZZZZ", moment: "release" }] });
    assert.deepEqual(res, { ok: false, error: "ZZZZ is not in the US stock list." });
  });

  it("goes to error with backoff when every check fails, and recovers", async () => {
    let failing = true;
    const sources = releaseSources({
      earningsDates: async () => {
        throw new Error("calendar down");
      },
      filings: async () => {
        if (failing) throw new Error("EDGAR down");
        return [];
      },
    });
    const { engine, store } = setup({ sources });
    const created = await engine.create(draft);
    assert.ok(created.ok);
    const run = await engine.runNow(created.data.id);
    assert.ok(run.ok);
    assert.match(run.data.note, /EDGAR down/);
    assert.equal(run.data.noteLines?.[0]?.code, "activity.checkFailed");
    assert.match(String(run.data.noteLines?.[0]?.params?.error), /EDGAR down/);
    const broken = store().get(created.data.id)!;
    assert.equal(broken.status, "error");
    assert.match(broken.error ?? "", /EDGAR down/);
    assert.equal(store().state(created.data.id).failures, 1);
    failing = false;
    await engine.runNow(created.data.id);
    const fixed = store().get(created.data.id)!;
    assert.equal(fixed.status, "active");
    assert.equal(fixed.error, undefined);
    assert.equal(store().state(created.data.id).failures, 0);
  });

  it("retries a failed write-up, then sends the facts alone", async () => {
    const { engine, store, setNow } = setup({ replies: [new Error("down"), new Error("down"), new Error("down"), new Error("down"), new Error("down"), new Error("down")] });
    const created = await engine.create(draft);
    assert.ok(created.ok);
    const id = created.data.id;
    for (const at of ["2026-11-19T21:30:00Z", "2026-11-19T21:40:00Z"]) {
      setNow(at);
      const run = await engine.runNow(id);
      assert.ok(run.ok);
      assert.equal(run.data.fired, false);
      assert.equal(store().get(id)!.status, "error");
    }
    setNow("2026-11-19T21:50:00Z");
    const last = await engine.runNow(id);
    assert.ok(last.ok);
    assert.equal(last.data.fired, true);
    assert.match(last.data.report!.summary, /model was not reachable/);
    assert.equal(store().get(id)!.status, "completed");
  });

  it("chats, storing the question and the answer", async () => {
    const { engine, events } = setup({ replies: [JSON.stringify({ reply: "No report yet. NVDA last traded at 100.", reportIds: [] })] });
    const created = await engine.create({ ...draft, oneShot: false });
    assert.ok(created.ok);
    const res = await engine.sendMessage(created.data.id, "  Anything yet?  ");
    assert.ok(res.ok);
    assert.equal(res.data.role, "agent");
    assert.equal(res.data.text, "No report yet. NVDA last traded at 100.");
    const detail = engine.get(created.data.id);
    assert.ok(detail.ok);
    assert.deepEqual(detail.data.messages.map((m) => m.role), ["user", "agent"]);
    assert.equal(detail.data.messages[0]!.text, "Anything yet?");
    assert.equal(events.filter((e) => e.type === "message").length, 2);
  });

  it("pauses, resumes, edits and removes", async () => {
    const { engine, events } = setup();
    const created = await engine.create({ ...draft, oneShot: false });
    assert.ok(created.ok);
    const id = created.data.id;
    const paused = engine.setStatus(id, "paused");
    assert.ok(paused.ok);
    assert.equal(paused.data.status, "paused");
    assert.deepEqual(engine.dueAgents(), []);
    assert.equal(engine.setStatus(id, "completed").ok, false);
    assert.ok(engine.setStatus(id, "active").ok);
    const edited = await engine.update(id, { metrics: [{ id: "x", label: "Revenue guidance" }] });
    assert.ok(edited.ok);
    assert.deepEqual(edited.data.metrics, [{ id: "x", label: "Revenue guidance" }]);
    assert.ok(engine.remove(id).ok);
    assert.equal(engine.get(id).ok, false);
    assert.ok(events.some((e) => e.type === "agent-removed"));
  });

  it("backs off from 5 minutes to 6 hours", () => {
    assert.equal(backoffMs(1), 5 * 60_000);
    assert.equal(backoffMs(3), 20 * 60_000);
    assert.equal(backoffMs(20), 6 * 60 * 60_000);
  });
});
