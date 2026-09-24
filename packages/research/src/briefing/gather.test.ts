import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  CORPORATE_HORIZON_SESSIONS,
  EARNINGS_HORIZON_SESSIONS,
  REBALANCE_HORIZON_SESSIONS,
  RECENT_SPLIT_SESSIONS,
  gatherBriefing,
} from "./gather.js";
import { MARKET_SYMBOLS } from "./markets.js";
import { copyRuleFaults } from "./narrative.js";
import {
  FIXTURE_HELD,
  NOW,
  SHARED_ARTICLE_URL,
  fakePorts,
  fixtureCorporate,
  fixtureHoldings,
  fixtureMarketHeadlines,
  fixtureNews,
  fixtureQuote,
  fixtureRisk,
  fixtureSlice,
} from "./test-fixtures.js";
import { BRIEFING_SCHEMA_VERSION, type BriefingPorts, type BriefingReport, type BriefingRequest, type BriefingSectionKey } from "./types.js";

const REQUEST: BriefingRequest = { holdings: fixtureHoldings(), cash: 5000 };

/** En and em dash, built from code points so the file stays ASCII whatever writes it. */
const DASHES = new RegExp(`[${String.fromCharCode(0x2013, 0x2014)}]`);

/** A provider error as they come: a key and a URL inside the message. */
const SECRET = "sk-live-4f9a2 https://provider.example/v8/chart?token=abc";

function failing(): Promise<never> {
  return Promise.reject(new Error(SECRET));
}

function hanging(): Promise<never> {
  return new Promise<never>(() => {});
}

function build(when: string, overrides: Partial<BriefingPorts> = {}, request: BriefingRequest = REQUEST): Promise<BriefingReport> {
  const now = new Date(when);
  return gatherBriefing(request, now, fakePorts(overrides, { now }));
}

function assertFullShape(report: BriefingReport): void {
  assert.equal(report.schema_version, BRIEFING_SCHEMA_VERSION);
  assert.equal(typeof report.generated_at, "string");
  assert.equal(typeof report.window.target_session_ymd, "string");
  assert.equal(report.overnight.markets.length, MARKET_SYMBOLS.length);
  for (const key of ["held_movers", "held_news", "filings", "measurements"] as const) assert.ok(Array.isArray(report.overnight[key]), key);
  assert.ok(Array.isArray(report.held_coverage));
  assert.equal(typeof report.book.equity_usd, "number");
  assert.ok(report.risk === null || typeof report.risk.matches_book === "boolean");
  assert.ok(Array.isArray(report.earnings_next));
  assert.ok(Array.isArray(report.corporate_events));
  assert.equal(typeof report.corporate_coverage.dividends, "string");
  assert.equal(typeof report.corporate_coverage.splits, "string");
  assert.ok(Array.isArray(report.calendar_today));
  assert.equal(typeof report.calendar_coverage.covers_target, "boolean");
  assert.ok(report.narrative.text.length > 0);
  assert.equal(report.narrative.source, "template");
  assert.equal(report.narrative.facts_hash, report.facts_hash);
  assert.ok(Array.isArray(report.implications) && report.implications.length <= 5);
  assert.ok(Array.isArray(report.headlines));
  assert.ok(Array.isArray(report.stories) && report.stories.length <= 6);
  for (const s of report.stories) assert.equal(s.source, "template");
  assert.ok(Array.isArray(report.degraded));
}

function sections(report: BriefingReport): BriefingSectionKey[] {
  return report.degraded.map((d) => d.section);
}

/** Every string a reader can meet that this module (or a module under it) wrote. */
function userFacingStrings(report: BriefingReport): string[] {
  return [
    ...report.corporate_events.flatMap((e) => [e.title, e.detail]),
    report.corporate_coverage.dividends,
    report.corporate_coverage.splits,
    ...report.calendar_today.flatMap((c) => [c.title, c.detail ?? ""]),
    ...report.overnight.measurements.map((m) => m.detail),
    ...report.overnight.filings.map((f) => f.label),
    ...report.implications.flatMap((i) => [i.headline, i.because, i.scenario ?? ""]),
    ...report.stories.flatMap((s) => [s.what, s.reaction, s.meaning ?? ""]),
    report.narrative.text,
  ].filter((s) => s !== "");
}

