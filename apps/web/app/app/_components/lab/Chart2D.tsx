"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { motion } from "framer-motion";
import { xKind, type ChartCandle, type ChartPoint, type ChartSpec, type ChartX, type XKind } from "@/lib/desk/chart-spec";
import { MONO } from "../parts";
import { observeSettledSize } from "../shell/resize";
import { EASE_OUT, useCalmMotion } from "./motion";

/**
 * The 2D charts Claude draws in a Desk reply (show_chart): line, area, bar,
 * scatter and candlestick in SVG, styled like the results panel's equity chart
 * (lab/RunPanel.tsx, strategy/EquityChart.tsx). Hover, touch or arrow keys
 * read the values; colors are theme tokens, so light and dark both work.
 */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** Series colors, in order: ink first, then the chart tokens (up/down stay for direction). */
export const SERIES_COLORS = [
  "rgb(var(--f-fore))",
  "rgb(var(--f-chart-ew))",
  "rgb(var(--f-chart-competitor))",
  "rgb(var(--f-warn))",
  "rgb(var(--f-chart-customer))",
  "rgb(var(--f-iris))",
  "rgb(var(--f-chart-peer))",
  "rgb(var(--f-chart-spy))",
];
const UP = "rgb(var(--f-up))";
const DOWN = "rgb(var(--f-down))";
const PAD = { top: 12, right: 14, bottom: 26 };
const DAY = 86_400_000;

/* ------------------------------------------------------------------ formatting */

function compact(v: number, digits: number): string {
  const a = Math.abs(v);
  if (a >= 1e12) return `${(v / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}k`;
  return v.toFixed(digits);
}

/** Decimals that show the difference between neighbouring ticks or values of this size. */
export function digitsFor(step: number): number {
  const a = Math.abs(step);
  if (!Number.isFinite(a) || a === 0) return 2;
  return Math.max(0, Math.min(6, -Math.floor(Math.log10(a)) + (a / 10 ** Math.floor(Math.log10(a)) < 2 ? 1 : 0)));
}

/** A value with its unit: "$182.40", "12.5%", "1.8x", "42 days". */
export function fmtValue(v: number | null | undefined, unit?: string, digits?: number, short = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const d = digits ?? (Number.isInteger(v) || Math.abs(v) >= 1000 ? 0 : Math.abs(v) >= 1 ? 2 : digitsFor(Math.abs(v) / 100));
  const body = short ? compact(v, d) : Math.abs(v) >= 1e4 ? v.toLocaleString("en-US", { maximumFractionDigits: d }) : v.toFixed(d);
  const u = unit?.trim();
  if (!u) return body;
  if (u === "$" || u.toUpperCase() === "USD") return v < 0 ? `-$${body.replace("-", "")}` : `$${body}`;
  if (u === "%" || u === "x" || u === "×") return `${body}${u}`;
  return `${body} ${u}`;
}

