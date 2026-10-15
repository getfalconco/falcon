import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { Agent } from "../../shared/agent-types";
import { AgentStore } from "../agents/store";
import { createUserEventsStore } from "../calendar/user-events-store";
import {
  accountBriefingFiles,
  clearAccountHistory,
  collectAgentsExport,
  collectCalendarExport,
  collectLocalExport,
  collectThesesExport,
  inventoryLocalData,
  monthStartYmd,
  summarizeLocalUsage,
  withoutSecrets,
} from "./local-data";

const ME = "56b7a75c-ac79-4e42-8286-26596d02622d";
const OTHER = "11111111-2222-3333-4444-555555555555";

function write(root: string, rel: string, content: string | object): void {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
}

function fixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-privacy-"));
  write(root, `briefing/report.${ME}.2026-10-05.abc12.json`, { saved_at: "x", report: { a: 1 } });
  write(root, `briefing/report.${ME}.2026-09-28.def34.json`, { saved_at: "x", report: { a: 2 } });
  write(root, `briefing/report.${OTHER}.2026-10-05.abc12.json`, { saved_at: "x", report: { a: 3 } });
  write(root, "briefing/narratives.json", { schema_version: 1, sessions: {} });
  write(root, "briefing/market-news.json", "[]");
  write(root, "profile/avatars/x.webp", "img");
  write(root, "portfolio-coverage.json", { NVDA: { symbol: "NVDA" } });
  write(root, "pending-research.txt", "APA\nSHEL\n\n");
  write(root, "research/AAPL.meta.json", { ticker: "AAPL", generatedAt: "2026-10-02T10:00:00.000Z" });
  write(root, "research/AAPL.stats.json", { input_tokens: 1000, output_tokens: 100, estimated_cost_usd: 0.5 });
  write(root, "research/MSFT.meta.json", { ticker: "MSFT", generatedAt: "2026-08-02T10:00:00.000Z" });
  write(root, "research/MSFT.stats.json", { input_tokens: 2000, output_tokens: 200, estimated_cost_usd: 1.25 });
  write(root, "research/TSLA.meta.json", { ticker: "TSLA", generatedAt: "2026-10-03T10:00:00.000Z" });
  write(root, "cache/AAPL.0001.txt", "filing text");
  write(root, "tracker/config.json", {});
  write(root, "classifier/metrics.json", { schema_version: 1, metrics: { verdicts_ok: 7, input_tokens: 500, output_tokens: 50 } });
  write(root, "mystery.bin", "?");
  return root;
}

const NOW = Date.parse("2026-10-10T12:00:00");