describe("briefing/gather: the full report", () => {
  it("fills every section from coherent ports, with nothing degraded", async () => {
    const report = await build(NOW);
    assertFullShape(report);
    assert.deepEqual(report.degraded, []);
    assert.equal(report.generated_at, NOW);
    assert.equal(report.demo, false);
    assert.equal(report.synthetic_now, false);
    assert.equal(report.window.target_session_ymd, "2026-09-21");
    assert.equal(report.window.phase, "pre_open");
    assert.equal(report.window.handover, "weekend");

    assert.deepEqual(report.overnight.markets.map((r) => r.symbol), MARKET_SYMBOLS.map((d) => d.symbol));
    assert.deepEqual(report.overnight.held_movers.map((m) => m.ticker), ["NVDA", "AAPL", "SPY", "IWM"]);
    assert.equal(report.overnight.held_movers[0]!.basis, "since_close");
    assert.equal(report.overnight.held_movers[0]!.move_z, 0.71);

    assert.deepEqual(report.held_coverage, [
      { ticker: "NVDA", coverage: "tracked" },
      { ticker: "AAPL", coverage: "tracked" },
      { ticker: "SPY", coverage: "price_only" },
      { ticker: "IWM", coverage: "price_only" },
    ]);
    assert.equal(report.book.position_count, 4);
    assert.equal(report.book.cash_usd, 5000);
    assert.deepEqual(report.book.unpriced, []);
    assert.equal(report.book.priced_at, NOW);
    assert.equal(report.risk?.matches_book, true);
    assert.equal(report.risk?.score, 58);

    assert.equal(report.overnight.filings.length, 1);
    assert.equal(report.overnight.measurements.length, 1);
    assert.equal(report.headlines.length, 3);
    assert.equal(report.stories.length, 3);
    assert.equal(report.narrative.pending, false);
    assert.equal(report.narrative.reason, null);
    assert.equal(report.calendar_coverage.covers_target, true);
  });

  it("withholds the move of a market whose last print predates the US close", async () => {
    const report = await build(NOW);
    const nikkei = report.overnight.markets.find((r) => r.symbol === "^N225")!;
    assert.equal(nikkei.state, "stale");
    assert.equal(nikkei.move, null);
    assert.equal(nikkei.last, 38250.1);
    // A stale lead row stays out of the paragraph too.
    assert.ok(!report.narrative.text.includes("Nikkei"));
    const es = report.overnight.markets.find((r) => r.symbol === "ES=F")!;
    assert.equal(es.state, "live");
    assert.equal(es.move, 0.42);
  });

  it("leads with the conclusions its own figures support, and the paragraph leads with them too", async () => {
    const report = await build(NOW);
    // NVDA is 22% of the book and reports in three sessions: two normal days
    // of 2.9% on it is 1.28% of the book, more than the 0.38% the futures
    // imply, so it leads. SPY is 35% of the invested book.
    assert.deepEqual(report.implications.map((i) => i.id), ["earnings_exposure:NVDA", "open_indication:book", "concentration:SPY"]);
    const open = report.implications[1]!;
    assert.equal(open.headline, "Overnight futures point to a rise of about 0.38% for the book at the open.");
    assert.equal(open.because, "S&P 500 futures are up 0.42% since the close, and the book moves about 0.91% for each 1% the index moves.");
    const earnings = report.implications[0]!;
    // Two normal days on the name's own value: 2 x 2.9% x 40 x 118.40.
    assert.equal(earnings.scenario_usd, 274.69);
    // The lead is the first story and the calendar; the open indication is the
    // tape story's meaning rather than a sentence of its own.
    assert.deepEqual(report.stories.map((s) => s.id), ["story:name:NVDA", "story:name:AAPL", "story:market:tape"]);
    assert.equal(report.stories[0]!.what, "NVDA is in the news since the close (2 headlines)");
    assert.equal(report.stories[0]!.reaction, "NVDA is up 2.07% since the close, 0.7 times its normal day");
    assert.ok(report.narrative.text.startsWith("NVDA is in the news since the close (2 headlines) and is up 2.07%, 0.7 times its normal day. "), report.narrative.text);
    assert.equal(report.stories[2]!.meaning, open.headline);
    assert.equal(report.stories[2]!.what, "Over the weekend, the tape has 3 market headlines");
    assert.ok(!report.narrative.text.includes("Overnight markets show"));
  });

  it("puts the missing futures first, and keeps the market sentence, when the open cannot be sized", async () => {
    const report = await build(NOW, { marketSnapshot: failing });
    assert.equal(report.implications[0]?.id, "data_gap:futures");
    assert.equal(report.implications[0]?.headline, "US futures could not be read for this report, so the open cannot be sized from them.");
    assert.ok(!report.implications.some((i) => i.kind === "open_indication"));
    // No US contract printed, so there is no tape to tell a story about; the held names lead.
    assert.ok(!report.stories.some((s) => s.scope === "market"));
    assert.ok(report.narrative.text.startsWith("NVDA is in the news since the close"), report.narrative.text);
  });

  it("gives the same report for the same inputs", async () => {
    assert.deepEqual(await build(NOW), await build(NOW));
  });

  it("measures from the prior close once the session is open", async () => {
    const report = await build("2026-09-21T15:00:00.000Z");
    assert.equal(report.window.phase, "in_session");
    assert.ok(report.overnight.held_movers.every((m) => m.basis === "today"));
  });

  it("carries the demo and developer-clock flags, and a demo book never waits for a model", async () => {
    const now = new Date(NOW);
    const demo = await gatherBriefing({ ...REQUEST, demo: true }, now, fakePorts({}, { now }), { syntheticNow: true, narrativePending: true });
    assert.equal(demo.demo, true);
    assert.equal(demo.synthetic_now, true);
    assert.equal(demo.narrative.pending, false);

    const real = await gatherBriefing(REQUEST, now, fakePorts({}, { now }), { narrativePending: true });
    assert.equal(real.narrative.pending, true);
    assert.equal(real.narrative.source, "template");
  });

  it("writes every string of its own inside the copy rules, and no dollar sign into the narrative", async () => {
    const whens = [NOW, "2026-10-28T12:00:00.000Z", "2026-11-27T12:30:00.000Z", "2026-12-18T12:00:00.000Z", "2027-05-04T12:00:00.000Z"];
    for (const when of whens) {
      const now = new Date(when);
      const report = await build(when, {
        chainSlice: async (ticker) =>
          fixtureSlice(ticker, now, ticker === "NVDA" ? { news: [fixtureNews("NVDA", now, { headline: "NVDA unveils $3B buyback", band: "P0" })] } : {}),
        corporateCalendar: async (symbol) =>
          fixtureCorporate(
            symbol,
            now,
            symbol === "SPY"
              ? { recent_dividends: [{ date: targetOf(now), amount: 1.7461 }] }
              : symbol === "NVDA"
                ? { recent_splits: [{ date: targetOf(now), numerator: 10, denominator: 1 }] }
                : {},
          ),
      });
      for (const text of userFacingStrings(report)) assert.deepEqual(copyRuleFaults(text), [], `${when}: ${text}`);
      // Third-party text is counted and named by id, never repeated in a sentence.
      for (const h of report.headlines) for (const text of userFacingStrings(report)) assert.ok(!text.includes(h.title), text);
      for (const n of report.overnight.held_news) for (const text of userFacingStrings(report)) assert.ok(!text.includes(n.headline), text);
      assert.ok(!report.narrative.text.includes("$"), report.narrative.text);
      for (const i of report.implications) assert.ok(![i.headline, i.because, i.scenario ?? ""].join(" ").includes("$"), i.id);
      assert.ok(!DASHES.test(JSON.stringify(userFacingStrings(report))));
    }
  });
});

describe("briefing/gather: market headlines and stories", () => {
  it("reads the headlines through the port since the close, one per article, newest first, and caps twelve", async () => {
    const now = new Date(NOW);
    const since = Date.parse("2026-09-18T20:00:00.000Z");
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `h${i}`,
      title: `Headline ${i}`,
      source: "wire",
      url: `https://news.example.com/story-${i}?utm_source=x`,
      published_at: new Date(since + (i + 1) * 3_600_000).toISOString(),
      related: ["SPY"],
      via: "SPY",
    }));
    const report = await build(NOW, {
      marketNews: async () => [
        ...many,
        // The same article again, from another query symbol: folded in, its tag kept.
        { ...many[14]!, id: "dup", url: "https://news.example.com/story-14", related: ["QQQ"], via: "QQQ" },
        // Before the close, unreadable date, no usable link: all dropped.
        { ...many[0]!, id: "old", url: "https://news.example.com/old", published_at: "2026-09-18T15:00:00.000Z" },
        { ...many[0]!, id: "undated", url: "https://news.example.com/undated", published_at: "yesterday" },
        { ...many[0]!, id: "nolink", url: "javascript:alert(1)" },
      ],
    });
    assert.deepEqual(report.degraded, []);
    assert.equal(report.headlines.length, 12);
    assert.deepEqual(report.headlines.slice(0, 3).map((h) => h.id), ["h14", "h13", "h12"]);
    assert.deepEqual(report.headlines[0]!.related, ["SPY", "QQQ"]);
    assert.ok(report.headlines.every((h) => Date.parse(h.published_at) >= since));
    assert.ok(!JSON.stringify(report.headlines).includes("javascript:"));
    assert.equal(report.stories.find((s) => s.id === "story:market:tape")?.what, "Over the weekend, the tape has 12 market headlines");
    assert.ok(report.stories.find((s) => s.id === "story:market:tape")!.evidence.includes("h14"));
    void now;
  });

  it("keys the facts hash on the headline ids, so a new article regenerates and a retitled one does not", async () => {
    const one = fixtureMarketHeadlines(new Date(NOW))[0]!;
    const base = await build(NOW, { marketNews: async () => [one] });
    const retitled = await build(NOW, { marketNews: async () => [{ ...one, title: "The same article, retitled by the desk" }] });
    const another = await build(NOW, { marketNews: async () => [one, { ...one, id: "new", url: "https://example.com/markets/another" }] });
    assert.equal(retitled.facts_hash, base.facts_hash);
    assert.notEqual(another.facts_hash, base.facts_hash);
  });

  it("tells the tape as quiet when the port answers with nothing, and the stories stay template", async () => {
    const report = await build(NOW, { marketNews: async () => [] });
    assert.deepEqual(report.degraded, []);
    assert.deepEqual(report.headlines, []);
    const tape = report.stories.find((s) => s.id === "story:market:tape")!;
    assert.equal(tape.what, "Over the weekend, the tape is quiet: no market headline since the close");
    assert.equal(tape.reaction, "S&P 500 futures are up 0.42% and Nasdaq-100 futures up 0.61% since the close; VIX down 0.55 pts at 16.85");
    assert.ok(report.stories.every((s) => s.source === "template"));
  });
});

