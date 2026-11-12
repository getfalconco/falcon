"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MONO } from "../parts";

export type ChartSeries = {
  id: string;
  label: string;
  color: string;
  dashed?: boolean;
  /** Line width, default 2. */
  weight?: number;
  /** Percent return from the start, by session date. */
  values: Map<string, number>;
};

const PAD = { top: 12, right: 14, bottom: 26, left: 52 };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function niceStep(span: number, target: number): number {
  const raw = span / Math.max(1, target);
  const mag = 10 ** Math.floor(Math.log10(raw));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
}

export function pct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const s = v.toFixed(digits);
  return `${v > 0 ? "+" : ""}${s === "-0.0" ? "0.0" : s}%`;
}

function longDate(d: string): string {
  const [y, m, day] = d.split("-");
  return `${MONTHS[Number(m) - 1]} ${Number(day)}, ${y}`;
}

/**
 * Growth of each series as percent return from the first session, on one
 * axis. Hover (or arrow keys) reads every series on that day.
 */
export function EquityChart({ dates, series, height = 300 }: { dates: string[]; series: ChartSeries[]; height?: number }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setWidth(Math.floor(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const n = dates.length;
  const plotW = Math.max(10, width - PAD.left - PAD.right);
  const plotH = height - PAD.top - PAD.bottom;

  const { min, max, ticks } = useMemo(() => {
    let lo = 0;
    let hi = 0;
    for (const s of series) {
      for (const v of Array.from(s.values.values())) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    // A little air above and below the lines; gridlines at round steps inside.
    const span = hi - lo || 10;
    const min = lo - span * 0.04;
    const max = hi + span * 0.04;
    const step = niceStep(span, 5);
    const ticks: number[] = [];
    for (let t = Math.ceil(min / step) * step; t <= max; t += step) ticks.push(Math.round(t * 1e6) / 1e6);
    return { min, max, ticks };
  }, [series]);

  const x = (i: number) => PAD.left + (n > 1 ? (i / (n - 1)) * plotW : 0);
  const y = (v: number) => PAD.top + (1 - (v - min) / (max - min || 1)) * plotH;

  const paths = useMemo(() => {
    if (!width || n < 2) return [];
    // About two points per pixel is all a line can show.
    const stride = Math.max(1, Math.floor(n / (plotW * 2)));
    const idx: number[] = [];
    for (let i = 0; i < n; i += stride) idx.push(i);
    if (idx[idx.length - 1] !== n - 1) idx.push(n - 1);
    return series.map((s) => {
      let d = "";
      let pen = false;
      for (const i of idx) {
        const v = s.values.get(dates[i]!);
        if (v === undefined) {
          pen = false;
          continue;
        }
        d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
      return { s, d };
    });
    // x and y are pure functions of these inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series, dates, width, min, max, plotW, plotH, n]);

  const xTicks = useMemo(() => {
    if (n < 2) return [];
    const years = Number(dates[n - 1]!.slice(0, 4)) - Number(dates[0]!.slice(0, 4));
    const out: { i: number; label: string }[] = [];
    if (years >= 2) {
      const every = years > 8 ? 2 : 1;
      let last = "";
      dates.forEach((d, i) => {
        const yr = d.slice(0, 4);
        if (yr !== last) {
          last = yr;
          if (i > 0 && Number(yr) % every === 0) out.push({ i, label: yr });
        }
      });
    } else {
      let last = "";
      dates.forEach((d, i) => {
        const m = d.slice(0, 7);
        if (m !== last) {
          last = m;
          const month = Number(d.slice(5, 7));
          if (i > 0 && (years >= 1 ? month % 3 === 1 : true)) out.push({ i, label: `${MONTHS[month - 1]}${month === 1 ? ` ${d.slice(2, 4)}` : ""}` });
        }
      });
    }
    // Keep labels at least ~56px apart.
    const spaced: typeof out = [];
    for (const t of out) if (!spaced.length || x(t.i) - x(spaced[spaced.length - 1]!.i) >= 56) spaced.push(t);
    return spaced;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dates, n, width]);

  const pick = (clientX: number) => {
    const el = box.current;
    if (!el || n < 2) return;
    const rect = el.getBoundingClientRect();
    const i = Math.round(((clientX - rect.left - PAD.left) / plotW) * (n - 1));
    setHover(Math.max(0, Math.min(n - 1, i)));
  };

  const hi = hover !== null ? hover : null;
  const tipLeft = hi !== null ? x(hi) : 0;
  const flip = hi !== null && tipLeft > width - 200;

  return (
    <div
      ref={box}
      className="relative select-none outline-none focus-visible:ring-2 focus-visible:ring-black/20"
      style={{ height }}
      tabIndex={0}
      role="img"
      aria-label={`Equity curves: ${series.map((s) => `${s.label} ${pct(s.values.get(dates[n - 1] ?? ""))}`).join(", ")}`}
      onPointerMove={(e) => pick(e.clientX)}
      onPointerLeave={() => setHover(null)}
      onKeyDown={(e) => {
        if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
        e.preventDefault();
        const step = e.shiftKey ? 21 : 1;
        setHover((h) => Math.max(0, Math.min(n - 1, (h ?? n - 1) + (e.key === "ArrowLeft" ? -step : step))));
      }}
      onBlur={() => setHover(null)}
    >
      {width > 0 ? (
        <svg width={width} height={height} className="block overflow-visible" aria-hidden>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? "rgba(0,0,0,0.22)" : "rgba(0,0,0,0.06)"} />
              <text x={PAD.left - 8} y={y(t) + 3.5} textAnchor="end" fontSize={10.5} fill="#9a9a9a" style={{ fontFamily: MONO }}>
                {`${t > 0 ? "+" : ""}${Math.abs(t) >= 1000 ? `${(t / 1000).toFixed(1)}k` : t}%`}
              </text>
            </g>
          ))}
          {xTicks.map((t) => (
            <text key={t.i} x={x(t.i)} y={height - 8} textAnchor="middle" fontSize={10.5} fill="#9a9a9a" style={{ fontFamily: MONO }}>
              {t.label}
            </text>
          ))}
          {/* Later series sit under earlier ones: the strategy draws last. */}
          {[...paths].reverse().map(({ s, d }) => (
            <path
              key={s.id}
              d={d}
              fill="none"
              stroke={s.color}
              strokeWidth={s.weight ?? (s.dashed ? 1.5 : 2)}
              strokeDasharray={s.dashed ? "4 3" : undefined}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
          ))}
          {hi !== null ? (
            <g>
              <line x1={x(hi)} x2={x(hi)} y1={PAD.top} y2={PAD.top + plotH} stroke="rgba(0,0,0,0.25)" />
              {series.map((s) => {
                const v = s.values.get(dates[hi]!);
                return v === undefined ? null : <circle key={s.id} cx={x(hi)} cy={y(v)} r={4} fill={s.color} stroke="#fff" strokeWidth={2} />;
              })}
            </g>
          ) : null}
        </svg>
      ) : null}
      {hi !== null ? (
        <div
          className="pointer-events-none absolute top-2 z-10 min-w-[180px] rounded-md border border-black/10 bg-white px-3 py-2 shadow-[0_4px_16px_rgba(0,0,0,0.08)]"
          style={flip ? { right: width - tipLeft + 10 } : { left: tipLeft + 10 }}
        >
          <div className="text-[11px] text-[#767676]" style={{ fontFamily: MONO }}>
            {longDate(dates[hi]!)}
          </div>
          <div className="mt-1.5 flex flex-col gap-1">
            {series.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-[12px]">
                <span className="h-[2px] w-3 shrink-0 rounded-full" style={{ background: s.color }} />
                <span className="min-w-0 flex-1 truncate text-[#4b4b48]">{s.label}</span>
                <span className="tabular-nums text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                  {pct(s.values.get(dates[hi]!))}
                </span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Legend above the chart: identity by swatch and name, never color alone. */
export function ChartLegend({ series, last }: { series: ChartSeries[]; last: string | undefined }) {
  return (
    <ul className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
      {series.map((s) => (
        <li key={s.id} className="flex items-center gap-2 text-[12px] text-[#4b4b48]">
          <svg width="16" height="6" aria-hidden>
            <line x1="1" x2="15" y1="3" y2="3" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? "4 3" : undefined} strokeLinecap="round" />
          </svg>
          <span className="max-w-[220px] truncate">{s.label}</span>
          {last ? (
            <span className="tabular-nums text-[#1d1b1b]" style={{ fontFamily: MONO }}>
              {pct(s.values.get(last))}
            </span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
