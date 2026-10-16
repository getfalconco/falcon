import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FilingRef } from "../agents/sources";
import type { LiveQuote } from "../../shared/stock-types";
import type { Bar } from "../../shared/today-move";
import { createTodayService, sessionMove, type TodayDeps } from "./today";

/**
 * The Today reads with fake readers: an ordinary session reads a quote and
 * closes and nothing else; an unusual one reads every source, each fails soft
 * on its own, and the answer is kept a couple of minutes.
 */

// Thursday 2026-10-15, 11:00 New York: the session is open.
const NOW = Date.parse("2026-10-15T15:00:00Z");

/** Daily closes up to Wednesday, one per weekday, from a list of returns (oldest first). */
function closesTo(lastDay: string, returns: readonly number[]): Bar[] {
  const days: string[] = [];
  let d = new Date(`${lastDay}T12:00:00Z`);
  while (days.length < returns.length + 1) {
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) days.unshift(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() - 86_400_000);
  }
  let c = 100;
  return days.map((day, i) => {
    if (i > 0) c *= 1 + returns[i - 1]!;
    return { d: day, c };
  });
}

const N = 200;
const marketReturns = Array.from({ length: N }, (_, i) => (i % 2 === 0 ? 0.008 : -0.008));
const ownReturns = Array.from({ length: N }, (_, i) => (i % 4 < 2 ? 0.01 : -0.01));

function quote(symbol: string, regular: number, previous: number): LiveQuote {
  return { symbol, companyName: symbol, price: regular, change: regular - previous, changePercent: (regular / previous - 1) * 100, session: "regular", asOf: NOW, previousClose: previous, regularPrice: regular };
}

function deps(over: Partial<TodayDeps> & { stockMove?: number } = {}): TodayDeps & { calls: string[] } {
  const calls: string[] = [];
  const move = over.stockMove ?? -0.04;
  const base: TodayDeps = {
    now: () => NOW,
    quote: async (s) => {
      calls.push(`quote:${s}`);
      if (s === "SPY") return quote(s, 100.2, 100);
      if (s === "XLI") return quote(s, 100.5, 100);
      if (s === "GWW") return quote(s, 97, 100);
      if (s === "MSM") return quote(s, 100.1, 100);
      return quote(s, 100 * (1 + move), 100);
    },
    closes: async (s) => {
      calls.push(`closes:${s}`);
      return closesTo("2026-10-14", s === "SPY" ? marketReturns : ownReturns);
    },
    sector: async () => {
      calls.push("sector");
      return "Industrials";
    },
    filings: async (t): Promise<FilingRef[]> => {
      calls.push(`filings:${t}`);
      return [
        { cik: "1", form: "8-K", accession: "a", filedAt: "2026-10-15", acceptedAt: "2026-10-15T11:30:00.000Z", acceptedAtUtc: true, items: ["2.02", "9.01"], primaryDocument: "x.htm", url: "https://www.sec.gov/x.htm" },
        { cik: "1", form: "10-Q", accession: "b", filedAt: "2026-07-20", acceptedAt: "2026-07-20T11:30:00.000Z", acceptedAtUtc: true, items: [], primaryDocument: "q.htm", url: "https://www.sec.gov/q.htm" },
      ];
    },
    keptFilings: (t) => {
      calls.push(`kept:${t}`);
      return null;
    },
    form4: () => undefined,
    graphEdges: async () => {
      calls.push("graph");
      return [];
    },
    radar: async () => {
      calls.push("radar");
      return [];
    },
    material: async () => {
      calls.push("news");
      return [{ title: "Fastenal posts quarterly sales", url: "https://example.com/1", source: "Reuters", publishedAt: "2026-10-15T11:40:00Z", tickers: ["FAST"] }];
    },
    peers: async () => {
      calls.push("peers");
      return ["GWW", "MSM"];
    },
  };
  return Object.assign({ ...base, ...over }, { calls });
}

