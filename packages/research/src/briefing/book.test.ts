import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { LARGE_MOVE_PCT, buildBook, heldMover, heldMovers, mergeHoldings, positionValues } from "./book.js";
import type { BriefingBook, BriefingHolding, HeldQuote, QuantSlice } from "./types.js";

const AS_OF = "2026-09-21T11:30:00.000Z";
const PRICED_AT = "2026-09-21T11:31:00.000Z";

function quote(symbol: string, over: Partial<HeldQuote> = {}): HeldQuote {
  return {
    symbol,
    price: 100,
    regular_price: 100,
    previous_close: 100,
    session: "pre",
    as_of: AS_OF,
    ...over,
  };
}

function hold(symbol: string, shares: number, cost_usd: number): BriefingHolding {
  return { symbol, shares, cost_usd };
}

function quotesOf(...quotes: HeldQuote[]): Map<string, HeldQuote | null> {
  return new Map(quotes.map((q) => [q.symbol, q]));
}

function assertNoNaN(book: BriefingBook): void {
  for (const [key, value] of Object.entries(book)) {
    if (typeof value === "number") assert.ok(Number.isFinite(value), `${key} is ${value}`);
  }
  for (const w of book.top_weights) assert.ok(Number.isFinite(w.weight), `${w.ticker} weight is ${w.weight}`);
}