describe("inventoryLocalData", () => {
  it("splits the briefing folder into the reader's reports and the shared cache, and counts every file once", () => {
    const root = fixture();
    const cats = inventoryLocalData(root);
    const byKey = Object.fromEntries(cats.map((c) => [c.key, c]));
    assert.equal(byKey.briefings?.files, 3);
    assert.equal(byKey["briefing-cache"]?.files, 2);
    assert.equal(byKey.portfolio?.files, 2);
    assert.equal(byKey.research?.files, 6);
    assert.equal(byKey.engines?.files, 2);
    assert.equal(byKey.other?.files, 1);
    const total = cats.reduce((n, c) => n + c.files, 0);
    assert.equal(total, 17);
    // Personal first.
    assert.equal(cats[0]?.kind, "personal");
  });

  it("counts the encrypted SnapTrade identities and the deletion retry record by name, not as Other", () => {
    const root = fixture();
    write(root, `snaptrade/${ME}.bin`, "enc-a");
    write(root, "snaptrade/local.bin", "enc-b");
    write(root, "account-cleanup.json", { schema_version: 1, pending: [] });
    const byKey = Object.fromEntries(inventoryLocalData(root).map((c) => [c.key, c]));
    assert.equal(byKey.snaptrade?.files, 2);
    assert.equal(byKey.snaptrade?.kind, "personal");
    assert.equal(byKey.account?.files, 1);
    assert.equal(byKey.account?.kind, "personal");
    assert.equal(byKey.other?.files, 1);
  });

  it("merges a not-yet-migrated plaintext SnapTrade file into the same category, once", () => {
    const root = fixture();
    write(root, `snaptrade/${ME}.bin`, "enc-a");
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-privacy-ud-"));
    const legacy = path.join(userData, "snaptrade-user.json");
    fs.writeFileSync(legacy, JSON.stringify({ userId: "u", userSecret: "s" }));
    const cats = inventoryLocalData(root, { legacySnaptradeFile: legacy });
    assert.equal(cats.filter((c) => c.key === "snaptrade").length, 1);
    assert.equal(cats.find((c) => c.key === "snaptrade")?.files, 2);
    // Migrated away: nothing extra is counted.
    fs.unlinkSync(legacy);
    assert.equal(inventoryLocalData(root, { legacySnaptradeFile: legacy }).find((c) => c.key === "snaptrade")?.files, 1);
    // Only the legacy file left: the category still shows.
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-privacy-bare-"));
    fs.writeFileSync(legacy, "{}");
    assert.equal(inventoryLocalData(bare, { legacySnaptradeFile: legacy }).find((c) => c.key === "snaptrade")?.files, 1);
  });

  it("keeps the SnapTrade identities out of the export", () => {
    const root = fixture();
    write(root, `snaptrade/${ME}.bin`, "enc-a");
    write(root, "account-cleanup.json", { schema_version: 1, pending: [] });
    const text = JSON.stringify(collectLocalExport(root, ME));
    assert.ok(!text.includes("enc-a"));
    assert.ok(!/snaptrade/i.test(text));
  });

  it("counts every account's agent files, digest included, under Agents rather than Other", () => {
    const root = fixture();
    const mine = new AgentStore(root, ME);
    mine.put(agent("inv-agent-1", "Mine", ME));
    mine.appendDigest({ id: "d1", at: "2026-10-02T10:00:00.000Z", agentId: "inv-agent-1", reportId: "r1", title: "Mine", body: "Held" });
    new AgentStore(root, "anon").put(agent("inv-agent-2", "Signed out", "local"));
    const byKey = Object.fromEntries(inventoryLocalData(root).map((c) => [c.key, c]));
    // Two agents.json and one digest.json.
    assert.equal(byKey.agents?.files, 3);
    assert.equal(byKey.agents?.kind, "personal");
    assert.equal(byKey.other?.files, 1);
  });

  it("splits the calendar folder into the reader's events and the sector cache", () => {
    const root = fixture();
    write(root, "calendar/user-events.json", { schema_version: 1, users: {} });
    write(root, "calendar/sectors.json", { schema_version: 1, entries: {} });
    const byKey = Object.fromEntries(inventoryLocalData(root).map((c) => [c.key, c]));
    assert.equal(byKey.calendar?.files, 1);
    assert.equal(byKey.calendar?.kind, "personal");
    assert.equal(byKey["calendar-cache"]?.files, 1);
    assert.equal(byKey["calendar-cache"]?.kind, "cache");
    assert.equal(byKey.other?.files, 1);
    // Only the cache on disk: no empty events category.
    fs.unlinkSync(path.join(root, "calendar", "user-events.json"));
    const after = Object.fromEntries(inventoryLocalData(root).map((c) => [c.key, c]));
    assert.equal(after.calendar, undefined);
    assert.equal(after["calendar-cache"]?.files, 1);
  });

  it("names every folder and file the app writes at the top, leaving only strangers in Other", () => {
    const root = fixture();
    write(root, "earnings/market-calendar.json", {});
    write(root, "earnings/tracked.json", {});
    write(root, "news/article-text.json", {});
    write(root, "notifications/settings.json", {});
    write(root, "system/settings.json", {});
    write(root, "ui-language.json", { language: "en-US" });
    write(root, "data-location.json", {});
    write(root, "base/config.json", {});
    const byKey = Object.fromEntries(inventoryLocalData(root).map((c) => [c.key, c]));
    assert.equal(byKey.earnings?.files, 2);
    assert.equal(byKey.earnings?.kind, "cache");
    assert.equal(byKey.news?.files, 1);
    assert.equal(byKey.preferences?.files, 4);
    assert.equal(byKey.preferences?.kind, "personal");
    assert.equal(byKey.engines?.files, 3);
    // Only the fixture's mystery.bin.
    assert.equal(byKey.other?.files, 1);
  });

  it("counts the Stock tab theses as the reader's own", () => {
    const root = fixture();
    write(root, `theses/${ME}.json`, { schema_version: 1, theses: { NVDA: { text: "Mine", updated_at: "2026-10-10T00:00:00.000Z" } } });
    write(root, `theses/${OTHER}.json`, { schema_version: 1, theses: {} });
    const byKey = Object.fromEntries(inventoryLocalData(root).map((c) => [c.key, c]));
    assert.equal(byKey.theses?.files, 2);
    assert.equal(byKey.theses?.kind, "personal");
    assert.equal(byKey.other?.files, 1);
  });

  it("returns nothing for a missing root", () => {
    assert.deepEqual(inventoryLocalData(path.join(os.tmpdir(), "falcon-privacy-missing-xyz")), []);
  });
});

