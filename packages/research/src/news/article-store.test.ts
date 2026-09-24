import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { ArticleStore, listNewsArticles } from "./article-store.js";

const article = (id: number, datetime: number, headline = `story ${id}`) => ({
  id,
  datetime,
  headline,
  summary: "",
  url: `https://x/${id}`,
  source: "Reuters",
});

describe("the article store", () => {
  it("files a story once and lets every ticker it was fetched for accumulate on it", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "articles-"));
    try {
      const store = new ArticleStore(dir);
      await store.load();
      store.note("NVDA", [article(1, 1_700_000_000), article(2, 1_700_000_100)]);
      store.note("AMD", [article(1, 1_700_000_000)]);
      store.classify(2, {
        is_material_event: true,
        event_type: "earnings",
        affected_ticker: "NVDA",
        direction_on_primary: "positive",
        summary: "beat",
        confidence: 0.9,
      });
      await store.persist();

      const feed = await listNewsArticles(dir, { days: 7 });
      assert.deepEqual(
        feed.map((a) => [a.id, a.tickers]),
        [
          [2, ["NVDA"]],
          [1, ["NVDA", "AMD"]],
        ],
      );
      assert.equal(feed[0].event?.material, true);
      assert.equal(feed[0].event?.affected_ticker, "NVDA");
      assert.equal(feed[1].event, null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps what an earlier poll filed, and honours the day and size limits", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "articles-"));
    try {
      const day = 86_400;
      const first = new ArticleStore(dir);
      await first.load();
      first.note("MSFT", [article(10, 1_700_000_000), article(11, 1_700_000_000 - 3 * day)]);
      await first.persist();

      const second = new ArticleStore(dir);
      await second.load();
      second.note("ORCL", [article(10, 1_700_000_000), article(12, 1_700_000_000 - day)]);
      await second.persist();

      const all = await listNewsArticles(dir, { days: 7 });
      assert.deepEqual(all.map((a) => a.id), [10, 12, 11]);
      assert.deepEqual(all[0].tickers, ["MSFT", "ORCL"]);

      const recent = await listNewsArticles(dir, { days: 2 });
      assert.deepEqual(recent.map((a) => a.id), [10, 12]);

      const capped = await listNewsArticles(dir, { days: 7, limit: 1 });
      assert.deepEqual(capped.map((a) => a.id), [10]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("drops stories with no usable id or headline", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "articles-"));
    try {
      const store = new ArticleStore(dir);
      await store.load();
      store.note("NVDA", [article(0, 1_700_000_000), article(3, 1_700_000_000, "")]);
      await store.persist();
      assert.deepEqual(await listNewsArticles(dir), []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
