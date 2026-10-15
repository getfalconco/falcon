import assert from "node:assert/strict";
import { after, afterEach, beforeEach, describe, it, mock } from "node:test";
import { fetchMarketCaps, fetchStockChartRange, fetchStockNews } from "./market-data-service";
import { CATALOG_TIMEOUT_MS, searchUsStocks } from "./us-stock-catalog";

/**
 * A provider that never answers: the request settles only when its signal
 * aborts. A read without a deadline would hang here until the test times out.
 */
const realFetch = globalThis.fetch;
type Route = (url: string, init?: RequestInit) => Promise<Response>;
const asked: string[] = [];
let aborted = 0;

function hang(init?: RequestInit): Promise<Response> {
  return new Promise((_, reject) => {
    init?.signal?.addEventListener("abort", () => {
      aborted += 1;
      reject(init.signal?.reason ?? new DOMException("aborted", "AbortError"));
    });
  });
}

function stub(route: Route) {
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    return route(url, init);
  }) as typeof fetch;
}

/** Lets pending promise chains run (setImmediate is left real). */
async function flush(times = 20) {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
  asked.length = 0;
  aborted = 0;
  mock.timers.enable({ apis: ["setTimeout"] });
});
afterEach(() => {
  mock.timers.reset();
});
after(() => {
  globalThis.fetch = realFetch;
});

const handshake = (url: string): Response | null => {
  if (url.startsWith("https://fc.yahoo.com")) return new Response("", { status: 404, headers: { "set-cookie": "A3=d=abc; Path=/" } });
  if (url.includes("/v1/test/getcrumb")) return new Response("crumb123", { status: 200 });
  return null;
};

describe("market data reads give up on a provider that hangs", { timeout: 10_000 }, () => {
  // Runs first: the crumb cache is still empty.
  it("a hung cookie request fails the handshake as a normal error", async () => {
    stub((url, init) => (url.startsWith("https://fc.yahoo.com") ? hang(init) : Promise.resolve(new Response("", { status: 500 }))));
    const read = fetchMarketCaps(["NVDA"]);
    const settled = assert.rejects(read, (error: unknown) => error instanceof Error && /timed out|unavailable/.test(error.message));
    await flush();
    mock.timers.tick(10_000);
    await flush();
    await settled;
    assert.equal(asked.filter((u) => u.startsWith("https://fc.yahoo.com")).length, 1);
    assert.equal(aborted, 1, "the hung request was aborted, not left open");
    assert.ok(!asked.some((u) => u.includes("/v7/finance/quote")), "no quote read without a crumb");
  });

  it("a hung crumb request fails the handshake too", async () => {
    stub((url, init) => {
      if (url.includes("/v1/test/getcrumb")) return hang(init);
      return Promise.resolve(handshake(url) ?? new Response("", { status: 500 }));
    });
    const settled = assert.rejects(fetchMarketCaps(["NVDA"]), /timed out|unavailable/);
    await flush();
    mock.timers.tick(10_000);
    await flush();
    await settled;
    assert.equal(aborted, 1);
  });

  it("concurrent readers share one handshake", async () => {
    let releaseCookie!: () => void;
    const cookieGate = new Promise<void>((r) => (releaseCookie = r));
    stub(async (url) => {
      if (url.startsWith("https://fc.yahoo.com")) await cookieGate;
      const answer = handshake(url);
      if (answer) return answer;
      return Response.json({ quoteResponse: { result: [{ symbol: "NVDA", marketCap: 1 }, { symbol: "AMD", marketCap: 2 }] } });
    });
    const reads = Promise.all([fetchMarketCaps(["NVDA"]), fetchMarketCaps(["AMD"]), fetchMarketCaps(["NVDA", "AMD"])]);
    await flush();
    releaseCookie();
    await flush();
    await reads;
    assert.equal(asked.filter((u) => u.startsWith("https://fc.yahoo.com")).length, 1);
    assert.equal(asked.filter((u) => u.includes("/v1/test/getcrumb")).length, 1);
    assert.equal(asked.filter((u) => u.includes("/v7/finance/quote")).length, 3);
  });

  it("a hung chart read rejects with a timeout error", async () => {
    stub((_url, init) => hang(init));
    const settled = assert.rejects(fetchStockChartRange("NVDA", 1_700_000_000, 1_700_086_400), {
      message: "Market data request timed out",
    });
    await flush();
    mock.timers.tick(12_000);
    await flush();
    await settled;
    assert.equal(asked.length, 1, "a timed-out read does not fall through to the daily retry");
    assert.equal(aborted, 1);
  });

  it("a hung news read still yields an empty list", async () => {
    stub((_url, init) => hang(init));
    const news = fetchStockNews("NVDA");
    await flush();
    mock.timers.tick(12_000);
    await flush();
    assert.deepEqual(await news, []);
    assert.equal(aborted, 1);
  });

  it("a hung listing directory rejects, and the next search retries", async () => {
    stub((_url, init) => hang(init));
    const settled = assert.rejects(searchUsStocks("nvda"), /timed out/);
    await flush();
    mock.timers.tick(CATALOG_TIMEOUT_MS);
    await flush();
    await settled;
    assert.equal(aborted, 2, "both listing requests were aborted");

    stub(async (url) =>
      url.includes("nasdaqlisted")
        ? new Response("Symbol|Security Name|Market Category|Test Issue|Financial Status|Round Lot Size|ETF|NextShares\nNVDA|NVIDIA Corporation - Common Stock|Q|N|N|100|N|N\n")
        : new Response("ACT Symbol|Security Name|Exchange|CQS Symbol|ETF|Round Lot Size|Test Issue|NASDAQ Symbol\n"),
    );
    const results = await searchUsStocks("nvda");
    assert.ok(results.some((r) => r.symbol === "NVDA"));
  });
});