describe("clearAccountHistory", () => {
  it("removes only this account's briefing reports", () => {
    const root = fixture();
    assert.equal(accountBriefingFiles(root, ME).length, 2);
    const out = clearAccountHistory(root, ME);
    assert.equal(out.removed, 2);
    assert.ok(out.bytes > 0);
    assert.equal(accountBriefingFiles(root, ME).length, 0);
    assert.equal(accountBriefingFiles(root, OTHER).length, 1);
    assert.ok(fs.existsSync(path.join(root, "briefing", "narratives.json")));
  });

  it("removes nothing without a session", () => {
    const root = fixture();
    assert.deepEqual(clearAccountHistory(root, "anon"), { removed: 0, bytes: 0 });
  });
});

describe("collectLocalExport", () => {
  it("carries the reader's own files and leaves public caches out", () => {
    const root = fixture();
    const out = collectLocalExport(root, ME);
    assert.equal((out.briefing_reports as unknown[]).length, 2);
    assert.deepEqual(out.pending_research, ["APA", "SHEL"]);
    assert.ok(out.portfolio_coverage);
    assert.equal(JSON.stringify(out).includes("filing text"), false);
  });
});

function agent(id: string, name: string, userId: string): Agent {
  return {
    id,
    userId,
    name,
    brief: `Watch ${name}`,
    ticker: "NVDA",
    triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }],
    metrics: [{ id: "rev", label: "Revenue", expectation: "above $30B" }],
    channels: ["desktop", "mobile_push"],
    status: "active",
    oneShot: false,
    createdAt: "2026-10-01T10:00:00.000Z",
    updatedAt: "2026-10-01T10:00:00.000Z",
    unread: 1,
  };
}

const EVENT = {
  title: "Call with IR",
  all_day: false,
  date: null,
  end_date: null,
  start_at: "2026-10-12T13:00:00.000Z",
  end_at: "2026-10-12T14:00:00.000Z",
  ticker: "nvda",
  sector: "Technology",
  color: "blue",
  notes: "Ask about supply.",
};

/** Two accounts' agents and calendar events, plus the signed-out pool, under one data root. */
function twoAccountFixture(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-privacy-accounts-"));
  const mine = new AgentStore(root, ME);
  mine.put(agent("mine-agent-1", "Mine", ME));
  // A v2 agent: stops on its own, has a next check, and reports only through the digest.
  mine.put({
    ...agent("mine-agent-2", "Mine digest", ME),
    channels: ["digest"],
    ends: { kind: "earnings", ticker: "NVDA" },
    nextCheckAt: "2026-10-03T13:30:00.000Z",
  });
  // A v2 agent with no channel at all: its reports stay in the app.
  mine.put({ ...agent("mine-agent-3", "Mine quiet", ME), channels: [], ends: { kind: "date", date: "2026-12-31" } });
  mine.addReport({
    id: "mine-report-1",
    agentId: "mine-agent-1",
    at: "2026-10-02T10:00:00.000Z",
    trigger: "earnings",
    headline: "Revenue beat",
    summary: "Upstream error quoted: key sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA was refused.",
    readings: [],
    sources: [{ title: "8-K", url: "https://www.sec.gov/x" }],
    read: false,
  });
  mine.addActivity({ id: "mine-act-1", agentId: "mine-agent-1", at: "2026-10-02T10:00:00.000Z", kind: "fired", text: "Fired" });
  mine.addMessages("mine-agent-1", [{ id: "mine-msg-1", agentId: "mine-agent-1", role: "user", at: "2026-10-02T11:00:00.000Z", text: "Why?" }]);
  mine.setState("mine-agent-1", { failures: 0, firedKeys: ["ENGINE-BOOKKEEPING"], lastFiredByTrigger: {} });
  mine.appendOutbox({
    id: "mine-out-1",
    at: "2026-10-02T10:00:00.000Z",
    agentId: "mine-agent-1",
    reportId: "mine-report-1",
    channel: "mobile_push",
    title: "Mine",
    body: "Revenue beat",
    status: "pending",
  });

  mine.setDigest({
    version: 1,
    lastSentDay: "2026-10-01",
    entries: [
      {
        id: "mine-digest-1",
        at: "2026-10-02T10:00:00.000Z",
        agentId: "mine-agent-2",
        reportId: "mine-report-2",
        title: "Mine digest",
        body: "Held with Bearer abcdefghijklmnopqrstuvwxyz0123 quoted",
      },
    ],
  });

  const theirs = new AgentStore(root, OTHER);
  theirs.put(agent("their-agent-1", "Theirs", OTHER));
  theirs.appendDigest({ id: "their-digest-1", at: "2026-10-02T10:00:00.000Z", agentId: "their-agent-1", reportId: "x", title: "THEIR DIGEST", body: "x" });
  theirs.addMessages("their-agent-1", [{ id: "their-msg-1", agentId: "their-agent-1", role: "user", at: "2026-10-02T11:00:00.000Z", text: "THEIR CHAT" }]);
  new AgentStore(root, "anon").put(agent("local-agent-1", "Signed out", "local"));

  const file = path.join(root, "calendar", "user-events.json");
  let ids = 0;
  const newId = () => `ue_test${String(++ids).padStart(4, "0")}`;
  assert.equal(createUserEventsStore({ file, userKey: () => ME, newId }).create(EVENT).ok, true);
  assert.equal(createUserEventsStore({ file, userKey: () => OTHER, newId }).create({ ...EVENT, title: "THEIR EVENT" }).ok, true);
  assert.equal(createUserEventsStore({ file, userKey: () => "anon", newId }).create({ ...EVENT, title: "SIGNED OUT EVENT" }).ok, true);
  return root;
}

