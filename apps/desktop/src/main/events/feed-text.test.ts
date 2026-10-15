import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { repairEventsText, repairFeedText } from "./feed-text";

describe("news feed text", () => {
  it("repairs provider mojibake in headlines and summaries, and leaves correct text alone", () => {
    const feed = {
      ok: true,
      status: { running: false },
      articles: [
        { id: 1, headline: "The weekâ€™s movers", summary: "weekâ\u0080\u0099s biggest", source: "SeekingAlpha", tickers: ["AAPL"] },
        { id: 2, headline: "Société Générale in Zürich", summary: "café", source: "Reuters", tickers: [] },
      ],
    };
    const out = repairFeedText(feed) as typeof feed;
    assert.equal(out.articles[0]!.headline, "The week’s movers");
    assert.equal(out.articles[0]!.summary, "week’s biggest");
    assert.deepEqual(out.articles[0]!.tickers, ["AAPL"]);
    assert.equal(out.articles[1], feed.articles[1]);
    assert.equal(out.status, feed.status);
  });

  it("passes failures and anything else through untouched", () => {
    const failed = { ok: false, error: "engine timed out" };
    assert.equal(repairFeedText(failed), failed);
    assert.equal(repairFeedText(null), null);
    assert.equal(repairFeedText("x"), "x");
  });
});

describe("stored events text", () => {
  it("repairs headline and summary of events filed before ingestion repaired them", () => {
    const answer = {
      ok: true,
      events: [
        { id: "e1", headline: "Appleâ€™s supplier cuts guidance", summary: "Cuts Â£ outlook", ticker: "AAPL", confidence: 0.8 },
        { id: "e2", headline: "Société Générale in Zürich", summary: "café", ticker: "GLE", confidence: 0.5 },
      ],
    };
    const out = repairEventsText(answer) as typeof answer;
    assert.equal(out.events[0]!.headline, "Apple’s supplier cuts guidance");
    assert.equal(out.events[0]!.summary, "Cuts £ outlook");
    assert.equal(out.events[0]!.confidence, 0.8);
    assert.deepEqual(out.events[1], answer.events[1]);
  });

  it("passes failures and anything else through untouched", () => {
    const failed = { ok: false, error: "disk" };
    assert.equal(repairEventsText(failed), failed);
    assert.equal(repairEventsText(undefined), undefined);
  });
});
