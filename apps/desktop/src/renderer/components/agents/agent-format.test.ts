import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Agent } from "../../../shared/agent-types";
import {
  countdown,
  fillTemplateTicker,
  joinOr,
  paragraphs,
  sayLines,
  sortAgents,
  suggestedQuestions,
  triggerSentence,
  upcoming,
  waitingLine,
} from "./agent-format";
import { parseBrief } from "./agent-fixtures";

const NOW = Date.parse("2026-10-10T12:00:00Z");
const DAY = 86_400_000;

function agent(patch: Partial<Agent> = {}): Agent {
  return {
    id: "a",
    name: "NVDA earnings",
    brief: "",
    ticker: "NVDA",
    triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }],
    metrics: [{ id: "m1", label: "Data center revenue" }],
    channels: ["desktop"],
    status: "active",
    oneShot: true,
    createdAt: new Date(NOW - DAY).toISOString(),
    updatedAt: new Date(NOW - DAY).toISOString(),
    unread: 0,
    ...patch,
  };
}

describe("agent format", () => {
  it("reads triggers back as sentences", () => {
    assert.equal(triggerSentence({ kind: "earnings", ticker: "NVDA", moment: "release" }, "en-US"), "When NVDA publishes quarterly results");
    assert.equal(
      triggerSentence({ kind: "filing", ticker: "MSFT", forms: ["8-K", "10-Q", "4"] }, "en-US"),
      "When MSFT files with the SEC (8-K, 10-Q, or Form 4)",
    );
    assert.equal(triggerSentence({ kind: "price_move", ticker: "AMD", thresholdPct: 6, window: "1d" }, "en-US"), "When AMD moves more than 6% in a day");
    assert.equal(triggerSentence({ kind: "schedule", cadence: "weekly", time: "07:30", weekday: 1 }, "en-US"), "Every Monday at 07:30");
    assert.equal(joinOr(["a"]), "a");
  });

  it("says triggers in the reader's language, tickers and forms as they are", () => {
    assert.equal(triggerSentence({ kind: "earnings", ticker: "NVDA", moment: "release" }, "tr-TR"), "NVDA çeyreklik sonuçlarını açıkladığında");
    assert.match(triggerSentence({ kind: "schedule", cadence: "weekly", time: "07:30", weekday: 1 }, "de-DE"), /Montag/);
    assert.match(triggerSentence({ kind: "filing", ticker: "MSFT", forms: ["8-K"] }, "ja-JP"), /MSFT.*8-K/);
  });

  it("reads engine lines in the reader's language, and falls back to the engine's English", () => {
    const lines = [{ code: "activity.checkedOnRequest" }, { code: "earnings.waitingDate", params: { ticker: "NVDA", date: "2026-11-19" } }];
    assert.equal(sayLines(lines, "en-US", "x"), "Checked on request. Waiting for NVDA results on Nov 19, 2026.");
    assert.match(sayLines(lines, "de-DE", "x"), /NVDA/);
    assert.notEqual(sayLines(lines, "de-DE", "x"), "x");
    assert.equal(sayLines([{ code: "no.such.code" }], "de-DE", "English as written"), "English as written");
    assert.equal(sayLines(undefined, "ja-JP", "English as written"), "English as written");
    assert.equal(sayLines([{ code: "next.retrying", params: { count: 1 } }], "en-US", "x"), "Retrying in 1 minute.");
    assert.equal(sayLines([{ code: "next.retrying", params: { count: 10 } }], "en-US", "x"), "Retrying in 10 minutes.");
    assert.equal(
      sayLines([{ code: "activity.created", triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }] }], "en-US", "x"),
      "Created. Watching NVDA earnings.",
    );
    assert.equal(sayLines([{ code: "activity.edited", params: { fields: "name,triggers" } }], "en-US", "x"), "Edited: name and triggers.");
  });

  it("counts down to the next event", () => {
    assert.equal(countdown(new Date(NOW + 3 * DAY).toISOString(), NOW), "in 3 days");
    assert.equal(countdown(new Date(NOW + DAY).toISOString(), NOW), "tomorrow");
    assert.equal(countdown(new Date(NOW + 5 * 3_600_000).toISOString(), NOW), "in 5 hours");
    assert.equal(countdown(new Date(NOW + 3 * DAY).toISOString(), NOW, "de-DE"), "in 3 Tagen");
    assert.equal(countdown(undefined, NOW), null);
  });

  it("says what an agent is waiting for, or why it is not", () => {
    assert.equal(waitingLine(agent({ nextExpectedAt: new Date(NOW + 3 * DAY).toISOString() }), NOW), "NVDA earnings in 3 days");
    assert.equal(waitingLine(agent({ nextExpectedAt: new Date(NOW + 30_000).toISOString() }), NOW), "NVDA earnings due now");
    assert.equal(waitingLine(agent(), NOW), "Watching NVDA earnings");
    assert.equal(waitingLine(agent({ status: "paused" }), NOW), "Paused");
    assert.match(waitingLine(agent({ status: "error", error: "Feed down." }), NOW), /^Needs attention: Feed down\.$/);
  });

  it("lists what is coming up, soonest first, active agents only", () => {
    const list = [
      agent({ id: "late", nextExpectedAt: new Date(NOW + 9 * DAY).toISOString() }),
      agent({ id: "soon", nextExpectedAt: new Date(NOW + DAY).toISOString() }),
      agent({ id: "paused", status: "paused", nextExpectedAt: new Date(NOW + DAY).toISOString() }),
      agent({ id: "far", nextExpectedAt: new Date(NOW + 40 * DAY).toISOString() }),
    ];
    assert.deepEqual(upcoming(list, NOW).map((a) => a.id), ["soon", "late"]);
  });

  it("sorts errors first, then unread, then the soonest wait", () => {
    const list = [
      agent({ id: "b", nextExpectedAt: new Date(NOW + 2 * DAY).toISOString() }),
      agent({ id: "unread", unread: 2 }),
      agent({ id: "err", status: "error" }),
      agent({ id: "done", status: "completed" }),
    ];
    assert.deepEqual(sortAgents(list).map((a) => a.id), ["err", "unread", "b", "done"]);
  });

  it("makes first questions out of the reader's metrics", () => {
    const qs = suggestedQuestions(agent(), []);
    assert.ok(qs[0]!.includes("data center revenue"), qs.join(" | "));
    assert.ok(qs.length <= 3);
  });

  it("splits plain text into paragraphs on blank lines", () => {
    assert.deepEqual(paragraphs("One.\nStill one.\n\n\nTwo."), ["One.\nStill one.", "Two."]);
  });
});

