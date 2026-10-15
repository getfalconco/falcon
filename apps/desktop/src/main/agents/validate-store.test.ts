import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { AgentActivity, AgentReport } from "../../shared/agent-types";
import { AgentStore, userDirName } from "./store";
import { agentFixture } from "./test-fakes";
import {
  LIMITS,
  normalizeForm,
  normalizeTicker,
  validateDraft,
  validateMetrics,
  validatePatch,
  validateTrigger,
} from "./validate";

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "falcon-agents-"));
}

describe("validation", () => {
  it("normalizes tickers and refuses what cannot be one", () => {
    assert.equal(normalizeTicker(" $nvda "), "NVDA");
    assert.equal(normalizeTicker("brk.b"), "BRK.B");
    assert.equal(normalizeTicker("BF-B"), "BF-B");
    assert.equal(normalizeTicker("TOOLONGTICKER"), null);
    assert.equal(normalizeTicker("../etc"), null);
    assert.equal(normalizeTicker(42), null);
  });

  it("maps the ways a reader writes a form to EDGAR's spelling", () => {
    assert.equal(normalizeForm("8k"), "8-K");
    assert.equal(normalizeForm("form 4"), "4");
    assert.equal(normalizeForm("13D"), "SC 13D");
    assert.equal(normalizeForm("10-q"), "10-Q");
    assert.equal(normalizeForm("<script>"), null);
  });

  it("fills a missing trigger ticker from the agent's company", () => {
    assert.deepEqual(validateTrigger({ kind: "earnings" }, "NVDA"), { kind: "earnings", ticker: "NVDA", moment: "release" });
    assert.throws(() => validateTrigger({ kind: "earnings" }), /needs a ticker/);
  });

  it("checks each trigger kind's own fields", () => {
    assert.throws(() => validateTrigger({ kind: "filing", ticker: "AAPL", forms: [] }), /at least one form/);
    assert.throws(() => validateTrigger({ kind: "price_move", ticker: "AAPL", thresholdPct: 90 }), /between 0.5% and 50%/);
    assert.throws(() => validateTrigger({ kind: "schedule", cadence: "daily", time: "25:00" }), /HH:mm/);
    assert.throws(() => validateTrigger({ kind: "schedule", cadence: "weekly", time: "08:00", weekday: 9 }), /weekday/);
    // Neither a ticker nor keywords: the market's headlines, which an agent about no one company may watch.
    assert.deepEqual(validateTrigger({ kind: "news", keywords: [] }), { kind: "news", keywords: [] });
    assert.throws(() => validateTrigger({ kind: "teleport" }), /Unknown trigger kind/);
    assert.deepEqual(validateTrigger({ kind: "price_move", ticker: "tsla", thresholdPct: -7.04, window: "1d" }), {
      kind: "price_move",
      ticker: "TSLA",
      thresholdPct: 7,
      window: "1d",
    });
    assert.deepEqual(validateTrigger({ kind: "filing", ticker: "MSFT", forms: ["form 4", "4"], insiderBuysOnly: true }), {
      kind: "filing",
      ticker: "MSFT",
      forms: ["4"],
      insiderBuysOnly: true,
    });
    // insiderBuysOnly means nothing without Form 4 and is dropped.
    assert.equal("insiderBuysOnly" in validateTrigger({ kind: "filing", ticker: "MSFT", forms: ["8-K"], insiderBuysOnly: true }), false);
  });

  it("gives metrics unique ids and requires labels", () => {
    const metrics = validateMetrics([{ id: "dc", label: " Data center revenue " }, { id: "dc", label: "Gross margin", expectation: "over 75%" }]);
    assert.deepEqual(metrics.map((m) => m.id), ["dc", "m2"]);
    assert.equal(metrics[0]!.label, "Data center revenue");
    assert.equal(metrics[1]!.expectation, "over 75%");
    assert.throws(() => validateMetrics([{ label: "" }]), /needs a label/);
    assert.throws(() => validateMetrics(Array.from({ length: LIMITS.metrics + 1 }, (_, i) => ({ label: `m${i}` }))), /at most/);
  });

  it("validates a whole draft, defaulting channels and the name", () => {
    const draft = validateDraft({
      brief: "  Tell me when NVDA reports.  ",
      ticker: "nvda",
      triggers: [{ kind: "earnings" }],
      metrics: [],
      channels: ["sms", "mobile_push"],
    });
    assert.equal(draft.brief, "Tell me when NVDA reports.");
    assert.equal(draft.ticker, "NVDA");
    assert.equal(draft.name, "NVDA earnings");
    assert.deepEqual(draft.channels, ["mobile_push"]);
    assert.equal(draft.oneShot, false);
    assert.throws(() => validateDraft({ brief: "", triggers: [{ kind: "macro", event: "CPI" }] }), /needs a brief/);
    assert.throws(() => validateDraft({ brief: "x", triggers: [] }), /at least one trigger/);
  });

  it("checks a patch against the ticker the agent will have", () => {
    assert.throws(() => validatePatch({ ticker: null, triggers: [{ kind: "earnings" }] }, "NVDA"), /needs a ticker/);
    const patch = validatePatch({ triggers: [{ kind: "earnings", moment: "call" }], oneShot: false }, "NVDA");
    assert.deepEqual(patch.triggers, [{ kind: "earnings", ticker: "NVDA", moment: "call" }]);
    assert.equal(patch.oneShot, false);
    assert.throws(() => validatePatch({ oneShot: "yes" }, "NVDA"), /true or false/);
  });
});

