import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BriefingReport, HeldFiling, MarketHeadline, Story, StoryScope } from "./briefing-types";
import { MASKED_USD } from "./briefing-view";
import {
  HANDOVER_INTRO,
  ITEMS_PER_SECTION,
  etDateLabel,
  etTimeLabel,
  handoverView,
  isEarningsFiling,
  sessionDateLabel,
} from "./handover-view";

// 9:04 AM in New York on Thursday, September 24 (EDT, UTC-4).
const MORNING = new Date("2026-09-24T13:04:00.000Z");

function story(id: string, scope: StoryScope, what: string, extra: Partial<Story> = {}): Story {
  return {
    id,
    scope,
    at: null,
    what,
    reaction: "",
    reactions: [],
    meaning: null,
    tickers: [],
    evidence: [],
    source: "model",
    ...extra,
  };
}

function headline(id: string, title: string, extra: Partial<MarketHeadline> = {}): MarketHeadline {
  return {
    id,
    title,
    source: "Reuters",
    url: `https://example.com/${id}`,
    published_at: "2026-09-24T10:00:00.000Z",
    related: [],
    via: "SPY",
    ...extra,
  };
}

function filing(ticker: string, label: string, kind: HeldFiling["kind"] = "filing"): HeldFiling {
  return { ticker, kind, label, filed_at: "2026-09-23T20:05:00.000Z", url: `https://sec.gov/${ticker}` };
}

function makeReport(overrides: Partial<BriefingReport> = {}): BriefingReport {
  return {
    schema_version: 3,
    generated_at: "2026-09-24T12:30:00.000Z",
    demo: false,
    synthetic_now: false,
    window: {
      target_session_ymd: "2026-09-24",
      prev_session_ymd: "2026-09-23",
      overnight_since: "2026-09-23T20:00:00.000Z",
      window_opens_at: "2026-09-24T00:00:00.000Z",
      target_open_at: "2026-09-24T13:30:00.000Z",
      target_close_at: "2026-09-24T20:00:00.000Z",
      phase: "pre_open",
      auto_show: true,
      handover: "overnight",
      early_close: false,
    },
    overnight: { markets: [], held_movers: [], held_news: [], filings: [], measurements: [] },
    held_coverage: [],
    book: {
      position_count: 0,
      equity_usd: 0,
      cash_usd: 0,
      invested_usd: 0,
      net_exposure_pct: 0,
      gross_exposure_pct: 0,
      overnight_pnl_usd: null,
      overnight_pnl_pct: null,
      top_weights: [],
      unpriced: [],
      priced_at: "2026-09-24T12:30:00.000Z",
    },
    risk: null,
    earnings_next: [],
    corporate_events: [],
    corporate_coverage: { dividends: "", splits: "", unknown_symbols: [] },
    calendar_today: [],
    calendar_coverage: { from: "2026-01-01", until: "2026-10-31", compiled_at: "2026-09-01T00:00:00.000Z", covers_target: true, days_left: 37 },
    headlines: [],
    stories: [],
    implications: [],
    narrative: {
      text: "",
      source: "template",
      model: null,
      generated_at: "2026-09-24T12:30:00.000Z",
      facts_hash: "h",
      pending: false,
      reason: null,
    },
    facts_hash: "h",
    degraded: [],
    ...overrides,
  };
}

describe("handover view: the frame", () => {
  it("opens with the introduction and closes on the market's time and the session date", () => {
    const view = handoverView(makeReport(), MORNING, false);
    assert.equal(view.intro, HANDOVER_INTRO);
    assert.equal(view.intro, "This is what happened when you were away");
    assert.equal(view.time, "9:04 AM ET");
    assert.equal(view.date, "Thu Sep 24");
  });

  it("says it is empty rather than drawing headings over nothing", () => {
    const view = handoverView(makeReport(), MORNING, false);
    assert.equal(view.empty, true);
    assert.deepEqual(view.sections, []);
    assert.equal(view.lead, null);
  });

  it("keeps the report's lead, whitespace tidied", () => {
    const report = makeReport();
    const view = handoverView(
      makeReport({ narrative: { ...report.narrative, text: "  Futures are flat.\n  Amazon moved late.  " } }),
      MORNING,
      false,
    );
    assert.equal(view.lead, "Futures are flat. Amazon moved late.");
  });
});

