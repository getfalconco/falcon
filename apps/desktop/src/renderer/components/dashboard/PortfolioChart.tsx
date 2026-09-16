import { useEffect, useMemo, useState } from "react";
import type { PricePoint } from "../../../shared/stock-types";
import { paperScopeKey, readPaperAccount } from "@/lib/paper-account";
import { demoValueSeries, useDemoMode } from "@/lib/demo-mode";
import { getStockChartRange } from "@/lib/stock-api";
import { fetchCloudSnapshots, type CloudSnapshot } from "@/lib/portfolio-sync";
import { usePortfolioValuation } from "@/hooks/usePortfolioBalance";
import { cn } from "@/lib/utils";
import type { Timeframe } from "./TimeframeControls";

/**
 * Minimal borderless net-worth chart under the headline: a smooth dark
 * line with a soft fade, drawn straight on the page background. Series is
 * real — recorded daily history + cloud snapshots + a live "now" point.
 */

type SeriesPoint = { t: number; value: number };

const TIMEFRAME_DAYS: Record<Timeframe, number> = {
  // The last 60 minutes — the finest window the recorder can serve.
  Hour: 1 / 24,
  Day: 1,
  Week: 7,
  Month: 30,
  Quarter: 90,
  Year: 365,
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Intraday recording + Day-view resolution. Deliberately below the live-quote
 *  poll in useLivePrices — a slot the price hasn't refreshed in just repeats
 *  the last value, so this may never be coarser than that poll. Note the cost:
 *  a full day at 5s is ~17k points re-parsed and re-stringified every tick. */
const RECORD_MS = 5_000;

/** Sampling resolution per window — fine enough to show real intraday shape,
 *  coarse enough that a year isn't ten thousand points. */
const BUCKET_MS: Record<Timeframe, number> = {
  Hour: RECORD_MS,
  Day: RECORD_MS,
  Week: 15 * 60_000,
  Month: 60 * 60_000,
  Quarter: 6 * 60 * 60_000,
  Year: DAY_MS,
};

/** Every window is trailing, Day included: a rolling 24h rather than
 *  'since local midnight'. Midnight made the Day view collapse in the small
 *  hours — at 01:00 it was a one-hour window, so a couple of bad samples and
 *  one flat stretch filled the whole chart and it read as noise. A trailing
 *  day also matches what the recorder keeps (it prunes the intraday buffer at
 *  24h), so the window and the data behind it are finally the same length.
 *
 *  Shorter windows than their full length are flat-filled on the left when
 *  the account is younger than the window. */
function domainStartFor(timeframe: Timeframe, now: number): number {
  return now - TIMEFRAME_DAYS[timeframe] * DAY_MS;
}

/** Design-time switch — off: the chart draws the real recorded series.
 *  (Flip to true to review layout with a dense fake curve.) */

/** Deterministic RNG so the demo curve doesn't reshuffle on every render. */
function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Demo S&P 500 benchmark: an index-like walk (steadier drift, lower vol)
 * expressed as % growth — rebased onto the portfolio's starting value so
 * the two lines are directly comparable.
 */
function demoSp500Series(timeframe: Timeframe, baseValue: number, seed = 0): SeriesPoint[] {
  const days = TIMEFRAME_DAYS[timeframe];
  const rand = mulberry32(days * 104729 + 7 + seed);
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  const n = 140;
  const raw: number[] = [];
  let value = 100;
  for (let i = 0; i < n; i++) {
    value *= 1 + 0.0005 + (rand() - 0.5) * 0.009;
    raw.push(value);
  }
  return raw.map((v, i) => ({
    t: start + ((now - start) * i) / (n - 1),
    value: baseValue * (v / raw[0]),
  }));
}

/**
 * Demo portfolio % growth (time-weighted return): tracks the portfolio's
 * character but ignores deposit/withdrawal jumps, so in real data it
 * legitimately diverges from the value line. Rebased to the same start.
 */
function demoGrowthSeries(timeframe: Timeframe, baseValue: number, seed = 0): SeriesPoint[] {
  const days = TIMEFRAME_DAYS[timeframe];
  const rand = mulberry32(days * 31337 + 3 + seed);
  const now = Date.now();
  const start = now - days * 24 * 60 * 60 * 1000;
  const n = 140;
  const raw: number[] = [];
  let value = 100;
  let drift = 0.0009;
  for (let i = 0; i < n; i++) {
    if (rand() < 0.04) drift = (rand() - 0.44) * 0.006;
    value *= 1 + drift + (rand() - 0.5) * 0.015;
    raw.push(value);
  }
  return raw.map((v, i) => ({
    t: start + ((now - start) * i) / (n - 1),
    value: baseValue * (v / raw[0]),
  }));
}

/** Rolling last-24h intraday buffer recorded by the portfolio tracker. */
function readIntraday(): Array<{ t: number; value: number }> {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(paperScopeKey("networthIntraday")) ?? "null",
    ) as { points?: Array<{ t: number; value: number }> } | null;
    if (!Array.isArray(parsed?.points)) return [];
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return parsed.points
      .filter((p) => Number.isFinite(p?.t) && p.t >= cutoff && Number.isFinite(p?.value))
      .sort((a, b) => a.t - b.t);
  } catch {
    return [];
  }
}