describe("briefing/book: heldMover", () => {
  it("measures a pre-open move from the previous US close, not from the close before it", () => {
    const mover = heldMover(
      hold("NVDA", 10, 1700),
      quote("NVDA", { price: 183.6, regular_price: 180, previous_close: 171 }),
      { daily_vol_30d: 2.5, beta: 1.8 },
      "pre_open",
      false,
    );
    assert.deepEqual(mover, {
      ticker: "NVDA",
      last: 183.6,
      ref_close: 180,
      move_pct: 2,
      move_z: 0.8,
      pnl_usd: 36,
      basis: "since_close",
      session: "pre",
      as_of: AS_OF,
      flag: null,
      beta: 1.8,
      daily_vol_pct: 2.5,
    });
  });

  it("uses the same reference between sessions", () => {
    const mover = heldMover(
      hold("NVDA", 10, 1700),
      quote("NVDA", { price: 178.2, regular_price: 180, previous_close: 171, session: "post" }),
      null,
      "between_sessions",
      false,
    );
    assert.equal(mover?.basis, "since_close");
    assert.equal(mover?.ref_close, 180);
    assert.equal(mover?.move_pct, -1);
    assert.equal(mover?.session, "post");
  });

  it("falls back to the previous close when the provider gave no regular price", () => {
    const mover = heldMover(hold("NVDA", 10, 1700), quote("NVDA", { price: 174.42, regular_price: null, previous_close: 171 }), null, "pre_open", false);
    assert.equal(mover?.basis, "since_close");
    assert.equal(mover?.ref_close, 171);
    assert.equal(mover?.move_pct, 2);
  });

  it("measures today's move against the previous close while the US session trades", () => {
    const mover = heldMover(
      hold("NVDA", 10, 1700),
      quote("NVDA", { price: 176.13, regular_price: 176.13, previous_close: 171, session: "regular" }),
      { daily_vol_30d: 2, beta: null },
      "in_session",
      false,
    );
    assert.equal(mover?.basis, "today");
    assert.equal(mover?.ref_close, 171);
    assert.equal(mover?.move_pct, 3);
    assert.equal(mover?.move_z, 1.5);
    assert.equal(mover?.pnl_usd, 51.3);
    assert.equal(mover?.session, "regular");
  });

  it("gains on a borrowed position when the price falls, and loses when it rises", () => {
    const fell = heldMover(hold("TSLA", -5, -2000), quote("TSLA", { price: 392, regular_price: 400 }), null, "pre_open", false);
    assert.equal(fell?.move_pct, -2);
    assert.equal(fell?.pnl_usd, 40);

    const rose = heldMover(hold("TSLA", -5, -2000), quote("TSLA", { price: 410, regular_price: 400 }), null, "pre_open", false);
    assert.equal(rose?.move_pct, 2.5);
    assert.equal(rose?.pnl_usd, -50);
  });

  it("returns nothing without a quote, a price, a reference close or a print time", () => {
    const h = hold("AAPL", 3, 600);
    assert.equal(heldMover(h, null, null, "pre_open", false), null);
    assert.equal(heldMover(h, quote("AAPL", { price: null }), null, "pre_open", false), null);
    assert.equal(heldMover(h, quote("AAPL", { price: 0 }), null, "pre_open", false), null);
    assert.equal(heldMover(h, quote("AAPL", { regular_price: null, previous_close: null }), null, "pre_open", false), null);
    assert.equal(heldMover(h, quote("AAPL", { previous_close: null }), null, "in_session", false), null);
    assert.equal(heldMover(h, quote("AAPL", { as_of: null }), null, "pre_open", false), null);
    assert.equal(heldMover(hold("AAPL", Number.NaN, 600), quote("AAPL"), null, "pre_open", false), null);
  });

  it("leaves the volatility multiple empty for an untracked name or a zero volatility", () => {
    const q = quote("AAPL", { price: 101 });
    assert.equal(heldMover(hold("AAPL", 1, 100), q, null, "pre_open", false)?.move_z, null);
    assert.equal(heldMover(hold("AAPL", 1, 100), q, { daily_vol_30d: null, beta: 1 }, "pre_open", false)?.move_z, null);
    assert.equal(heldMover(hold("AAPL", 1, 100), q, { daily_vol_30d: 0, beta: 1 }, "pre_open", false)?.move_z, null);
  });

  it("carries beta and volatility as the chain gives them, and nothing it does not", () => {
    const q = quote("AAPL", { price: 101 });
    const tracked = heldMover(hold("AAPL", 1, 100), q, { daily_vol_30d: 1.4, beta: -0.35 }, "pre_open", false);
    assert.equal(tracked?.beta, -0.35);
    assert.equal(tracked?.daily_vol_pct, 1.4);
    const untracked = heldMover(hold("AAPL", 1, 100), q, null, "pre_open", false);
    assert.equal(untracked?.beta, null);
    assert.equal(untracked?.daily_vol_pct, null);
    // A zero volatility would size a "normal day" at nothing; an unreadable beta is no beta.
    const broken = heldMover(hold("AAPL", 1, 100), q, { daily_vol_30d: 0, beta: Number.NaN }, "pre_open", false);
    assert.equal(broken?.beta, null);
    assert.equal(broken?.daily_vol_pct, null);
  });

  it("defaults a missing session to closed and upper-cases the ticker", () => {
    const mover = heldMover(hold(" brk.b ", 1, 480), quote("BRK.B", { session: null }), null, "pre_open", false);
    assert.equal(mover?.session, "closed");
    assert.equal(mover?.ticker, "BRK.B");
  });

  it("withholds the move on a split day instead of printing a 90 percent loss", () => {
    // 10-for-1: the print is post-split, the provider's close is not adjusted yet.
    const mover = heldMover(
      hold("NFLX", 10, 12000),
      quote("NFLX", { price: 121, regular_price: 1200, previous_close: 1190 }),
      { daily_vol_30d: 2, beta: 1.1 },
      "pre_open",
      true,
    );
    assert.equal(mover?.flag, "corporate_action_check");
    assert.equal(mover?.move_pct, 0);
    assert.equal(mover?.pnl_usd, 0);
    assert.equal(mover?.move_z, null);
    assert.equal(mover?.last, 121);
    assert.equal(mover?.ref_close, 1200);
    // What describes the name survives the withheld move.
    assert.equal(mover?.beta, 1.1);
    assert.equal(mover?.daily_vol_pct, 2);
  });

  it("flags a move beyond the threshold but keeps its figures", () => {
    assert.equal(LARGE_MOVE_PCT, 35);
    const big = heldMover(hold("BIOX", 100, 2000), quote("BIOX", { price: 12, regular_price: 20 }), null, "pre_open", false);
    assert.equal(big?.flag, "corporate_action_check");
    assert.equal(big?.move_pct, -40);
    assert.equal(big?.pnl_usd, -800);

    const atThreshold = heldMover(hold("BIOX", 100, 2000), quote("BIOX", { price: 27, regular_price: 20 }), null, "pre_open", false);
    assert.equal(atThreshold?.move_pct, 35);
    assert.equal(atThreshold?.flag, null);

    const justOver = heldMover(hold("BIOX", 100, 2000), quote("BIOX", { price: 27.01, regular_price: 20 }), null, "pre_open", false);
    assert.equal(justOver?.flag, "corporate_action_check");
  });
});