describe("agents and calendar in the export", () => {
  it("carries only the signed-in account's agents, with reports, activity, chat, outbox and digest", () => {
    const root = twoAccountFixture();
    const out = collectAgentsExport(root, ME) as {
      schema: string;
      schema_version: number;
      agents: Array<{ agent: Agent; reports: unknown[]; activity: unknown[]; messages: unknown[] }>;
      mobile_outbox: unknown[];
      digest: { version: number; lastSentDay?: string; entries: Array<{ id: string; agentId: string; reportId: string; body: string }> };
    };
    assert.equal(out.schema, "falcon-agents");
    assert.equal(out.schema_version, 2);
    assert.deepEqual(
      out.agents.map((a) => a.agent.id).sort(),
      ["mine-agent-1", "mine-agent-2", "mine-agent-3"],
    );
    const byId = Object.fromEntries(out.agents.map((a) => [a.agent.id, a.agent]));
    assert.deepEqual(byId["mine-agent-2"]!.channels, ["digest"]);
    assert.deepEqual(byId["mine-agent-2"]!.ends, { kind: "earnings", ticker: "NVDA" });
    assert.equal(byId["mine-agent-2"]!.nextCheckAt, "2026-10-03T13:30:00.000Z");
    assert.deepEqual(byId["mine-agent-3"]!.channels, []);
    assert.deepEqual(byId["mine-agent-3"]!.ends, { kind: "date", date: "2026-12-31" });
    assert.equal(out.digest.version, 1);
    assert.equal(out.digest.lastSentDay, "2026-10-01");
    assert.deepEqual(
      out.digest.entries.map((e) => [e.id, e.agentId, e.reportId]),
      [["mine-digest-1", "mine-agent-2", "mine-report-2"]],
    );
    // withoutSecrets runs over the digest too.
    assert.equal(out.digest.entries[0]!.body, "Held with [removed] quoted");
    const first = out.agents.find((a) => a.agent.id === "mine-agent-1")!;
    assert.equal(first.reports.length, 1);
    assert.equal(first.activity.length, 1);
    assert.equal(first.messages.length, 1);
    assert.equal(out.mobile_outbox.length, 1);
    const text = JSON.stringify(out);
    assert.equal(text.includes("THEIR CHAT"), false);
    assert.equal(text.includes("THEIR DIGEST"), false);
    assert.equal(text.includes("their-agent-1"), false);
    assert.equal(text.includes("local-agent-1"), false);
    // Engine bookkeeping stays out.
    assert.equal(text.includes("ENGINE-BOOKKEEPING"), false);
  });

  it("carries only the signed-in account's calendar events", () => {
    const root = twoAccountFixture();
    const out = collectCalendarExport(root, ME) as { schema: string; schema_version: number; events: Array<{ title: string }> };
    assert.equal(out.schema, "falcon-calendar-events");
    assert.equal(out.schema_version, 1);
    assert.deepEqual(
      out.events.map((e) => e.title),
      ["Call with IR"],
    );
  });

  it("puts both sections in the device export, keeps other accounts and secrets out", () => {
    const root = twoAccountFixture();
    const out = collectLocalExport(root, ME);
    assert.ok(out.agents);
    assert.ok(out.calendar_events);
    const text = JSON.stringify(out);
    for (const foreign of ["THEIR CHAT", "THEIR DIGEST", "THEIR EVENT", "SIGNED OUT EVENT", "Signed out", OTHER]) {
      assert.equal(text.includes(foreign), false, foreign);
    }
    assert.equal(text.includes("sk-ant-api03"), false);
    assert.ok(text.includes("[removed]"));
  });

  it("exports no agents or events without a session", () => {
    const root = twoAccountFixture();
    assert.equal(collectAgentsExport(root, "anon"), null);
    assert.equal(collectCalendarExport(root, "anon"), null);
    const out = collectLocalExport(root, "anon");
    assert.equal(out.agents, undefined);
    assert.equal(out.calendar_events, undefined);
  });

  it("an account with nothing saved still gets empty, versioned sections", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-privacy-empty-"));
    assert.deepEqual(collectAgentsExport(root, ME), {
      schema: "falcon-agents",
      schema_version: 2,
      agents: [],
      mobile_outbox: [],
      digest: { version: 1, entries: [] },
    });
    assert.deepEqual(collectCalendarExport(root, ME), { schema: "falcon-calendar-events", schema_version: 1, events: [] });
  });
});

