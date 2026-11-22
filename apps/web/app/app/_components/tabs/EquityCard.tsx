"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { fetchEquity, fetchHistory, type EquityAnswer } from "@/lib/portfolio-client";
import { DEFAULT_RANGE, EQUITY_RANGES, finishCurve, historyStart, nearestIndex, niceTicks, nominalStart, rangeCoverage, snapshotOf, snapshotPoints, timeScale, timeTicks, type EquityPoint, type EquityRange } from "@/lib/workspace/equity";
import { compactMoney, money, pctText, signedMoney, tone } from "@/lib/workspace/positions-view";
import { useWorkspace } from "../context";
import { FlatMark } from "./FlatMark";

/**
 * The Dashboard's Equity card, beside the Portfolio Overview (same shell and
 * height on wide panes, below it on narrow ones): the member's real equity
 * over a timeframe (1D to 5Y), from the moment they connected a portfolio.
 * Falcon records a snapshot of the holdings every time they change; the
 * server rebuilds the curve from those snapshots x market prices (5-minute
 * bars for the day, finer bars for the real part of a long timeframe) and
 * sends values only (/api/portfolio/equity, lib/workspace/equity.ts). The
 * chart starts on the account's first day, never before (SPY included,
 * rebased to the account's value that day): a timeframe that begins earlier
 * is drawn from that day and labelled "Since Nov 18" beside the change, and
 * the longer ones that would draw the same thing are disabled. The x axis is
 * time (calendar time from 1M on, trading time for 1D and 1W: timeScale).
 * The curve ends at the live total, the Positions card's.
 *
 * A paper account kept in this browser only (the preview) has no server
 * history: its one snapshot (cash, at creation) is built here, priced the same
 * way. The timeframe and the SPY overlay live in memory only.
 */

const TONE_CLASS = { up: "text-up", down: "text-down", flat: "text-quiet" } as const;
const COLOR = { up: "rgb(var(--f-up))", down: "rgb(var(--f-down))", flat: "rgb(var(--f-fore) / 0.45)" } as const;
const SPY_COLOR = "rgb(var(--f-fore) / 0.35)";
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/25";
const BENCH = "SPY";

/** The curve's points for the timeframe: from the server's history, or built here for a paper account kept in memory; refetched on change and every few minutes while visible. */
function useEquity(range: EquityRange, currency: string, enabled: boolean): { answer: EquityAnswer | null; loading: boolean } {
  const { holdings, getToken } = useWorkspace();
  const localPaper = holdings.paperInMemory && !holdings.test ? holdings.paper : null;
  const source = holdings.test ? `seed:${holdings.seed}` : holdings.mode === "fixture" ? "fixture" : holdings.mode === "sizes" ? "member" : localPaper ? `paper:${localPaper.asOf}:${localPaper.cash}` : "none";
  // Re-read after the holdings change too (a save writes a new snapshot).
  const key = `${range}|${currency}|${source}|${holdings.data?.positions.length ?? 0}|${holdings.data?.accounts.length ?? 0}`;
  const [state, setState] = useState<{ key: string; answer: EquityAnswer | null } | null>(null);
  const [loadingKey, setLoadingKey] = useState<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const ctrl = new AbortController();
    const load = async () => {
      setLoadingKey(key);
      let answer: EquityAnswer | null = null;
      if (localPaper && source.startsWith("paper:")) {
        // The paper account's only snapshot: its cash, from its creation; SPY gives the times.
        const series = await fetchHistory([BENCH], range, ctrl.signal);
        const now = Date.now();
        const from = nominalStart(range, now) ?? series[BENCH]?.t[0] ?? now - 86_400_000;
        const at = Date.parse(localPaper.asOf ?? "") || now;
        const snaps = [{ at, source: "paper" as const, ...snapshotOf([localPaper], []) }];
        const built = snapshotPoints({ snapshots: snaps, series, from, nowMs: now, currency, spy: series[BENCH] ?? null });
        answer = { points: built.points, firstAt: built.firstAt, from, at: now };
      } else if (source !== "none") {
        const token = holdings.mode === "sizes" && !holdings.test ? await getToken() : null;
        if (holdings.mode === "sizes" && !holdings.test && !token) answer = null;
        else answer = await fetchEquity(token ? { Authorization: `Bearer ${token}` } : {}, { range, currency, fixture: holdings.test ? holdings.seed ?? false : holdings.mode === "fixture", signal: ctrl.signal });
      }
      if (ctrl.signal.aborted) return;
      setState({ key, answer });
      setLoadingKey(null);
    };
    void load();
    const every = range === "1D" ? 60_000 : range === "1W" ? 2 * 60_000 : 15 * 60_000;
    const timer = setInterval(() => {
      if (!document.hidden) void load();
    }, every);
    return () => {
      ctrl.abort();
      clearInterval(timer);
    };
    // `key` covers the range, the currency and where the history comes from.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, enabled]);
  return { answer: state?.key === key ? state.answer : null, loading: loadingKey === key };
}

