import type { Agent } from "../../shared/agent-types";
import type { AgentDataSources, FilingRef } from "./sources";

/**
 * Fakes for the agent engine's tests: data sources that answer from fixed
 * values, and an agent with sensible defaults. Nothing here touches the
 * network or Electron.
 */

export function fakeSources(overrides: Partial<AgentDataSources> = {}): AgentDataSources {
  return {
    earningsDates: async () => ({ dates: [], estimated: null }),
    filings: async () => [],
    filingText: async (f) => ({ title: f.form, url: f.url, text: "" }),
    insiderTxn: async () => null,
    quote: async (t) => ({
      symbol: t,
      price: 100,
      changePct: 0.4,
      regularChangePct: 0.4,
      previousClose: 99.6,
      session: "regular",
      asOf: "2026-11-19T15:00:00.000Z",
    }),
    dailyCloses: async () => [],
    news: async () => [],
    marketNews: async () => [],
    consensus: async () => null,
    macroEvents: () => [],
    macroCoverageUntil: () => "2026-12-31",
    lookupTicker: async (t) => (["NVDA", "AAPL", "MSFT", "TSLA", "AMZN"].includes(t) ? { symbol: t, companyName: `${t} Corp` } : null),
    searchCompany: async () => [],
    linkEdges: async () => [],
    filingFormOf: () => null,
    materialNews: async () => [],
    readthrough: async () => [],
    filingChanges: async () => {
      throw new Error("no filing changes in this fake");
    },
    ...overrides,
  };
}

export function filing(over: Partial<FilingRef> = {}): FilingRef {
  return {
    cik: "0001045810",
    form: "8-K",
    accession: "0001045810-26-000101",
    filedAt: "2026-11-19",
    acceptedAt: "2026-11-19T21:20:00.000Z",
    acceptedAtUtc: true,
    items: ["2.02", "9.01"],
    primaryDocument: "nvda-8k.htm",
    url: "https://www.sec.gov/Archives/edgar/data/1045810/000104581026000101/nvda-8k.htm",
    ...over,
  };
}

export function agentFixture(over: Partial<Agent> = {}): Agent {
  return {
    id: "agent-0001",
    name: "NVDA earnings watch",
    brief: "Tell me when NVDA reports. I care about data center revenue and gross margin.",
    ticker: "NVDA",
    companyName: "NVIDIA Corporation",
    triggers: [{ kind: "earnings", ticker: "NVDA", moment: "release" }],
    metrics: [
      { id: "m1", label: "Data center revenue", expectation: "above $50B" },
      { id: "m2", label: "Gross margin" },
    ],
    channels: ["desktop"],
    status: "active",
    oneShot: true,
    createdAt: "2026-11-10T12:00:00.000Z",
    updatedAt: "2026-11-10T12:00:00.000Z",
    unread: 0,
    ...over,
  };
}

/** A deterministic id source: id-000001, id-000002, ... */
export function sequentialIds(prefix = "id"): () => string {
  let n = 0;
  return () => `${prefix}-${String(++n).padStart(6, "0")}`;
}