describe("handover view: stories bucketed as the design reads them", () => {
  const base = makeReport();
  const report = makeReport({
    stories: [
      story("s3", "market", "Treasury yields rose after the jobs data.", { reaction: "10-year +6bp." }),
      story("s1", "name", "Garmin beat on revenue and raised its outlook.", {
        tickers: ["grmn"],
        reaction: "GRMN +6.1% after hours.",
        meaning: "Your largest holding.",
      }),
      story("s2", "name", "Amazon said it will open a new logistics hub.", { tickers: ["AMZN"], reaction: "AMZN +0.8% premarket." }),
      story("s4", "release", "CPI printed at 08:30 ET"),
    ],
    overnight: { ...base.overnight, filings: [filing("GRMN", "8-K, items 2.02, 9.01 (results of operations)")] },
  });
  const view = handoverView(report, MORNING, false);

  it("news, then earnings, then the rest, whatever order the stories came in", () => {
    assert.deepEqual(
      view.sections.map((s) => [s.kind, s.title]),
      [
        ["news", "News"],
        ["earnings", "Earnings"],
        ["other", "Other"],
      ],
    );
    assert.equal(view.empty, false);
  });

  it("names each line after its company, and a market line after the market", () => {
    assert.deepEqual(
      view.sections.map((s) => s.items.map((i) => i.subject)),
      [["AMZN"], ["GRMN"], ["Markets", "Macro"]],
    );
  });

  it("files a macro release (the engine's 'release' scope) under Other, not Earnings", () => {
    const other = view.sections.find((s) => s.kind === "other")!;
    assert.ok(other.items.some((i) => i.id === "s4"));
    const earnings = view.sections.find((s) => s.kind === "earnings")!;
    assert.deepEqual(
      earnings.items.map((i) => i.id),
      ["s1"],
    );
  });

  it("tells a company that reported once: its story, not the story and the filing again", () => {
    const b = makeReport();
    const lly = handoverView(
      makeReport({
        stories: [story("story:name:LLY", "name", "LLY reported results", { tickers: ["LLY"] })],
        overnight: { ...b.overnight, filings: [filing("LLY", "8-K, items 2.02, 9.01 (results of operations)")] },
      }),
      MORNING,
      false,
    );
    assert.deepEqual(
      lly.sections.map((s) => [s.kind, s.items.map((i) => i.id)]),
      [["earnings", ["story:name:LLY"]]],
    );
  });

  it("keeps the reaction and the meaning for 'See more'", () => {
    const earnings = view.sections.find((s) => s.kind === "earnings")!;
    assert.equal(earnings.items[0]!.summary, "Garmin beat on revenue and raised its outlook.");
    assert.equal(earnings.items[0]!.detail, "GRMN +6.1% after hours.");
    assert.equal(earnings.items[0]!.meaning, "Your largest holding.");
  });

  it("shows at most a glance per section and keeps the report's own order", () => {
    const many = makeReport({
      stories: Array.from({ length: ITEMS_PER_SECTION + 2 }, (_, i) =>
        story(`n${i}`, "name", `Story number ${i}.`, { tickers: [`T${i}`] }),
      ),
    });
    const items = handoverView(many, MORNING, false).sections[0]!.items;
    assert.equal(items.length, ITEMS_PER_SECTION);
    assert.deepEqual(
      items.map((i) => i.id),
      ["n0", "n1", "n2"],
    );
  });

  it("drops a story with no sentence and a repeat of one already shown", () => {
    const view2 = handoverView(
      makeReport({
        stories: [
          story("a", "name", "   "),
          story("b", "name", "Apple cut its guidance."),
          story("c", "name", "apple cut its  guidance."),
        ],
      }),
      MORNING,
      false,
    );
    assert.deepEqual(
      view2.sections[0]!.items.map((i) => i.id),
      ["b"],
    );
  });

  it("shortens a line about many names", () => {
    const view3 = handoverView(
      makeReport({ stories: [story("x", "name", "Chipmakers fell.", { tickers: ["NVDA", "AMD", "AVGO", "TSM"] })] }),
      MORNING,
      false,
    );
    assert.equal(view3.sections[0]!.items[0]!.subject, "NVDA, AMD +2");
    // A line about several names opens none of them.
    assert.equal(view3.sections[0]!.items[0]!.ticker, null);
  });

  it("opens the one company a line is about, and leaves an unnamed line unnamed", () => {
    const view4 = handoverView(
      makeReport({ stories: [story("a", "name", "Amazon moved.", { tickers: ["amzn", "AMZN"] }), story("b", "name", "A private firm moved.")] }),
      MORNING,
      false,
    );
    assert.deepEqual(
      view4.sections[0]!.items.map((i) => [i.subject, i.ticker]),
      [
        ["AMZN", "AMZN"],
        [null, null],
      ],
    );
  });
});