describe("briefing/book: heldMovers", () => {
  const holdings = [hold("AAPL", 10, 2000), hold("MSFT", 4, 2000), hold("TSLA", -5, -2000), hold("BIOX", 100, 2000), hold("NFLX", 10, 12000), hold("GONE", 1, 50)];
  const quotes = quotesOf(
    quote("AAPL", { price: 202, regular_price: 200 }),
    quote("MSFT", { price: 485, regular_price: 500 }),
    quote("TSLA", { price: 392, regular_price: 400 }),
    quote("BIOX", { price: 12, regular_price: 20 }),
    quote("NFLX", { price: 121, regular_price: 1200 }),
  );
  quotes.set("GONE", null);

  it("sorts by the size of the move, with flagged rows last", () => {
    const quants = new Map<string, QuantSlice | null>([["MSFT", { daily_vol_30d: 1.5, beta: 1 }]]);
    const movers = heldMovers(holdings, quotes, quants, "pre_open", new Set(["nflx"]));
    assert.deepEqual(movers.map((m) => m.ticker), ["MSFT", "TSLA", "AAPL", "BIOX", "NFLX"]);
    assert.deepEqual(movers.map((m) => m.move_pct), [-3, -2, 1, -40, 0]);
    assert.deepEqual(movers.map((m) => m.flag), [null, null, null, "corporate_action_check", "corporate_action_check"]);
    assert.equal(movers[0]?.move_z, -2);
    assert.equal(movers[1]?.move_z, null);
  });

  it("breaks ties by ticker so the order is stable", () => {
    const tied = heldMovers(
      [hold("ZZZ", 1, 100), hold("AAA", 1, 100)],
      quotesOf(quote("ZZZ", { price: 101 }), quote("AAA", { price: 99 })),
      new Map(),
      "pre_open",
      new Set(),
    );
    assert.deepEqual(tied.map((m) => m.ticker), ["AAA", "ZZZ"]);
  });

  it("merges duplicate lots into one row and finds quotes whatever their case", () => {
    const movers = heldMovers(
      [hold("aapl", 4, 800), hold("AAPL", 6, 1200)],
      quotesOf(quote("Aapl", { price: 202, regular_price: 200 })),
      new Map(),
      "pre_open",
      new Set(),
    );
    assert.equal(movers.length, 1);
    assert.equal(movers[0]?.ticker, "AAPL");
    assert.equal(movers[0]?.pnl_usd, 20);
  });

  it("returns an empty list for an empty book", () => {
    assert.deepEqual(heldMovers([], new Map(), new Map(), "pre_open", new Set()), []);
  });
});

