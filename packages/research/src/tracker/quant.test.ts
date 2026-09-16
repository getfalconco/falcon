import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TRACKER_CONFIG } from "./config.js";
import { alignBars, computeContextFlags, computeQuantContext, volumeBaseline } from "./quant.js";
import { emptyTickerState } from "./store.js";
import { addTradingDays } from "./calendar.js";
import type { DailyBar, TickerState } from "./types.js";

const CONFIG = DEFAULT_TRACKER_CONFIG;

const bar = (d: string, c: number, v = 1_000_000, o = c): DailyBar => ({
  d,
  o,
  h: Math.max(o, c),
  l: Math.min(o, c),
  c,
  v,
});

/** Three consecutive trading days (Aug 13–17 2026 skips the weekend). */
const DAYS = ["2026-08-13", "2026-08-14", "2026-08-17"];

function stateWith(bars: DailyBar[]): TickerState {
  const state = emptyTickerState("TEST", "2026-08-17T00:00:00.000Z");
  state.bars = bars;
  state.barsAsOf = bars[bars.length - 1]?.d ?? null;
  return state;
}

describe("move_today baseline selection", () => {
  const tickerBars = [bar(DAYS[0], 100), bar(DAYS[1], 100), bar(DAYS[2], 104)];
  const benchBars = [bar(DAYS[0], 500), bar(DAYS[1], 500), bar(DAYS[2], 505)];

  it("with no quote, the latest bar is today and the bar before it is the baseline", () => {
    // Regression guard: comparing the latest bar against itself reports a 0%
    // move and silently disables every close-run detector.
    const quant = computeQuantContext({
      state: stateWith(tickerBars),
      benchBars,
      config: CONFIG,
      now: new Date("2026-08-17T21:30:00.000Z"),
      quote: null,
      benchQuote: null,
    });
    assert.equal(quant.prev_close, 100);
    assert.equal(quant.last_price, 104);
    assert.ok(quant.move_today != null && Math.abs(quant.move_today - 0.04) < 1e-12);
  });

  it("a quote inside the latest bar's day replaces its close, keeping the same baseline", () => {
    const quant = computeQuantContext({
      state: stateWith(tickerBars),
      benchBars,
      config: CONFIG,
      now: new Date("2026-08-17T17:00:00.000Z"),
      quote: {
        price: 106,
        asof: "2026-08-17T17:00:00.000Z",
        session: "regular",
        intradayVolume: null,
      },
      benchQuote: null,
    });
    assert.equal(quant.prev_close, 100);
    assert.equal(quant.last_price, 106);
    assert.ok(quant.move_today != null && Math.abs(quant.move_today - 0.06) < 1e-12);
  });

  it("a quote for a day the bars do not cover yet uses the latest bar as baseline", () => {
    const quant = computeQuantContext({
      state: stateWith(tickerBars),
      benchBars,
      config: CONFIG,
      now: new Date("2026-08-18T17:00:00.000Z"),
      quote: {
        price: 109.2,
        asof: "2026-08-18T17:00:00.000Z",
        session: "regular",
        intradayVolume: null,
      },
      benchQuote: null,
    });
    assert.equal(quant.prev_close, 104);
    assert.ok(quant.move_today != null && Math.abs(quant.move_today - 0.05) < 1e-12);
  });

  it("session comes from the quote when present, else from the clock", () => {
    const afterClose = computeQuantContext({
      state: stateWith(tickerBars),
      benchBars,
      config: CONFIG,
      now: new Date("2026-08-17T21:30:00.000Z"),
      quote: null,
      benchQuote: null,
    });
    assert.equal(afterClose.session, "post");
    assert.equal(afterClose.volume_ratio_partial, false);

    const midSession = computeQuantContext({
      state: stateWith(tickerBars),
      benchBars,
      config: CONFIG,
      now: new Date("2026-08-17T17:00:00.000Z"),
      quote: {
        price: 106,
        asof: "2026-08-17T17:00:00.000Z",
        session: "regular",
        intradayVolume: 500_000,
      },
      benchQuote: null,
    });
    assert.equal(midSession.session, "regular");
    assert.equal(midSession.volume_ratio_partial, true);
  });
});

describe("return alignment (T1.3)", () => {
  // 120 trading days; ticker price = 3 × bench price, so their return series
  // are identical and any consistent alignment yields beta = 1, r² = 1.
  const days = (() => {
    const out = ["2026-01-02"];
    while (out.length < 120) out.push(addTradingDays(out[out.length - 1], 1));
    return out;
  })();
  const price = (i: number) => 100 * (1 + 0.003 * Math.sin(i * 1.7) + 0.001 * (i % 7));
  const benchFull = days.map((d, i) => bar(d, price(i)));
  const tickerBars = days.map((d, i) => bar(d, 3 * price(i)));

  it("a deliberately removed benchmark day does not shift the pairing", () => {
    // Drop one mid-series bench day. Positional pairing would offset every
    // later pair by one and crush r²; date-keyed pairing stays perfect.
    const benchGap = benchFull.filter((_, i) => i !== 60);
    const aligned = alignBars(tickerBars, benchGap);
    assert.equal(aligned.ticker.length, 119);
    for (let i = 0; i < aligned.ticker.length; i++) {
      assert.equal(aligned.ticker[i].d, aligned.bench[i].d, "pair dates must match");
    }

    const quant = computeQuantContext({
      state: stateWith(tickerBars),
      benchBars: benchGap,
      config: CONFIG,
      now: new Date("2026-08-17T21:30:00.000Z"),
      quote: null,
      benchQuote: null,
    });
    assert.ok(quant.beta_90d != null && Math.abs(quant.beta_90d - 1) < 1e-9, `beta ${quant.beta_90d}`);
    assert.ok(quant.r_squared != null && quant.r_squared > 0.999999, `r² ${quant.r_squared}`);
  });

  it("a removed ticker day is likewise harmless", () => {
    const tickerGap = tickerBars.filter((_, i) => i !== 45);
    const quant = computeQuantContext({
      state: stateWith(tickerGap),
      benchBars: benchFull,
      config: CONFIG,
      now: new Date("2026-08-17T21:30:00.000Z"),
      quote: null,
      benchQuote: null,
    });
    assert.ok(quant.r_squared != null && quant.r_squared > 0.999999);
  });
});