/** The target session of a fixture clock, for payloads that must land on it. */
function targetOf(now: Date): string {
  const hourUtc = now.getUTCHours();
  // Every clock used in this file is a weekday morning before the close.
  assert.ok(hourUtc < 20);
  return now.toISOString().slice(0, 10);
}

describe("briefing/gather: news across held names", () => {
  it("lists a shared article once and names the other holding", async () => {
    const report = await build(NOW);
    const shared = report.overnight.held_news.filter((n) => n.url === SHARED_ARTICLE_URL);
    assert.equal(shared.length, 1);
    assert.equal(shared[0]!.ticker, "NVDA");
    assert.deepEqual(shared[0]!.also, ["AAPL"]);
    // Band first, then recency.
    assert.deepEqual(report.overnight.held_news.map((n) => n.band), ["P1", "P2"]);
  });

  it("matches copies through tracking parameters, keeps the more urgent one, and falls back to the headline", async () => {
    const now = new Date(NOW);
    const report = await build(NOW, {
      chainSlice: async (ticker) => {
        if (ticker === "NVDA") {
          return fixtureSlice(ticker, now, {
            news: [
              fixtureNews("NVDA", now, { url: "https://www.example.com/story/?utm_source=feed", band: "P3", headline: "Story" }),
              fixtureNews("NVDA", now, { url: "", headline: "Wire item with  no link", band: "P2" }),
            ],
          });
        }
        if (ticker === "AAPL") {
          return fixtureSlice(ticker, now, {
            news: [
              fixtureNews("AAPL", now, { url: "https://example.com/story", band: "P1", headline: "Story" }),
              fixtureNews("AAPL", now, { url: "", headline: "wire item with no link", band: "P2" }),
            ],
          });
        }
        return fixtureSlice(ticker, now);
      },
    });
    assert.deepEqual(
      report.overnight.held_news.map((n) => [n.ticker, n.also, n.band]),
      [
        ["AAPL", ["NVDA"], "P1"],
        ["NVDA", ["AAPL"], "P2"],
      ],
    );
  });

  it("caps each overnight list at twelve, most urgent and most recent first", async () => {
    const now = new Date(NOW);
    const report = await build(NOW, {
      chainSlice: async (ticker) =>
        fixtureSlice(ticker, now, {
          news: Array.from({ length: 8 }, (_, i) =>
            fixtureNews(ticker, now, {
              url: `https://example.com/${ticker}/${i}`,
              headline: `${ticker} item ${i}`,
              band: i === 7 ? "P0" : "P3",
              published_at: new Date(now.getTime() - i * 60_000).toISOString(),
            }),
          ),
          filings: Array.from({ length: 5 }, (_, i) => ({
            ticker,
            kind: "filing" as const,
            label: "8-K",
            filed_at: new Date(now.getTime() - i * 60_000).toISOString(),
            url: `https://www.sec.gov/${ticker}/${i}`,
          })),
        }),
    });
    assert.equal(report.overnight.held_news.length, 12);
    assert.deepEqual(report.overnight.held_news.slice(0, 4).map((n) => n.band), ["P0", "P0", "P0", "P0"]);
    assert.equal(report.overnight.filings.length, 12);
    const times = report.overnight.filings.map((f) => Date.parse(f.filed_at));
    assert.deepEqual(times, [...times].sort((a, b) => b - a));
  });

  it("counts a name's headlines from the whole night, so the cap never reads as an absence", async () => {
    const now = new Date(NOW);
    // NVDA moves far enough for the report to draw a conclusion about it, and
    // that conclusion's evidence clause is where the count is spoken.
    const clause = async (crowd: number): Promise<string> => {
      const report = await build(NOW, {
        heldQuote: async (symbol) => fixtureQuote(symbol, now, symbol === "NVDA" ? { price: 128 } : {}),
        chainSlice: async (ticker) => {
          if (ticker === "NVDA") {
            return fixtureSlice(ticker, now, {
              coverage: "tracked",
              news: Array.from({ length: 2 }, (_, i) =>
                fixtureNews("NVDA", now, { url: `https://example.com/nvda/${i}`, headline: `NVDA item ${i}`, band: "P3" }),
              ),
            });
          }
          if (ticker === "AAPL") {
            return fixtureSlice(ticker, now, {
              coverage: "tracked",
              news: Array.from({ length: crowd }, (_, i) =>
                fixtureNews("AAPL", now, { url: `https://example.com/aapl/${i}`, headline: `AAPL item ${i}`, band: "P0" }),
              ),
            });
          }
          return fixtureSlice(ticker, now);
        },
      });
      return report.implications.find((i) => i.id === "name_specific:NVDA")?.because ?? "";
    };

    assert.ok((await clause(0)).endsWith("and the report lists 2 headlines on NVDA since the close."), await clause(0));
    // Twelve P0 items about another name fill the list and NVDA's own two are
    // cut from it; the night still had them, and the sentence says so.
    assert.ok((await clause(12)).endsWith("and 2 headlines on NVDA came out since the close, none of them in this report."), await clause(12));
  });
});