describe("briefing/book: mergeHoldings", () => {
  it("sums shares and cost per upper-cased symbol and drops flat or unreadable rows", () => {
    const merged = mergeHoldings([
      hold("aapl", 4, 800),
      hold(" AAPL ", 6, 1200),
      hold("DUST", 1e-12, 0.0001),
      hold("NETS", 5, 500),
      hold("NETS", -5, -480),
      hold("BAD", Number.NaN, 100),
      hold("", 3, 100),
      hold("TSLA", -5, -2000),
    ]);
    assert.deepEqual(merged, [hold("AAPL", 10, 2000), hold("TSLA", -5, -2000)]);
  });

  it("leaves the caller's holdings untouched", () => {
    const original = [hold("AAPL", 4, 800), hold("AAPL", 6, 1200)];
    mergeHoldings(original);
    assert.deepEqual(original, [hold("AAPL", 4, 800), hold("AAPL", 6, 1200)]);
  });
});

describe("briefing/book: buildBook", () => {
  it("marks bought and borrowed positions to market with signed values", () => {
    const book = buildBook(
      [hold("AAPL", 10, 1900), hold("TSLA", -5, -2000)],
      5000,
      quotesOf(quote("AAPL", { price: 202, regular_price: 200 }), quote("TSLA", { price: 392, regular_price: 400 })),
      "pre_open",
      PRICED_AT,
    );
    // AAPL +2020, TSLA -1960: equity 5000 + 60.
    assert.equal(book.position_count, 2);
    assert.equal(book.cash_usd, 5000);
    assert.equal(book.invested_usd, 3980);
    assert.equal(book.equity_usd, 5060);
    assert.equal(book.net_exposure_pct, 1.19);
    assert.equal(book.gross_exposure_pct, 78.66);
    // AAPL +20, TSLA +40 on the fall.
    assert.equal(book.overnight_pnl_usd, 60);
    assert.equal(book.overnight_pnl_pct, 1.2);
    assert.deepEqual(book.top_weights, [
      { ticker: "AAPL", weight: 0.5075, side: "long" },
      { ticker: "TSLA", weight: 0.4925, side: "short" },
    ]);
    assert.deepEqual(book.unpriced, []);
    assert.equal(book.priced_at, PRICED_AT);
    assertNoNaN(book);
  });

  it("carries an unpriced position at cost and lists it", () => {
    const quotes = quotesOf(quote("AAPL", { price: 202, regular_price: 200 }), quote("HALT", { price: null }));
    quotes.set("SHRT", null);
    const book = buildBook([hold("AAPL", 10, 1900), hold("HALT", 50, 1000), hold("SHRT", -20, -600), hold("NOQT", 1, 80)], 1000, quotes, "pre_open", PRICED_AT);
    assert.deepEqual(book.unpriced, ["HALT", "SHRT", "NOQT"]);
    assert.equal(book.position_count, 4);
    assert.equal(book.invested_usd, 3700);
    assert.equal(book.equity_usd, 3500);
    // Only the priced name has a move to count.
    assert.equal(book.overnight_pnl_usd, 20);
    assert.equal(book.top_weights.find((w) => w.ticker === "SHRT")?.side, "short");
    assertNoNaN(book);
  });

  it("gives an unsigned cost the sign of the shares", () => {
    const book = buildBook([hold("SHRT", -20, 600)], 2000, new Map(), "pre_open", PRICED_AT);
    assert.equal(book.equity_usd, 1400);
    assert.equal(book.net_exposure_pct, -42.86);
    assert.equal(book.gross_exposure_pct, 42.86);
  });

  it("returns zeros and nulls, never NaN, for an empty book", () => {
    const book = buildBook([], 0, new Map(), "pre_open", PRICED_AT);
    assert.deepEqual(book, {
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
      pnl_excluded: [],
      priced_at: PRICED_AT,
    });

    const cashOnly = buildBook([hold("FLAT", 0, 0)], 2500.129, new Map(), "between_sessions", PRICED_AT);
    assert.equal(cashOnly.position_count, 0);
    assert.equal(cashOnly.equity_usd, 2500.13);
    assert.equal(cashOnly.overnight_pnl_usd, null);
    assertNoNaN(cashOnly);

    const badCash = buildBook([], Number.NaN, new Map(), "pre_open", PRICED_AT);
    assert.equal(badCash.cash_usd, 0);
    assertNoNaN(badCash);
  });

  it("reports no exposure percentages when equity is not positive", () => {
    const book = buildBook([hold("TSLA", -10, -3000)], 3500, quotesOf(quote("TSLA", { price: 400, regular_price: 300 })), "pre_open", PRICED_AT);
    assert.equal(book.equity_usd, -500);
    assert.equal(book.net_exposure_pct, 0);
    assert.equal(book.gross_exposure_pct, 0);
    assert.equal(book.overnight_pnl_usd, -1000);
    // The book was worth 500 before the move, so the loss is measurable.
    assert.equal(book.overnight_pnl_pct, -200);
    assertNoNaN(book);
  });

  it("withholds the P&L percentage when the book was worth nothing before the move", () => {
    const book = buildBook([hold("TSLA", -10, -3000)], 2900, quotesOf(quote("TSLA", { price: 310, regular_price: 300 })), "pre_open", PRICED_AT);
    assert.equal(book.overnight_pnl_usd, -100);
    assert.equal(book.overnight_pnl_pct, null);
  });

  it("merges duplicate symbols before counting and weighting", () => {
    const book = buildBook(
      [hold("aapl", 4, 800), hold("AAPL", 6, 1200), hold("MSFT", 2, 1000)],
      0,
      quotesOf(quote("AAPL", { price: 200, regular_price: 200 }), quote("MSFT", { price: 500, regular_price: 500 })),
      "pre_open",
      PRICED_AT,
    );
    assert.equal(book.position_count, 2);
    assert.equal(book.invested_usd, 3000);
    assert.deepEqual(book.top_weights.map((w) => [w.ticker, w.weight]), [["AAPL", 0.6667], ["MSFT", 0.3333]]);
    assert.equal(book.overnight_pnl_usd, 0);
    assert.equal(book.overnight_pnl_pct, 0);
  });

  it("keeps the five largest weights, which sum to about one over a five-name book", () => {
    const names = ["AAA", "BBB", "CCC", "DDD", "EEE", "FFF", "GGG"];
    const holdings = names.map((n, i) => hold(n, i % 2 === 0 ? i + 1 : -(i + 1), (i + 1) * 100));
    const quotes = quotesOf(...names.map((n) => quote(n, { price: 37.3, regular_price: 37 })));

    const seven = buildBook(holdings, 10000, quotes, "pre_open", PRICED_AT);
    assert.deepEqual(seven.top_weights.map((w) => w.ticker), ["GGG", "FFF", "EEE", "DDD", "CCC"]);
    assert.deepEqual(seven.top_weights.map((w) => w.side), ["long", "short", "long", "short", "long"]);
    assert.ok(seven.top_weights.every((w) => w.weight > 0 && w.weight <= 1));

    const five = buildBook(holdings.slice(0, 5), 10000, quotes, "pre_open", PRICED_AT);
    const total = five.top_weights.reduce((sum, w) => sum + w.weight, 0);
    assert.ok(Math.abs(total - 1) < 1e-3, `weights sum to ${total}`);
  });

  it("uses today's basis for the P&L while the US session trades", () => {
    const book = buildBook(
      [hold("AAPL", 10, 1900)],
      0,
      quotesOf(quote("AAPL", { price: 204, regular_price: 204, previous_close: 200, session: "regular" })),
      "in_session",
      PRICED_AT,
    );
    assert.equal(book.overnight_pnl_usd, 40);
    assert.equal(book.overnight_pnl_pct, 2);
  });

  it("counts a position whose quote has no print time, since its price still marks the book", () => {
    const book = buildBook([hold("AAPL", 10, 1900)], 0, quotesOf(quote("AAPL", { price: 202, regular_price: 200, as_of: null })), "pre_open", PRICED_AT);
    assert.deepEqual(book.unpriced, []);
    assert.equal(book.overnight_pnl_usd, 20);
  });

  it("leaves a split name out of the P&L when the caller names it", () => {
    const holdings = [hold("NFLX", 10, 12000), hold("AAPL", 10, 1900)];
    const quotes = quotesOf(quote("NFLX", { price: 121, regular_price: 1200 }), quote("AAPL", { price: 202, regular_price: 200 }));

    const unaware = buildBook(holdings, 0, quotes, "pre_open", PRICED_AT);
    assert.equal(unaware.overnight_pnl_usd, -10770);

    const aware = buildBook(holdings, 0, quotes, "pre_open", PRICED_AT, new Set(["nflx"]));
    assert.equal(aware.overnight_pnl_usd, 20);

    const onlySplit = buildBook([hold("NFLX", 10, 12000)], 0, quotes, "pre_open", PRICED_AT, new Set(["NFLX"]));
    assert.equal(onlySplit.overnight_pnl_usd, null);
    assert.equal(onlySplit.overnight_pnl_pct, null);
  });

  it("names the positions the P&L leaves out, whether they split or never priced", () => {
    const holdings = [hold("NFLX", 10, 12000), hold("AAPL", 10, 1900), hold("HALT", 50, 1000)];
    const quotes = quotesOf(
      quote("NFLX", { price: 121, regular_price: 1200 }),
      quote("AAPL", { price: 202, regular_price: 200 }),
      quote("HALT", { price: null }),
    );

    const book = buildBook(holdings, 0, quotes, "pre_open", PRICED_AT, new Set(["NFLX"]));
    // NFLX is valued at 1210 and HALT at its 1000 cost, so both sit inside the
    // equity the 20 is expressed over while neither is inside the 20 itself.
    assert.deepEqual(book.pnl_excluded, ["NFLX", "HALT"]);
    assert.deepEqual(book.unpriced, ["HALT"]);
    assert.equal(book.overnight_pnl_usd, 20);

    const whole = buildBook([hold("AAPL", 10, 1900)], 0, quotes, "pre_open", PRICED_AT);
    assert.deepEqual(whole.pnl_excluded, []);
  });
});