function readHistory(): Array<{ date: string; value: number }> {
  try {
    const parsed = JSON.parse(
      localStorage.getItem(paperScopeKey("networthHistory")) ?? "[]",
    );
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is { date: string; value: number } =>
        typeof p?.date === "string" && Number.isFinite(p?.value),
    );
  } catch {
    return [];
  }
}

/**
 * Monotone cubic (Fritsch–Carlson) — smooth but never overshoots, so sharp
 * jumps don't grow teardrop loops.
 */
function smoothPath(pts: Array<[number, number]>): string {
  const n = pts.length;
  if (n < 2) return "";
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = xs[i + 1] - xs[i];
    slope[i] = dx[i] !== 0 ? (ys[i + 1] - ys[i]) / dx[i] : 0;
  }
  const tan: number[] = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    tan[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  tan[n - 1] = slope[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tan[i] = 0;
      tan[i + 1] = 0;
      continue;
    }
    const a = tan[i] / slope[i];
    const b = tan[i + 1] / slope[i];
    const s2 = a * a + b * b;
    if (s2 > 9) {
      const tau = 3 / Math.sqrt(s2);
      tan[i] = tau * a * slope[i];
      tan[i + 1] = tau * b * slope[i];
    }
  }
  let d = `M${xs[0]},${ys[0]}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i];
    d += ` C${xs[i] + h / 3},${ys[i] + (tan[i] * h) / 3} ${xs[i + 1] - h / 3},${
      ys[i + 1] - (tan[i + 1] * h) / 3
    } ${xs[i + 1]},${ys[i + 1]}`;
  }
  return d;
}

const W = 960;
const H = 230;
const TOP = 12;
/** Line plot floor — the relative-performance columns get their own lane
 *  below it, so the texture never grows up through the portfolio line. */
const BOTTOM = H - 60;
const AREA_FLOOR = H - 52;
const COL_BASE = H - 2;
const COL_MAX = 46;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Calendar tick positions for the bottom axis, per timeframe. */
function xTicksFor(
  timeframe: Timeframe,
  domainStart: number,
  now: number,
): Array<{ t: number; label: string }> {
  const ticks: Array<{ t: number; label: string }> = [];

  if (timeframe === "Hour") {
    // A tick every ten minutes, on the ten.
    const d = new Date(domainStart);
    d.setSeconds(0, 0);
    while (d.getTime() < domainStart || d.getMinutes() % 10 !== 0) {
      d.setMinutes(d.getMinutes() + 1);
    }
    while (d.getTime() <= now) {
      ticks.push({
        t: d.getTime(),
        label: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
      });
      d.setMinutes(d.getMinutes() + 10);
    }
    return ticks;
  }

  if (timeframe === "Day") {
    // A tick every 6 hours; midnight shows the date instead of the time.
    const d = new Date(domainStart);
    d.setMinutes(0, 0, 0);
    while (d.getTime() < domainStart || d.getHours() % 6 !== 0) {
      d.setHours(d.getHours() + 1);
    }
    while (d.getTime() <= now) {
      ticks.push({
        t: d.getTime(),
        label:
          d.getHours() === 0
            ? `${MONTHS[d.getMonth()]} ${d.getDate()}`
            : `${String(d.getHours()).padStart(2, "0")}:00`,
      });
      d.setHours(d.getHours() + 6);
    }
    return ticks;
  }

  if (timeframe === "Week") {
    // One tick per day, at noon.
    const d = new Date(domainStart);
    d.setHours(12, 0, 0, 0);
    if (d.getTime() < domainStart) d.setDate(d.getDate() + 1);
    while (d.getTime() <= now) {
      ticks.push({ t: d.getTime(), label: WEEKDAYS[d.getDay()] });
      d.setDate(d.getDate() + 1);
    }
    return ticks;
  }

  if (timeframe === "Month") {
    // Weekly ticks on Mondays.
    const d = new Date(domainStart);
    d.setHours(12, 0, 0, 0);
    while (d.getDay() !== 1 || d.getTime() < domainStart) d.setDate(d.getDate() + 1);
    while (d.getTime() <= now) {
      ticks.push({ t: d.getTime(), label: `${MONTHS[d.getMonth()]} ${d.getDate()}` });
      d.setDate(d.getDate() + 7);
    }
    return ticks;
  }

  // Quarter / Year: a tick at the first day of each month in the window.
  const d = new Date(domainStart);
  d.setDate(1);
  d.setHours(0, 0, 0, 0);
  if (d.getTime() < domainStart) d.setMonth(d.getMonth() + 1);
  while (d.getTime() <= now) {
    ticks.push({ t: d.getTime(), label: MONTHS[d.getMonth()] });
    d.setMonth(d.getMonth() + 1);
  }
  return ticks;
}

type HoverPoint = { xPct: number; yPct: number; value: number; t: number };

/**
 * The hovered sample's moment, for the scrub tag.
 *
 * A clock time is only printed where a point genuinely is one: Day buckets
 * at 90s and Week at 15min come from the intraday buffer and the worker's
 * 5-minute snapshots, so the reading is real. The longer windows bucket by
 * hours or days, and their older points come from daily closes pinned at
 * noon — one number standing in for a whole session. Printing '12:00' there
 * would be inventing a precision the data does not have, so those show the
 * date alone.
 */
function hoverStamp(timeframe: Timeframe, t: number): string {
  const d = new Date(t);
  const date = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  // An hour of one day: the date is the same at every point, so the clock is
  // the only part that says anything.
  if (timeframe === "Hour") return `${hh}:${mm}`;
  if (timeframe !== "Day" && timeframe !== "Week") return date;
  return `${date} · ${hh}:${mm}`;
}

export default function PortfolioChart({
  timeframe,
  showGrowth = true,
  showSp500 = true,
  expanded = false,
  fill = false,
  onScrub,
}: {
  timeframe: Timeframe;
  showGrowth?: boolean;
  showSp500?: boolean;
  /** Filling the workspace — the plot grows with the viewport. */
  expanded?: boolean;
  /** Stretch to the container height without the full-screen layout (dock mode). */
  fill?: boolean;
  /** Fires with the hovered point's value while scrubbing, null on leave. */
  onScrub?: (value: number | null) => void;
}) {
  const [hover, setHover] = useState<HoverPoint | null>(null);
  const demo = useDemoMode();
  const DEMO_SERIES = demo != null;
  // Slider window as [startPct, endPct] — keep in sync with the scrubber's default.

  // Real overlay data: a year of SPY closes, and of each holding's closes.
  const [spyRaw, setSpyRaw] = useState<PricePoint[]>([]);
  const [holdRaw, setHoldRaw] = useState<Array<{ weight: number; pts: PricePoint[] }>>([]);

  useEffect(() => {
    if (DEMO_SERIES || !showSp500 || spyRaw.length > 0) return;
    let cancelled = false;
    const endSec = Math.floor(Date.now() / 1000);
    void getStockChartRange("SPY", endSec - 366 * 24 * 3600, endSec)
      .then((pts) => {
        if (!cancelled) setSpyRaw(pts.filter((p) => p.v > 0).sort((a, b) => a.t - b.t));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [showSp500, spyRaw.length, DEMO_SERIES]);

  useEffect(() => {
    if (DEMO_SERIES || !showGrowth || holdRaw.length > 0) return;
    const positions = Object.values(readPaperAccount().positions);
    if (positions.length === 0) return;
    let cancelled = false;
    const endSec = Math.floor(Date.now() / 1000);
    void Promise.all(
      positions.map(async (p) => {
        try {
          return {
            weight: Math.abs(p.costUsd),
            pts: await getStockChartRange(p.symbol, endSec - 366 * 24 * 3600, endSec),
          };
        } catch {
          return null;
        }
      }),
    ).then((res) => {
      if (cancelled) return;
      setHoldRaw(res.filter((r): r is NonNullable<typeof r> => r != null && r.pts.length > 1));
    });
    return () => {
      cancelled = true;
    };
  }, [showGrowth, holdRaw.length, DEMO_SERIES]);
  const { value: balance, priced } = usePortfolioValuation();
  const [cloudSnaps, setCloudSnaps] = useState<CloudSnapshot[]>([]);

  // Cloud snapshots fill the hours the app was closed — refreshed every
  // minute so the chart keeps riding the worker's series while open.
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      void fetchCloudSnapshots(366).then((snaps) => {
        if (!cancelled) setCloudSnaps(snaps);
      });
    };
    load();
    const id = window.setInterval(load, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  // Local recorder — the old dashboard wrote the intraday buffer + daily close;
  // the rebuilt shell must too, or open-app hours leave no trace between
  // cloud points and the line collapses into one long smooth segment.
  useEffect(() => {
    if (DEMO_SERIES) return;
    if (!Number.isFinite(balance) || balance <= 0) return;
    // Never record a half-priced book. A position still waiting on its quote
    // is carried at cost, which produced the spikes in this buffer: four
    // samples at exactly 10000.00 (both positions at their 5000 cost) and one
    // at 9428.56 (one live, one at cost) against a ~9763 median. Two such
    // samples were enough to stretch the Day axis over a 571-dollar range the
    // portfolio never traded in.
    if (!priced) return;
    const write = () => {
      try {
        const now = Date.now();
        const key = paperScopeKey("networthIntraday");
        const parsed = JSON.parse(localStorage.getItem(key) ?? "null") as {
          points?: Array<{ t: number; value: number }>;
        } | null;
        const cutoff = now - DAY_MS;
        const points = (parsed?.points ?? []).filter(
          (p) => Number.isFinite(p?.t) && p.t >= cutoff && Number.isFinite(p?.value),
        );
        const slot = Math.floor(now / RECORD_MS);
        if (points.length > 0 && Math.floor(points[points.length - 1].t / RECORD_MS) === slot) {
          points[points.length - 1] = { t: now, value: balance };
        } else {
          points.push({ t: now, value: balance });
        }
        localStorage.setItem(key, JSON.stringify({ points }));

        // Today's daily close, for the longer views.
        const hKey = paperScopeKey("networthHistory");
        const rawHist = JSON.parse(localStorage.getItem(hKey) ?? "[]");
        const hist: Array<{ date: string; value: number }> = Array.isArray(rawHist)
          ? rawHist
          : [];
        const d = new Date();
        const p2 = (n: number) => String(n).padStart(2, "0");
        const dayKey = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
        const idx = hist.findIndex((r) => r?.date === dayKey);
        if (idx >= 0) hist[idx] = { date: dayKey, value: balance };
        else hist.push({ date: dayKey, value: balance });
        localStorage.setItem(hKey, JSON.stringify(hist));
      } catch {
        /* recording is best-effort */
      }
    };
    write();
    const id = window.setInterval(write, RECORD_MS);
    return () => window.clearInterval(id);
  }, [balance, priced, DEMO_SERIES]);

  const series = useMemo<SeriesPoint[]>(() => {
    if (demo) return demoValueSeries(demo.seed, TIMEFRAME_DAYS[timeframe], balance);

    const now = Date.now();
    const domainStart = domainStartFor(timeframe, now);
    // Never finer than one point per pixel: a 5s recorder over 24h is ~17k
    // points for a 960px path, 18 per pixel, none of them visible, with
    // smoothPath rebuilding a bezier command for each on every price tick.
    // Now that Day is a fixed 24h window this resolves to a constant 90s for
    // Day, so BUCKET_MS.Day is no longer what decides it; the floor still
    // binds on Week and Year, whose windows divide finer than is useful.
    const bucket = Math.max(BUCKET_MS[timeframe], Math.ceil((now - domainStart) / W));
    const byBucket = new Map<number, SeriesPoint>();

    // Layered coarsest → finest, so the sharper source always wins the bucket.
    // 1. Recorded daily closes carry the long tail, beyond snapshot retention.
    //
    //    Not on Day. A daily row is one number for a whole session and it has
    //    to be pinned somewhere, so it is stamped at noon — fine when a pixel
    //    is a day, a lie when a pixel is 90 seconds. It claims the book was at
    //    its CLOSING value at midday, which on a trending day is simply a
    //    price it never traded at, drawn as a step the finer sources then
    //    contradict. Day is covered end to end by cloud snapshots, the
    //    intraday buffer and the live point, so it needs none of them.
    if (timeframe !== "Day") {
      for (const p of readHistory()) {
        const t = new Date(`${p.date}T12:00:00`).getTime();
        if (Number.isFinite(t) && t >= domainStart && t <= now) {
          byBucket.set(Math.floor(t / bucket), { t, value: p.value });
        }
      }
    }
    // 2. Cloud snapshots — the worker's round-the-clock record, so pre-market
    //    and after-hours moves are in here just like regular session ones.
    for (const snap of cloudSnaps) {
      const t = new Date(snap.ts).getTime();
      if (!Number.isFinite(t) || t < domainStart) continue;
      byBucket.set(Math.floor(t / bucket), { t, value: snap.value });
    }
    // 3. This device's own intraday buffer wins wherever it overlaps.
    for (const p of readIntraday()) {
      if (p.t >= domainStart) byBucket.set(Math.floor(p.t / bucket), p);
    }
    // 4. Live "now".
    byBucket.set(Math.floor(now / bucket), { t: now, value: balance });

    const out = [...byBucket.values()].sort((a, b) => a.t - b.t);
    // Younger than the window: run flat from the left edge to the first record,
    // so the chart still spans the full period instead of starting mid-axis.
    if (out.length > 0 && out[0].t > domainStart) {
      out.unshift({ t: domainStart, value: out[0].value });
    }
    return out;
  }, [balance, timeframe, cloudSnaps, demo]);

  // S&P 500 benchmark, rebased to the portfolio's starting value. Demo-only
  // for now — real wiring needs an index quote source (Yahoo v8 ^GSPC).
  const benchmark = useMemo<SeriesPoint[]>(() => {
    if (!showSp500 || series.length === 0) return [];
    if (DEMO_SERIES) return demoSp500Series(timeframe, series[0].value, demo?.seed ?? 0);
    // SPY % growth over the window, rebased onto the portfolio's start value.
    if (spyRaw.length < 2) return [];
    const domainStart = domainStartFor(timeframe, Date.now());
    const vis = spyRaw.filter((p) => p.t >= domainStart);
    if (vis.length < 2) return [];
    const base = series[0].value;
    return vis.map((p) => ({ t: p.t, value: base * (p.v / vis[0].v) }));
  }, [series, timeframe, showSp500, spyRaw, demo]);

  // When the account first recorded any value — growth can't predate it.
  const bornAt = useMemo(() => {
    let t = Infinity;
    for (const p of readHistory()) {
      const v = new Date(`${p.date}T00:00:00`).getTime();
      if (Number.isFinite(v)) t = Math.min(t, v);
    }
    for (const s of cloudSnaps) {
      const v = new Date(s.ts).getTime();
      if (Number.isFinite(v)) t = Math.min(t, v);
    }
    return t;
  }, [cloudSnaps]);

  // Portfolio % growth: the holdings' value-weighted real returns — but only
  // from the day the account existed. Before that the line runs flat, same
  // as the value line; no made-up pre-purchase history.
  const growth = useMemo<SeriesPoint[]>(() => {
    if (!showGrowth || series.length === 0) return [];
    if (DEMO_SERIES) return demoGrowthSeries(timeframe, series[0].value, demo?.seed ?? 0);
    if (holdRaw.length === 0) return [];
    const domainStart = domainStartFor(timeframe, Date.now());
    const startBound = Math.max(domainStart, bornAt);
    const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
    const maps = holdRaw.map((h) => {
      const pts = h.pts.filter((p) => p.v > 0).sort((a, b) => a.t - b.t);
      const m = new Map<string, { t: number; r: number }>();
      for (let i = 1; i < pts.length; i++) {
        if (pts[i].t >= startBound) {
          m.set(dayOf(pts[i].t), { t: pts[i].t, r: Math.log(pts[i].v / pts[i - 1].v) });
        }
      }
      return m;
    });
    let dates = [...maps[0].keys()];
    for (const m of maps.slice(1)) dates = dates.filter((d) => m.has(d));
    if (dates.length === 0) return [];
    dates.sort();
    const totW = holdRaw.reduce((s, h) => s + h.weight, 0) || 1;
    let acc = series[0].value;
    const out: SeriesPoint[] = [{ t: domainStart, value: acc }];
    for (const d of dates) {
      const r = holdRaw.reduce((s, h, i) => s + (h.weight / totW) * (maps[i].get(d)?.r ?? 0), 0);
      acc *= Math.exp(r);
      out.push({ t: maps[0].get(d)!.t, value: acc });
    }
    return out;
  }, [series, timeframe, showGrowth, holdRaw, bornAt, demo]);

  // Percentage-point lead over the S&P 500 per bucket (always on — the
  // strip doesn't depend on which overlay lines are toggled visible).
  const relPerf = useMemo<number[]>(() => {
    if (DEMO_SERIES) {
      const gs = demoGrowthSeries(timeframe, 100, demo?.seed ?? 0);
      const sp = demoSp500Series(timeframe, 100, demo?.seed ?? 0);
      const n = Math.min(gs.length, sp.length);
      const out: number[] = [];
      for (let i = 0; i < n; i++) out.push(gs[i].value - sp[i].value);
      return out;
    }
    // Real: holdings' growth minus SPY growth, day by day — only from the
    // day the account existed, so no columns over made-up history.
    if (benchmark.length < 2 || growth.length < 2) return [];
    const startBound = Math.max(domainStartFor(timeframe, Date.now()), bornAt);
    const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
    const bByDay = new Map(benchmark.map((p) => [dayOf(p.t), p.value]));
    const base = growth[0].value || 1;
    const out: number[] = [];
    for (const g of growth) {
      if (g.t < startBound) continue;
      const b = bByDay.get(dayOf(g.t));
      if (b != null) out.push(((g.value - b) / base) * 100);
    }
    if (out.length < 2) return out;
    // Upsample to a dense grid so short windows (Week ≈ 5 trading days)
    // still render a full field of columns, like Year does.
    const N = 120;
    const dense: number[] = [];
    for (let i = 0; i < N; i++) {
      const pos = (i / (N - 1)) * (out.length - 1);
      const lo = Math.floor(pos);
      const hi = Math.min(out.length - 1, lo + 1);
      dense.push(out[lo] + (out[hi] - out[lo]) * (pos - lo));
    }
    return dense;
  }, [timeframe, benchmark, growth, bornAt, demo]);

  const chart = useMemo(() => {
    if (series.length === 0) return null;
    const now = Date.now();
    const domainStart = domainStartFor(timeframe, now);
    const xAt = (t: number) =>
      ((Math.min(Math.max(t, domainStart), now) - domainStart) / (now - domainStart)) * W;

    const values = [...series, ...benchmark, ...growth].map((p) => p.value);
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (min === max) {
      // Flat series — pad so the line sits mid-chart instead of on an edge.
      min -= Math.abs(min) * 0.05 || 1;
      max += Math.abs(max) * 0.05 || 1;
    } else {
      const pad = (max - min) * 0.12;
      min -= pad;
      max += pad;
    }
    // Near-flat series: force a minimum span so ticks don't collapse into a
    // pile of identical labels.
    const mid = (min + max) / 2;
    const minSpan = Math.max(Math.abs(mid) * 0.012, 1);
    if (max - min < minSpan) {
      min = mid - minSpan / 2;
      max = mid + minSpan / 2;
    }
    const yAt = (v: number) => BOTTOM - ((v - min) / (max - min)) * (BOTTOM - TOP);

    let pts: Array<[number, number]> = series.map((p) => [xAt(p.t), yAt(p.value)]);
    if (pts.length === 1) pts = [pts[0], [W, pts[0][1]]];

    const line = smoothPath(pts);
    const area = `${line} L${pts[pts.length - 1][0]},${AREA_FLOOR} L${pts[0][0]},${AREA_FLOOR} Z`;

    const benchLine =
      benchmark.length >= 2
        ? smoothPath(benchmark.map((p) => [xAt(p.t), yAt(p.value)]))
        : "";
    const growthLine =
      growth.length >= 2
        ? smoothPath(growth.map((p) => [xAt(p.t), yAt(p.value)]))
        : "";

    // Calendar ticks along the bottom, positioned as a % of chart width.
    const xTicks = xTicksFor(timeframe, domainStart, now).map((tick) => ({
      label: tick.label,
      leftPct: (xAt(tick.t) / W) * 100,
    }));

    // Pixel-space points of the portfolio line, for hover snapping.
    const hoverPts: HoverPoint[] = series.map((p) => ({
      xPct: (xAt(p.t) / W) * 100,
      yPct: (yAt(p.value) / H) * 100,
      value: p.value,
      t: p.t,
    }));

    return { line, area, benchLine, growthLine, xTicks, hoverPts };
  }, [series, benchmark, growth, timeframe]);

  if (!chart) return null;

  const relMaxAbs = Math.max(...relPerf.map(Math.abs), 1e-6);

  return (
    <div className={cn("select-none", (expanded || fill) && "flex h-full min-h-0 flex-col")}>
      <div className={cn("flex items-stretch gap-3", (expanded || fill) && "min-h-0 flex-1")}>
        <div
          className={cn(
            "relative min-w-0 flex-1 transition-[height] duration-500 ease-[cubic-bezier(0.4,0,0.2,1)]",
            expanded || fill ? "h-full" : "h-[300px]",
          )}
          onMouseMove={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            if (rect.width === 0) return;
            const xPct = ((e.clientX - rect.left) / rect.width) * 100;
            let best: HoverPoint | null = null;
            let bestDist = Infinity;
            for (const p of chart.hoverPts) {
              const d = Math.abs(p.xPct - xPct);
              if (d < bestDist) {
                bestDist = d;
                best = p;
              }
            }
            setHover(best);
            onScrub?.(best?.value ?? null);
          }}
          onMouseLeave={() => {
            setHover(null);
            onScrub?.(null);
          }}
        >
          <svg
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            // Both edges dissolve instead of being cut off by the frame —
            // the series continues past the window, so a hard stop reads as
            // the data ending there.
            className="h-full w-full [-webkit-mask-image:linear-gradient(to_right,transparent_0%,#000_4%)] [mask-image:linear-gradient(to_right,transparent_0%,#000_4%)]"
            aria-label="Portfolio value chart"
          >
            <defs>
              <linearGradient id="pv-fade" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#1d1b1b" stopOpacity="0.13" />
                <stop offset="100%" stopColor="#1d1b1b" stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Portfolio value — the hero: filled area under a solid line */}
            <path d={chart.area} fill="url(#pv-fade)" />
            {chart.benchLine ? (
              <path
                d={chart.benchLine}
                fill="none"
                stroke="#C4C4C4"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            {chart.growthLine ? (
              <path
                d={chart.growthLine}
                fill="none"
                stroke="#A6A6A6"
                strokeWidth="1.25"
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
              />
            ) : null}
            <path
              d={chart.line}
              fill="none"
              stroke="#1d1b1b"
              strokeWidth="2.25"
              strokeLinecap="round"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />

            {/* Relative performance vs the S&P — a low texture band in its own
                lane under the plot, so it reads as context, not as the chart */}
            {relPerf.map((d, i) => {
              const bw = W / relPerf.length;
              const h = Math.max((Math.abs(d) / relMaxAbs) * COL_MAX, 1.5);
              return (
                <rect
                  key={i}
                  x={i * bw + bw * 0.2}
                  y={COL_BASE - h}
                  width={bw * 0.6}
                  height={h}
                  fill={d >= 0 ? "#B4B4B4" : "#D5D5D5"}
                  fillOpacity="0.5"
                />
              );
            })}
          </svg>

          {/* Scrub indicator — HTML overlay so the dot never stretches */}
          {hover ? (
            <>
              <div
                aria-hidden
                className="pointer-events-none absolute inset-y-0 border-l border-dashed border-black/15"
                style={{ left: `${hover.xPct}%` }}
              />
              <div
                aria-hidden
                className="pointer-events-none absolute h-[9px] w-[9px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#1d1b1b] ring-2 ring-white"
                style={{ left: `${hover.xPct}%`, top: `${hover.yPct}%` }}
              />
              {/* When the hovered point is. The value is already in the
                  headline, which scrubs with the cursor, so repeating it here
                  would just be two numbers moving together. Pinned to the top
                  of the plot rather than to the dot: the dot rides the line and
                  a tag chasing it up and down is harder to read than a steady
                  one. Clamped so it cannot leave the plot at either edge. */}
              <div
                aria-hidden
                className="pointer-events-none absolute top-1 z-10 -translate-x-1/2 whitespace-nowrap rounded-lg border border-white/60 bg-white/40 px-1.5 py-0.5 font-['Geist_Mono'] text-[10px] tabular-nums text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_8px_24px_rgba(0,0,0,0.10)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
                style={{ left: `${Math.min(Math.max(hover.xPct, 7), 93)}%` }}
              >
                {hoverStamp(timeframe, hover.t)}
              </div>
            </>
          ) : null}
        </div>
      </div>


      {/* Time labels — aligned under the plot, clear of the right gutter */}
      <div className="relative mt-1.5 h-3.5">
        {chart.xTicks.map((tick) => (
          <span
            key={`${tick.label}-${tick.leftPct}`}
            className="absolute -translate-x-1/2 whitespace-nowrap text-[10px] text-[#A5AAB3]"
            style={{ left: `${tick.leftPct}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>
    </div>
  );
}