describe("briefing/gather: one failing input costs one section", () => {
  const cases: Array<{ port: keyof BriefingPorts; section: BriefingSectionKey; check: (r: BriefingReport) => void }> = [
    {
      port: "marketSnapshot",
      section: "markets",
      check: (r) => {
        assert.ok(r.overnight.markets.every((row) => row.state === "unavailable"));
        assert.ok(!r.stories.some((s) => s.scope === "market"));
        assert.equal(r.overnight.held_movers.length, 4);
      },
    },
    {
      port: "heldQuote",
      section: "held_quotes",
      check: (r) => {
        assert.deepEqual(r.overnight.held_movers, []);
        assert.deepEqual(r.book.unpriced, ["NVDA", "AAPL", "SPY", "IWM"]);
        assert.equal(r.book.overnight_pnl_usd, null);
        assert.equal(r.book.position_count, 4);
      },
    },
    {
      port: "quant",
      section: "quant",
      check: (r) => {
        assert.equal(r.overnight.held_movers.length, 4);
        assert.ok(r.overnight.held_movers.every((m) => m.move_z === null));
      },
    },
    {
      port: "chainSlice",
      section: "chain_news",
      check: (r) => {
        assert.deepEqual(r.overnight.held_news, []);
        assert.ok(r.held_coverage.every((c) => c.coverage === "pending"));
        // The provider calendar still supplies earnings dates.
        assert.deepEqual(r.earnings_next.map((e) => [e.ticker, e.source]), [["NVDA", "yahoo"], ["AAPL", "yahoo"]]);
      },
    },
    {
      port: "riskLatest",
      section: "risk",
      check: (r) => {
        assert.equal(r.risk, null);
        assert.ok(!r.narrative.text.includes("Book risk"));
      },
    },
    {
      port: "marketNews",
      section: "market_news",
      check: (r) => {
        assert.deepEqual(r.headlines, []);
        // A failed feed is said to be one; the tape is not called quiet.
        assert.equal(r.stories.find((s) => s.id === "story:market:tape")?.what, "Over the weekend, the market headlines could not be read for this report");
      },
    },
    {
      port: "corporateCalendar",
      section: "corporate_actions",
      check: (r) => {
        assert.deepEqual(r.corporate_coverage.unknown_symbols, ["NVDA", "AAPL", "SPY", "IWM"]);
        assert.ok(!r.corporate_events.some((e) => e.kind === "dividend"));
        // The chain still supplies the confirmed earnings date.
        assert.deepEqual(r.earnings_next.map((e) => e.ticker), ["NVDA"]);
      },
    },
    {
      port: "calendarOverlay",
      section: "macro_calendar",
      check: (r) => {
        assert.equal(r.calendar_coverage.covers_target, true);
        assert.equal(r.calendar_coverage.until, "2026-12-31");
      },
    },
  ];

  for (const { port, section, check } of cases) {
    it(`${port} rejecting leaves a full report with "${section}" degraded`, async () => {
      const report = await build(NOW, { [port]: failing } as Partial<BriefingPorts>);
      assertFullShape(report);
      assert.deepEqual(report.degraded, [{ section, detail: "request failed" }]);
      check(report);
      // The provider's own words never reach the report.
      assert.ok(!JSON.stringify(report).includes("sk-live"));
      assert.ok(!JSON.stringify(report).includes("provider.example"));
    });
  }

  it("names the symbols when only some calls of a section fail", async () => {
    const now = new Date(NOW);
    const report = await build(NOW, {
      heldQuote: (symbol) => (symbol === "AAPL" ? failing() : Promise.resolve(fixtureQuote(symbol, now))),
      marketSnapshot: (symbol) => (symbol === "^FTSE" || symbol === "GC=F" ? failing() : fakePorts({}, { now }).marketSnapshot(symbol)),
    });
    assert.deepEqual(report.degraded, [
      { section: "markets", detail: "request failed", symbols: ["^FTSE", "GC=F"] },
      { section: "held_quotes", detail: "request failed", symbols: ["AAPL"] },
    ]);
    assert.deepEqual(report.book.unpriced, ["AAPL"]);
    assert.equal(report.overnight.markets.find((r) => r.symbol === "^FTSE")!.state, "unavailable");
    assert.equal(report.overnight.markets.find((r) => r.symbol === "^FCHI")!.state, "live");
  });

  it("survives every port failing at once", async () => {
    const report = await build(NOW, {
      marketSnapshot: failing,
      heldQuote: failing,
      quant: failing,
      chainSlice: failing,
      riskLatest: failing,
      marketNews: failing,
      corporateCalendar: failing,
      calendarOverlay: failing,
    });
    assertFullShape(report);
    assert.deepEqual(sections(report), ["markets", "held_quotes", "chain_news", "market_news", "quant", "risk", "corporate_actions", "macro_calendar"]);
    // The date rules need no port: the schedule still stands.
    assert.equal(report.calendar_coverage.covers_target, true);
  });

  it("treats a port that throws before returning a promise, or answers with nonsense, as a failed call", async () => {
    const report = await build(NOW, {
      heldQuote: (() => {
        throw new Error(SECRET);
      }) as BriefingPorts["heldQuote"],
      chainSlice: (async () => "nope") as unknown as BriefingPorts["chainSlice"],
      riskLatest: (async () => 7) as unknown as BriefingPorts["riskLatest"],
      corporateCalendar: (async () => null) as unknown as BriefingPorts["corporateCalendar"],
    });
    assertFullShape(report);
    assert.deepEqual(report.degraded, [
      { section: "held_quotes", detail: "request failed" },
      { section: "chain_news", detail: "unusable response" },
      { section: "risk", detail: "unusable response" },
      { section: "corporate_actions", detail: "unusable response" },
    ]);
  });

  it("tolerates a slice whose lists are missing", async () => {
    const report = await build(NOW, {
      chainSlice: (async (ticker: string) => ({ ticker, coverage: "tracked" })) as unknown as BriefingPorts["chainSlice"],
    });
    assertFullShape(report);
    assert.deepEqual(report.degraded, []);
    assert.deepEqual(report.overnight.held_news, []);
    assert.ok(report.held_coverage.every((c) => c.coverage === "tracked"));
  });

  it("returns an empty, fully marked report when it is handed no ports at all", async () => {
    const report = await gatherBriefing(REQUEST, new Date(NOW), null as unknown as BriefingPorts);
    assertFullShape(report);
    assert.ok(report.degraded.length >= 7);
    assert.ok(report.degraded.every((d) => d.detail === "assembly failed"));
    assert.equal(report.window.target_session_ymd, "2026-09-21");
    assert.deepEqual(report.implications, []);
  });

  it("answers an unreadable clock with a marked report instead of throwing, and calls nothing", async () => {
    let calls = 0;
    const counting = new Proxy(fakePorts(), {
      get: (target, key) => (...args: unknown[]) => {
        calls += 1;
        return (target as unknown as Record<string | symbol, (...a: unknown[]) => unknown>)[key]!(...args);
      },
    });
    const report = await gatherBriefing(REQUEST, new Date("not a clock"), counting);
    assertFullShape(report);
    assert.equal(calls, 0);
    assert.ok(report.degraded.every((d) => d.detail === "invalid clock"));
    assert.deepEqual(report.overnight.held_movers, []);
    assert.deepEqual(report.implications, []);
  });

  it("does not reject on a valid Date the session calendar cannot resolve", async () => {
    // The far ends of the Date range are valid instants, and Intl still throws
    // on the calendar arithmetic around them.
    for (const ms of [8.64e15, -8.64e15]) {
      const report = await gatherBriefing(REQUEST, new Date(ms), fakePorts());
      assertFullShape(report);
      assert.ok(report.degraded.length >= 7);
      assert.ok(report.degraded.every((d) => d.detail === "invalid clock"));
    }
  });
});