describe("AgentStore", () => {
  it("keeps one folder per account and never a path from the key", () => {
    assert.equal(userDirName("anon"), "local");
    assert.equal(userDirName(null), "local");
    assert.equal(userDirName("../../etc"), "local");
    assert.equal(userDirName("3F2504E0-4F89-11D3-9A0C-0305E82C3301"), "3f2504e0-4f89-11d3-9a0c-0305e82c3301");
  });

  it("stores, updates and removes agents with their files", () => {
    const store = new AgentStore(tempRoot(), "anon");
    const agent = agentFixture();
    store.put(agent);
    assert.equal(store.list().length, 1);
    store.addReport({ id: "rep-000001", agentId: agent.id, at: "2026-11-19T22:00:00.000Z", trigger: "earnings", headline: "h", summary: "s", readings: [], sources: [], read: false });
    assert.equal(store.update(agent.id, (a) => ({ ...a, name: "Renamed" }))?.name, "Renamed");
    assert.equal(store.markReportsRead(agent.id), 1);
    assert.equal(store.reports(agent.id)[0]!.read, true);
    assert.equal(store.remove(agent.id), true);
    assert.equal(store.list().length, 0);
    assert.equal(fs.existsSync(path.join(store.dir, agent.id)), false);
    assert.throws(() => store.reports("../x"), /Not an agent id/);
  });

  it("caps the number of agents and the history kept per agent", () => {
    const store = new AgentStore(tempRoot(), "anon");
    for (let i = 0; i < LIMITS.agentsPerUser; i++) store.put(agentFixture({ id: `agent-${String(i).padStart(4, "0")}` }));
    assert.throws(() => store.put(agentFixture({ id: "agent-overflow" })), /at most/);
    const id = "agent-0000";
    for (let i = 0; i < LIMITS.reportsPerAgent + 5; i++) {
      const r: AgentReport = { id: `rep-${i}`, agentId: id, at: new Date(i).toISOString(), trigger: "news", headline: `h${i}`, summary: "", readings: [], sources: [], read: false };
      store.addReport(r);
    }
    const reports = store.reports(id);
    assert.equal(reports.length, LIMITS.reportsPerAgent);
    assert.equal(reports[reports.length - 1]!.headline, `h${LIMITS.reportsPerAgent + 4}`);
  });

  it("coalesces repeated checks into one timeline line", () => {
    const store = new AgentStore(tempRoot(), "anon");
    const agent = agentFixture();
    store.put(agent);
    const entry = (id: string, at: string, kind: AgentActivity["kind"], text: string): AgentActivity => ({ id, agentId: agent.id, at, kind, text });
    assert.equal(store.addActivity(entry("a1", "2026-11-19T10:00:00.000Z", "waiting", "Watching SEC filings.")).appended, true);
    const second = store.addActivity(entry("a2", "2026-11-19T10:10:00.000Z", "waiting", "Watching SEC filings."));
    assert.equal(second.appended, false);
    assert.equal(second.activity.id, "a1");
    assert.equal(second.activity.at, "2026-11-19T10:10:00.000Z");
    store.addActivity(entry("a3", "2026-11-19T10:20:00.000Z", "waiting", "Something else."));
    // "fired" never coalesces, even when the text repeats.
    store.addActivity(entry("a4", "2026-11-19T10:30:00.000Z", "fired", "Reported."));
    store.addActivity(entry("a5", "2026-11-19T10:40:00.000Z", "fired", "Reported."));
    assert.deepEqual(store.activity(agent.id).map((a) => a.id), ["a1", "a3", "a4", "a5"]);
  });

  it("reads missing engine state as empty and caps the dedupe keys", () => {
    const store = new AgentStore(tempRoot(), "anon");
    const agent = agentFixture();
    store.put(agent);
    assert.deepEqual(store.state(agent.id), { failures: 0, firedKeys: [], lastFiredByTrigger: {} });
    store.setState(agent.id, { failures: 2, firedKeys: Array.from({ length: 400 }, (_, i) => `k${i}`), lastFiredByTrigger: {} });
    const state = store.state(agent.id);
    assert.equal(state.failures, 2);
    assert.equal(state.firedKeys.length, 300);
    assert.equal(state.firedKeys[299], "k399");
  });

  it("appends mobile deliveries to the outbox", () => {
    const store = new AgentStore(tempRoot(), "user-1");
    store.appendOutbox({ id: "o1", at: "2026-11-19T22:00:00.000Z", agentId: "agent-0001", reportId: "rep-1", channel: "mobile_push", title: "t", body: "b", status: "pending" });
    assert.equal(store.outbox().length, 1);
    assert.match(store.dir, /user-1$/);
  });
});
