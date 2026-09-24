import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { sliceFromReplay } from "./chain-slice.js";
import { copyRuleFaults } from "./narrative.js";
import { fixtureIncident, fixtureMessage, fixtureReplay } from "./test-fixtures.js";

/** Friday 2026-09-18 16:00 ET. */
const SINCE = "2026-09-18T20:00:00.000Z";
const BEFORE = "2026-09-18T19:30:00.000Z";
const AFTER = "2026-09-21T10:00:00.000Z";
const LATER = "2026-09-21T11:00:00.000Z";

function news(ticker: string, timestamp: string, over: Record<string, unknown> = {}) {
  return fixtureMessage("news_item", ticker, timestamp, {
    headline: "Supplier widens capacity plan",
    source: "Newswire",
    url: "https://example.com/a/supplier-capacity",
    published_at: timestamp,
    article_id: "",
    summary: "",
    ...over,
  });
}

describe("briefing/chain-slice: since-filter", () => {
  it("keeps what the Tracker saw after the close and drops what it saw before", () => {
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P2", [
        news("NVDA", BEFORE, { url: "https://example.com/a/old", headline: "Old story" }),
        news("NVDA", AFTER, { url: "https://example.com/a/new", headline: "New story" }),
      ]),
    ]);
    const slice = sliceFromReplay("NVDA", replay, SINCE, "tracked");
    assert.deepEqual(slice.news.map((n) => n.headline), ["New story"]);
    assert.equal(slice.coverage, "tracked");
    assert.equal(slice.ticker, "NVDA");
  });

  it("drops an article polled after the close but published before it", () => {
    // A newly followed name is back-filled with days of articles, all stamped
    // with the poll time.
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P2", [news("NVDA", AFTER, { published_at: "2026-09-17T14:00:00.000Z" })]),
    ]);
    assert.deepEqual(sliceFromReplay("NVDA", replay, SINCE, "tracked").news, []);
  });

  it("keeps only the ticker it was asked for, whatever the case", () => {
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P2", [news("NVDA", AFTER)]),
      fixtureIncident("AAPL", "P2", [news("AAPL", AFTER, { url: "https://example.com/a/aapl" })]),
    ]);
    const slice = sliceFromReplay(" nvda ", replay, SINCE, "tracked");
    assert.equal(slice.ticker, "NVDA");
    assert.equal(slice.news.length, 1);
    assert.equal(slice.news[0]!.ticker, "NVDA");
  });

  it("returns an empty slice when the boundary cannot be read", () => {
    const replay = fixtureReplay([fixtureIncident("NVDA", "P2", [news("NVDA", AFTER)])]);
    const slice = sliceFromReplay("NVDA", replay, "not a date", "price_only");
    assert.deepEqual(slice, { ticker: "NVDA", coverage: "price_only", news: [], filings: [], measurements: [], scheduled_earnings: [] });
  });
});