describe("briefing/gather: time limits", () => {
  it("gives up on a hanging call after the per-call timeout", async () => {
    const now = new Date(NOW);
    const report = await gatherBriefing(
      REQUEST,
      now,
      fakePorts({ heldQuote: (symbol) => (symbol === "NVDA" ? hanging() : Promise.resolve(fixtureQuote(symbol, now))) }, { now }),
      { perCallTimeoutMs: 25 },
    );
    assertFullShape(report);
    assert.deepEqual(report.degraded, [{ section: "held_quotes", detail: "timed out", symbols: ["NVDA"] }]);
    assert.deepEqual(report.book.unpriced, ["NVDA"]);
  });

  it("stops starting calls once the deadline has passed", async () => {
    const now = new Date(NOW);
    let started = 0;
    const report = await gatherBriefing(
      REQUEST,
      now,
      fakePorts(
        {
          marketSnapshot: () => {
            started += 1;
            return hanging();
          },
        },
        { now },
      ),
      { perCallTimeoutMs: 60_000, deadlineMs: 40, concurrency: 4 },
    );
    assertFullShape(report);
    assert.deepEqual(report.degraded, [{ section: "markets", detail: "deadline reached" }]);
    assert.equal(started, 4);
    assert.equal(report.overnight.held_movers.length, 4);
  });

  it("keeps the calls in flight per section within the limit", async () => {
    const now = new Date(NOW);
    const inFlight = { quote: 0, chain: 0 };
    const peak = { quote: 0, chain: 0 };
    const tracked = <T>(key: "quote" | "chain", value: T): Promise<T> => {
      inFlight[key] += 1;
      peak[key] = Math.max(peak[key], inFlight[key]);
      return new Promise((resolve) =>
        setTimeout(() => {
          inFlight[key] -= 1;
          resolve(value);
        }, 5),
      );
    };
    const symbols = ["A", "B", "C", "D", "E", "F", "G", "H", "I"];
    const report = await gatherBriefing(
      { holdings: symbols.map((symbol) => ({ symbol, shares: 1, cost_usd: 10 })), cash: 0 },
      now,
      fakePorts(
        {
          heldQuote: (symbol) => tracked("quote", fixtureQuote(symbol, now)),
          chainSlice: (ticker) => tracked("chain", fixtureSlice(ticker, now)),
        },
        { now },
      ),
      { concurrency: 5 },
    );
    assert.equal(report.overnight.held_movers.length, symbols.length);
    assert.equal(peak.quote, 5);
    // The chain port is capped lower than the rest whatever the option says.
    assert.equal(peak.chain, 3);
  });
});

describe("briefing/gather: holdings", () => {
  it("drops a symbol that is not shaped like one, reports it, and never shows it to a port", async () => {
    const now = new Date(NOW);
    const seen: string[] = [];
    const base = fakePorts({}, { now });
    const report = await gatherBriefing(
      {
        cash: 100,
        holdings: [
          { symbol: " nvda ", shares: 10, cost_usd: 1000 },
          { symbol: "NVDA", shares: 5, cost_usd: 500 },
          { symbol: "AAPL/../../etc", shares: 1, cost_usd: 1 },
          { symbol: "https://evil.example/?q=", shares: 1, cost_usd: 1 },
          { symbol: "", shares: 1, cost_usd: 1 },
          { symbol: 42 as unknown as string, shares: 1, cost_usd: 1 },
          { symbol: "BRK.B", shares: 2, cost_usd: 900 },
          { symbol: "MSFT", shares: 0, cost_usd: 0 },
        ],
      },
      now,
      {
        ...base,
        heldQuote: (s) => (seen.push(s), base.heldQuote(s)),
        quant: (s) => (seen.push(s), base.quant(s)),
        chainSlice: (s, held, since) => (seen.push(s, ...held), base.chainSlice(s, held, since)),
        corporateCalendar: (s) => (seen.push(s), base.corporateCalendar(s)),
      },
    );
    assert.deepEqual([...new Set(seen)].sort(), ["BRK.B", "NVDA"]);
    assert.equal(report.book.position_count, 2);
    assert.deepEqual(report.held_coverage.map((c) => c.ticker), ["NVDA", "BRK.B"]);
    assert.deepEqual(report.degraded, [
      { section: "held_quotes", detail: "invalid symbol dropped", symbols: ["AAPL....ETC", "HTTPSEVIL.EX", "?"] },
    ]);
    // Two lots of one name are one position.
    assert.equal(report.overnight.held_movers.find((m) => m.ticker === "NVDA")!.pnl_usd, 36);
  });

  it("builds an empty book from no holdings", async () => {
    const report = await build(NOW, {}, { holdings: [], cash: 2500 });
    assertFullShape(report);
    assert.deepEqual(report.degraded, []);
    assert.equal(report.book.position_count, 0);
    assert.equal(report.book.equity_usd, 2500);
    assert.equal(report.book.overnight_pnl_usd, null);
    assert.deepEqual(report.book.top_weights, []);
    assert.deepEqual(report.overnight.held_movers, []);
    assert.deepEqual(report.held_coverage, []);
    assert.deepEqual(report.earnings_next, []);
    // A risk snapshot over somebody's positions cannot describe an empty book.
    assert.equal(report.risk?.matches_book, false);
    assert.equal(report.overnight.markets.length, MARKET_SYMBOLS.length);
    // No book, nothing to conclude about it.
    assert.deepEqual(report.implications, []);
  });

  it("does not throw on a request that is not a request", async () => {
    for (const bad of [null, undefined, 7, { holdings: "NVDA", cash: "lots" }, { holdings: [null, 3, {}] }]) {
      const report = await gatherBriefing(bad as unknown as BriefingRequest, new Date(NOW), fakePorts());
      assertFullShape(report);
      assert.equal(report.book.position_count, 0);
      assert.equal(report.book.cash_usd, 0);
    }
  });
});

