import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { en } from "../renderer/lib/i18n/messages/areas/today";
import {
  MAX_LINKED,
  barMove,
  inWindow,
  linkedItems,
  moveCheck,
  newsItems,
  normalDay,
  ownFilings,
  parseTodayMovesRequest,
  peersSameWay,
  reportInWindow,
  sectorFund,
  sessionFrame,
  todaySummary,
  todayView,
  webUrl,
  type Bar,
  type FilingLike,
  type Form4Read,
  type StockToday,
  type TodayFormat,
  type Window,
} from "./today-move";

/** Sessions from 2025-01-01, one per calendar day (the maths does not care about weekends). */
function day(i: number): string {
  return new Date(Date.UTC(2025, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
}

function barsFrom(returns: readonly number[]): Bar[] {
  const out: Bar[] = [{ d: day(0), c: 100 }];
  let c = 100;
  returns.forEach((r, i) => {
    c *= 1 + r;
    out.push({ d: day(i + 1), c });
  });
  return out;
}

/** An alternating series: +a, -a, ... (mean zero, standard deviation about a). */
function wiggle(n: number, a: number, phase = 0): number[] {
  return Array.from({ length: n }, (_, i) => ((i + phase) % 2 === 0 ? a : -a));
}

const t = (key: string, params: Record<string, string | number> = {}) => {
  const text = (en as Record<string, string>)[key];
  assert.ok(text, `missing message ${key}`);
  return text.replace(/\{(\w+)\}/g, (_, n: string) => String(params[n] ?? `{${n}}`));
};

const fmt: TodayFormat = {
  t,
  move: (x) => `${x > 0 ? "+" : x < 0 ? "-" : ""}${(Math.abs(x) * 100).toFixed(1)}%`,
  share: (x) => `${(Math.abs(x) * 100).toFixed(1)}%`,
  ratio: (x) => x.toFixed(1),
  money: (x) => `$${(x / 1e6).toFixed(1)}M`,
  weekday: (ymd) => new Date(`${ymd}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" }),
  time: (at, withDay) => new Date(at).toLocaleString("en-US", { ...(withDay ? { weekday: "short" as const } : {}), hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: "America/New_York" }) + " ET",
  list: (xs) => xs.join(", "),
  plural: (n) => (n === 1 ? "one" : "other"),
};

// 2026-10-15 is a Thursday; the window opens at Wednesday's close (20:00 UTC in EDT).
const W: Window = {
  sinceMs: Date.parse("2026-10-14T20:00:00Z"),
  untilMs: Date.parse("2026-10-15T19:00:00Z"),
  previousDay: "2026-10-14",
  untilDay: "2026-10-15",
};

function filing(form: string, at: string | null, extra: Partial<FilingLike> = {}): FilingLike {
  return {
    form,
    accession: `${form}-${at ?? "x"}`,
    filedAt: (at ?? "2026-10-15T12:00:00Z").slice(0, 10),
    acceptedMs: at ? Date.parse(at) : null,
    items: [],
    url: `https://www.sec.gov/Archives/edgar/data/1/${form.replace(/\W/g, "")}.htm`,
    ...extra,
  };
}

function base(over: Partial<StockToday> = {}): StockToday {
  return {
    ticker: "FAST",
    day: "2026-10-15",
    previousDay: "2026-10-14",
    since: "2026-10-14T20:00:00.000Z",
    asOf: "2026-10-15T19:00:00.000Z",
    move: -0.0312,
    market: { symbol: "SPY", move: 0.0028 },
    sector: { symbol: "XLI", move: 0.0051 },
    beta: 0.55,
    sigma: 0.0125,
    sessions: 60,
    abnormal: -0.0327,
    ratio: 2.62,
    unusual: true,
    filings: [],
    linked: [],
    news: [],
    peers: [],
    peersRead: 5,
    degraded: [],
    ...over,
  };
}

describe("today: the usual day", () => {
  it("is the spread of moves beyond the market, beta read against the market", () => {
    const n = 300;
    const market = wiggle(n, 0.01);
    // The stock: 1.5 times the market plus its own wiggle of 1%, on the other phase pattern.
    const own = Array.from({ length: n }, (_, i) => (i % 4 < 2 ? 0.01 : -0.01));
    const stock = market.map((m, i) => 1.5 * m + own[i]!);
    const normal = normalDay(barsFrom(stock), barsFrom(market), day(n + 1));
    assert.ok(normal);
    assert.ok(Math.abs(normal.beta - 1.5) < 0.05, `beta ${normal.beta}`);
    assert.ok(Math.abs(normal.sigma - 0.01) < 0.002, `sigma ${normal.sigma}`);
    assert.equal(normal.sessions, 60);
  });

  it("leaves out the move's own session and later", () => {
    const n = 120;
    const market = wiggle(n, 0.01);
    const stock = [...Array.from({ length: n - 1 }, (_, i) => (i % 4 < 2 ? 0.01 : -0.01)), 0.5];
    const all = normalDay(barsFrom(stock), barsFrom(market), day(n + 1))!;
    const before = normalDay(barsFrom(stock), barsFrom(market), day(n))!;
    assert.ok(all.sigma > before.sigma * 2);
  });

  it("is null with too few shared sessions, and beta falls back to one with too few for it", () => {
    assert.equal(normalDay(barsFrom(wiggle(30, 0.01)), barsFrom(wiggle(30, 0.01)), day(40)), null);
    const fifty = normalDay(barsFrom(wiggle(50, 0.02)), barsFrom(wiggle(50, 0.01, 1)), day(60))!;
    assert.equal(fifty.beta, 1);
  });

  it("calls a move unusual from twice the usual day beyond the market", () => {
    const normal = { beta: 1.2, sigma: 0.01, sessions: 60 };
    const big = moveCheck(-0.031, 0.003, normal);
    assert.ok(Math.abs(big.abnormal - (-0.031 - 1.2 * 0.003)) < 1e-12);
    assert.ok(big.unusual);
    // A large move the market made too is not the stock's own.
    assert.equal(moveCheck(-0.03, -0.025, normal).unusual, false);
    assert.equal(moveCheck(0.0199, 0, normal).unusual, false);
    assert.equal(moveCheck(0.02, 0, normal).unusual, true);
  });

  it("reads a closed session's move from bars", () => {
    const bars = [
      { d: "2026-10-14", c: 100 },
      { d: "2026-10-15", c: 96.88 },
    ];
    assert.ok(Math.abs(barMove(bars, "2026-10-15", "2026-10-14")! + 0.0312) < 1e-9);
    assert.equal(barMove(bars, "2026-10-16", "2026-10-15"), null);
  });

  it("maps sectors to their funds", () => {
    assert.equal(sectorFund("Technology"), "XLK");
    assert.equal(sectorFund("Funds & ETFs"), null);
    assert.equal(sectorFund(null), null);
  });
});

describe("today: which session", () => {
  it("is today from the open, the session before until then, on the session clock", () => {
    const during = sessionFrame(Date.parse("2026-10-15T15:00:00Z"));
    assert.deepEqual({ day: during.day, previousDay: during.previousDay, live: during.live }, { day: "2026-10-15", previousDay: "2026-10-14", live: true });
    assert.equal(during.sinceMs, Date.parse("2026-10-14T20:00:00Z"));
    const early = sessionFrame(Date.parse("2026-10-16T11:00:00Z"));
    assert.deepEqual({ day: early.day, previousDay: early.previousDay, live: early.live }, { day: "2026-10-15", previousDay: "2026-10-14", live: false });
    // A Saturday reads Friday's session, from Thursday's close.
    const weekend = sessionFrame(Date.parse("2026-10-17T15:00:00Z"));
    assert.deepEqual({ day: weekend.day, previousDay: weekend.previousDay, live: weekend.live }, { day: "2026-10-16", previousDay: "2026-10-15", live: false });
    // Monday's window opens at Friday's close.
    const monday = sessionFrame(Date.parse("2026-10-19T15:00:00Z"));
    assert.equal(monday.previousDay, "2026-10-16");
  });
});

describe("today: the window", () => {
  it("holds a filing by its acceptance instant, or by its day when there is none", () => {
    assert.equal(inWindow(filing("8-K", "2026-10-14T20:05:00Z"), W), true);
    assert.equal(inWindow(filing("8-K", "2026-10-14T19:55:00Z"), W), false);
    assert.equal(inWindow(filing("8-K", null, { filedAt: "2026-10-15" }), W), true);
    assert.equal(inWindow(filing("8-K", null, { filedAt: "2026-10-14" }), W), false);
  });

  it("sorts the company's filings into lines, newest first", () => {
    const list = [
      filing("8-K", "2026-10-15T11:30:00Z", { items: ["2.02", "9.01"] }),
      filing("4", "2026-10-14T21:00:00Z", { accession: "a1" }),
      filing("4", "2026-10-14T22:00:00Z", { accession: "a2" }),
      filing("4", "2026-10-14T23:00:00Z", { accession: "a3" }),
      filing("SC 13D/A", "2026-10-15T13:00:00Z"),
      filing("SCHEDULE 13G", "2026-10-15T13:30:00Z"),
      filing("10-Q", "2026-10-15T10:00:00Z"),
      filing("424B2", "2026-10-15T14:00:00Z"),
      filing("S-3ASR", "2026-10-15T14:10:00Z"),
      filing("424B5", "2026-10-15T14:20:00Z"),
      filing("8-K", "2026-10-13T12:00:00Z", { items: ["5.02"] }),
    ];
    const kept: Record<string, Form4Read> = { a2: { name: "Jane Doe", role: "CFO", code: "S", value: 1_250_000, plan: true } };
    const lines = ownFilings(list, W, (acc) => kept[acc]);
    assert.deepEqual(
      lines.map((l) => l.kind),
      ["schedule", "schedule", "current", "periodic", "insider", "insider_other", "other"],
    );
    const current = lines.find((l) => l.kind === "current");
    assert.ok(current && current.kind === "current");
    assert.deepEqual(current.items, ["2.02"]);
    const other = lines.find((l) => l.kind === "other");
    assert.ok(other && other.kind === "other");
    assert.deepEqual(other.forms, ["424B5", "S-3ASR"]);
    const form4 = lines.find((l) => l.kind === "insider_other");
    assert.ok(form4 && form4.kind === "insider_other");
    assert.equal(form4.count, 2);
    const amended = lines.find((l) => l.kind === "schedule" && l.amendment);
    assert.ok(amended && amended.kind === "schedule" && amended.schedule === "13D");
  });

  it("lists linked companies that reported or filed an 8-K, strongest link first", () => {
    const links = [
      { ticker: "TSM", name: "Taiwan Semiconductor", category: "supplier", direction: "names" as const, filingUrl: "https://www.sec.gov/a" },
      { ticker: "AMD", name: null, category: "competitor", direction: "named" as const, filingUrl: "https://www.sec.gov/b" },
      { ticker: "MU", name: null, category: "supplier", direction: "names" as const, filingUrl: null },
      { ticker: "ORCL", name: null, category: "customer", direction: "named" as const, filingUrl: null },
    ];
    const kept: Record<string, FilingLike[]> = {
      AMD: [filing("8-K", "2026-10-15T12:00:00Z", { items: ["1.01", "9.01"] })],
      MU: [filing("8-K", "2026-10-14T21:00:00Z", { items: ["2.02", "9.01"] })],
      ORCL: [filing("8-K", "2026-10-12T21:00:00Z", { items: ["8.01"] })],
    };
    const radar = [
      { counterparty: "TSM", kind: "recent" as const, date: "2026-10-15", time: "bmo", releasedMs: null },
      { counterparty: "ORCL", kind: "recent" as const, date: "2026-10-13", time: "amc", releasedMs: null },
    ];
    const items = linkedItems("NVDA", links, (t) => kept[t] ?? null, radar, W);
    assert.deepEqual(
      items.map((i) => [i.ticker, i.event, i.namedBy]),
      [
        ["TSM", "report", "NVDA"],
        ["AMD", "filing", "AMD"],
        ["MU", "report", "NVDA"],
      ],
    );
    assert.equal(items[0]!.url, null);
    assert.equal(items[0]!.linkUrl, "https://www.sec.gov/a");
    assert.deepEqual(items[1]!.items, ["1.01"]);
    assert.ok(items[2]!.url?.startsWith("https://www.sec.gov/"));
  });

  it("caps the linked companies", () => {
    const links = Array.from({ length: 10 }, (_, i) => ({ ticker: `T${i}`, name: null, category: "supplier", direction: "names" as const, filingUrl: null }));
    const items = linkedItems("X", links, () => [filing("8-K", "2026-10-15T12:00:00Z", { items: ["8.01"] })], [], W);
    assert.equal(items.length, MAX_LINKED);
  });

  it("reads a radar report into the window by hour", () => {
    const r = (date: string, time: string) => ({ counterparty: "C", kind: "recent" as const, date, time, releasedMs: null });
    assert.equal(reportInWindow(r("2026-10-14", "amc"), W), true);
    assert.equal(reportInWindow(r("2026-10-14", "bmo"), W), false);
    assert.equal(reportInWindow(r("2026-10-15", "unknown"), W), true);
    assert.equal(reportInWindow({ ...r("2026-10-15", "bmo"), kind: "upcoming" }, W), false);
    assert.equal(reportInWindow({ ...r("2026-10-14", "bmo"), releasedMs: Date.parse("2026-10-14T20:30:00Z") }, W), true);
  });

  it("keeps the material stories for the company inside the window, once each", () => {
    const stories = [
      { title: "Fastenal posts quarterly sales of $2.1 billion", url: "https://example.com/1", source: "Reuters", publishedAt: "2026-10-15T11:00:00Z", tickers: ["FAST"] },
      { title: "Fastenal posts quarterly sales of $2.1 billion", url: "https://example.com/2", source: "Other", publishedAt: "2026-10-15T11:05:00Z", tickers: ["FAST"] },
      { title: "Another company", url: "https://example.com/3", publishedAt: "2026-10-15T11:00:00Z", tickers: ["GWW"] },
      { title: "Old story", url: "https://example.com/4", publishedAt: "2026-10-14T15:00:00Z", tickers: ["FAST"] },
    ];
    const news = newsItems(stories, "fast", W);
    assert.equal(news.length, 1);
    assert.equal(news[0]!.source, "Other");
  });

  it("keeps competitors that moved the same way by at least their own usual day", () => {
    const same = peersSameWay(-0.03, [
      { ticker: "GWW", move: -0.025, sigma: 0.015 },
      { ticker: "MSM", move: -0.005, sigma: 0.015 },
      { ticker: "WCC", move: 0.03, sigma: 0.02 },
      { ticker: "URI", move: -0.012, sigma: null },
      { ticker: "CNM", move: null, sigma: 0.01 },
    ]);
    assert.deepEqual(same.map((p) => p.ticker), ["GWW", "URI"]);
    assert.deepEqual(peersSameWay(0, [{ ticker: "A", move: 0.05, sigma: 0.01 }]), []);
  });

  it("takes a clean, capped list of held tickers", () => {
    assert.deepEqual(parseTodayMovesRequest(["nvda", "NVDA", " amd ", 3, "bad ticker!"]), ["NVDA", "AMD"]);
    assert.equal(parseTodayMovesRequest("NVDA"), null);
    assert.equal(parseTodayMovesRequest(Array.from({ length: 200 }, (_, i) => `T${String.fromCharCode(65 + (i % 26))}${String.fromCharCode(65 + Math.floor(i / 26))}`))!.length, 60);
  });

  it("opens web addresses only", () => {
    assert.equal(webUrl("https://www.sec.gov/x"), "https://www.sec.gov/x");
    assert.equal(webUrl("javascript:alert(1)"), null);
    assert.equal(webUrl("file:///c:/x"), null);
    assert.equal(webUrl(null), null);
  });
});

describe("today: the lines", () => {
  it("says the move, the market and the sector, then what is on record with its source", () => {
    const d = base({
      filings: [
        { kind: "current", form: "8-K", items: ["2.02"], at: "2026-10-15T11:31:00.000Z", url: "https://www.sec.gov/8k" },
        { kind: "insider", name: "Jane Doe", role: "CFO", code: "S", value: 1_250_000, plan: true, at: "2026-10-14T21:00:00.000Z", url: "https://www.sec.gov/f4" },
      ],
      linked: [
        { ticker: "GWW", name: null, category: "competitor", namedBy: "GWW", linkUrl: "https://www.sec.gov/10k", event: "report", items: ["2.02"], at: "2026-10-15T10:30:00.000Z", url: "https://www.sec.gov/gww8k" },
      ],
      news: [{ title: "Fastenal posts quarterly sales of $2.1 billion", url: "https://example.com/1", source: "Reuters", at: "2026-10-15T20:30:00.000Z" }],
      peers: [
        { ticker: "GWW", move: -0.025 },
        { ticker: "MSM", move: -0.018 },
      ],
    });
    const v = todayView(d, "2026-10-15", fmt);
    assert.equal(v.headline, "FAST -3.1% today, 2.6 times its usual day beyond the market.");
    assert.equal(v.context, "Beyond the market: -3.3%. Usual day: 1.3% either way, last 60 sessions. SPY +0.3%, XLI +0.5%.");
    assert.equal(t("today.onRecord", { since: v.since }), "On record since yesterday's close:");
    assert.deepEqual(
      v.lines.map((l) => l.text),
      [
        "8-K: results of operations (item 2.02)",
        "Form 4: Jane Doe, CFO, open market sale of $1.3M (10b5-1 plan)",
        "GWW reported results; competitor, named in GWW's filing",
        "Fastenal posts quarterly sales of $2.1 billion",
        "Competitors the same way today: GWW -2.5%, MSM -1.8% (2 of 5)",
      ],
    );
    assert.deepEqual(v.lines.map((l) => l.source), ["SEC", "SEC", "SEC", "Reuters", ""]);
    assert.equal(v.lines[0]!.time, "07:31 ET");
    // Wednesday evening carries its day; a record after Thursday's close says so.
    assert.equal(v.lines[1]!.time, "Wed 17:00 ET");
    assert.equal(v.lines[3]!.time, "16:30 ET");
    assert.deepEqual(v.lines.map((l) => l.afterClose), [false, false, false, true, false]);
    assert.equal(v.empty, null);
    assert.equal(v.note, null);
  });

  it("says so when nothing is on record, the absence being information too", () => {
    const v = todayView(base(), "2026-10-15", fmt);
    assert.deepEqual(v.lines, []);
    assert.equal(v.empty, "No filings or company news on record since yesterday's close.");
    assert.equal(todaySummary(base(), "2026-10-15", fmt), "FAST -3.1% today, 2.6 times its usual day beyond the market. No filings or company news on record since yesterday's close.");
  });

  it("does not call a source empty when it was not read", () => {
    const v = todayView(base({ degraded: ["sec", "peers"] }), "2026-10-15", fmt);
    assert.equal(v.empty, "Nothing on record since yesterday's close in the sources read.");
    assert.equal(v.note, "Not read this time: SEC filings, competitors.");
  });

  it("names the day of a session that is not today's, and of a close that is not yesterday's", () => {
    // Read on Saturday: Friday's session, from Thursday's close.
    const d = base({ day: "2026-10-16", previousDay: "2026-10-15" });
    const v = todayView(d, "2026-10-17", fmt);
    assert.equal(v.headline, "FAST -3.1% yesterday, 2.6 times its usual day beyond the market.");
    assert.equal(v.since, "since Thursday's close");
    const monday = todayView(base({ day: "2026-10-19", previousDay: "2026-10-16" }), "2026-10-19", fmt);
    assert.equal(monday.since, "since Friday's close");
    assert.equal(todayView(base({ day: "2026-10-16" }), "2026-10-19", fmt).headline.includes("on Friday"), true);
  });

  it("counts what is on record for the dashboard line", () => {
    const d = base({
      filings: [{ kind: "periodic", form: "10-Q", at: null, url: "https://www.sec.gov/q" }],
      news: [{ title: "x", url: "https://example.com", source: null, at: "2026-10-15T12:00:00.000Z" }],
    });
    assert.equal(todaySummary(d, "2026-10-15", fmt), "FAST -3.1% today, 2.6 times its usual day beyond the market. On record since yesterday's close: SEC filings 1, company news 1.");
  });
});
