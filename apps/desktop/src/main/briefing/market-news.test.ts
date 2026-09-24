import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { MarketHeadline } from "../../shared/briefing-types";
import {
  BRIEFING_NEWS_SYMBOLS,
  MARKET_HEADLINES_MAX,
  mergeMarketHeadlines,
  toMarketHeadline,
  type YahooNewsItem,
} from "../stock/market-data-service";
import {
  MARKET_NEWS_FAILURE_TTL_MS,
  MARKET_NEWS_TTL_MS,
  createMarketNews,
  marketNewsEntryFresh,
  marketNewsKey,
} from "./market-news";

const MINUTE = 60_000;
/** Tuesday 20:00 UTC: the previous US close the overnight list starts from. */
const SINCE = "2026-09-22T20:00:00.000Z";
const START = Date.parse("2026-09-23T10:00:00.000Z");

function headline(overrides: Partial<MarketHeadline> & { url: string }): MarketHeadline {
  return {
    id: overrides.url,
    title: "Futures point lower before the bell",
    source: "Wire",
    published_at: "2026-09-23T08:00:00.000Z",
    related: [],
    via: "SPY",
    ...overrides,
  };
}

describe("toMarketHeadline", () => {
  const raw: YahooNewsItem = {
    uuid: "u-1",
    title: "  Equity futures lower pre-bell  ",
    publisher: "MT Newswires",
    link: "https://example.com/a",
    providerPublishTime: 1_790_000_000,
    relatedTickers: ["spy", " QQQ", ""],
  };

  it("maps the provider fields and reads the tags upper-cased", () => {
    assert.deepEqual(toMarketHeadline(raw, "SPY"), {
      id: "u-1",
      title: "Equity futures lower pre-bell",
      source: "MT Newswires",
      url: "https://example.com/a",
      published_at: new Date(1_790_000_000 * 1000).toISOString(),
      related: ["SPY", "QQQ"],
      via: "SPY",
    });
  });

  it("falls back to the url as id, an empty source and no tags", () => {
    const item = toMarketHeadline({ ...raw, uuid: undefined, publisher: undefined, relatedTickers: undefined }, "QQQ");
    assert.equal(item?.id, "https://example.com/a");
    assert.equal(item?.source, "");
    assert.deepEqual(item?.related, []);
    assert.equal(item?.via, "QQQ");
  });

  it("refuses an item with no title, no link or no publish time", () => {
    assert.equal(toMarketHeadline({ ...raw, title: " " }, "SPY"), null);
    assert.equal(toMarketHeadline({ ...raw, link: undefined }, "SPY"), null);
    assert.equal(toMarketHeadline({ ...raw, providerPublishTime: undefined }, "SPY"), null);
    assert.equal(toMarketHeadline({ ...raw, providerPublishTime: Number.NaN }, "SPY"), null);
  });
});

describe("mergeMarketHeadlines", () => {
  it("keeps only what was published at or after since", () => {
    const merged = mergeMarketHeadlines(
      [
        headline({ url: "a", published_at: "2026-09-22T19:59:59.000Z" }),
        headline({ url: "b", published_at: SINCE }),
        headline({ url: "c", published_at: "2026-09-23T09:00:00.000Z" }),
        headline({ url: "d", published_at: "not a date" }),
      ],
      SINCE,
    );
    assert.deepEqual(merged.map((h) => h.url), ["c", "b"]);
  });

  it("keeps one item per url, the first query symbol that surfaced it winning", () => {
    const merged = mergeMarketHeadlines(
      [
        headline({ url: "a", via: "SPY", published_at: "2026-09-23T08:00:00.000Z" }),
        headline({ url: "b", via: "SPY", published_at: "2026-09-23T07:00:00.000Z" }),
        headline({ url: "a", via: "QQQ", published_at: "2026-09-23T08:00:00.000Z" }),
        headline({ url: "b", via: "^GSPC", published_at: "2026-09-23T07:00:00.000Z" }),
      ],
      SINCE,
    );
    assert.deepEqual(merged.map((h) => [h.url, h.via]), [["a", "SPY"], ["b", "SPY"]]);
  });

  it("orders newest first, query order breaking a tie, and caps the list", () => {
    const many = Array.from({ length: MARKET_HEADLINES_MAX + 5 }, (_, i) =>
      headline({ url: `u${i}`, via: i % 2 === 0 ? "SPY" : "TLT", published_at: new Date(START - (i % 5) * MINUTE).toISOString() }),
    );
    const merged = mergeMarketHeadlines(many, SINCE);
    assert.equal(merged.length, MARKET_HEADLINES_MAX);
    for (let i = 1; i < merged.length; i++) {
      assert.ok(Date.parse(merged[i - 1]!.published_at) >= Date.parse(merged[i]!.published_at));
    }
    // The five newest share one stamp and stay in the order the queries listed them.
    assert.deepEqual(merged.slice(0, 5).map((h) => h.url), ["u0", "u5", "u10", "u15", "u20"]);
  });

  it("refuses a since that is not an instant", () => {
    assert.throws(() => mergeMarketHeadlines([], "yesterday"));
  });

  it("queries the index fund first, so it is the symbol a shared article is filed under", () => {
    assert.equal(BRIEFING_NEWS_SYMBOLS[0], "SPY");
    assert.equal(new Set(BRIEFING_NEWS_SYMBOLS).size, BRIEFING_NEWS_SYMBOLS.length);
  });
});