describe("briefing/gather: risk", () => {
  it("keeps the figures but marks them as another book's when the tickers differ", async () => {
    const now = new Date(NOW);
    const bookBetaSentence = (report: BriefingReport): string =>
      report.implications.find((i) => i.kind === "open_indication")?.because ?? "";
    for (const tickers of [["NVDA", "AAPL", "SPY"], [...FIXTURE_HELD, "MSFT"], ["TSLA"], []]) {
      const report = await gatherBriefing(REQUEST, now, fakePorts({}, { now, riskTickers: tickers }));
      assert.equal(report.risk?.matches_book, false, tickers.join(","));
      assert.equal(report.risk?.score, 58);
      assert.ok(!report.narrative.text.includes("Book risk"));
      // Another book's beta does not size this one; the held names' own betas do.
      assert.ok(bookBetaSentence(report).includes("moves about 0.96% for each 1%"), bookBetaSentence(report));
    }
    const same = await gatherBriefing(REQUEST, now, fakePorts({}, { now, riskTickers: ["iwm", " spy", "AAPL", "NVDA"] }));
    assert.equal(same.risk?.matches_book, true);
    assert.ok(bookBetaSentence(same).includes("moves about 0.91% for each 1%"), bookBetaSentence(same));
  });

  it("marks a snapshot from before the last close as another book's", async () => {
    const now = new Date(NOW);
    const at = async (computed_at: string): Promise<BriefingReport> =>
      gatherBriefing(REQUEST, now, fakePorts({ riskLatest: async () => fixtureRisk(now, { computed_at }) }, { now }));

    // The host recomputes on its own schedule, so the snapshot on hand can be
    // the one from before the close this report measures from: it describes
    // the book as it stood in a session that has ended.
    const stale = await at("2026-09-18T19:00:00.000Z");
    assert.equal(stale.risk?.matches_book, false);
    assert.equal(stale.risk?.score, 58);
    const fresh = await at("2026-09-18T20:00:00.000Z");
    assert.equal(fresh.risk?.matches_book, true);
    for (const unreadable of ["", "the other day"]) {
      assert.equal((await at(unreadable)).risk?.matches_book, false, unreadable);
    }
  });

  it("reports no risk, and nothing degraded, when the engine has no snapshot yet", async () => {
    const report = await build(NOW, { riskLatest: async () => null });
    assert.equal(report.risk, null);
    assert.deepEqual(report.degraded, []);
  });
});

describe("briefing/gather: earnings", () => {
  it("prefers the chain's announced date and falls back to the provider calendar", async () => {
    const report = await build(NOW);
    assert.deepEqual(report.earnings_next, [
      { ticker: "NVDA", due_ymd: "2026-09-24", timing: "amc_or_unspecified", sessions_until: 3, fiscal_period: "Q3 2026", confirmed: true, source: "tracker" },
      { ticker: "AAPL", due_ymd: "2026-10-01", timing: "amc_or_unspecified", sessions_until: 8, fiscal_period: null, confirmed: false, source: "yahoo" },
    ]);
    const mirrored = report.corporate_events.filter((e) => e.kind === "earnings");
    assert.deepEqual(mirrored.map((e) => [e.id, e.certainty, e.source, e.sessions_until]), [
      ["earn:NVDA:2026-09-24", "confirmed", "tracker", 3],
      ["earn:AAPL:2026-10-01", "estimated", "yahoo_calendar", 8],
    ]);
  });

  it("reads the Tracker's 12:00Z marker as before the open, keeps the nearest date, and lists a report due this session", async () => {
    const now = new Date(NOW);
    const report = await build(NOW, {
      chainSlice: async (ticker) =>
        fixtureSlice(ticker, now, {
          scheduled_earnings:
            ticker === "AAPL"
              ? [
                  { due_at: "2026-10-02T20:00:00.000Z", confirmed: true, fiscal_period: "Q4 2026" },
                  { due_at: "2026-09-21T12:00:00.000Z", confirmed: true, fiscal_period: "Q3 2026" },
                  { due_at: "garbage", confirmed: true, fiscal_period: null },
                ]
              : [],
        }),
      corporateCalendar: async (symbol) => fixtureCorporate(symbol, now, { earnings_dates: [] }),
    });
    assert.deepEqual(report.earnings_next, [
      { ticker: "AAPL", due_ymd: "2026-09-21", timing: "bmo", sessions_until: 0, fiscal_period: "Q3 2026", confirmed: true, source: "tracker" },
    ]);
    const item = report.calendar_today.find((c) => c.kind === "earnings")!;
    assert.deepEqual(item, {
      id: "earn:AAPL:2026-09-21",
      kind: "earnings",
      time_et: null,
      at: null,
      title: "AAPL earnings report",
      detail: "Before the open.",
      importance: 3,
      tickers: ["AAPL"],
      source: "tracker",
    });
    assert.ok(report.narrative.text.includes("earnings from AAPL"));
  });

  it("looks no further than the horizon and never behind the target session", async () => {
    const now = new Date(NOW);
    const report = await build(NOW, {
      chainSlice: async (ticker) => fixtureSlice(ticker, now, { scheduled_earnings: [{ due_at: "2026-09-18T20:00:00.000Z", confirmed: true, fiscal_period: "Q2 2026" }] }),
      // 2026-10-05 is the tenth session after 09-21; 10-06 is the eleventh.
      corporateCalendar: async (symbol) =>
        fixtureCorporate(symbol, now, { available: true, earnings_dates: symbol === "NVDA" ? ["2026-10-06"] : symbol === "AAPL" ? ["2026-10-05", "bad"] : [], earnings_estimated: false }),
    });
    assert.equal(EARNINGS_HORIZON_SESSIONS, 10);
    assert.deepEqual(report.earnings_next.map((e) => [e.ticker, e.due_ymd, e.sessions_until, e.confirmed]), [["AAPL", "2026-10-05", 10, true]]);
  });
});

