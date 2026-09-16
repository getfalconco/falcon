"use client";

import { useMemo, useRef, useState } from "react";

/* ------------------------------------------------------------------ */
/* Types + palette shared by ProgressMetricCard                        */
/* ------------------------------------------------------------------ */

export type MetricAccent = "emerald" | "rose" | "sky" | "violet" | "amber" | "neutral";
export type ChartView = "curve" | "bars";

export interface SeriesPoint {
  value: number;
  date: string;
}

export interface MetricSeries {
  name: string;
  data: SeriesPoint[];
  accent?: MetricAccent;
}

export interface ChartSeries {
  name: string;
  data: SeriesPoint[];
  color: string;
}

/**
 * Hex values (not CSS vars) because the card composes them with alpha
 * suffixes like `${stroke}1f`.
 */
export const ACCENTS: Record<MetricAccent, { stroke: string; text: string }> = {
  emerald: { stroke: "#2ebd85", text: "#2ebd85" },
  rose: { stroke: "#e5484d", text: "#e5484d" },
  sky: { stroke: "#38bdf8", text: "#38bdf8" },
  violet: { stroke: "#a78bfa", text: "#a78bfa" },
  amber: { stroke: "#d3a44a", text: "#d3a44a" },
  neutral: { stroke: "#8b9096", text: "#9ba1a8" },
};

export const SERIES_COLORS = ["#2ebd85", "#38bdf8", "#a78bfa", "#d3a44a", "#e5484d"];

export function formatCompact(n: number): string {
  const abs = Math.abs(n);
  const trim = (v: number) => v.toFixed(1).replace(/\.0$/, "");
  if (abs >= 1_000_000_000) return `${trim(n / 1_000_000_000)}B`;
  if (abs >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (abs >= 1_000) return `${trim(n / 1_000)}K`;
  return String(Math.round(n));
}

/* ------------------------------------------------------------------ */
/* Chart geometry                                                      */
/* ------------------------------------------------------------------ */

// Vertical padding inside the 0..100 viewBox (top / bottom).
const PAD_TOP = 14;
const PAD_BOTTOM = 10;

function scaleY(value: number, min: number, max: number): number {
  const t = max === min ? 0.5 : (value - min) / (max - min);
  return 100 - PAD_BOTTOM - t * (100 - PAD_TOP - PAD_BOTTOM);
}

function buildSmoothPath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return "";
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const cp1x = p1[0] + (p2[0] - p0[0]) / 6;
    const cp1y = p1[1] + (p2[1] - p0[1]) / 6;
    const cp2x = p2[0] - (p3[0] - p1[0]) / 6;
    const cp2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C${cp1x},${cp1y} ${cp2x},${cp2y} ${p2[0]},${p2[1]}`;
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* MetricChart                                                         */
/* ------------------------------------------------------------------ */

type Props = {
  series: ChartSeries[];
  view: ChartView;
  defaultIndex?: number;
  valueFormatter: (value: number) => string;
  dateFormatter: (date: string) => string;
};

export function MetricChart({
  series,
  view,
  defaultIndex,
  valueFormatter,
  dateFormatter,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const primary = series[0];
  const n = primary?.data.length ?? 0;

  // Shared y-scale across every series so they are comparable.
  const { min, max } = useMemo(() => {
    const all = series.flatMap((s) => s.data.map((d) => d.value));
    return {
      min: all.length ? Math.min(...all) : 0,
      max: all.length ? Math.max(...all) : 1,
    };
  }, [series]);

  const xAt = (i: number) => (n <= 1 ? 50 : (i / (n - 1)) * 100);

  const paths = useMemo(
    () =>
      series.map((s) => {
        const pts = s.data.map(
          (d, i) => [xAt(i), scaleY(d.value, min, max)] as [number, number],
        );
        const line = buildSmoothPath(pts);
        return { line, area: `${line} L100,100 L0,100 Z`, pts };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [series, min, max, n],
  );

  if (n < 2) return null;

  const activeIndex = Math.max(
    0,
    Math.min(hoverIndex ?? defaultIndex ?? n - 1, n - 1),
  );
  const activeX = xAt(activeIndex);
  const activeY = scaleY(primary.data[activeIndex]?.value ?? 0, min, max);
  const flipLeft = activeX > 64;
  const nearTop = activeY < 34;

  const barGroupW = (100 / n) * 0.52;
  const barW = barGroupW / series.length;

  return (
    <div
      ref={containerRef}
      className="absolute inset-0"
      onMouseMove={(e) => {
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect || rect.width === 0) return;
        const f = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
        setHoverIndex(Math.round(f * (n - 1)));
      }}
      onMouseLeave={() => setHoverIndex(null)}
    >
      <svg
        viewBox="0 0 100 100"
        preserveAspectRatio="none"
        className="h-full w-full"
        aria-hidden
      >
        {view === "curve" ? (
          <>
            {series.length === 1 ? (
              <path d={paths[0].area} fill={`${series[0].color}14`} />
            ) : null}
            {paths.map((p, i) => (
              <path
                key={series[i].name}
                d={p.line}
                fill="none"
                stroke={series[i].color}
                strokeWidth="1.75"
                vectorEffect="non-scaling-stroke"
                strokeLinejoin="round"
                strokeLinecap="round"
              />
            ))}
          </>
        ) : (
          series.map((s, si) =>
            s.data.map((d, i) => {
              const y = scaleY(d.value, min, max);
              const x = xAt(i) - barGroupW / 2 + si * barW;
              const active = i === activeIndex;
              return (
                <rect
                  key={`${s.name}-${i}`}
                  x={x}
                  y={y}
                  width={barW * 0.86}
                  height={100 - PAD_BOTTOM - y}
                  rx="0.5"
                  fill={s.color}
                  opacity={active ? 0.95 : 0.45}
                />
              );
            }),
          )
        )}

        {/* Crosshair on the primary series */}
        <line
          x1={activeX}
          y1={PAD_TOP - 6}
          x2={activeX}
          y2={100 - PAD_BOTTOM + 4}
          stroke="currentColor"
          strokeOpacity="0.22"
          strokeWidth="1"
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
          className="text-foreground"
        />
      </svg>

      {/* Marker dots (HTML so they stay round despite the stretched viewBox) */}
      {series.map((s) => {
        const v = s.data[activeIndex]?.value;
        if (v == null) return null;
        return (
          <span
            key={s.name}
            className="pointer-events-none absolute h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-card"
            style={{
              left: `${activeX}%`,
              top: `${scaleY(v, min, max)}%`,
              background: s.color,
            }}
          />
        );
      })}

      {/* Tooltip */}
      <div
        className="pointer-events-none absolute z-20 whitespace-nowrap rounded-lg border border-white/[0.1] bg-[#161616] px-2.5 py-1.5 shadow-lg"
        style={{
          left: `${activeX}%`,
          top: `${activeY}%`,
          transform: `translate(${flipLeft ? "calc(-100% - 10px)" : "10px"}, ${
            nearTop ? "8px" : "-100%"
          })`,
        }}
      >
        {series.map((s) => (
          <p
            key={s.name}
            className="text-[12px] font-medium tabular-nums text-foreground"
          >
            {series.length > 1 ? (
              <span
                className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                style={{ background: s.color }}
              />
            ) : null}
            {valueFormatter(s.data[activeIndex]?.value ?? 0)}
          </p>
        ))}
        <p className="mt-0.5 text-[10.5px] text-fg-faint">
          {dateFormatter(primary.data[activeIndex]?.date ?? "")}
        </p>
      </div>
    </div>
  );
}