describe("fixture brief parser", () => {
  it("reads the reader's own example into an earnings agent", () => {
    const d = parseBrief(
      "NVDA reports next week and I don't have time to follow it. When they publish earnings, tell me. I care about data center revenue, gross margin and next-quarter guidance.",
    );
    assert.equal(d.ticker, "NVDA");
    assert.equal(d.triggers[0]?.kind, "earnings");
    assert.deepEqual(d.metrics.map((m) => m.label), ["Data center revenue", "Gross margin", "Next-quarter guidance"]);
    assert.equal(d.oneShot, true);
  });
});

describe("fillTemplateTicker", () => {
  it("fills the placeholder ticker and selects it", () => {
    const { text, select } = fillTemplateTicker("Tell me when {ticker} reports, and how {ticker} moved.", "NVDA");
    assert.equal(text, "Tell me when NVDA reports, and how NVDA moved.");
    assert.deepEqual(select, [13, 17]);
  });

  it("finds the ticker in a brief that names it outright", () => {
    const brief = "Tell me when AMD reports.";
    assert.deepEqual(fillTemplateTicker(brief, "AMD"), { text: brief, select: [13, 16] });
    assert.deepEqual(fillTemplateTicker("No ticker here", "AMD").select, null);
    // Not inside another word.
    assert.equal(fillTemplateTicker("AMDX moved", "AMD").select, null);
  });
});