describe("briefing/gather: corporate events", () => {
  it("lists an upcoming ex-dividend date and ignores one that has passed or lies past the horizon", async () => {
    const now = new Date(NOW);
    assert.equal(CORPORATE_HORIZON_SESSIONS, 10);
    const report = await build(NOW, {
      corporateCalendar: async (symbol) =>
        fixtureCorporate(symbol, now, {
          available: true,
          earnings_dates: [],
          ex_dividend_date: { NVDA: "2026-09-10", AAPL: "2026-09-25", SPY: "2026-10-06", IWM: "2026-09-21" }[symbol] ?? null,
          dividend_rate: symbol === "AAPL" ? 1.04 : null,
        }),
    });
    const dividends = report.corporate_events.filter((e) => e.kind === "dividend");
    assert.deepEqual(dividends.map((e) => [e.id, e.sessions_until, e.certainty, e.source]), [
      ["div:IWM:2026-09-21", 0, "confirmed", "yahoo_calendar"],
      ["div:AAPL:2026-09-25", 4, "confirmed", "yahoo_calendar"],
    ]);
    assert.equal(dividends[1]!.title, "AAPL ex-dividend date");
    assert.equal(dividends[1]!.detail, "Indicated annual rate $1.04 per share. Shares held before this date carry the payment.");
    assert.equal(dividends[0]!.detail, "Shares held before this date carry the payment.");
    assert.deepEqual(dividends[1]!.affects_held, ["AAPL"]);
  });

  it("picks up a fund's distribution on its ex-date from the price history, and still says the fund has no calendar", async () => {
    const now = new Date(NOW);
    const report = await build(NOW, {
      corporateCalendar: async (symbol) =>
        fixtureCorporate(symbol, now, symbol === "SPY" ? { recent_dividends: [{ date: "2026-06-19", amount: 1.76 }, { date: "2026-09-21", amount: 1.7461 }] } : {}),
    });
    const spy = report.corporate_events.filter((e) => e.ticker === "SPY");
    assert.deepEqual(spy.map((e) => [e.id, e.source, e.detail]), [
      ["div:SPY:2026-09-21", "yahoo_chart", "$1.7461 per share went ex-dividend this session, read from the price history."],
    ]);
    assert.deepEqual(report.corporate_coverage.unknown_symbols, ["SPY", "IWM"]);
    assert.ok(report.corporate_coverage.dividends.includes("fund distributions are not available"));
    assert.ok(report.corporate_coverage.splits.includes("Upcoming splits are not available"));
  });

  it("lets the price history supply the exact amount when the calendar already had the date", async () => {
    const now = new Date(NOW);
    const report = await build(NOW, {
      corporateCalendar: async (symbol) =>
        fixtureCorporate(
          symbol,
          now,
          symbol === "AAPL" ? { ex_dividend_date: "2026-09-21", dividend_rate: 1.04, recent_dividends: [{ date: "2026-09-21", amount: 0.26 }] } : {},
        ),
    });
    const dividends = report.corporate_events.filter((e) => e.kind === "dividend");
    assert.deepEqual(dividends.map((e) => [e.id, e.source, e.detail]), [
      ["div:AAPL:2026-09-21", "yahoo_calendar", "$0.26 per share went ex-dividend this session, read from the price history."],
    ]);
  });

  it("withholds the move of a name that split inside the window, and keeps an older split listed", async () => {
    const now = new Date(NOW);
    assert.equal(RECENT_SPLIT_SESSIONS, 5);
    const report = await build(NOW, {
      heldQuote: async (symbol) => fixtureQuote(symbol, now, symbol === "NVDA" ? { price: 11.84, regular_price: 116 } : {}),
      corporateCalendar: async (symbol) =>
        fixtureCorporate(
          symbol,
          now,
          symbol === "NVDA"
            ? { recent_splits: [{ date: "2026-09-21", numerator: 10, denominator: 1 }] }
            : symbol === "AAPL"
              ? { recent_splits: [{ date: "2026-09-15", numerator: 1, denominator: 8 }, { date: "2026-09-11", numerator: 2, denominator: 1 }] }
              : {},
        ),
    });
    const nvda = report.overnight.held_movers.find((m) => m.ticker === "NVDA")!;
    assert.equal(nvda.flag, "corporate_action_check");
    assert.equal(nvda.move_pct, 0);
    assert.equal(nvda.pnl_usd, 0);
    // The fake ninety percent loss stays out of the book total as well.
    assert.equal(report.book.overnight_pnl_usd, -0.9);
    assert.ok(report.overnight.held_movers.find((m) => m.ticker === "AAPL")!.flag === null);

    const splits = report.corporate_events.filter((e) => e.kind === "split");
    assert.deepEqual(splits.map((e) => [e.id, e.title, e.sessions_until]), [
      ["split:AAPL:2026-09-15", "AAPL 1-for-8 reverse split took effect", -4],
      ["split:NVDA:2026-09-21", "NVDA 10-for-1 split took effect", 0],
    ]);
    assert.ok(splits[1]!.detail.includes("withheld"));
    assert.ok(!splits[0]!.detail.includes("withheld"));
  });

  it("ties a rebalance to the held funds that track the index, and keeps one no held fund tracks", async () => {
    assert.equal(REBALANCE_HORIZON_SESSIONS, 15);
    const report = await build("2026-12-01T13:00:00.000Z");
    const rebalances = report.corporate_events.filter((e) => e.kind === "rebalance");
    assert.deepEqual(rebalances.map((e) => [e.id, e.index, e.affects_held, e.certainty, e.source, e.sessions_until]), [
      ["reb:russell:2026-12-11", "russell", ["IWM"], "confirmed", "curated", 8],
      ["reb:nasdaq100:2026-12-18", "nasdaq100", [], "rule", "rule", 13],
      ["reb:sp:2026-12-18", "sp", ["SPY"], "rule", "rule", 13],
    ]);
    assert.ok(rebalances[2]!.detail.endsWith("Held funds tracking it: SPY."));
    assert.ok(rebalances[1]!.detail.endsWith("None of the funds this report tracks for that family is held."));
    assert.equal(rebalances[2]!.ticker, null);

    // Out of range in September: the third Friday has just passed.
    const september = await build(NOW);
    assert.deepEqual(september.corporate_events.filter((e) => e.kind === "rebalance"), []);
  });

  it("orders events by date, then kind, with stable ids", async () => {
    const report = await build("2026-12-01T13:00:00.000Z");
    const keys = report.corporate_events.map((e) => `${e.date}|${e.kind}`);
    const kindOrder = ["dividend", "split", "rebalance", "earnings"];
    const sorted = [...report.corporate_events]
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : kindOrder.indexOf(a.kind) - kindOrder.indexOf(b.kind) || (a.id < b.id ? -1 : 1)))
      .map((e) => `${e.date}|${e.kind}`);
    assert.deepEqual(keys, sorted);
    assert.equal(new Set(report.corporate_events.map((e) => e.id)).size, report.corporate_events.length);
  });
});