describe("theses in the export", () => {
  it("carries only the signed-in account's theses, and none without a session", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-privacy-theses-"));
    write(root, `theses/${ME}.json`, {
      schema_version: 1,
      theses: { NVDA: { text: "Data center demand", updated_at: "2026-10-10T00:00:00.000Z" }, "../X": { text: "junk" } },
    });
    write(root, `theses/${OTHER}.json`, { schema_version: 1, theses: { AAPL: { text: "THEIR THESIS", updated_at: "2026-10-10T00:00:00.000Z" } } });
    const out = collectThesesExport(root, ME) as { schema: string; schema_version: number; theses: Array<{ ticker: string; text: string }> };
    assert.equal(out.schema, "falcon-stock-theses");
    assert.equal(out.schema_version, 1);
    assert.deepEqual(
      out.theses.map((t) => [t.ticker, t.text]),
      [["NVDA", "Data center demand"]],
    );
    const device = collectLocalExport(root, ME);
    assert.ok(device.stock_theses);
    assert.equal(JSON.stringify(device).includes("THEIR THESIS"), false);
    assert.equal(collectThesesExport(root, "anon"), null);
    assert.equal(collectLocalExport(root, "anon").stock_theses, undefined);
  });
});

describe("withoutSecrets", () => {
  it("drops credential-named fields at any depth and masks credential-shaped text", () => {
    const out = withoutSecrets({
      name: "x",
      apiKey: "abc",
      nested: [{ access_token: "t", refreshToken: "r", user_secret: "s", "push-token": "p", inputTokens: 5, keywords: ["a"] }],
      note: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123",
    });
    assert.deepEqual(out, {
      name: "x",
      nested: [{ inputTokens: 5, keywords: ["a"] }],
      note: "Authorization: [removed]",
    });
  });
});

describe("summarizeLocalUsage", () => {
  it("counts extractions by month and sums only what the stats files record", () => {
    const root = fixture();
    const u = summarizeLocalUsage(root, { userKey: ME, nowMs: NOW, seedDir: null, enginesRemote: false });
    assert.equal(u.monthStart, "2026-10-01");
    assert.equal(u.extractions.total, 3);
    assert.equal(u.extractions.thisMonth, 2);
    assert.equal(u.extractions.withStats, 2);
    assert.equal(u.extractions.inputTokens, 3000);
    assert.equal(u.extractions.outputTokens, 300);
    assert.equal(u.extractions.estimatedCostUsd, 1.75);
    assert.deepEqual(u.briefings, { total: 2, thisMonth: 1 });
    assert.deepEqual(u.engines, [
      { key: "classifier", label: "News classifier", unit: "verdicts", completed: 7, inputTokens: 500, outputTokens: 50 },
    ]);
  });

  it("leaves out extractions that shipped with the app, and engines that run remotely", () => {
    const root = fixture();
    const seed = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-seed-"));
    write(seed, "research/MSFT.meta.json", { ticker: "MSFT", generatedAt: "2026-08-02T10:00:00.000Z" });
    const u = summarizeLocalUsage(root, { userKey: ME, nowMs: NOW, seedDir: seed, enginesRemote: true });
    assert.equal(u.extractions.bundled, 1);
    assert.equal(u.extractions.total, 2);
    assert.equal(u.extractions.inputTokens, 1000);
    assert.deepEqual(u.engines, []);
  });

  it("names the month start on the local clock", () => {
    assert.equal(monthStartYmd(Date.parse("2026-01-31T12:00:00")), "2026-01-01");
  });
});