/** The element's size, re-read when it changes. */
function useSize(): { ref: (el: HTMLElement | null) => void; size: { w: number; h: number } | null } {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  useEffect(() => {
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setSize({ w: Math.floor(e.contentRect.width), h: Math.floor(e.contentRect.height) }));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return { ref: setEl, size };
}

export function EquityCard({ currency, total, hasSizes, className = "", style }: {
  currency: string;
  /** The live total (positions plus cash): the curve's last point; null without sizes. */
  total: number | null;
  hasSizes: boolean;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [range, setRange] = useState<EquityRange>(DEFAULT_RANGE);
  // SPY is shown by default; the toggle hides it.
  const [showSpy, setShowSpy] = useState(true);
  const { answer, loading } = useEquity(range, currency, hasSizes && total !== null);
  // The account's first day, kept while another timeframe loads, for the timeframe buttons.
  const [firstAt, setFirstAt] = useState<number | null>(null);
  useEffect(() => {
    if (answer) setFirstAt(answer.firstAt);
  }, [answer]);
  const coverage = rangeCoverage(firstAt, Date.now());
  const covering = EQUITY_RANGES.find((r) => coverage[r] === "since");
  const curve = useMemo(() => (answer && total !== null ? finishCurve(answer.points, total, Math.max(answer.at, Date.now()), answer.firstAt) : null), [answer, total]);

  const shell = `flex min-w-0 flex-col rounded-2xl border border-line/[0.08] bg-raised px-5 pb-3 pt-4 shadow-[0_1px_2px_rgba(0,0,0,0.05),0_8px_24px_-6px_rgba(0,0,0,0.10)] ${className}`;
  const label = <p className="mb-2 text-fs-13 text-quiet">Equity</p>;

  if (!hasSizes || total === null) {
    return (
      <section aria-label="Equity" className={shell} style={style}>
        {label}
        <div className="flex flex-1 items-center justify-center py-10 text-fs-13 text-quiet">Add your holdings to see equity</div>
      </section>
    );
  }

  const drawn = curve !== null && curve.points.length > 1;
  const t = !drawn || curve.change === null || Math.abs(curve.change) < 0.005 ? "flat" : tone(curve.change);
  // The history is shorter than the timeframe: the change says from when, in place of the timeframe's name.
  const since = drawn && answer ? historyStart(range, answer.firstAt, answer.from) : null;
  return (
    <section aria-label="Equity" className={shell} style={style}>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0">
          {label}
          <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-0.5 tabular-nums">
            <span className="text-fs-17 font-semibold leading-fs-24 text-fore">{money(total, currency)}</span>
            {drawn && curve.change !== null ? (
              <span className={`inline-flex items-center gap-1 text-fs-13 font-medium ${TONE_CLASS[t]}`}>
                {signedMoney(t === "flat" ? 0 : curve.change, currency, 0)}
                {t === "flat" ? <FlatMark /> : <span aria-hidden>·</span>}
                {pctText(t === "flat" ? 0 : curve.pct ?? 0, 1)}
                <span className="font-normal">{since !== null ? `Since ${sinceText(since, range)}` : range}</span>
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            aria-pressed={showSpy}
            onClick={() => setShowSpy((v) => !v)}
            className={`rounded-md px-1.5 py-0.5 text-fs-11 font-medium transition-colors ${showSpy ? "bg-line/[0.08] text-fore" : "text-quiet hover:text-fore"} ${FOCUS}`}
            title="SPY over the same period, from the same starting value"
          >
            vs SPY
          </button>
          <div role="radiogroup" aria-label="Timeframe" className="flex items-center rounded-lg bg-line/[0.04] p-0.5">
            {EQUITY_RANGES.map((r) => {
              // Longer than the account's history and the same as a shorter timeframe: nothing new to show.
              const same = coverage[r] === "same" && r !== range;
              const opened = firstAt !== null ? sinceText(firstAt, "1M") : "";
              return (
                <button
                  key={r}
                  type="button"
                  role="radio"
                  aria-checked={r === range}
                  disabled={same}
                  onClick={() => setRange(r)}
                  title={same ? `Your account opened ${opened}, so ${r} shows the same as ${covering ?? "a shorter timeframe"}` : coverage[r] === "since" ? `Since ${opened}, when your account opened` : undefined}
                  className={`rounded-md px-1.5 py-0.5 text-fs-11 font-medium tabular-nums transition-colors ${r === range ? "bg-raised text-fore shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : same ? "cursor-default text-faint opacity-60" : "text-quiet hover:text-fore"} ${FOCUS}`}
                >
                  {r}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {drawn ? (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-fs-11 tabular-nums text-quiet">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden className="h-[2px] w-3 rounded-full" style={{ background: COLOR[t] }} />
            Portfolio <span className={TONE_CLASS[t]}>{pctText(t === "flat" ? 0 : curve.pct ?? 0, 1)}</span>
          </span>
          {showSpy ? (
            curve.spyPct !== null ? (
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="h-[1.5px] w-3 rounded-full" style={{ background: SPY_COLOR }} />
                SPY <span>{pctText(curve.spyPct, 1)}</span>
              </span>
            ) : (
              <span>SPY isn&apos;t available for this range</span>
            )
          ) : null}
        </div>
      ) : null}
      <div className="relative mt-2 min-h-[200px] flex-1">
        {drawn ? (
          <Plot points={curve.points} start={curve.start!} range={range} currency={currency} color={COLOR[t]} showSpy={showSpy} />
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 px-6 text-center text-fs-13 text-quiet">
            {loading && !answer ? (
              "Loading"
            ) : (
              <>
                <span>Your equity history starts when your portfolio is saved.</span>
                <span className="text-fs-12 text-faint">From then on, every change to your holdings is tracked here.</span>
              </>
            )}
          </div>
        )}
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ the plot */

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Mar 2022" for the long timeframes, "Nov 12" for the short ones. */
function sinceText(t: number, range: EquityRange): string {
  const d = new Date(t);
  if (range === "1D") return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return d.getFullYear() === new Date().getFullYear() ? `${MONTHS[d.getMonth()]} ${d.getDate()}` : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function tipDate(t: number, range: EquityRange): string {
  const d = new Date(t);
  const day = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (range === "1D" || range === "1W" || range === "1M") return `${day}, ${d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}`;
  return `${day}, ${d.getFullYear()}`;
}

/** A smooth path through the points that never overshoots them (monotone cubic). */
function smoothPath(xs: readonly number[], ys: readonly number[]): string {
  const n = xs.length;
  if (n < 3) return xs.map((x, i) => `${i ? "L" : "M"}${x.toFixed(1)},${ys[i]!.toFixed(1)}`).join("");
  const d: number[] = [];
  const m: number[] = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1]! - ys[i]!) / (xs[i + 1]! - xs[i]! || 1));
  m.push(d[0]!);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1]! * d[i]! <= 0 ? 0 : (d[i - 1]! + d[i]!) / 2);
  m.push(d[n - 2]!);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const a = m[i]! / d[i]!;
    const b = m[i + 1]! / d[i]!;
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      m[i] = k * a * d[i]!;
      m[i + 1] = k * b * d[i]!;
    }
  }
  let p = `M${xs[0]!.toFixed(1)},${ys[0]!.toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = (xs[i + 1]! - xs[i]!) / 3;
    p += `C${(xs[i]! + h).toFixed(1)},${(ys[i]! + m[i]! * h).toFixed(1)} ${(xs[i + 1]! - h).toFixed(1)},${(ys[i + 1]! - m[i + 1]! * h).toFixed(1)} ${xs[i + 1]!.toFixed(1)},${ys[i + 1]!.toFixed(1)}`;
  }
  return p;
}

const PAD = { top: 8, right: 52, bottom: 20, left: 2 };

/**
 * The line's runs: smooth inside a run, one straight segment across a gap
 * (a step wider than 4 times the typical one: missing days, a weekend on the
 * calendar scale), so nothing is invented where there is no data.
 */
function linePath(xs: readonly number[], ys: readonly number[]): string {
  const steps = xs.slice(1).map((x, i) => x - xs[i]!).filter((d) => d > 0).sort((a, b) => a - b);
  const typical = steps[Math.floor(steps.length / 2)] ?? 0;
  let out = "";
  let from = 0;
  for (let i = 1; i <= xs.length; i++) {
    if (i < xs.length && !(typical > 0 && xs[i]! - xs[i - 1]! > Math.max(4 * typical, 6))) continue;
    const run = smoothPath(xs.slice(from, i), ys.slice(from, i));
    out += from ? `L${run.slice(1)}` : run;
    from = i;
  }
  return out;
}

function Plot({ points, start, range, currency, color, showSpy }: { points: EquityPoint[]; start: number; range: EquityRange; currency: string; color: string; showSpy: boolean }) {
  const { ref, size } = useSize();
  const gradient = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  // x from the points' times (calendar time, or trading time for 1D and 1W: lib/workspace/equity.ts timeScale).
  const times = useMemo(() => points.map((p) => p.t), [points]);
  const scale = useMemo(() => timeScale(range, times), [range, times]);

  const w = size?.w ?? 0;
  const h = size?.h ?? 0;
  const plotW = Math.max(1, w - PAD.left - PAD.right);
  const plotH = Math.max(1, h - PAD.top - PAD.bottom);
  const values = points.flatMap((p) => (showSpy && p.spy !== null ? [p.v, p.spy] : [p.v]));
  let lo = Math.min(...values, start);
  let hi = Math.max(...values, start);
  if (hi - lo < Math.max(1, Math.abs(hi) * 0.002)) {
    const mid = (hi + lo) / 2;
    const pad = Math.max(1, Math.abs(mid) * 0.01);
    lo = mid - pad;
    hi = mid + pad;
  }
  const span = hi - lo;
  lo -= span * 0.08;
  hi += span * 0.08;
  const xAt = (t: number) => PAD.left + (points.length === 1 ? plotW : scale.at(t) * plotW);
  const y = (v: number) => PAD.top + (1 - (v - lo) / (hi - lo)) * plotH;
  const xs = points.map((p) => xAt(p.t));
  const line = linePath(xs, points.map((p) => y(p.v)));
  const area = `${line}L${xs[xs.length - 1]!.toFixed(1)},${(PAD.top + plotH).toFixed(1)}L${xs[0]!.toFixed(1)},${(PAD.top + plotH).toFixed(1)}Z`;
  // SPY on the same time scale; a point without SPY breaks its line.
  let spyLine = "";
  points.forEach((p, i) => {
    if (p.spy !== null) spyLine += `${i && points[i - 1]!.spy !== null ? "L" : "M"}${xs[i]!.toFixed(1)},${y(p.spy).toFixed(1)}`;
  });
  const ticks = niceTicks(lo, hi, 4).filter((v) => v >= lo && v <= hi);
  // Date labels placed by time, each at least 44px from the last one kept.
  const dates = timeTicks(scale, Math.max(2, Math.min(6, Math.floor(plotW / 90)))).reduce<{ x: number; label: string }[]>((kept, k) => {
    const x = xAt(k.t);
    if (!kept.length || x - kept[kept.length - 1]!.x >= 44) kept.push({ x, label: k.label });
    return kept;
  }, []);

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r) return;
    // The pointer's time, then the point nearest to it in time.
    const i = nearestIndex(times, scale.invert((e.clientX - r.left - PAD.left) / plotW));
    setHover(i < 0 ? null : i);
  };
  const hp = hover !== null ? points[hover] : null;
  const hChange = hp ? hp.v - start : 0;

  return (
    <div ref={ref} className="absolute inset-0">
      {w > 0 && h > 0 ? (
        <svg
          ref={svgRef}
          width={w}
          height={h}
          role="img"
          aria-label={`Equity over ${range}: from ${money(start, currency)} to ${money(points[points.length - 1]!.v, currency)}`}
          onPointerMove={onMove}
          onPointerLeave={() => setHover(null)}
          className="block touch-none select-none"
        >
          <defs>
            <linearGradient id={gradient} x1="0" x2="0" y1="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.16} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          {ticks.map((v) => (
            <g key={v}>
              <line x1={PAD.left} x2={PAD.left + plotW} y1={y(v)} y2={y(v)} stroke="rgb(var(--f-line) / 0.06)" />
              <text x={w - 2} y={y(v) + 3.5} textAnchor="end" className="fill-[rgb(var(--f-fore)/0.45)] text-[10.5px] tabular-nums">
                {compactMoney(v, currency)}
              </text>
            </g>
          ))}
          <line x1={PAD.left} x2={PAD.left + plotW} y1={y(start)} y2={y(start)} stroke="rgb(var(--f-fore) / 0.25)" strokeDasharray="3 3" />
          <path d={area} fill={`url(#${gradient})`} />
          {showSpy && spyLine.includes("L") ? <path d={spyLine} fill="none" stroke={SPY_COLOR} strokeWidth={1} /> : null}
          <path d={line} fill="none" stroke={color} strokeWidth={1.75} strokeLinejoin="round" strokeLinecap="round" />
          {dates.map((d) => (
            <g key={`${d.label}-${d.x}`}>
              <line x1={d.x} x2={d.x} y1={PAD.top + plotH} y2={PAD.top + plotH + 3} stroke="rgb(var(--f-fore) / 0.2)" />
              <text x={d.x} y={h - 4} textAnchor={d.x < PAD.left + 24 ? "start" : d.x > PAD.left + plotW - 24 ? "end" : "middle"} className="fill-[rgb(var(--f-fore)/0.45)] text-[10.5px]">
                {d.label}
              </text>
            </g>
          ))}
          {hp ? (
            <g pointerEvents="none">
              <line x1={xs[hover!]!} x2={xs[hover!]!} y1={PAD.top} y2={PAD.top + plotH} stroke="rgb(var(--f-fore) / 0.25)" />
              {showSpy && hp.spy !== null ? <circle cx={xs[hover!]!} cy={y(hp.spy)} r={2.5} fill={SPY_COLOR} /> : null}
              <circle cx={xs[hover!]!} cy={y(hp.v)} r={3.5} fill={color} stroke="rgb(var(--f-raised))" strokeWidth={1.5} />
            </g>
          ) : null}
        </svg>
      ) : null}
      {hp ? (
        <div
          className="pointer-events-none absolute top-1 z-10 rounded-lg border border-line/[0.08] bg-raised px-2.5 py-1.5 text-fs-12 leading-fs-17 tabular-nums shadow-[0_4px_16px_-4px_rgba(0,0,0,0.18)]"
          style={xs[hover!]! > w / 2 ? { right: w - xs[hover!]! + 10 } : { left: xs[hover!]! + 10 }}
        >
          <div className="text-quiet">{tipDate(hp.t, range)}</div>
          <div className="font-medium text-fore">{money(hp.v, currency)}</div>
          <div className={TONE_CLASS[Math.abs(hChange) < 0.005 ? "flat" : tone(hChange)]}>
            {signedMoney(hChange, currency, 0)} · {pctText(start ? (hChange / Math.abs(start)) * 100 : 0, 2)}
          </div>
          {showSpy && hp.spy !== null ? <div className="text-quiet">SPY {pctText(start ? ((hp.spy - start) / Math.abs(start)) * 100 : 0, 2)}</div> : null}
        </div>
      ) : null}
    </div>
  );
}