describe("marketNewsKey", () => {
  it("normalises two spellings of one instant to one key and refuses a non-instant", () => {
    assert.equal(marketNewsKey("2026-09-22T20:00:00Z"), SINCE);
    assert.equal(marketNewsKey(SINCE), SINCE);
    assert.throws(() => marketNewsKey("last close"));
  });
});

describe("marketNewsEntryFresh", () => {
  it("keeps a good answer ten minutes and a failure two, and refuses the boundary", () => {
    const good = { at: START, headlines: [] };
    assert.equal(marketNewsEntryFresh(good, START + MARKET_NEWS_TTL_MS - 1), true);
    assert.equal(marketNewsEntryFresh(good, START + MARKET_NEWS_TTL_MS), false);
    const failed = { at: START, headlines: null };
    assert.equal(marketNewsEntryFresh(failed, START + MARKET_NEWS_FAILURE_TTL_MS - 1), true);
    assert.equal(marketNewsEntryFresh(failed, START + MARKET_NEWS_FAILURE_TTL_MS), false);
  });

  it("refuses an entry from the future, a malformed one, or none", () => {
    assert.equal(marketNewsEntryFresh({ at: START + MINUTE, headlines: [] }, START), false);
    assert.equal(marketNewsEntryFresh({ at: Number.NaN, headlines: [] }, START), false);
    assert.equal(marketNewsEntryFresh({ at: START, headlines: "x" as unknown as MarketHeadline[] }, START), false);
    assert.equal(marketNewsEntryFresh(undefined, START), false);
  });
});

describe("market news cache", () => {
  let dir = "";
  let file = "";
  let clock = START;
  let calls: string[] = [];
  let answer: () => Promise<MarketHeadline[]>;

  function make() {
    return createMarketNews({
      file,
      now: () => clock,
      fetch: (since) => {
        calls.push(since);
        return answer();
      },
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-market-news-"));
    file = path.join(dir, "market-news.json");
    clock = START;
    calls = [];
    answer = async () => [headline({ url: "a" })];
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads once and answers from memory until the ten minutes are up", async () => {
    const news = make();
    assert.deepEqual((await news.get(SINCE)).map((h) => h.url), ["a"]);
    clock += MARKET_NEWS_TTL_MS - MINUTE;
    await news.get("2026-09-22T20:00:00Z");
    assert.deepEqual(calls, [SINCE]);
    clock += 2 * MINUTE;
    await news.get(SINCE);
    assert.equal(calls.length, 2);
  });

  it("keeps one entry per since", async () => {
    const news = make();
    await news.get(SINCE);
    await news.get("2026-09-23T20:00:00.000Z");
    assert.deepEqual(calls, [SINCE, "2026-09-23T20:00:00.000Z"]);
  });

  it("survives a restart through the file on disk", async () => {
    await make().get(SINCE);
    assert.ok(fs.existsSync(file));
    const again = await make().get(SINCE);
    assert.deepEqual(again.map((h) => h.url), ["a"]);
    assert.equal(calls.length, 1);
  });

  it("shares one read between two callers asking together", async () => {
    const news = make();
    await Promise.all([news.get(SINCE), news.get(SINCE)]);
    assert.equal(calls.length, 1);
  });

  it("caches an empty list as a real answer", async () => {
    answer = async () => [];
    const news = make();
    assert.deepEqual(await news.get(SINCE), []);
    await news.get(SINCE);
    assert.equal(calls.length, 1);
  });

  it("remembers a failure for two minutes, rejects meanwhile, and reads again after", async () => {
    answer = async () => {
      throw new Error("HTTP 429");
    };
    const news = make();
    await assert.rejects(news.get(SINCE), /429/);
    clock += MARKET_NEWS_FAILURE_TTL_MS - MINUTE;
    await assert.rejects(news.get(SINCE), /unavailable/);
    assert.equal(calls.length, 1);

    clock += 2 * MINUTE;
    answer = async () => [headline({ url: "b" })];
    assert.deepEqual((await news.get(SINCE)).map((h) => h.url), ["b"]);
    assert.equal(calls.length, 2);
  });

  it("drops entries of a handover that is over when it next writes", async () => {
    const news = make();
    await news.get(SINCE);
    clock += 40 * 60 * MINUTE;
    await news.get("2026-09-24T20:00:00.000Z");
    const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { by_since: Record<string, unknown> };
    assert.deepEqual(Object.keys(stored.by_since), ["2026-09-24T20:00:00.000Z"]);
  });

  it("starts over from a corrupt file instead of failing", async () => {
    fs.writeFileSync(file, "{not json", "utf8");
    assert.deepEqual((await make().get(SINCE)).map((h) => h.url), ["a"]);
  });

  it("refuses a since that is not an instant before reading anything", async () => {
    const news = make();
    await assert.rejects(news.get("last close"));
    assert.equal(calls.length, 0);
  });
});
