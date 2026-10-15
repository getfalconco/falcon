import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { BriefingFact, BriefingReport, HeldFiling, MarketHeadline, Story, StoryScope } from "./briefing-types";
import { MASKED_USD } from "./briefing-view";
import { copyProblems } from "./copy-rules";
import {
  HANDOVER_INTRO,
  ITEMS_PER_SECTION,
  etDateLabel,
  etTimeLabel,
  factHint,
  factTitle,
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

  it("dates the footer by the clock on a day the market does not open, and by the session otherwise", () => {
    const monday = makeReport({ window: { ...makeReport().window, target_session_ymd: "2026-10-12" } });
    // Sunday 10:00 ET and Saturday 23:30 ET: the handover is Monday's, the footer reads today.
    assert.equal(handoverView(monday, new Date("2026-10-11T14:00:00.000Z"), false).date, "Sun Oct 11");
    assert.equal(handoverView(monday, new Date("2026-10-11T03:30:00.000Z"), false).date, "Sat Oct 10");
    // Labor Day morning, the handover for Tuesday.
    const tuesday = makeReport({ window: { ...makeReport().window, target_session_ymd: "2026-09-08" } });
    assert.equal(handoverView(tuesday, new Date("2026-09-07T14:00:00.000Z"), false).date, "Mon Sep 7");
    // Friday evening after the close is still a trading day: the footer names the session, as before.
    assert.equal(handoverView(monday, new Date("2026-10-09T22:30:00.000Z"), false).date, "Mon Oct 12");
  });

  it("names the session's weekday and date, and passes a malformed date through", () => {
    assert.equal(sessionDateLabel("2026-09-24"), "Thu Sep 24");
    assert.equal(sessionDateLabel("2026-01-05"), "Mon Jan 5");
    assert.equal(sessionDateLabel("2026-13-01"), "2026-13-01");
    assert.equal(sessionDateLabel("soon"), "soon");
  });
});

