import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { agentIsAbout, bareCompanyName, mentionTest, stockAgentReports } from "./stock-agent-reports";
import type { Agent, AgentReport } from "../../../shared/agent-types";

function agent(id: string, over: Partial<Agent> = {}): Agent {
  return {
    id,
    name: `Agent ${id}`,
    brief: "",
    triggers: [],
    metrics: [],
    channels: [],
    status: "active",
    oneShot: false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    unread: 0,
    ...over,
  };
}

function report(id: string, agentId: string, at: string, headline: string, summary = ""): AgentReport {
  return { id, agentId, at, trigger: "news", headline, summary, readings: [], sources: [], read: true };
}

describe("agent reports about a stock", () => {
  it("knows an agent about the ticker by its own ticker or a trigger on it", () => {
    assert.equal(agentIsAbout(agent("a", { ticker: "nvda" }), "NVDA"), true);
    assert.equal(agentIsAbout(agent("b", { triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }] }), "nvda"), true);
    assert.equal(agentIsAbout(agent("c", { triggers: [{ kind: "news", keywords: ["NVDA"] }] }), "NVDA"), false);
    assert.equal(agentIsAbout(agent("d", { triggers: [{ kind: "macro", event: "CPI" }] }), "NVDA"), false);
  });

  it("finds the ticker as a word, and short tickers only in their marked forms", () => {
    const nvda = mentionTest("NVDA");
    assert.equal(nvda("NVDA guides above consensus"), true);
    assert.equal(nvda("Chip names led, $NVDA up 3%"), true);
    assert.equal(nvda("NVDAX is a fund"), false);
    const it2 = mentionTest("IT");
    assert.equal(it2("IT spending slowed"), false);
    assert.equal(it2("Gartner (IT) reported"), true);
    assert.equal(it2("$IT fell"), true);
  });

  it("finds the company's name without its legal suffix", () => {
    assert.equal(bareCompanyName("NVIDIA Corporation"), "NVIDIA");
    assert.equal(bareCompanyName("Apple Inc."), "Apple");
    assert.equal(bareCompanyName("Alphabet Inc. Class A"), "Alphabet");
    assert.equal(bareCompanyName("AB Co"), null);
    const nvidia = mentionTest("NVDA", "NVIDIA Corporation");
    assert.equal(nvidia("Nvidia's supplier raised prices"), true);
    assert.equal(nvidia("Nvidiaesque"), false);
  });

  it("lists the agent's reports and other agents' reports that name it, newest first, each once", () => {
    const about = agent("about", { ticker: "NVDA" });
    const market = agent("market", { latestReport: { id: "m-latest", headline: "Semis: NVDA and AMD lead", at: "2026-10-14T12:00:00.000Z", read: true } });
    const loaded = agent("loaded");
    const other = agent("other", { latestReport: { id: "o1", headline: "Oil slips", at: "2026-10-15T00:00:00.000Z", read: true } });
    const list = stockAgentReports(
      [about, market, loaded, other],
      {
        about: [report("a1", "about", "2026-10-10T00:00:00.000Z", "Quarter in line"), report("a2", "about", "2026-10-13T00:00:00.000Z", "Filing 8-K")],
        loaded: [
          report("l1", "loaded", "2026-10-12T00:00:00.000Z", "Supply chain", "TSMC capacity for NVIDIA is booked"),
          report("l2", "loaded", "2026-10-11T00:00:00.000Z", "Banks"),
        ],
      },
      "NVDA",
      "NVIDIA Corporation",
    );
    assert.deepEqual(
      list.map((r) => [r.report.id, r.via]),
      [
        ["m-latest", "mention"],
        ["a2", "agent"],
        ["l1", "mention"],
        ["a1", "agent"],
      ],
    );
  });

  it("is empty when nothing names the stock", () => {
    assert.deepEqual(stockAgentReports([agent("x")], {}, "NVDA"), []);
  });
});