describe("briefing/book: positionValues", () => {
  it("values each merged position the way the book does, signed, at cost when unpriced", () => {
    const holdings = [hold("aapl", 4, 800), hold("AAPL", 6, 1200), hold("TSLA", -5, -2000), hold("HALT", 50, 1000), hold("SHRT", -20, 600), hold("FLAT", 0, 10)];
    const quotes = quotesOf(quote("AAPL", { price: 202 }), quote("TSLA", { price: 392 }), quote("HALT", { price: 0 }));
    assert.deepEqual(positionValues(holdings, quotes), [
      { ticker: "AAPL", market_value: 2020, priced: true },
      { ticker: "TSLA", market_value: -1960, priced: true },
      { ticker: "HALT", market_value: 1000, priced: false },
      { ticker: "SHRT", market_value: -600, priced: false },
    ]);
  });

  it("sums, in absolute value, to the book's invested figure", () => {
    const holdings = [hold("AAPL", 10, 1900), hold("HALT", 50, 1000), hold("SHRT", -20, -600), hold("NOQT", 1, 80)];
    const quotes = quotesOf(quote("AAPL", { price: 202, regular_price: 200 }), quote("HALT", { price: null }));
    const gross = positionValues(holdings, quotes).reduce((sum, p) => sum + Math.abs(p.market_value), 0);
    assert.equal(gross, buildBook(holdings, 1000, quotes, "pre_open", PRICED_AT).invested_usd);
  });

  it("returns an empty list for an empty book", () => {
    assert.deepEqual(positionValues([], new Map()), []);
  });
});