describe("briefing/gather: the calendar of the target session", () => {
  it("lists an FOMC day in the order of the day, with each time as an instant", async () => {
    const report = await build("2026-10-28T12:00:00.000Z");
    assert.deepEqual(report.calendar_today.map((c) => [c.id, c.kind, c.time_et, c.at, c.importance]), [
      ["macro:2026-10-28:FOMC", "fomc", "14:00", "2026-10-28T18:00:00.000Z", 3],
      ["macro:2026-10-28:FOMC_PRESSER", "fomc", "14:30", "2026-10-28T18:30:00.000Z", 2],
    ]);
    assert.equal(report.calendar_today[0]!.title, "FOMC rate decision");
    assert.equal(report.calendar_today[0]!.source, "fed");
    assert.ok(report.narrative.text.includes("FOMC rate decision at 14:00 ET"));

    // Standard time: the same wall clock is an hour later in UTC.
    const december = await build("2026-12-09T13:00:00.000Z");
    assert.equal(december.calendar_today.find((c) => c.id === "macro:2026-12-09:FOMC")!.at, "2026-12-09T19:00:00.000Z");
  });

  it("puts all-day items first, then timed ones, and says what a release covers", async () => {
    const report = await build("2026-09-11T12:00:00.000Z");
    assert.deepEqual(report.calendar_today.map((c) => [c.id, c.time_et, c.detail]), [
      ["macro:2026-09-11:UMICH_PRELIM", null, "Covers September 2026."],
      ["macro:2026-09-11:CPI", "08:30", "Covers August 2026."],
    ]);
  });

  it("lists the quarterly expiry and the rebalances that take effect after that close", async () => {
    const report = await build("2026-12-18T12:00:00.000Z");
    assert.deepEqual(report.calendar_today.map((c) => [c.id, c.kind, c.importance, c.tickers]), [
      ["opex:quarterly_expiry:2026-12-18", "opex", 3, []],
      ["reb:nasdaq100:2026-12-18", "rebalance", 2, []],
      ["reb:sp:2026-12-18", "rebalance", 2, ["SPY"]],
      ["macro:2026-12-18:UMICH_FINAL", "data", 1, []],
    ]);
    const monthly = await build("2026-10-16T12:00:00.000Z");
    assert.deepEqual(monthly.calendar_today.filter((c) => c.kind === "opex").map((c) => [c.title, c.importance]), [["Monthly options expiry", 2]]);
    const vix = await build("2026-10-21T12:00:00.000Z");
    assert.deepEqual(vix.calendar_today.filter((c) => c.kind === "opex").map((c) => [c.title, c.importance]), [["VIX futures and options expiry", 1]]);
  });

  it("marks an early close and the first session after a holiday", async () => {
    const report = await build("2026-11-27T12:30:00.000Z");
    assert.equal(report.window.early_close, true);
    assert.equal(report.window.handover, "holiday");
    assert.deepEqual(report.calendar_today.filter((c) => c.kind === "session").map((c) => [c.id, c.title, c.importance, c.time_et]), [
      ["session:early_close", "Early close at 13:00 ET", 2, null],
      ["session:after_holiday", "First session after a US market holiday", 1, null],
    ]);
    const plain = await build(NOW);
    assert.deepEqual(plain.calendar_today.filter((c) => c.kind === "session"), []);
  });

  it("says so, in the report and in the paragraph, when the target lies past the calendar file", async () => {
    const report = await build("2027-01-05T13:00:00.000Z");
    assertFullShape(report);
    assert.equal(report.calendar_coverage.covers_target, false);
    assert.equal(report.calendar_coverage.until, "2026-12-31");
    assert.ok(report.calendar_coverage.days_left < 0);
    assert.deepEqual(report.degraded, [{ section: "macro_calendar", detail: "calendar file does not reach this session" }]);
    assert.ok(report.narrative.text.includes("The macro calendar file ends on December 31, 2026"), report.narrative.text);
    assert.ok(!report.narrative.text.includes("Nothing is scheduled"));

    // The date rules have no end: an expiry past the file is still listed.
    const opex = await build("2027-01-15T13:00:00.000Z");
    assert.deepEqual(opex.calendar_today.map((c) => c.title), ["Monthly options expiry"]);
    assert.ok(opex.narrative.text.includes("the calendar still has Monthly options expiry"));
  });
});

describe("briefing/gather: the calendar overlay", () => {
  it("applies a correction and an ad-hoc early close", async () => {
    const report = await build(NOW, {
      calendarOverlay: async () => ({
        events: [{ date: "2026-09-21", time_et: "10:00", kind: "data", code: "EXISTING_HOMES", title: "Existing Home Sales", period: "August 2026", importance: 1, source: "census" }],
        session_overrides: [
          { date: "2026-09-21", early_close: true, note: "Ad-hoc early close", source: "nyse" },
          { date: "2026-09-18", early_close: true, note: "Ad-hoc early close", source: "nyse" },
        ],
      }),
    });
    assert.deepEqual(report.degraded, []);
    assert.equal(report.window.early_close, true);
    assert.equal(report.window.target_close_at, "2026-09-21T17:00:00.000Z");
    assert.equal(report.window.overnight_since, "2026-09-18T17:00:00.000Z");
    assert.deepEqual(report.calendar_today.map((c) => c.id), ["session:early_close", "macro:2026-09-21:EXISTING_HOMES"]);
    assert.ok(report.narrative.text.includes("closes early at 13:00 ET"));
  });

  it("lets an ad-hoc close decide which session the report hands over to", async () => {
    const overlay = (date: string, early_close: boolean): Partial<BriefingPorts> => ({
      calendarOverlay: async () => ({ session_overrides: [{ date, early_close, note: "Ad-hoc", source: "nyse" }] }),
    });

    // 14:30 ET on a session an ad-hoc close ended at 13:00: the report has to
    // hand over to the next one, not go on describing a session that is over.
    const added = await build("2026-09-21T18:30:00.000Z", overlay("2026-09-21", true));
    assert.equal(added.window.target_session_ymd, "2026-09-22");
    assert.equal(added.window.prev_session_ymd, "2026-09-21");
    assert.equal(added.window.overnight_since, "2026-09-21T17:00:00.000Z");
    assert.equal(added.window.phase, "between_sessions");
    const scheduled = await build("2026-09-21T18:30:00.000Z");
    assert.equal(scheduled.window.target_session_ymd, "2026-09-21");
    assert.equal(scheduled.window.phase, "in_session");

    // The other way: the algorithmic calendar has 2026-11-27 closing at 13:00,
    // and an override says it trades the full session. At 14:30 the market is
    // still open, so the report stays on it.
    const cleared = await build("2026-11-27T19:30:00.000Z", overlay("2026-11-27", false));
    assert.equal(cleared.window.target_session_ymd, "2026-11-27");
    assert.equal(cleared.window.early_close, false);
    assert.equal(cleared.window.target_close_at, "2026-11-27T21:00:00.000Z");
    assert.equal(cleared.window.phase, "in_session");
    assert.equal(cleared.window.overnight_since, "2026-11-25T21:00:00.000Z");
    const asRuled = await build("2026-11-27T19:30:00.000Z");
    assert.equal(asRuled.window.target_session_ymd, "2026-11-30");
    assert.equal(asRuled.window.early_close, false);
  });

  it("falls back to the shipped file when the overlay does not validate or is malformed", async () => {
    const bad = [
      { events: [{ date: "2027-03-01", time_et: "08:30", kind: "data", code: "CPI", title: "Consumer Price Index", importance: 3, source: "bls" }] },
      { events: [{ date: "2026-09-21", time_et: "08:30", kind: "data", code: "X", title: "Traders should expect a surprise", importance: 1, source: "bls" }] },
      { events: [{ date: "2026-09-21", time_et: "08:30", kind: "data", code: "X", title: "From a blog", importance: 1, source: "some_blog" }] },
      { events: "all of them" },
      { index_events: 12 },
    ];
    for (const overlay of bad) {
      const report = await build(NOW, { calendarOverlay: (async () => overlay) as unknown as BriefingPorts["calendarOverlay"] });
      assertFullShape(report);
      assert.deepEqual(report.degraded, [{ section: "macro_calendar", detail: "overlay rejected, shipped calendar used" }], JSON.stringify(overlay));
      assert.deepEqual(report.calendar_today, []);
      assert.equal(report.calendar_coverage.covers_target, true);
    }
  });

  it("works without the optional port", async () => {
    const now = new Date(NOW);
    const { calendarOverlay: _unused, ...required } = fakePorts({}, { now });
    const report = await gatherBriefing(REQUEST, now, required);
    assertFullShape(report);
    assert.deepEqual(report.degraded, []);
  });
});
