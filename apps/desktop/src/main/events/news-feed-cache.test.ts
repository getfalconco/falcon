import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";
import { MAIN_FRESH_MS, NEWS_FEED_CACHE_FILE, NewsFeedCache, newsFeedKey } from "./news-feed-cache";
import type { NewsFeedArticle, NewsFeedResult } from "../../shared/news-feed";

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-news-cache-"));
  dirs.push(dir);
  return dir;
}
/** One temp dir for the life of a cache instance. */
function fixedTempDir(): () => string {
  const dir = tempDir();
  return () => dir;
}
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

const STATUS = {
  running: false,
  lastPollAt: null,
  lastError: null,
  lastNewEvents: 0,
  articlesChecked: 0,
  lastSummary: null,
  currentTicker: null,
  tickersCompleted: 0,
  totalTickers: 0,
};

function article(id: number): NewsFeedArticle {
  return {
    id,
    headline: `story ${id}`,
    summary: "",
    url: `https://example.com/${id}`,
    source: "Wire",
    datetime: 1_700_000_000 + id,
    tickers: ["NVDA"],
    event: null,
    first_seen: "2026-10-11T00:00:00.000Z",
    sectors: [],
  };
}

function ok(...ids: number[]): NewsFeedResult {
  return { ok: true, articles: ids.map(article), status: STATUS };
}

describe("news feed cache (main)", () => {
  it("keys on days and limit only", () => {
    assert.equal(newsFeedKey({ days: 3, limit: 300 }), newsFeedKey({ limit: 300, days: 3 }));
    assert.notEqual(newsFeedKey({ days: 3, limit: 300 }), newsFeedKey({ days: 1, limit: 300 }));
    assert.equal(newsFeedKey(undefined), newsFeedKey({}));
  });

  it("serves a repeat inside the fresh window from memory and asks again after it", async () => {
    let now = 1_000;
    let calls = 0;
    const cache = new NewsFeedCache({ dir: fixedTempDir(), now: () => now });
    const fetch = async () => {
      calls += 1;
      return ok(calls);
    };
    const opts = { days: 3, limit: 300 };
    await cache.get(opts, fetch);
    await cache.get(opts, fetch);
    assert.equal(calls, 1);
    now += MAIN_FRESH_MS;
    const third = await cache.get(opts, fetch);
    assert.equal(calls, 2);
    assert.equal(third.ok && third.articles[0]?.id, 2);
    await cache.flush();
  });

  it("shares one call between identical requests in flight", async () => {
    let calls = 0;
    let resolve!: (v: NewsFeedResult) => void;
    const cache = new NewsFeedCache({ dir: fixedTempDir() });
    const fetch = () => {
      calls += 1;
      return new Promise<NewsFeedResult>((r) => (resolve = r));
    };
    const a = cache.get({ days: 3 }, fetch);
    const b = cache.get({ days: 3 }, fetch);
    await new Promise((r) => setImmediate(r));
    assert.equal(calls, 1);
    assert.equal(a, b);
    resolve(ok(1));
    assert.deepEqual(await a, await b);
    await cache.flush();
  });

  it("passes a failure through and keeps the last good answer for peek", async () => {
    let now = 0;
    const cache = new NewsFeedCache({ dir: fixedTempDir(), now: () => now });
    await cache.get({ days: 3 }, async () => ok(7));
    now += MAIN_FRESH_MS + 1;
    const failed = await cache.get({ days: 3 }, async () => ({ ok: false, error: "engine timed out" }));
    assert.deepEqual(failed, { ok: false, error: "engine timed out" });
    const thrown = await cache.get({ days: 3 }, async () => {
      throw new Error("offline");
    });
    assert.deepEqual(thrown, { ok: false, error: "offline" });
    const peek = cache.peek({ days: 3 });
    assert.equal(peek.ok, true);
    assert.equal(peek.ok && peek.articles[0]?.id, 7);
    assert.equal(peek.ok && peek.fetchedAt, 0);
    await cache.flush();
  });

  it("writes good answers to disk and a new process reads them back", async () => {
    const dir = tempDir();
    const first = new NewsFeedCache({ dir: () => dir, now: () => 5_000 });
    await first.get({ days: 3, limit: 300 }, async () => ok(1, 2, 3));
    await first.flush();
    assert.ok(fs.existsSync(path.join(dir, NEWS_FEED_CACHE_FILE)));

    // "Restart": a fresh instance with nothing in memory.
    const second = new NewsFeedCache({ dir: () => dir, now: () => 9_000 });
    const peek = second.peek({ days: 3, limit: 300 });
    assert.equal(peek.ok, true);
    assert.deepEqual(peek.ok && peek.articles.map((a) => a.id), [1, 2, 3]);
    assert.equal(peek.ok && peek.fetchedAt, 5_000);
    assert.equal(second.peek({ days: 1 }).ok, false, "another request has no copy");

    // Still inside the fresh window by the stored clock: no call.
    let calls = 0;
    await second.get({ days: 3, limit: 300 }, async () => {
      calls += 1;
      return ok(4);
    });
    assert.equal(calls, 0);
  });

  it("treats a missing or torn file as empty", async () => {
    const dir = tempDir();
    assert.equal(new NewsFeedCache({ dir: () => dir }).peek({ days: 3 }).ok, false);
    fs.writeFileSync(path.join(dir, NEWS_FEED_CACHE_FILE), "{ not json", "utf8");
    const cache = new NewsFeedCache({ dir: () => dir });
    assert.equal(cache.peek({ days: 3 }).ok, false);
    // And the next good answer replaces it.
    await cache.get({ days: 3 }, async () => ok(1));
    await cache.flush();
    const raw = JSON.parse(fs.readFileSync(path.join(dir, NEWS_FEED_CACHE_FILE), "utf8"));
    assert.equal(raw.version, 1);
  });

  it("does not store a failure or a malformed answer", async () => {
    const dir = tempDir();
    const cache = new NewsFeedCache({ dir: () => dir });
    await cache.get({ days: 3 }, async () => ({ ok: true, articles: "nope" }));
    await cache.flush();
    assert.equal(cache.peek({ days: 3 }).ok, false);
    assert.equal(fs.existsSync(path.join(dir, NEWS_FEED_CACHE_FILE)), false);
  });
});