describe("briefing/chain-slice: mapping", () => {
  it("maps a news item with the incident's band, tags and id", () => {
    const incident = fixtureIncident("NVDA", "P1", [news("NVDA", AFTER)], ["event_gap", "explained_move"]);
    const [item] = sliceFromReplay("NVDA", fixtureReplay([incident]), SINCE, "tracked").news;
    assert.deepEqual(item, {
      ticker: "NVDA",
      also: [],
      headline: "Supplier widens capacity plan",
      source: "Newswire",
      url: "https://example.com/a/supplier-capacity",
      published_at: AFTER,
      band: "P1",
      tags: ["event_gap", "explained_move"],
      incident_id: incident.incident.incident_id,
    });
  });

  it("passes on web links only", () => {
    const replay = fixtureReplay([fixtureIncident("NVDA", "P2", [news("NVDA", AFTER, { url: "javascript:alert(1)" })])]);
    assert.equal(sliceFromReplay("NVDA", replay, SINCE, "tracked").news[0]!.url, "");
  });

  it("labels an 8-K with its item codes and any other form by its type", () => {
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P1", [
        fixtureMessage("filing_item", "NVDA", AFTER, {
          form_type: "8-K",
          accession_number: "0001045810-26-000101",
          filed_at: "2026-09-18T20:05:00.000Z",
          item_codes: ["2.02", "9.01"],
          filing_url: "https://www.sec.gov/Archives/edgar/data/1045810/a.htm",
        }),
        fixtureMessage("filing_item", "NVDA", LATER, {
          form_type: "10-Q",
          accession_number: "0001045810-26-000102",
          filed_at: "2026-09-21T10:30:00.000Z",
          item_codes: [],
          filing_url: "https://www.sec.gov/Archives/edgar/data/1045810/b.htm",
        }),
        fixtureMessage("filing_item", "NVDA", LATER, {
          form_type: "8-K",
          accession_number: "0001045810-26-000103",
          filed_at: "2026-09-21T10:45:00.000Z",
          item_codes: ["3.03"],
          filing_url: "https://www.sec.gov/Archives/edgar/data/1045810/c.htm",
        }),
      ]),
    ]);
    const filings = sliceFromReplay("NVDA", replay, SINCE, "tracked").filings;
    // Newest first.
    assert.deepEqual(
      filings.map((f) => [f.kind, f.label, f.filed_at]),
      [
        ["filing", "8-K, item 3.03", "2026-09-21T10:45:00.000Z"],
        ["filing", "10-Q", "2026-09-21T10:30:00.000Z"],
        ["filing", "8-K, items 2.02, 9.01 (results of operations)", "2026-09-18T20:05:00.000Z"],
      ],
    );
  });

  it("labels an insider filing plainly and carries no name or dollar value", () => {
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P2", [
        fixtureMessage("insider_filing", "NVDA", AFTER, {
          insider_name: "Jane Roe",
          role: "CFO",
          transaction_code: "S",
          is_10b5_1_plan: true,
          shares: 5000,
          value: 612_000,
          transaction_date: "2026-09-17",
          filed_at: "2026-09-18T21:10:00.000Z",
          filing_url: "https://www.sec.gov/Archives/edgar/data/1045810/form4.xml",
        }),
      ]),
    ]);
    const [filing] = sliceFromReplay("NVDA", replay, SINCE, "tracked").filings;
    assert.deepEqual(filing, {
      ticker: "NVDA",
      kind: "insider",
      label: "Insider filing (Form 4)",
      filed_at: "2026-09-18T21:10:00.000Z",
      url: "https://www.sec.gov/Archives/edgar/data/1045810/form4.xml",
    });
    assert.ok(!JSON.stringify(filing).includes("612"));
  });

  it("writes one plain line per measurement from the payload numbers", () => {
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P1", [
        fixtureMessage("gap_event", "NVDA", "2026-09-21T13:31:00.000Z", { gap_pct: -0.0321, gap_z: -2.44, direction: "down", prev_close: 116, open_price: 112.28 }),
        fixtureMessage("volume_anomaly", "NVDA", "2026-09-18T20:12:00.000Z", { volume_ratio: 3.14, threshold_crossed: 3, catch_up: false }),
        fixtureMessage("unexplained_move", "NVDA", "2026-09-18T20:13:00.000Z", {
          residual_zscore: 2.81,
          measure_used: "residual_zscore",
          direction: "up",
          volume_ratio: 1.2,
          news_items_since_prev_close: 0,
          catch_up: false,
        }),
        fixtureMessage("drift_event", "NVDA", "2026-09-18T20:14:00.000Z", { momentum_5d: 0.0642, drift_z: 2.3, direction: "up", news_items_last_5d: 1, catch_up: false }),
        fixtureMessage("news_burst", "NVDA", "2026-09-21T09:00:00.000Z", { articles_last_24h: 12, baseline_daily_rate: 3, burst_multiple: 4 }),
        fixtureMessage("insider_cluster", "NVDA", "2026-09-21T09:30:00.000Z", {
          window_business_days: 10,
          insider_count: 3,
          direction: "sell",
          total_notional: 4_250_000,
          transactions: [],
        }),
      ]),
    ]);
    const byType = new Map(sliceFromReplay("NVDA", replay, SINCE, "tracked").measurements.map((m) => [m.type, m]));
    assert.equal(byType.get("gap_event")!.detail, "Opened 3.2% below the prior close, a 2.4 standard deviation gap.");
    assert.equal(byType.get("volume_anomaly")!.detail, "Volume ran at 3.1 times its usual level in the last measured session.");
    assert.equal(
      byType.get("unexplained_move")!.detail,
      "Moved up 2.8 standard deviations more than the market explains, with no company news in that session.",
    );
    assert.equal(
      byType.get("drift_event")!.detail,
      "Up 6.4% over five sessions, 2.3 standard deviations of drift, with 1 company news item in that span.",
    );
    assert.equal(byType.get("news_burst")!.detail, "12 articles in 24 hours, 4.0 times the usual daily rate.");
    assert.equal(byType.get("insider_cluster")!.detail, "3 insiders reported open-market sales within 10 business days.");
    assert.equal(byType.get("gap_event")!.at, "2026-09-21T13:31:00.000Z");

    // No price level and no insider dollar total reaches a line.
    const all = [...byType.values()].map((m) => m.detail).join(" ");
    for (const leaked of ["116", "112.28", "4250000", "4,250,000", "$"]) assert.ok(!all.includes(leaked), leaked);
  });

  it("says which measure an unexplained move used, and words a purchase cluster without a trade verb", () => {
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P1", [
        fixtureMessage("unexplained_move", "NVDA", AFTER, {
          residual_zscore: -3.05,
          measure_used: "move_zscore",
          direction: "down",
          volume_ratio: null,
          news_items_since_prev_close: 2,
          catch_up: true,
        }),
        fixtureMessage("insider_cluster", "NVDA", LATER, { window_business_days: 1, insider_count: 1, direction: "buy", total_notional: 1, transactions: [] }),
      ]),
    ]);
    const details = sliceFromReplay("NVDA", replay, SINCE, "tracked").measurements.map((m) => m.detail);
    assert.deepEqual(details, [
      "1 insider reported open-market purchases within 1 business day.",
      "Moved down 3.0 standard deviations in the last measured session, against 2 company news items in that session.",
    ]);
  });

  it("does not call a cluster with an unknown direction a sale", () => {
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P1", [
        fixtureMessage("insider_cluster", "NVDA", LATER, { window_business_days: 5, insider_count: 2, direction: "exercise", total_notional: 1, transactions: [] }),
      ]),
    ]);
    const details = sliceFromReplay("NVDA", replay, SINCE, "tracked").measurements.map((m) => m.detail);
    assert.deepEqual(details, ["2 insiders reported open-market transactions within 5 business days."]);
  });

  it("keeps every line it can write inside the copy rules", () => {
    const payloads: Array<[Parameters<typeof fixtureMessage>[0], Record<string, unknown>]> = [];
    for (const direction of ["up", "down"]) {
      payloads.push(["gap_event", { gap_pct: direction === "up" ? 0.05 : -0.05, gap_z: 3, direction }]);
      payloads.push(["gap_event", { gap_pct: 0.01, direction }]);
      for (const measure_used of ["residual_zscore", "move_zscore"]) {
        for (const news_items_since_prev_close of [0, 1, 4, undefined]) {
          payloads.push(["unexplained_move", { residual_zscore: 2.5, measure_used, direction, news_items_since_prev_close }]);
        }
      }
      payloads.push(["drift_event", { momentum_5d: 0.08, drift_z: 2.1, direction, news_items_last_5d: 0 }]);
      payloads.push(["drift_event", { momentum_5d: 0.08, direction }]);
    }
    payloads.push(["volume_anomaly", { volume_ratio: 5 }]);
    payloads.push(["news_burst", { articles_last_24h: 1, burst_multiple: 6 }]);
    payloads.push(["news_burst", { articles_last_24h: 9 }]);
    for (const direction of ["buy", "sell"]) {
      payloads.push(["insider_cluster", { insider_count: 4, window_business_days: 10, direction }]);
      payloads.push(["insider_cluster", { insider_count: 2, direction }]);
    }
    const replay = fixtureReplay([fixtureIncident("NVDA", "P2", payloads.map(([type, payload]) => fixtureMessage(type, "NVDA", AFTER, payload)))]);
    const slice = sliceFromReplay("NVDA", replay, SINCE, "tracked");
    assert.equal(slice.measurements.length, payloads.length);
    for (const m of slice.measurements) assert.deepEqual(copyRuleFaults(m.detail), [], m.detail);

    const labels = sliceFromReplay(
      "NVDA",
      fixtureReplay([
        fixtureIncident("NVDA", "P2", [
          fixtureMessage("filing_item", "NVDA", AFTER, { form_type: "8-K", filed_at: AFTER, item_codes: ["1.01", "2.02", "5.02", "7.01", "8.01", "9.01"], filing_url: "" }),
          fixtureMessage("insider_filing", "NVDA", AFTER, { filed_at: AFTER, filing_url: "" }),
        ]),
      ]),
      SINCE,
      "tracked",
    ).filings.map((f) => f.label);
    assert.equal(labels.length, 2);
    for (const label of labels) assert.deepEqual(copyRuleFaults(label), [], label);
  });

  it("keeps a scheduled earnings date that is still ahead, however long ago it was announced", () => {
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P3", [
        fixtureMessage("scheduled_event", "NVDA", "2026-08-30T12:00:00.000Z", {
          event_type: "earnings",
          due_at: "2026-09-24T20:00:00.000Z",
          fiscal_period: "Q3 2026",
          earnings_rhythm: null,
          rescheduled: false,
          previous_due_at: null,
        }),
        fixtureMessage("scheduled_event", "NVDA", "2026-06-01T12:00:00.000Z", {
          event_type: "earnings",
          due_at: "2026-06-24T20:00:00.000Z",
          fiscal_period: "Q2 2026",
          earnings_rhythm: null,
          rescheduled: false,
          previous_due_at: null,
        }),
      ]),
    ]);
    assert.deepEqual(sliceFromReplay("NVDA", replay, SINCE, "tracked").scheduled_earnings, [
      { due_at: "2026-09-24T20:00:00.000Z", confirmed: true, fiscal_period: "Q3 2026" },
    ]);
  });

  it("believes the newest message when a date was rescheduled", () => {
    const scheduled = (timestamp: string, due_at: string, rescheduled: boolean) =>
      fixtureMessage("scheduled_event", "NVDA", timestamp, {
        event_type: "earnings",
        due_at,
        fiscal_period: "Q3 2026",
        earnings_rhythm: null,
        rescheduled,
        previous_due_at: rescheduled ? "2026-09-24T20:00:00.000Z" : null,
      });
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P3", [scheduled("2026-09-10T12:00:00.000Z", "2026-09-29T12:00:00.000Z", true)]),
      fixtureIncident("NVDA", "P3", [scheduled("2026-08-30T12:00:00.000Z", "2026-09-24T20:00:00.000Z", false)]),
    ]);
    assert.deepEqual(sliceFromReplay("NVDA", replay, SINCE, "tracked").scheduled_earnings, [
      { due_at: "2026-09-29T12:00:00.000Z", confirmed: true, fiscal_period: "Q3 2026" },
    ]);
  });
});

