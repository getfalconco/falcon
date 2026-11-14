/**
 * Event studies (design 4.7): what happened to target tickers after each
 * event, as market-model abnormal returns, with N hits and G independent
 * event dates. Two measures:
 *
 *   measured  from the close before the event session to `w` sessions later;
 *   tradable  from the first fill after the decision (the next open on the
 *             close clock) to the close `w` sessions after the event session.
 *
 * The gap between them is the part no one could have captured.
 *
 * Also `eventStudyFromHistory`: the same summary from a Sightings card's own
 * record (`history.events`), so "Backtest this" shows the card's numbers.
 */

import type { Panel } from "./fsl/eval";
import { abnormalReturn } from "./prepare";
import { clusteredT, mean, median, ols, wilson, wildClusterP } from "./stats";
import { rng } from "./util";

export type EventRow = { date: string; ticker: string; measured: Record<number, number>; tradable: Record<number, number> };

export type WindowStats = {
  window: number;
  n: number;
  /** Independent event dates. */
  g: number;
  meanPct: number;
  medianPct: number;
  tradableMeanPct: number;
  /** Share of event dates whose average abnormal move was above 0, with a ~90% Wilson range. */
  hitRate: number;
  hitRange: [number, number];
  datesUp: number;
  t: number;
  df: number;
  p: number;
  /** Wild cluster bootstrap p-value when G < 30. */
  wildP: number | null;
};

export type EventStudy = { windows: WindowStats[]; events: EventRow[]; method: string };

function marketModel(panel: Panel, c: number, spy: number, d: number): { a: number; b: number } | null {
  const T = panel.dates.length;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let t = Math.max(1, d - 260); t <= d - 11; t++) {
    const pa = panel.close[c * T + t - 1]!;
    const pb = panel.close[c * T + t]!;
    const ma = panel.close[spy * T + t - 1]!;
    const mb = panel.close[spy * T + t]!;
    if (pa > 0 && pb > 0 && ma > 0 && mb > 0 && panel.has[c * T + t]) {
      xs.push(mb / ma - 1);
      ys.push(pb / pa - 1);
    }
  }
  return xs.length >= 120 ? ols(xs, ys) : null;
}

/**
 * `hits[u * T + d] > 0`: an event for universe ticker u decided on session d.
 * `lag`: sessions from decision to the first fill (1 on the close clock).
 */
export function eventStudy(
  panel: Panel,
  universe: string[],
  hits: Float64Array,
  windows: number[],
  range: { start: number; end: number },
  lag: number,
  seed = 1,
): EventStudy {
  const T = panel.dates.length;
  const spy = panel.col.get("SPY")!;
  const events: EventRow[] = [];
  universe.forEach((ticker, u) => {
    const c = panel.col.get(ticker);
    if (c === undefined) return;
    for (let d = range.start; d <= range.end; d++) {
      if (!(hits[u * T + d]! > 0)) continue;
      const mm = marketModel(panel, c, spy, d);
      const row: EventRow = { date: panel.dates[d]!, ticker, measured: {}, tradable: {} };
      for (const w of windows) {
        const last = d + w - 1;
        if (last > range.end || d < 1) continue;
        const px = (col: number, t: number) => panel.close[col * T + t]!;
        const ri = px(c, last) / px(c, d - 1) - 1;
        const rm = px(spy, last) / px(spy, d - 1) - 1;
        const abn = mm ? ri - (mm.a * w + mm.b * rm) : ri - rm;
        if (Number.isFinite(abn)) row.measured[w] = abn;
        const f = d + lag;
        if (f <= last) {
          const ti = px(c, last) / panel.open[c * T + f]! - 1;
          const tm = px(spy, last) / panel.open[spy * T + f]! - 1;
          const span = last - f + 1;
          const tab = mm ? ti - (mm.a * span + mm.b * tm) : ti - tm;
          if (Number.isFinite(tab)) row.tradable[w] = tab;
        }
      }
      events.push(row);
    }
  });
  const rand = rng(seed);
  const stats = windows.map((w) => {
    const rows = events.filter((e) => e.measured[w] !== undefined);
    const byDate = new Map<string, number[]>();
    for (const r of rows) byDate.set(r.date, [...(byDate.get(r.date) ?? []), r.measured[w]!]);
    const groups = Array.from(byDate.values());
    const dateMeans = groups.map(mean);
    const up = dateMeans.filter((x) => x > 0).length;
    const ct = clusteredT(groups);
    const tr = rows.map((r) => r.tradable[w]).filter((x): x is number => x !== undefined);
    return {
      window: w,
      n: rows.length,
      g: groups.length,
      meanPct: mean(rows.map((r) => r.measured[w]!)) * 100,
      medianPct: median(rows.map((r) => r.measured[w]!)) * 100,
      tradableMeanPct: mean(tr) * 100,
      hitRate: groups.length ? up / groups.length : NaN,
      hitRange: wilson(up, groups.length),
      datesUp: up,
      t: ct.t,
      df: ct.df,
      p: ct.p,
      wildP: groups.length >= 3 && groups.length < 30 ? wildClusterP(groups, rand) : null,
    };
  });
  return { windows: stats, events, method: "Market-model abnormal returns vs SPY (beta and alpha over sessions -260 to -11), clustered by event date." };
}

/** Reaction-day abnormal return, re-exported for the engine's shared use. */
export { abnormalReturn };

