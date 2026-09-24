import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createChainPort, type ChannelInvoker } from "./chain-port";

const SINCE = "2026-09-18T20:00:00.000Z";

const HEALTH_OK = { last_success_at: "2026-09-21T10:00:00.000Z", last_error: null };
const STATUS = {
  running: true,
  startedAt: "2026-09-21T09:00:00.000Z",
  tickers: [
    { ticker: "AAPL", backfilled: true, insiderSeeded: true, barsAsOf: "2026-09-18", health: { news: HEALTH_OK, filings: HEALTH_OK, calendar: HEALTH_OK, price: HEALTH_OK } },
    {
      ticker: "XLE",
      backfilled: true,
      insiderSeeded: true,
      barsAsOf: "2026-09-18",
      health: { news: { last_success_at: null, last_error: null }, filings: HEALTH_OK, calendar: HEALTH_OK, price: HEALTH_OK },
    },
  ],
  messagesEmitted: 10,
  lastMessageAt: null,
};

/** One replayed incident holding a single overnight headline for AAPL. */
const REPLAY = {
  summary: {},
  article_groups: [],
  incidents: [
    {
      incident: {
        incident_id: "inc-1",
        priority_band: "P1",
        composite_tags: ["guidance"],
        messages: [
          {
            id: "m1",
            type: "news_item",
            ticker: "AAPL",
            timestamp: "2026-09-21T06:00:00.000Z",
            payload: {
              headline: "Apple supplier reports record orders",
              source: "Newswire",
              url: "https://example.com/a?utm_source=x",
              published_at: "2026-09-21T05:58:00.000Z",
              article_id: "a1",
            },
          },
          {
            id: "m0",
            type: "news_item",
            ticker: "AAPL",
            timestamp: "2026-09-18T15:00:00.000Z",
            payload: { headline: "Before the close", source: "Newswire", url: "https://example.com/b", published_at: "2026-09-18T15:00:00.000Z", article_id: "a0" },
          },
        ],
      },
    },
  ],
};

type Call = { channel: string; args: unknown[] };

function invoker(answers: Record<string, unknown | ((...args: unknown[]) => unknown)>): { invoke: ChannelInvoker; calls: Call[] } {
  const calls: Call[] = [];
  const invoke = (async (channel: string, ...args: unknown[]) => {
    calls.push({ channel, args });
    const answer = answers[channel];
    if (answer === undefined) throw new Error(`No handler registered for ${channel}`);
    return typeof answer === "function" ? (answer as (...a: unknown[]) => unknown)(...args) : answer;
  }) as ChannelInvoker;
  return { invoke, calls };
}

describe("chain port", () => {
  it("asks the replay for one name with the held book and a bounded message count", async () => {
    const { invoke, calls } = invoker({
      "tracker:status": { ok: true, status: STATUS },
      "base:replay": { ok: true, result: REPLAY },
    });
    const slice = await createChainPort(invoke).chainSlice("AAPL", ["AAPL", "XLE"], SINCE);

    assert.deepEqual(calls.find((c) => c.channel === "base:replay")?.args, [{ ticker: "AAPL", held: ["AAPL", "XLE"], limit: 300 }]);
    assert.equal(calls.some((c) => c.channel === "tracker:messages"), false);
    assert.equal(slice.coverage, "tracked");
    assert.deepEqual(slice.news.map((n) => [n.headline, n.band, n.incident_id]), [["Apple supplier reports record orders", "P1", "inc-1"]]);
  });

  it("carries the price tier through to the slice", async () => {
    const { invoke } = invoker({ "tracker:status": { ok: true, status: STATUS }, "base:replay": { ok: true, result: { ...REPLAY, incidents: [] } } });
    const slice = await createChainPort(invoke).chainSlice("XLE", ["XLE"], SINCE);
    assert.equal(slice.coverage, "price_only");
    assert.deepEqual(slice.news, []);
  });

  it("reads the status once for a whole build, and again after five minutes", async () => {
    let clock = 0;
    const { invoke, calls } = invoker({ "tracker:status": { ok: true, status: STATUS }, "base:replay": { ok: true, result: REPLAY } });
    const port = createChainPort(invoke, () => clock);
    await Promise.all([port.chainSlice("AAPL", ["AAPL"], SINCE), port.chainSlice("XLE", ["AAPL"], SINCE), port.quant("SHOP")]);
    assert.equal(calls.filter((c) => c.channel === "tracker:status").length, 1);

    clock = 5 * 60_000;
    await port.quant("SHOP");
    assert.equal(calls.filter((c) => c.channel === "tracker:status").length, 2);
  });

  it("raises a refusal instead of returning a quiet night", async () => {
    const { invoke } = invoker({
      "tracker:status": { ok: true, status: STATUS },
      "base:replay": { ok: false, error: "not signed in yet" },
      "risk:latest": { ok: false, error: "engine timed out" },
    });
    const port = createChainPort(invoke);
    await assert.rejects(port.chainSlice("AAPL", ["AAPL"], SINCE));
    await assert.rejects(port.riskLatest());
  });

  it("does not let a failed status read answer for the next five minutes", async () => {
    let healthy = false;
    const { invoke, calls } = invoker({
      "tracker:status": () => (healthy ? { ok: true, status: STATUS } : { ok: false, error: "not signed in yet" }),
      "base:replay": { ok: true, result: REPLAY },
    });
    const port = createChainPort(invoke, () => 0);
    await assert.rejects(port.chainSlice("AAPL", ["AAPL"], SINCE));
    healthy = true;
    assert.equal((await port.chainSlice("AAPL", ["AAPL"], SINCE)).coverage, "tracked");
    assert.equal(calls.filter((c) => c.channel === "tracker:status").length, 2);
  });

  it("answers null for a name the Tracker does not follow, without asking for its quant", async () => {
    const { invoke, calls } = invoker({ "tracker:status": { ok: true, status: STATUS } });
    assert.equal(await createChainPort(invoke).quant("SHOP"), null);
    assert.equal(calls.some((c) => c.channel === "tracker:quant"), false);
  });

  it("maps a followed name's quant context, volatility in percent", async () => {
    const { invoke, calls } = invoker({
      "tracker:status": { ok: true, status: STATUS },
      "tracker:quant": { ok: true, quant: { daily_vol_30d: 0.02, beta_90d: 1.3, session: "closed" } },
    });
    assert.deepEqual(await createChainPort(invoke).quant("AAPL"), { daily_vol_30d: 2, beta: 1.3 });
    assert.deepEqual(calls.find((c) => c.channel === "tracker:quant")?.args, ["AAPL"]);
  });

  it("reduces the risk snapshot, and answers null before the first one", async () => {
    const snapshot = {
      computed_at: "2026-09-21T10:00:00.000Z",
      score: 40,
      band: "moderate",
      driver: { component: "market", sentence: "Beta is the largest part.", contribution: 0.3 },
      components: { market: { beta_eff: 1.1, beta_port: 1.2 }, volatility: { port_vol_daily_pct: 1.4 } },
      weights: [{ ticker: "AAPL", weight: 1 }],
    };
    const withSnapshot = invoker({ "risk:latest": { ok: true, snapshot, riskCardEnabled: true } });
    assert.deepEqual((await createChainPort(withSnapshot.invoke).riskLatest())?.tickers, ["AAPL"]);

    const without = invoker({ "risk:latest": { ok: true, snapshot: null, riskCardEnabled: false } });
    assert.equal(await createChainPort(without.invoke).riskLatest(), null);
  });
});
