// Run (from apps/web): node <repo>/node_modules/.pnpm/tsx@4.22.4/node_modules/tsx/dist/cli.mjs --test lib/desk/source-labels.test.ts
// Regression: every cited figure is labelled with where that figure came from. A return Falcon computed from
// Databento or Yahoo closes once showed "sec.gov" (and opened the 8-K) because the earnings events' source line
// named SEC first and the whole tool result shared one label. Nothing here touches the network.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildRegistry, checkReply, citeKey, fieldSource, sourceKind, withSourceId, type CiteCheck, type Turn } from "./citations";
import { replySources } from "./reply-sources";
import { eventsTool, resetEvents, type EventRow, type EventsStore } from "./tools/events";
import { valuationSources } from "./tools/fundamentals";
import { summarizeBars } from "./tools/history";
import type { ChartResult } from "./tools/yahoo";

const AT = "2026-11-22T17:02:01.520Z";
const signal = new AbortController().signal;

const row = (date: string, prices: string, r: { abn: number; abn0: number; abn1: number; s0: number; s: number; e: number }): EventRow => ({
  ticker: "ABEO",
  event_date: date,
  filed_at: `${date}T11:35:00Z`,
  accession: `0001493152-${date}`,
  filing_url: `https://www.sec.gov/Archives/edgar/data/318306/${date}-index.htm`,
  form: "8-K",
  sector_etf: "XLV",
  abnormal_return_d0_d1: r.abn,
  abnormal_return_d0: r.abn0,
  abnormal_return_d1: r.abn1,
  stock_return_d0: r.s0,
  stock_return_d0_d1: r.s,
  etf_return_d0_d1: r.e,
  price_source: prices,
  flags: null,
});

// The ABEO case: Nov 9 2026 priced 'mixed' (stock from Databento, XLV from Yahoo), an older release all from Yahoo.
const ROWS = [
  row("2026-11-09", "mixed", { abn: -0.4333, abn0: -0.41, abn1: -0.0364, s0: -0.3909, s: -0.4113, e: 0.0221 }),
  row("2023-03-30", "yahoo", { abn: -0.1914, abn0: -0.1899, abn1: -0.0021, s0: -0.18, s: -0.1702, e: 0.0212 }),
];
const store: EventsStore = { rows: async () => ({ rows: ROWS, count: ROWS.length }), hasAny: async () => true };

const use = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const result = (id: string, content: string) => ({ type: "tool_result", tool_use_id: id, content });

async function abeoReply() {
  resetEvents();
  const data = await eventsTool({ ticker: "ABEO" }, store, signal);
  const content = withSourceId("t1", JSON.stringify(data), AT);
  const text = [
    'On Nov 9 ABEO fell [-39.09%](src:t1 "events[0].stock_d0") while XLV rose [+2.21%](src:t1 "events[0].etf"), an abnormal [-43.33%](src:t1 "events[0].abn") over two days.',
    'The 8-K was filed [2026-11-09](src:t1 "events[0].date"). In 2023 the reaction was [-19.14%](src:t1 "events[1].abn"); the typical move is [31.24%](src:t1 "summary.avg_abs_abn").',
    "So Nov 9 was about 1.39x the typical move (computed).",
  ].join("\n");
  const tail: Turn[] = [
    { role: "assistant", content: [use("a", "earnings_events", { ticker: "ABEO" })] },
    { role: "user", content: [result("a", content)] },
    { role: "assistant", content: [{ type: "text", text }] },
  ];
  const report = checkReply(text, buildRegistry([], tail, 0, () => "/events ABEO"));
  const by = (field: string) => report.checks.find((c) => c.field === field)!;
  return { report, by, content };
}

const SEC_URL = /^https:\/\/(www\.)?sec\.gov\//;