function longDate(d: string): string {
  const [y, m, day] = d.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(day)}, ${y}`;
}

const dateMs = (d: string) => Date.parse(`${d}T00:00:00Z`);

/* ------------------------------------------------------------------ scales */

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

function niceTicks(min: number, max: number, target: number): { ticks: number[]; step: number } {
  const step = niceStep(max - min || Math.abs(max) || 1, target);
  const ticks: number[] = [];
  for (let t = Math.ceil(min / step) * step; t <= max + step * 1e-9; t += step) ticks.push(Math.round(t / step) * step);
  return { ticks, step };
}

/** Date ticks at day, month or year starts, at least `gap` px apart. */
function timeTicks(lo: number, hi: number, plotW: number, gap = 64): { t: number; label: string }[] {
  const steps: { unit: "day" | "month" | "year"; n: number }[] = [
    { unit: "day", n: 1 },
    { unit: "day", n: 7 },
    { unit: "month", n: 1 },
    { unit: "month", n: 2 },
    { unit: "month", n: 3 },
    { unit: "month", n: 6 },
    { unit: "year", n: 1 },
    { unit: "year", n: 2 },
    { unit: "year", n: 5 },
    { unit: "year", n: 10 },
    { unit: "year", n: 25 },
  ];
  const approx = { day: DAY, month: 30.44 * DAY, year: 365.25 * DAY };
  const span = Math.max(DAY, hi - lo);
  const s = steps.find((x) => (span / (approx[x.unit] * x.n)) * gap <= plotW) ?? steps[steps.length - 1]!;
  const out: { t: number; label: string }[] = [];
  const start = new Date(lo);
  let d =
    s.unit === "year"
      ? new Date(Date.UTC(Math.ceil(start.getUTCFullYear() / s.n) * s.n, 0, 1))
      : s.unit === "month"
        ? new Date(Date.UTC(start.getUTCFullYear(), Math.ceil(start.getUTCMonth() / s.n) * s.n, 1))
        : new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  if (d.getTime() < lo) d = s.unit === "day" ? new Date(d.getTime() + DAY) : d;
  for (let guard = 0; d.getTime() <= hi && guard < 400; guard++) {
    if (d.getTime() >= lo) {
      const m = d.getUTCMonth();
      const label =
        s.unit === "year" ? String(d.getUTCFullYear()) : s.unit === "month" ? (m === 0 ? String(d.getUTCFullYear()) : `${MONTHS[m]}`) : `${MONTHS[m]} ${d.getUTCDate()}`;
      out.push({ t: d.getTime(), label });
    }
    d =
      s.unit === "year"
        ? new Date(Date.UTC(d.getUTCFullYear() + s.n, 0, 1))
        : s.unit === "month"
          ? new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + s.n, 1))
          : new Date(d.getTime() + s.n * DAY);
  }
  return out;
}

/* ------------------------------------------------------------------ chart */

type Prepared = {
  xk: XKind;
  /** Every distinct x, in axis order (hover snaps to these). */
  xs: ChartX[];
  /** x -> numeric position (ms for dates, the value for numbers, the index for categories). */
  pos: (x: ChartX) => number;
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
  yTicks: number[];
  yStep: number;
  /** Per series: x -> y (the value at that x). */
  lookup: Map<ChartX, number | null>[];
  /** Average distance between neighbouring x positions. */
  stepX: number;
};

function prepare(spec: ChartSpec): Prepared {
  const series = spec.series ?? [];
  const candle = spec.kind === "candlestick";
  const xk: XKind = candle ? "time" : xKind(series);
  const seen = new Map<ChartX, number>();
  const xs: ChartX[] = [];
  for (const s of series)
    for (const p of s.points) {
      if (!seen.has(p[0])) {
        seen.set(p[0], xs.length);
        xs.push(p[0]);
      }
    }
  if (xk !== "category") xs.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const index = new Map(xs.map((x, i) => [x, i]));
  const pos = xk === "time" ? (x: ChartX) => dateMs(String(x)) : xk === "number" ? (x: ChartX) => Number(x) : (x: ChartX) => index.get(x) ?? 0;
  let lo = Infinity;
  let hi = -Infinity;
  const lookup = series.map((s) => {
    const m = new Map<ChartX, number | null>();
    for (const p of s.points) {
      if (candle) {
        const c = p as ChartCandle;
        lo = Math.min(lo, c[3]);
        hi = Math.max(hi, c[2]);
        m.set(c[0], c[4]);
      } else {
        const v = (p as ChartPoint)[1];
        if (v !== null) {
          lo = Math.min(lo, v);
          hi = Math.max(hi, v);
        }
        m.set(p[0], v);
      }
    }
    return m;
  });
  if (!Number.isFinite(lo)) {
    lo = 0;
    hi = 1;
  }
  // Bars and areas stand on zero.
  if (spec.kind === "bar" || spec.kind === "area") {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }
  const span = hi - lo || Math.abs(hi) || 1;
  let yMin = lo - (lo === 0 && (spec.kind === "bar" || spec.kind === "area") ? 0 : span * 0.06);
  let yMax = hi + span * 0.06;
  const { ticks, step } = niceTicks(yMin, yMax, 5);
  yMin = Math.min(yMin, ticks[0] ?? yMin);
  yMax = Math.max(yMax, ticks[ticks.length - 1] ?? yMax);
  const xVals = xs.map(pos);
  let xMin = Math.min(...xVals);
  let xMax = Math.max(...xVals);
  const stepX = xs.length > 1 ? (xMax - xMin) / (xs.length - 1) || 1 : 1;
  if (xk === "category" || spec.kind === "bar" || candle) {
    // Bands: half a step of room at both ends.
    xMin -= stepX / 2;
    xMax += stepX / 2;
  } else if (xMin === xMax) {
    xMin -= 1;
    xMax += 1;
  }
  return { xk, xs, pos, xMin, xMax, yMin, yMax, yTicks: ticks, yStep: step, lookup, stepX };
}

function xLabel(x: ChartX, xk: XKind, unit?: string): string {
  if (xk === "time") return longDate(String(x));
  if (xk === "number") return fmtValue(Number(x), unit, digitsFor(Math.abs(Number(x)) / 100));
  return String(x);
}

export function Chart2D({ spec, height = 260, animate = false }: { spec: ChartSpec; height?: number; animate?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<{ i: number; s?: number } | null>(null);
  const still = useCalmMotion();
  const [reveal] = useState(animate && !still);
  const clipId = `chart-clip-${useId().replace(/:/g, "")}`;

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    return observeSettledSize(el, (rect) => setWidth(Math.floor(rect.width)));
  }, []);

  const p = useMemo(() => prepare(spec), [spec]);
  const series = spec.series ?? [];
  const yUnit = spec.axes?.y?.unit;
  const xUnit = spec.axes?.x?.unit;
  const tickDigits = digitsFor(p.yStep);
  const yTickText = (v: number) => fmtValue(v, yUnit, tickDigits, true);
  // Room for the longest y tick label.
  const left = Math.min(84, Math.max(36, 10 + Math.max(...p.yTicks.map((t) => yTickText(t).length)) * 6.4));
  const hasXLabel = !!spec.axes?.x?.label;
  const plotW = Math.max(10, width - left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom - (hasXLabel ? 14 : 0);
  const x = (v: number) => left + ((v - p.xMin) / (p.xMax - p.xMin || 1)) * plotW;
  const y = (v: number) => PAD.top + (1 - (v - p.yMin) / (p.yMax - p.yMin || 1)) * plotH;
  /** Width of one x step (a bar group or a candle's slot). */
  const band = (p.stepX / (p.xMax - p.xMin || 1)) * plotW;
  const color = (i: number) => SERIES_COLORS[i % SERIES_COLORS.length]!;
  const single = series.length === 1;

  const xTicks = useMemo(() => {
    if (!width) return [];
    if (p.xk === "time") return timeTicks(p.xMin, p.xMax, plotW).map((t) => ({ v: t.t, label: t.label }));
    if (p.xk === "number") {
      const { ticks, step } = niceTicks(p.xMin, p.xMax, Math.max(2, Math.floor(plotW / 72)));
      return ticks.map((t) => ({ v: t, label: fmtValue(t, xUnit, digitsFor(step), true) }));
    }
    const every = Math.max(1, Math.ceil(p.xs.length / Math.max(1, Math.floor(plotW / 56))));
    return p.xs.flatMap((c, i) => (i % every === 0 ? [{ v: i, label: String(c).length > 12 ? `${String(c).slice(0, 11)}…` : String(c) }] : []));
    // x is a pure function of p, width and left.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p, width, plotW, xUnit]);

  const marks = useMemo(() => {
    if (!width) return null;
    if (spec.kind === "candlestick") {
      const pts = (series[0]?.points ?? []) as ChartCandle[];
      const w = Math.max(1, Math.min(10, band * 0.66));
      return (
        <g>
          {pts.map((c) => {
            const cx = x(dateMs(c[0]));
            const up = c[4] >= c[1];
            const top = y(Math.max(c[1], c[4]));
            const bottom = y(Math.min(c[1], c[4]));
            return (
              <g key={c[0]} stroke={up ? UP : DOWN} fill={up ? UP : DOWN}>
                <line x1={cx} x2={cx} y1={y(c[2])} y2={y(c[3])} strokeWidth={1} />
                <rect x={cx - w / 2} y={top} width={w} height={Math.max(1, bottom - top)} strokeWidth={0} />
              </g>
            );
          })}
        </g>
      );
    }
    if (spec.kind === "bar") {
      const groupW = Math.max(1, band * 0.72);
      const barW = Math.max(1, groupW / series.length - (series.length > 1 ? 1 : 0));
      const zero = y(Math.max(p.yMin, Math.min(p.yMax, 0)));
      const signed = single && (spec.series?.[0]?.points as ChartPoint[]).some((q) => q[1] !== null && q[1] < 0);
      return (
        <g>
          {series.map((s, si) =>
            (s.points as ChartPoint[]).map((q) => {
              if (q[1] === null) return null;
              const cx = x(p.pos(q[0])) - groupW / 2 + si * (groupW / series.length);
              const top = Math.min(zero, y(q[1]));
              const fill = signed ? (q[1] >= 0 ? UP : DOWN) : color(si);
              return <rect key={`${si}-${String(q[0])}`} x={cx} y={top} width={barW} height={Math.max(0.5, Math.abs(y(q[1]) - zero))} rx={barW > 6 ? 2 : 0} fill={fill} opacity={signed || single ? 0.85 : 0.9} />;
            }),
          )}
        </g>
      );
    }
    if (spec.kind === "scatter") {
      return (
        <g>
          {series.map((s, si) =>
            (s.points as ChartPoint[]).map((q, k) => (q[1] === null ? null : <circle key={`${si}-${k}`} cx={x(p.pos(q[0]))} cy={y(q[1])} r={3} fill={color(si)} fillOpacity={0.7} />)),
          )}
        </g>
      );
    }
    // line / area: about two points per pixel is all a line can show.
    const base = y(Math.max(p.yMin, Math.min(p.yMax, 0)));
    return (
      <g>
        {[...series]
          .map((s, si) => ({ s, si }))
          .reverse()
          .map(({ s, si }) => {
            const pts = s.points as ChartPoint[];
            const stride = Math.max(1, Math.floor(pts.length / (plotW * 2)));
            let d = "";
            let pen = false;
            const runs: { from: number; to: number; path: string }[] = [];
            let run: { from: number; to: number; path: string } | null = null;
            const idx: number[] = [];
            for (let k = 0; k < pts.length; k += stride) idx.push(k);
            if (idx[idx.length - 1] !== pts.length - 1) idx.push(pts.length - 1);
            for (const k of idx) {
              const q = pts[k]!;
              if (q[1] === null) {
                pen = false;
                if (run) runs.push(run);
                run = null;
                continue;
              }
              const px = x(p.pos(q[0]));
              const py = y(q[1]);
              d += `${pen ? "L" : "M"}${px.toFixed(1)},${py.toFixed(1)}`;
              pen = true;
              if (!run) run = { from: px, to: px, path: `M${px.toFixed(1)},${py.toFixed(1)}` };
              else {
                run.path += `L${px.toFixed(1)},${py.toFixed(1)}`;
                run.to = px;
              }
            }
            if (run) runs.push(run);
            const c = color(si);
            return (
              <g key={si}>
                {spec.kind === "area"
                  ? runs.map((r, ri) => <path key={ri} d={`${r.path}L${r.to.toFixed(1)},${base.toFixed(1)}L${r.from.toFixed(1)},${base.toFixed(1)}Z`} fill={c} fillOpacity={single ? 0.1 : 0.07} stroke="none" />)
                  : null}
                <path d={d} fill="none" stroke={c} strokeWidth={si === 0 ? 2 : 1.75} strokeLinejoin="round" strokeLinecap="round" />
              </g>
            );
          })}
      </g>
    );
    // x and y are pure functions of these inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, p, width, plotW, plotH, left]);

  const n = p.xs.length;
  const pick = (clientX: number, clientY: number) => {
    const el = box.current;
    if (!el || !n) return;
    const rect = el.getBoundingClientRect();
    const mx = clientX - rect.left;
    const my = clientY - rect.top;
    if (spec.kind === "scatter") {
      let best: { i: number; s: number; d: number } | null = null;
      series.forEach((s, si) =>
        (s.points as ChartPoint[]).forEach((q) => {
          if (q[1] === null) return;
          const d = Math.hypot(x(p.pos(q[0])) - mx, y(q[1]) - my);
          if (d < 28 && (!best || d < best.d)) best = { i: p.xs.indexOf(q[0]), s: si, d };
        }),
      );
      const b = best as { i: number; s: number; d: number } | null;
      setHover(b ? { i: b.i, s: b.s } : null);
      return;
    }
    // Nearest x (binary search on positions).
    const target = p.xMin + ((mx - left) / plotW) * (p.xMax - p.xMin);
    let a = 0;
    let b = n - 1;
    while (b - a > 1) {
      const m = (a + b) >> 1;
      if (p.pos(p.xs[m]!) < target) a = m;
      else b = m;
    }
    setHover({ i: Math.abs(p.pos(p.xs[a]!) - target) <= Math.abs(p.pos(p.xs[b]!) - target) ? a : b });
  };

  const hx = hover ? p.xs[hover.i] : undefined;
  const tipLeft = hx !== undefined ? x(p.pos(hx)) : 0;
  const flip = hx !== undefined && tipLeft > width - 210;
  const candleAt = hx !== undefined && spec.kind === "candlestick" ? ((series[0]?.points ?? []) as ChartCandle[]).find((c) => c[0] === hx) : undefined;
  const rows =
    hx === undefined
      ? []
      : series.flatMap((s, si) => {
          if (hover?.s !== undefined && hover.s !== si) return [];
          const v = p.lookup[si]!.get(hx);
          return v === undefined ? [] : [{ si, name: s.name, v }];
        });
  const summary = `${spec.title}. ${series.map((s) => s.name).join(", ")}`;

  return (
    <div
      ref={box}
      className="relative select-none rounded-md outline-none [overflow-x:clip] focus-visible:ring-2 focus-visible:ring-line/20"
      style={{ height, touchAction: "pan-y" }}
      tabIndex={0}
      role="img"
      aria-label={summary}
      onPointerMove={(e) => pick(e.clientX, e.clientY)}
      onPointerDown={(e) => pick(e.clientX, e.clientY)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = e.shiftKey ? Math.max(1, Math.round(n / 12)) : 1;
        setHover((h) => ({ i: Math.max(0, Math.min(n - 1, (h?.i ?? n - 1) + (e.key === "ArrowLeft" ? -step : step))) }));
      }}
      onBlur={() => setHover(null)}
    >
      {width > 0 ? (
        <svg width={width} height={height} className="block overflow-visible" aria-hidden>
          <defs>
            <clipPath id={clipId}>
              <motion.rect
                x={left - 4}
                y={0}
                height={height}
                initial={reveal ? { width: 0 } : false}
                animate={{ width: plotW + 8 + PAD.right }}
                transition={{ duration: 0.7, ease: EASE_OUT }}
              />
            </clipPath>
          </defs>
          {p.yTicks.map((t) => (
            <g key={t}>
              <line x1={left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 && p.yMin < 0 ? "rgb(var(--f-line) / 0.22)" : "rgb(var(--f-line) / 0.06)"} />
              <text x={left - 8} y={y(t) + 3.5} textAnchor="end" fontSize={10.5} fill="rgb(var(--f-faint))" style={{ fontFamily: MONO }}>
                {yTickText(t)}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t.v} x={x(t.v)} y={PAD.top + plotH + 17} textAnchor="middle" fontSize={10.5} fill="rgb(var(--f-faint))" style={{ fontFamily: MONO }}>
              {t.label}
            </text>
          ))}
          {hasXLabel ? (
            <text x={left + plotW / 2} y={height - 4} textAnchor="middle" fontSize={11} fill="rgb(var(--f-quiet))">
              {spec.axes!.x!.label}
              {xUnit && p.xk !== "category" ? ` (${xUnit})` : ""}
            </text>
          ) : null}
          <g clipPath={`url(#${clipId})`}>{marks}</g>
          {hx !== undefined ? (
            <g>
              <line x1={tipLeft} x2={tipLeft} y1={PAD.top} y2={PAD.top + plotH} stroke="rgb(var(--f-line) / 0.25)" />
              {spec.kind === "line" || spec.kind === "area" || spec.kind === "scatter"
                ? rows.map((r) => (r.v === null ? null : <circle key={r.si} cx={tipLeft} cy={y(r.v)} r={4} fill={color(r.si)} stroke="rgb(var(--f-surface))" strokeWidth={2} />))
                : null}
            </g>
          ) : null}
        </svg>
      ) : null}
      {hx !== undefined && (rows.length || candleAt) ? (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[150px] max-w-[240px] rounded-md border border-line/10 bg-raised px-3 py-2 shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
          style={flip ? { right: width - tipLeft + 10 } : { left: tipLeft + 10 }}
        >
          <div className="text-fs-11 text-quiet" style={{ fontFamily: MONO }}>
            {xLabel(hx, p.xk, xUnit)}
          </div>
          {candleAt ? (
            <div className="mt-1.5 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-fs-12">
              {(["Open", "High", "Low", "Close"] as const).map((k, i) => (
                <span key={k} className="contents">
                  <span className="text-fore-4">{k}</span>
                  <span className="text-right tabular-nums text-fore" style={{ fontFamily: MONO }}>
                    {fmtValue(candleAt[i + 1] as number, yUnit)}
                  </span>
                </span>
              ))}
            </div>
          ) : (
            <div className="mt-1.5 flex flex-col gap-1">
              {rows.map((r) => (
                <div key={r.si} className="flex items-center gap-2 text-fs-12">
                  <span className="h-[2px] w-3 shrink-0 rounded-full" style={{ background: color(r.si) }} />
                  <span className="min-w-0 flex-1 truncate text-fore-4">{r.name}</span>
                  <span className="tabular-nums text-fore" style={{ fontFamily: MONO }}>
                    {fmtValue(r.v, yUnit)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Legend for several series: swatch and name, never color alone. */
export function ChartKey({ spec }: { spec: ChartSpec }) {
  const series = spec.series ?? [];
  if (series.length < 2) return null;
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
      {series.map((s, i) => (
        <li key={i} className="flex items-center gap-2 text-fs-12 text-fore-4">
          <svg width="16" height="6" aria-hidden>
            {spec.kind === "bar" || spec.kind === "scatter" ? (
              <rect x="4" y="0" width="8" height="6" rx="1.5" fill={SERIES_COLORS[i % SERIES_COLORS.length]} />
            ) : (
              <line x1="1" x2="15" y1="3" y2="3" stroke={SERIES_COLORS[i % SERIES_COLORS.length]} strokeWidth="2" strokeLinecap="round" />
            )}
          </svg>
          <span className="max-w-[220px] truncate">{s.name}</span>
        </li>
      ))}
    </ul>
  );
}