describe("completed-session snapshots", () => {
  const tickerBars = [bar(DAYS[0], 100), bar(DAYS[1], 100), bar(DAYS[2], 104)];
  const benchBars = [bar(DAYS[0], 500), bar(DAYS[1], 500), bar(DAYS[2], 505)];

  it("never flags volume partial, whatever the wall clock says", () => {
    // The close-run reads a finished daily bar, so its volume is a full-day
    // figure even if the run happens during the next pre-market session.
    const quant = computeQuantContext({
      state: stateWith(tickerBars),
      benchBars,
      config: CONFIG,
      now: new Date("2026-08-18T11:56:00.000Z"), // pre-market the next day
      quote: null,
      benchQuote: null,
      asOfCompletedSession: true,
    });
    assert.equal(quant.volume_ratio_partial, false);
    assert.equal(quant.session, "closed");
  });

  it("without the flag, the same inputs follow the clock", () => {
    const quant = computeQuantContext({
      state: stateWith(tickerBars),
      benchBars,
      config: CONFIG,
      now: new Date("2026-08-18T11:56:00.000Z"),
      quote: null,
      benchQuote: null,
    });
    assert.equal(quant.session, "pre");
    assert.equal(quant.volume_ratio_partial, true);
  });
});

describe("insufficient history (§3.11)", () => {
  it("every windowed statistic is null, never zero", () => {
    const quant = computeQuantContext({
      state: stateWith([bar(DAYS[0], 100), bar(DAYS[1], 102)]),
      benchBars: [bar(DAYS[0], 500), bar(DAYS[1], 505)],
      config: CONFIG,
      now: new Date("2026-08-14T21:30:00.000Z"),
      quote: null,
      benchQuote: null,
    });
    assert.equal(quant.beta_90d, null);
    assert.equal(quant.r_squared, null);
    assert.equal(quant.daily_vol_30d, null);
    assert.equal(quant.vol_regime, null);
    assert.equal(quant.move_zscore, null);
    assert.equal(quant.residual_move, null);
    assert.equal(quant.residual_zscore, null);
    assert.equal(quant.momentum_5d, null);
    assert.equal(quant.pct_from_52w_high, null);
    assert.equal(quant.earnings_rhythm, null);
    assert.equal(quant.volume_ratio, null); // 20-day baseline not covered
    // Prices themselves are observed, not derived, so they stay populated.
    assert.equal(quant.last_price, 102);
    assert.equal(quant.prev_close, 100);
  });
});

describe("volumeBaseline", () => {
  const days = Array.from({ length: 25 }, (_, i) => `2026-0${i < 9 ? "1" : "2"}-${String((i % 28) + 1).padStart(2, "0")}`);

  it("is the median of the trailing 20 volumes", () => {
    const bars = days.map((d, i) => bar(d, 100, (i + 1) * 1_000));
    // Trailing 20 volumes are 6k…25k → median = (15k + 16k)/2.
    assert.equal(volumeBaseline(bars, 20), 15_500);
  });

  it("is null before the window is covered (§3.11)", () => {
    assert.equal(volumeBaseline(days.slice(0, 10).map((d) => bar(d, 100)), 20), null);
  });

  it("returns null while a split leaves the window only partly covered", () => {
    // 25 bars, split at index 15 → only 10 post-split days. Mixing in the
    // pre-split 10M-share days would make today look like a volume collapse.
    const bars = days.map((d, i) => bar(d, 100, i < 15 ? 10_000_000 : 1_000));
    assert.equal(volumeBaseline(bars, 20, days[15]), null);
  });

  it("uses post-split days once enough of them exist", () => {
    const bars = days.map((d, i) => bar(d, 100, i < 5 ? 10_000_000 : (i + 1) * 1_000));
    // Post-split days are indices 5…24 — exactly the 20-day window.
    assert.equal(volumeBaseline(bars, 20, days[5]), 15_500);
  });
});

describe("context_flags", () => {
  it("flags ±1 trading day around an earnings date", () => {
    const state = stateWith([bar(DAYS[0], 100)]);
    state.earnings = [{ date: "2026-08-14", fiscalPeriod: "Q2", hour: "amc" }];
    assert.deepEqual(computeContextFlags(state, "2026-08-14"), ["earnings_window"]);
    assert.deepEqual(computeContextFlags(state, "2026-08-13"), ["earnings_window"]);
    assert.deepEqual(computeContextFlags(state, "2026-08-17"), ["earnings_window"]); // next session
    assert.deepEqual(computeContextFlags(state, "2026-08-18"), []);
  });

  it("also flags around a scheduled (not yet reported) date", () => {
    const state = stateWith([bar(DAYS[0], 100)]);
    state.scheduledEarnings = [
      { dueAt: "2026-08-20T20:00:00.000Z", fiscalPeriod: "Q3", confirmed: true },
    ];
    assert.deepEqual(computeContextFlags(state, "2026-08-20"), ["earnings_window"]);
  });
});