describe("briefing/chain-slice: dedupe and robustness", () => {
  it("lists an article once and keeps the more urgent incident's band", () => {
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P3", [news("NVDA", AFTER, { article_id: "7781" })]),
      // The same article id under a tracking-tagged URL, inside a P1 incident.
      fixtureIncident("NVDA", "P1", [news("NVDA", LATER, { article_id: "7781", url: "https://example.com/a/supplier-capacity?utm_source=feed" })]),
      // No article id: the URL is the identity, tracking parameters aside.
      fixtureIncident("NVDA", "P2", [
        news("NVDA", AFTER, { url: "https://www.example.com/b/other?utm_campaign=x", headline: "Other story" }),
        news("NVDA", LATER, { url: "https://example.com/b/other", headline: "Other story" }),
      ]),
    ]);
    const slice = sliceFromReplay("NVDA", replay, SINCE, "tracked");
    assert.deepEqual(
      slice.news.map((n) => [n.headline, n.band]),
      [
        ["Supplier widens capacity plan", "P1"],
        ["Other story", "P2"],
      ],
    );
  });

  it("ignores message types the briefing has no place for, and malformed rows, without throwing", () => {
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P2", [
        fixtureMessage("silence_anomaly", "NVDA", AFTER, { trading_days_silent: 6 }),
        fixtureMessage("filing_overdue", "NVDA", AFTER, { expected_form: "10-Q" }),
        fixtureMessage("tape_structure" as never, "NVDA", AFTER, { pattern: "compression" }),
        fixtureMessage("something_new" as never, "NVDA", AFTER, {}),
        fixtureMessage("gap_event", "NVDA", AFTER, { gap_pct: "wide" }),
        fixtureMessage("news_item", "NVDA", AFTER, { headline: 42 }),
        fixtureMessage("news_item", "NVDA", "not a time", { headline: "Undated" }),
        { ...fixtureMessage("news_item", "NVDA", AFTER, {}), payload: null as never },
        null as never,
      ]),
      { incident: null, routing: null } as never,
    ]);
    const slice = sliceFromReplay("NVDA", replay, SINCE, "pending");
    assert.deepEqual(slice, { ticker: "NVDA", coverage: "pending", news: [], filings: [], measurements: [], scheduled_earnings: [] });
    assert.doesNotThrow(() => sliceFromReplay("NVDA", {} as never, SINCE, "pending"));
    assert.doesNotThrow(() => sliceFromReplay(undefined as never, null as never, SINCE, "pending"));
  });

  it("flattens control characters and caps a runaway headline", () => {
    const replay = fixtureReplay([
      fixtureIncident("NVDA", "P2", [news("NVDA", AFTER, { headline: `Line one\nline two\t${"x".repeat(400)}` })]),
    ]);
    const [item] = sliceFromReplay("NVDA", replay, SINCE, "tracked").news;
    assert.ok(item!.headline.startsWith("Line one line two x"));
    assert.ok(item!.headline.length <= 303);
    assert.ok(item!.headline.endsWith("..."));
  });
});