test("earnings events: each return names the closes it was computed from, never SEC", async () => {
  const { report, by } = await abeoReply();
  assert.equal(report.stats.verified, 6, JSON.stringify(report.checks.filter((c) => c.status !== "verified")));
  const stock = by("events[0].stock_d0");
  assert.match(stock.source!.label, /^Computed by Falcon from Databento EQUS\.SUMMARY daily closes \(the stock\)/);
  assert.deepEqual(sourceKind("earnings_events", stock.source!), { kind: "computed", domain: "databento.com" });
  const etf = by("events[0].etf");
  assert.match(etf.source!.label, /Yahoo Finance daily closes \(the sector ETF\)/);
  assert.deepEqual(sourceKind("earnings_events", etf.source!), { kind: "computed", domain: "finance.yahoo.com" });
  const abn = by("events[0].abn");
  assert.match(abn.source!.label, /Databento EQUS\.SUMMARY \(stock\) and Yahoo Finance \(sector ETF\)/);
  assert.deepEqual(sourceKind("earnings_events", abn.source!), { kind: "computed", domain: "databento.com + finance.yahoo.com" });
  // The older row's closes were all Yahoo's.
  assert.match(by("events[1].abn").source!.label, /from Yahoo Finance daily closes \(stock and sector ETF\)/);
  assert.match(by("summary.avg_abs_abn").source!.label, /^Computed by Falcon from the events' returns \(daily closes: Databento EQUS\.SUMMARY and Yahoo Finance\)/);
  // No price-based figure is labelled SEC or opens the 8-K beside it.
  for (const c of [stock, etf, abn, by("events[1].abn"), by("summary.avg_abs_abn")]) {
    assert.notEqual(sourceKind("earnings_events", c.source!).kind, "sec", c.field);
    assert.ok(!(c.url && SEC_URL.test(c.url)), `${c.field} opens ${c.url}`);
  }
  // The filing date is the filing's: SEC, with the 8-K to open.
  const date = by("events[0].date");
  assert.equal(sourceKind("earnings_events", date.source!).kind, "sec");
  assert.match(date.url ?? "", SEC_URL);
  // The lookup as a whole is Falcon's own data, not SEC.
  assert.equal(report.sources?.[0]?.kind, "falcon");
});

test("a computed figure lists the cited inputs it came from", async () => {
  const { report } = await abeoReply();
  const derived = report.uncited.find((u) => u.text === "1.39x");
  assert.equal(derived?.status, "derived");
  // No citation in its own sentence: the paragraph's (here its line has none either, so none are claimed).
  assert.equal(derived?.inputs, undefined);
  const text = 'ABEO went from [$4.17](src:t1 "a") to [$2.54](src:t1 "b"), a fall of 39.1% (computed).';
  const tail: Turn[] = [
    { role: "assistant", content: [use("q", "history", { ticker: "ABEO" })] },
    { role: "user", content: [result("q", withSourceId("t1", JSON.stringify({ a: 4.17, b: 2.54, source: "Yahoo Finance chart (v8)" }), AT))] },
  ];
  const r = checkReply(text, buildRegistry([], tail, 0));
  assert.deepEqual(r.uncited[0]?.inputs, [
    { ref: "t1", field: "a", label: "$4.17" },
    { ref: "t1", field: "b", label: "$2.54" },
  ]);
  assert.equal(r.checks[0]?.source?.label, "Yahoo Finance chart (v8)");
});

test("chips: each cited figure maps to its own source, the lookup keeps its own label", async () => {
  const { report, content } = await abeoReply();
  const sources = replySources([{ src: "t1", cmd: "/events ABEO", ok: true, result: content }], report);
  const byKey = new Map(sources.flatMap((s) => (s.keys ?? []).map((k) => [k, s] as const)));
  const chip = (field: string) => byKey.get(citeKey(report.checks.find((c) => c.field === field) as CiteCheck))!;
  assert.equal(chip("events[0].stock_d0").domain, "Databento");
  assert.equal(chip("events[0].etf").domain, "Yahoo");
  assert.equal(chip("events[0].abn").domain, "Databento + Yahoo");
  assert.equal(chip("events[1].abn").domain, "Yahoo");
  assert.equal(chip("events[0].date").domain, "sec.gov");
  // The lookup itself is listed first under its own label, not one figure's.
  assert.equal(sources[0]!.id, "t1");
  assert.match(sources[0]!.label, /^Falcon earnings events/);
  assert.equal(sources[0]!.domain, "Falcon");
  for (const s of sources) if (s.domain === "sec.gov") assert.ok(s.keys?.every((k) => k.includes("date")), s.label);
  // A reloaded reply whose stored result was cut short still names the lookup from the route's list.
  const cut = replySources([{ src: "t1", cmd: "/events ABEO", ok: true, result: content.slice(0, 200) }], report);
  assert.match(cut[0]!.label, /^Falcon earnings events/);
});

test("fundamentals: multiples name Yahoo's price and SEC's figures; filed figures stay SEC", () => {
  const data = {
    revenue: { ttm: { value: 94_930_000_000, end: "2026-09-27" } },
    valuation: { price: 271.49, marketCap: { value: 4_030_000_000_000, basis: "price x cover-page shares outstanding as of 2026-10-17" }, peTtm: 36.6, priceToSalesTtm: 9.8, enterpriseValue: { value: 4_060_000_000_000 }, evToEbitdaTtm: 28.1 },
    source: "SEC XBRL company facts (us-gaap); the valuation block (price, market cap, multiples) uses Yahoo Finance's last price",
    sources: valuationSources("AAPL", { marketCap: { basis: "price x cover-page shares outstanding as of 2026-10-17" } }),
  };
  const base = { label: data.source };
  assert.equal(sourceKind("fundamentals", base).kind, "sec");
  assert.equal(fieldSource(data, "revenue.ttm.value", base).label, data.source);
  assert.deepEqual(sourceKind("fundamentals", fieldSource(data, "valuation.price", base)), { kind: "yahoo", domain: "finance.yahoo.com" });
  assert.deepEqual(sourceKind("fundamentals", fieldSource(data, "valuation.peTtm", base)), { kind: "computed", domain: "finance.yahoo.com + sec.gov" });
  assert.deepEqual(sourceKind("fundamentals", fieldSource(data, "valuation.marketCap.value", base)), { kind: "computed", domain: "finance.yahoo.com + sec.gov" });
  assert.match(fieldSource(data, "valuation.enterpriseValue.value", base).label, /SEC XBRL debt, cash and EBITDA/);
  // Yahoo's own market cap is Yahoo's, not computed.
  const yahooCap = { ...data, sources: valuationSources("AAPL", { marketCap: { basis: "Yahoo market cap" } }) };
  assert.equal(sourceKind("fundamentals", fieldSource(yahooCap, "valuation.marketCap.value", base)).kind, "yahoo");
});

test("history and quote say which provider answered the call", () => {
  const bars = [
    { date: "2026-11-06", open: 4, high: 4.3, low: 3.9, close: 4.17, adj: 4.17, volume: 1 },
    { date: "2026-11-09", open: 3, high: 3.1, low: 2.4, close: 2.54, adj: 2.54, volume: 1 },
  ];
  const chart = { meta: { currency: "USD" } } as ChartResult;
  const db = summarizeBars("ABEO", "1m", bars, chart, 0, true);
  const yahoo = summarizeBars("ABEO", "1m", bars, chart, 0, false);
  assert.equal(sourceKind("history", { label: db.source }).kind, "databento");
  assert.equal(sourceKind("history", { label: yahoo.source }).kind, "yahoo");
});

test("source kinds follow the provider a line names first", () => {
  const kind = (label: string, name = "") => sourceKind(name, { label }).kind;
  // The line that once read as SEC.
  assert.equal(kind("Falcon historical earnings events (SEC 8-K Item 2.02); prices: mixed, yahoo", "earnings_events"), "falcon");
  assert.equal(kind("SEC XBRL company facts (us-gaap); price from Yahoo Finance"), "sec");
  assert.equal(kind("Yahoo Finance options chain (delayed ~15 min): Falcon computed every figure from the bid/ask mids"), "yahoo");
  assert.equal(kind("OPRA via Databento: Falcon's daily snapshot (end of day)"), "opra");
  assert.equal(kind("Databento XNAS.ITCH trades (Nasdaq TotalView-ITCH), regular hours 09:30-16:00 ET"), "databento");
  // "sec" inside a word is not SEC.
  assert.equal(kind("Falcon forecast ledger, consecutive sessions"), "falcon");
});

test("field sources: wildcards, row conditions and the most specific group", () => {
  const data = {
    rows: [
      { v: 1, w: 2, prices: "a" },
      { v: 3, w: 4, prices: "b" },
    ],
    sources: [
      { covers: ["rows"], label: "All rows" },
      { covers: ["rows.v*"], when: { prices: "a" }, label: "Row a's v" },
      { covers: ["rows.v"], label: "Any row's v" },
      { covers: [], label: "Malformed" },
    ],
  };
  const base = { label: "Base" };
  assert.equal(fieldSource(data, "rows[0].v", base).label, "Row a's v");
  assert.equal(fieldSource(data, "rows[1].v", base).label, "Any row's v");
  assert.equal(fieldSource(data, "rows[1].w", base).label, "All rows");
  assert.equal(fieldSource(data, "other", base).label, "Base");
  assert.equal(fieldSource("not json", "rows[0].v", base).label, "Base");
});