describe("handover view: falling back to the evidence", () => {
  it("fills News from the headlines when no story is about a company, with the link kept", () => {
    const view = handoverView(
      makeReport({ headlines: [headline("h1", "Amazon expands same-day delivery", { related: ["AMZN"] }), headline("h2", "Oil slips")] }),
      MORNING,
      false,
    );
    const news = view.sections.find((s) => s.kind === "news")!;
    assert.deepEqual(
      news.items.map((i) => [i.subject, i.summary, i.url]),
      [
        ["AMZN", "Amazon expands same-day delivery", "https://example.com/h1"],
        ["Reuters", "Oil slips", "https://example.com/h2"],
      ],
    );
    assert.equal(news.items[0]!.detail, "Reported by Reuters.");
  });

  it("does not mix headlines under stories that already cover the news", () => {
    const view = handoverView(
      makeReport({ stories: [story("s", "name", "Amazon moved.", { tickers: ["AMZN"] })], headlines: [headline("h1", "Something else")] }),
      MORNING,
      false,
    );
    assert.deepEqual(
      view.sections[0]!.items.map((i) => i.id),
      ["s"],
    );
  });

  it("adds a company that filed results but has no story, beside the stories", () => {
    const b = makeReport();
    const view = handoverView(
      makeReport({
        stories: [story("s", "name", "Amazon moved.", { tickers: ["AMZN"] })],
        overnight: { ...b.overnight, filings: [filing("GRMN", "8-K, item 2.02")] },
      }),
      MORNING,
      false,
    );
    assert.deepEqual(
      view.sections.map((s) => [s.kind, s.items.map((i) => i.subject)]),
      [
        ["news", ["AMZN"]],
        ["earnings", ["GRMN"]],
      ],
    );
  });

  it("fills Earnings from an 8-K item 2.02 and ignores other filings and insider trades", () => {
    const report = makeReport();
    const view = handoverView(
      makeReport({
        overnight: {
          ...report.overnight,
          filings: [
            filing("GRMN", "8-K, items 2.02, 9.01 (results of operations)"),
            filing("KO", "8-K, items 7.01, 9.01 (Regulation FD disclosure)"),
            filing("NVDA", "Insider filing (Form 4)", "insider"),
          ],
        },
      }),
      MORNING,
      false,
    );
    assert.deepEqual(
      view.sections.map((s) => s.kind),
      ["earnings"],
    );
    const item = view.sections[0]!.items[0]!;
    assert.equal(item.subject, "GRMN");
    assert.equal(item.summary, "GRMN released its quarterly results.");
    assert.equal(item.detail, "Filed with the SEC: 8-K, items 2.02, 9.01 (results of operations).");
    assert.equal(item.url, "https://sec.gov/GRMN");
  });

  it("reads an earnings filing from its item number, not from a lookalike", () => {
    assert.equal(isEarningsFiling(filing("A", "8-K, item 2.02")), true);
    assert.equal(isEarningsFiling(filing("A", "8-K, items 12.021")), false);
    assert.equal(isEarningsFiling(filing("A", "8-K, items 5.02 (departure of directors)")), false);
    assert.equal(isEarningsFiling(filing("A", "Quarterly results")), true);
    assert.equal(isEarningsFiling(filing("A", "8-K, item 2.02", "insider")), false);
  });
});

describe("handover view: privacy", () => {
  it("masks dollar amounts in every sentence under the privacy switch, and only then", () => {
    const base = makeReport();
    const report = makeReport({
      narrative: { ...base.narrative, text: "Your book is up $12,400 overnight." },
      stories: [story("s", "name", "Apple lost $40 billion in value.", { reaction: "Down $3.10.", meaning: "About $900 of yours." })],
    });
    const open = handoverView(report, MORNING, false);
    assert.match(open.lead!, /\$12,400/);

    const masked = handoverView(report, MORNING, true);
    const item = masked.sections[0]!.items[0]!;
    for (const text of [masked.lead!, item.summary, item.detail!, item.meaning!]) {
      assert.doesNotMatch(text, /\$\d/, text);
      assert.ok(text.includes(MASKED_USD), text);
    }
  });
});

describe("handover view: time and date labels", () => {
  it("tells the time on New York's clock whatever the machine's timezone", () => {
    assert.equal(etTimeLabel(new Date("2026-09-24T13:00:00.000Z")), "9:00 AM ET");
    assert.equal(etTimeLabel(new Date("2026-01-15T14:30:00.000Z")), "9:30 AM ET");
    assert.equal(etTimeLabel(new Date("2026-09-24T21:15:00.000Z")), "5:15 PM ET");
    assert.equal(etTimeLabel(new Date("nope")), "");
  });

  it("dates the footer by New York's calendar before a report has arrived", () => {
    // 11:30 PM on the 23rd in New York is already the 24th in UTC.
    assert.equal(etDateLabel(new Date("2026-09-24T03:30:00.000Z")), "Wed Sep 23");
    assert.equal(etDateLabel(MORNING), "Thu Sep 24");
    assert.equal(etDateLabel(new Date("nope")), "");
  });

  it("names the session's weekday and date, and passes a malformed date through", () => {
    assert.equal(sessionDateLabel("2026-09-24"), "Thu Sep 24");
    assert.equal(sessionDateLabel("2026-01-05"), "Mon Jan 5");
    assert.equal(sessionDateLabel("2026-13-01"), "2026-13-01");
    assert.equal(sessionDateLabel("soon"), "soon");
  });
});
