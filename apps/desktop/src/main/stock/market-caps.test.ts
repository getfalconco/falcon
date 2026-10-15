import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { MARKET_CAP_BATCH, fetchMarketCaps } from "./market-data-service";

const realFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = realFetch;
});

/** Yahoo's handshake (cookie, crumb) and its batched quote, stubbed. */
function stub(quote: (url: string) => Response) {
  const asked: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    asked.push(url);
    if (url.startsWith("https://fc.yahoo.com")) return new Response("", { status: 404, headers: { "set-cookie": "A3=d=abc; Path=/" } });
    if (url.includes("/v1/test/getcrumb")) return new Response("crumb123", { status: 200 });
    if (url.includes("/v7/finance/quote")) return quote(url);
    return new Response("", { status: 500 });
  }) as typeof fetch;
  return asked;
}

describe("market values, batched", () => {
  it("reads the caps of a batch in one request and leaves out the names without one", async () => {
    const asked = stub(() =>
      Response.json({
        quoteResponse: {
          result: [
            { symbol: "TSM", marketCap: 2181067833344 },
            { symbol: "BSVN", marketCap: 531066464 },
            { symbol: "ZZZZ" },
            { symbol: "BAD", marketCap: -1 },
          ],
        },
      }),
    );
    const caps = await fetchMarketCaps(["tsm", "BSVN", "ZZZZ", "BAD", "TSM"]);
    assert.deepEqual(caps, { TSM: 2181067833344, BSVN: 531066464 });
    const quote = asked.filter((u) => u.includes("/v7/finance/quote"));
    assert.equal(quote.length, 1);
    assert.ok(decodeURIComponent(quote[0]!).includes("symbols=TSM,BSVN,ZZZZ,BAD"), quote[0]);
    assert.ok(quote[0]!.includes("crumb=crumb123"));
  });

  it("asks nothing for an empty list and caps one read at a batch", async () => {
    let symbols = 0;
    stub((url) => {
      symbols = decodeURIComponent(new URL(url).searchParams.get("symbols") ?? "").split(",").length;
      return Response.json({ quoteResponse: { result: [] } });
    });
    assert.deepEqual(await fetchMarketCaps([]), {});
    await fetchMarketCaps(Array.from({ length: 150 }, (_, i) => `S${i}`));
    assert.equal(symbols, MARKET_CAP_BATCH);
  });

  it("throws on a failed read, so a cache does not remember it as no cap", async () => {
    stub(() => new Response("", { status: 429 }));
    await assert.rejects(fetchMarketCaps(["NVDA"]));
  });
});