describe("today service", () => {
  it("reads the move from the regular print while the session is open", () => {
    const frame = { day: "2026-10-15", previousDay: "2026-10-14", sinceMs: 0, live: true };
    assert.ok(Math.abs(sessionMove(quote("X", 96, 100), [], frame)! + 0.04) < 1e-12);
    assert.equal(sessionMove({ ...quote("X", 96, 100), previousClose: undefined }, [], frame), null);
    // Before the open the closed session's bars answer, never the quote.
    const bars = [
      { d: "2026-10-14", c: 100 },
      { d: "2026-10-15", c: 103 },
    ];
    assert.ok(Math.abs(sessionMove(quote("X", 1, 2), bars, { ...frame, live: false })! - 0.03) < 1e-12);
  });

  it("reads nothing past the quotes and closes on an ordinary session", async () => {
    const d = deps({ stockMove: 0.004 });
    const answer = await createTodayService(d).today("FAST");
    assert.ok(answer);
    assert.equal(answer.unusual, false);
    assert.deepEqual(answer.filings, []);
    assert.ok(d.calls.every((c) => c.startsWith("quote:") || c.startsWith("closes:")), d.calls.join(" "));
  });

  it("lists what is on record on an unusual session", async () => {
    const d = deps();
    const answer = await createTodayService(d).today("FAST");
    assert.ok(answer?.unusual);
    assert.equal(answer.day, "2026-10-15");
    assert.equal(answer.previousDay, "2026-10-14");
    assert.equal(answer.since, "2026-10-14T20:00:00.000Z");
    assert.deepEqual(answer.sector, { symbol: "XLI", move: answer.sector!.move });
    assert.equal(answer.filings.length, 1);
    assert.equal(answer.filings[0]!.kind, "current");
    assert.equal(answer.news.length, 1);
    assert.deepEqual(answer.peers.map((p) => p.ticker), ["GWW"]);
    assert.equal(answer.peersRead, 2);
    assert.deepEqual(answer.degraded, []);
  });

  it("goes without a source that fails, and says which", async () => {
    const d = deps({
      filings: async () => {
        throw new Error("SEC down");
      },
      material: async () => {
        throw new Error("feed down");
      },
    });
    const answer = await createTodayService(d).today("FAST");
    assert.ok(answer?.unusual);
    assert.deepEqual(answer.degraded.sort(), ["news", "sec"]);
    assert.equal(answer.peers.length, 1);
  });

  it("answers null when the market move or the history is missing", async () => {
    const noMarket = deps({
      quote: async (s) => {
        if (s === "SPY") throw new Error("no quote");
        return quote(s, 96, 100);
      },
    });
    assert.equal(await createTodayService(noMarket).today("FAST"), null);
    const short = deps({ closes: async () => closesTo("2026-10-14", ownReturns.slice(0, 20)) });
    assert.equal(await createTodayService(short).today("FAST"), null);
  });

  it("keeps an answer a couple of minutes, and shares a read in flight", async () => {
    let now = NOW;
    const d = deps({ now: () => now });
    const svc = createTodayService(d);
    await Promise.all([svc.today("FAST"), svc.today("FAST")]);
    const first = d.calls.filter((c) => c === "filings:FAST").length;
    assert.equal(first, 1);
    await svc.today("FAST");
    assert.equal(d.calls.filter((c) => c === "filings:FAST").length, 1);
    now += 3 * 60_000;
    await svc.today("FAST");
    assert.equal(d.calls.filter((c) => c === "filings:FAST").length, 2);
  });

  it("lists the held names moving unusually, the largest first", async () => {
    const d = deps({
      quote: async (s) => {
        if (s === "SPY") return quote(s, 100.2, 100);
        if (s === "AAA") return quote(s, 95, 100);
        if (s === "BBB") return quote(s, 100.3, 100);
        if (s === "CCC") return quote(s, 103, 100);
        return quote(s, 100, 100);
      },
    });
    const list = await createTodayService(d).unusual(["AAA", "BBB", "CCC"]);
    assert.deepEqual(list.map((x) => x.ticker), ["AAA", "CCC"]);
  });
});