describe("handover view: filings and insiders", () => {
  const SEC = "https://www.sec.gov/Archives/edgar/data/1/000000000126000001/doc.htm";
  const facts: BriefingFact[] = [
    { id: "f1", kind: "red_flag", flag: "restatement", ticker: "ACME", scope: "held", date: "2026-09-23", url: SEC, form: "8-K", name: null, previous: null },
    { id: "f2", kind: "insider", event: "purchase_cluster", ticker: "NVDA", scope: "held", date: "2026-09-23", url: SEC, form: "Form 4", insiders: 3, value_usd: 2_500_000, role: "ceo", filer: null, score: 72 },
    {
      id: "f3",
      kind: "linked_report",
      ticker: "NVDA",
      scope: "held",
      date: "2026-09-24",
      url: SEC,
      form: "10-K",
      counterparty: "TSM",
      relation: "supplier",
      time: "bmo",
      on_session: true,
      sample: 8,
      with_it: 6,
      avg_abs_move_pct: 2.1,
    },
    { id: "f4", kind: "risk_factor", ticker: "AMD", scope: "watchlist", date: "2026-09-22", url: SEC, form: "10-Q", count: 2, heading: "We depend on one foundry" },
    { id: "f5", kind: "red_flag", flag: "restatement", ticker: "BETA", scope: "held", date: "2026-09-23", url: SEC, form: "8-K", name: null, previous: null },
  ];

  it("adds a section between earnings and the rest, in the engine's order, one title per record", () => {
    const view = handoverView(
      makeReport({
        research_facts: { facts, unavailable: [] },
        stories: [story("m", "market", "Futures moved little.")],
        overnight: { markets: [], held_movers: [], held_news: [], filings: [filing("AAPL", "8-K 2.02 Results")], measurements: [] },
      }),
      MORNING,
      false,
    );
    assert.deepEqual(view.sections.map((s) => s.kind), ["earnings", "filings", "other"]);
    const section = view.sections.find((s) => s.kind === "filings")!;
    assert.equal(section.title, "Filings and insiders");
    assert.deepEqual(section.items.map((i) => i.ticker), ["ACME", "NVDA", "NVDA", "AMD", "BETA"]);
    assert.deepEqual(
      section.items.map((i) => i.summary),
      [
        "Past financial statements no longer to be relied on, 8-K Item 4.02",
        "3 insiders made open market purchases, $2.5M",
        "TSM, a supplier to NVDA, reports today, before the open · NVDA moved with it 6 of the last 8 times · average 2.1% on the day",
        "2 new risk factors in the 10-Q",
        "Past financial statements no longer to be relied on, 8-K Item 4.02",
      ],
    );
    for (const item of section.items) {
      assert.equal(item.url, SEC);
      assert.equal(item.detail, null);
      assert.equal(item.meaning, null);
    }
    assert.equal(section.items[3]!.hint, "“We depend on one foundry”\n10-Q filed Tue Sep 22\nOpen on SEC.gov");
    assert.equal(section.items[2]!.hint, "NVDA moved with it 6 of the last 8 times · average 2.1% on the day\nOpen the filing that links TSM and NVDA on SEC.gov");
  });

  it("gives the count and no figure for a pair measured fewer than three times, and says tomorrow for the next day", () => {
    const fact: BriefingFact = { ...(facts[2] as Extract<BriefingFact, { kind: "linked_report" }>), date: "2026-09-25", time: "amc", on_session: false, sample: 2, with_it: null, avg_abs_move_pct: null };
    const view = handoverView(makeReport({ research_facts: { facts: [fact], unavailable: [] } }), MORNING, false);
    assert.equal(view.sections[0]!.items[0]!.summary, "TSM, a supplier to NVDA, reports tomorrow, after the close · 2 past reports measured, too few for figures");
  });

  it("draws nothing for a report without them, and the popup is not empty with them alone", () => {
    assert.equal(handoverView(makeReport(), MORNING, false).empty, true);
    const view = handoverView(makeReport({ research_facts: { facts: [facts[0]!], unavailable: [] } }), MORNING, false);
    assert.equal(view.empty, false);
    assert.equal(handoverView(makeReport({ research_facts: { facts: [], unavailable: ["insiders"] } }), MORNING, false).empty, true);
  });

  it("words every kind without an empty placeholder", () => {
    const all: BriefingFact[] = [
      { id: "a", kind: "red_flag", flag: "auditor_name", ticker: "A", scope: "held", date: "2026-09-23", url: null, form: "10-K", name: "New LLP", previous: "Old LLP" },
      { id: "b", kind: "insider", event: "activist_13d", ticker: "B", scope: "held", date: "2026-09-23", url: null, form: "SC 13D", insiders: 0, value_usd: null, role: null, filer: "Holder LP", score: 60 },
      { id: "c", kind: "counterparty_named", role: "supplier", name: "Foundry Co", pct: null, ticker: "C", scope: "held", date: "2026-09-23", url: null, form: "10-K" },
      { id: "d", kind: "share_change", name: "Big Co", basis: "revenue", pct: 18, previous_pct: 11, ticker: "D", scope: "held", date: "2026-09-23", url: null, form: "10-K" },
      { id: "e", kind: "insider", event: "unplanned_sale", ticker: "E", scope: "held", date: "2026-09-23", url: null, form: "Form 4", insiders: 1, value_usd: null, role: "cfo", filer: null, score: 50 },
    ];
    const titles = all.map((f) => factTitle(f));
    assert.deepEqual(titles, [
      "Auditor changed from Old LLP to New LLP",
      "Holder LP filed a 13D",
      "Foundry Co named as a supplier for the first time in the 10-K",
      "Big Co: 18% of revenue, 11% the year before",
      "CFO sale outside a 10b5-1 plan",
    ]);
    for (const title of titles) assert.equal(/\{\w+\}/.test(title), false, title);
  });

  it("keeps every line and hover to the house copy rules: a record restated, no advice, nothing ahead", () => {
    const lines = [...facts.map((f) => factTitle(f, undefined, "2026-09-24")), ...facts.map((f) => factHint(f))];
    for (const line of lines) assert.deepEqual(copyProblems(JSON.stringify(line), { riskWords: true }), [], line);
  });
});
