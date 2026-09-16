import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildSeriesView } from "../screen/series.js";
import { barsFrom, cfg, synthetic, tradingDays } from "../screen/test-fixtures.js";
import { TradingCalendar } from "./calendar.js";
import { buildQuantSeries, detectGaps, snapshotAsOf, snapshotAt } from "./series.js";

const WINDOWS = cfg().windows;

/** Every scalar a strategy can read. If a field is added, this list must grow. */
const SCALARS = [
  "beta",
  "r2",
  "daily_vol",
  "vol_regime",
  "momentum_5d",
  "momentum_20d",
  "range_10s",
  "pct_from_52w_high",
  "pct_from_52w_low",
] as const;

describe("quantlab/series — equivalence with Screen's point-in-time view", () => {
  const { ticker, bench } = synthetic({ n: 320, seed: 11 });

  it("every snapshot equals buildSeriesView evaluated at that session", () => {
    const series = buildQuantSeries({ ticker: "TEST", bars: ticker, benchBars: bench, windows: WINDOWS });
    assert.ok(series.snapshots.length > 300, `expected a full series, got ${series.snapshots.length}`);

    for (const snap of series.snapshots) {
      const view = buildSeriesView({ ticker: "TEST", bars: ticker, benchBars: bench, session: snap.d, windows: WINDOWS });
      for (const key of SCALARS) {
        assert.deepEqual(snap[key], view[key], `${key} disagreed at ${snap.d}`);
      }
      assert.equal(snap.history_sessions, view.history_sessions, `history_sessions at ${snap.d}`);
      const last = view.sessions[view.sessions.length - 1];
      assert.equal(snap.volume_ratio, last.volume_ratio, `volume_ratio at ${snap.d}`);
      assert.equal(snap.residual_z, last.residual_z, `residual_z at ${snap.d}`);
      assert.equal(snap.residual_move, last.residual_move, `residual_move at ${snap.d}`);
      assert.equal(snap.ret, last.ret, `ret at ${snap.d}`);
      assert.equal(snap.close, last.close, `close at ${snap.d}`);
    }
  });

  it("look-ahead: truncating every bar after session T leaves T's snapshot unchanged", () => {
    const full = buildQuantSeries({ ticker: "TEST", bars: ticker, benchBars: bench, windows: WINDOWS });
    // Sampled across the series rather than all 320 — each rebuild is O(n^2).
    for (const at of [120, 200, 260, 300]) {
      const session = full.snapshots[at].d;
      const truncated = buildQuantSeries({
        ticker: "TEST",
        bars: ticker.filter((b) => b.d <= session),
        benchBars: bench.filter((b) => b.d <= session),
        windows: WINDOWS,
      });
      const tail = truncated.snapshots[truncated.snapshots.length - 1];
      assert.equal(tail.d, session);
      assert.deepEqual(tail, full.snapshots[at], `snapshot at ${session} changed when the future was removed`);
    }
  });

  it("future bars appended after T never alter T", () => {
    const short = buildQuantSeries({ ticker: "TEST", bars: ticker.slice(0, 200), benchBars: bench.slice(0, 200), windows: WINDOWS });
    const long = buildQuantSeries({ ticker: "TEST", bars: ticker, benchBars: bench, windows: WINDOWS });
    const cut = short.snapshots[short.snapshots.length - 1];
    const same = long.snapshots.find((s) => s.d === cut.d);
    assert.deepEqual(same, cut);
  });

  it("`to` is an inclusive cut and emits no session beyond it", () => {
    const full = buildQuantSeries({ ticker: "TEST", bars: ticker, benchBars: bench, windows: WINDOWS });
    const cutSession = full.snapshots[210].d;
    const cut = buildQuantSeries({ ticker: "TEST", bars: ticker, benchBars: bench, windows: WINDOWS, to: cutSession });
    assert.equal(cut.snapshots[cut.snapshots.length - 1].d, cutSession);
    assert.ok(cut.snapshots.every((s) => s.d <= cutSession));
    assert.deepEqual(cut.snapshots[210], full.snapshots[210]);
  });

  it("`from` trims the warm-up without changing the surviving snapshots", () => {
    const full = buildQuantSeries({ ticker: "TEST", bars: ticker, benchBars: bench, windows: WINDOWS });
    const start = full.snapshots[280].d;
    const trimmed = buildQuantSeries({ ticker: "TEST", bars: ticker, benchBars: bench, windows: WINDOWS, from: start });
    assert.equal(trimmed.snapshots[0].d, start);
    assert.deepEqual(trimmed.snapshots[0], full.snapshots[280]);
  });
});

describe("quantlab/series — sessions the ticker did not trade", () => {
  const days = tradingDays(40);
  const bench = barsFrom({ days, returns: new Array(39).fill(0.001), startPrice: 500 });

  it("halted sessions are skipped, never forward-filled", () => {
    const halted = new Set([days[20], days[21], days[22]]);
    const ownDays = days.filter((d) => !halted.has(d));
    const own = barsFrom({ days: ownDays, returns: new Array(ownDays.length - 1).fill(0.002) });

    const series = buildQuantSeries({ ticker: "HALT", bars: own, benchBars: bench, windows: WINDOWS });
    const emitted = new Set(series.snapshots.map((s) => s.d));
    for (const d of halted) assert.equal(emitted.has(d), false, `${d} must not appear`);
    assert.equal(series.snapshots.length, ownDays.length);
  });

  it("detectGaps reports interior holes and ignores leading absence", () => {
    const calendar = TradingCalendar.fromBars(bench);
    // Listed late (first 10 sessions absent) and halted for 3 in the middle.
    const ownDays = days.filter((_d, i) => i >= 10 && ![20, 21, 22].includes(i));
    const own = barsFrom({ days: ownDays, returns: new Array(ownDays.length - 1).fill(0.002) });
    const series = buildQuantSeries({ ticker: "HALT", bars: own, benchBars: bench, windows: WINDOWS });

    const gaps = detectGaps(series, calendar.sessions());
    assert.equal(gaps.length, 1, "leading absence is not a gap");
    assert.equal(gaps[0].sessions, 3);
    assert.equal(gaps[0].from, days[20]);
    assert.equal(gaps[0].to, days[22]);
  });

  it("a clean series reports no gaps", () => {
    const own = barsFrom({ days, returns: new Array(39).fill(0.002) });
    const series = buildQuantSeries({ ticker: "OK", bars: own, benchBars: bench, windows: WINDOWS });
    assert.deepEqual(detectGaps(series, TradingCalendar.fromBars(bench).sessions()), []);
  });
});

describe("quantlab/series — lookups", () => {
  const { ticker, bench } = synthetic({ n: 60, seed: 3 });
  const series = buildQuantSeries({ ticker: "TEST", bars: ticker, benchBars: bench, windows: WINDOWS });

  it("snapshotAt returns null for a session the ticker did not trade", () => {
    assert.equal(snapshotAt(series, "1999-01-04"), null);
    const known = series.snapshots[30];
    assert.equal(snapshotAt(series, known.d)?.d, known.d);
  });

  it("snapshotAsOf falls back to the last known session", () => {
    const known = series.snapshots[30];
    assert.equal(snapshotAsOf(series, "2099-01-01")?.d, series.snapshots[series.snapshots.length - 1].d);
    assert.equal(snapshotAsOf(series, known.d)?.d, known.d);
    assert.equal(snapshotAsOf(series, "1999-01-01"), null);
  });
});
