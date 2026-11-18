"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { ArrowDown, ArrowLeftRight, ArrowUp, ChartLine, Check, ChevronLeft, CodeXml, Copy, Download, FlaskConical, LayoutDashboard, LoaderCircle, ShieldCheck, Terminal, TriangleAlert, X } from "lucide-react";
import { TRADES_DEFINITION, benchmarkLong, benchmarkName, fmtPct, isTickerName, type RunResult, type RunTrade } from "@/lib/desk/run-result";
import { fmtPts, type HeadlinePart } from "@/lib/desk/robustness";
import { describeEventRules, eventCountsLine, type EventSpecInfo } from "@/lib/desk/event-spec";
import { MONO } from "../parts";
import { ICON_BUTTON } from "../shell/ui";
import { observeSettledSize } from "../shell/resize";
import { ChartLegend, EquityChart, type ChartSeries } from "../strategy/EquityChart";
import { highlightPython } from "./highlight";
import { seriesCsv, tradesCsv, type LabRun } from "./run";
import { AuditChecks, EvidenceCard } from "./AuditView";
import { Benchmarks, Caveats, KeyStats, useRunStats } from "./RunHonesty";
import { PanelSources } from "./PanelSources";

/**
 * The results panel of a Desk strategy test: a left sub-nav (Overview,
 * Equity, Trades, Code, Logs) and the content, with the strategy's name and
 * period on top. `RunSplit` puts it beside the chat (resizable divider; a
 * full overlay with a back button when the pane is narrow), `RunChip` is the
 * "View results" chip on the reply, `useRunPanel` keeps which run is shown.
 */

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/20";
const INK = "rgb(var(--f-fore))";
const SPY = "rgb(var(--f-chart-spy))";
const DD = "rgb(var(--f-down))";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const TABS = [
  { id: "overview", label: "Overview", icon: LayoutDashboard },
  { id: "audit", label: "Audit", icon: ShieldCheck },
  { id: "equity", label: "Equity", icon: ChartLine },
  { id: "trades", label: "Trades", icon: ArrowLeftRight },
  { id: "code", label: "Code", icon: CodeXml },
  { id: "logs", label: "Logs", icon: Terminal },
] as const;
type Tab = (typeof TABS)[number]["id"];

/** "Nov 16, 2021" from "2021-11-16", no time zone involved. */
function day(d: string): string {
  const [y, m, dd] = d.split("-");
  return y && m && dd ? `${MONTHS[Number(m) - 1]} ${Number(dd)}, ${y}` : d;
}

const num = (v: number | null | undefined, digits = 2) => (v === null || v === undefined || !Number.isFinite(v) ? "n/a" : v.toFixed(digits));
const tone = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) || v === 0 ? "text-fore" : v > 0 ? "text-up" : "text-down");

/* ------------------------------------------------------------------ state */

/**
 * Runs the panel has opened by itself this page visit, by id: each opens once, when its result arrives, so a
 * panel the member closed stays closed for that run (a remount or a later re-run of it does not reopen it).
 */
const autoOpened = new Set<string>();

/**
 * Which run the panel shows and whether it is open. `runs`: the session's tests that have a result (never code
 * that only drew a chart or computed something). `liveResult`: the run whose result just arrived in the reply
 * streaming now; the panel opens for it once. Nothing opens at a tool call's start, while code is written, or
 * for a reply loaded from history; the header button and the reply's chip open it by hand.
 */
export function useRunPanel(runs: LabRun[], liveResult?: string) {
  const latest = runs[runs.length - 1];
  const [shownId, setShownId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!liveResult || autoOpened.has(liveResult)) return;
    autoOpened.add(liveResult);
    setShownId(liveResult);
    setOpen(true);
  }, [liveResult]);
  const run = runs.find((r) => r.id === shownId) ?? latest;
  return {
    run,
    open: open && !!run,
    show: (id: string) => {
      setShownId(id);
      setOpen(true);
    },
    toggle: () => setOpen((o) => !o),
    close: () => setOpen(false),
  };
}

/* ------------------------------------------------------------------ chip */

/** "View results" on the reply that ran a test; shows the run's state. */
export function RunChip({ run, active, onOpen }: { run: LabRun; active: boolean; onOpen: () => void }) {
  const r = run.result;
  const running = run.status === "running";
  const h = useRunStats(run)?.headline;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-pressed={active}
      className={`group flex w-full max-w-[460px] items-center gap-3 rounded-xl border px-3 py-2.5 text-left transition-colors ${
        active ? "border-line/[0.18] bg-line/[0.04]" : "border-line/[0.1] bg-surface hover:bg-line/[0.03]"
      } ${FOCUS}`}
    >
      <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-line/[0.05] text-fore-3">
        {running ? <LoaderCircle width={15} height={15} strokeWidth={2} className="animate-spin" aria-hidden /> : <FlaskConical width={15} height={15} strokeWidth={1.75} aria-hidden />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-fs-13.5 font-medium leading-fs-20 text-fore">{r?.name ?? (running ? "Running strategy test…" : "Strategy test")}</span>
        <span className="truncate text-fs-12 leading-fs-18 text-quiet">
          {r ? (
            <>
              {h?.scope === "oos" ? "Out of sample: " : ""}
              <span style={{ fontFamily: MONO }}>CAGR {fmtPct(h ? h.main.cagr : r.metrics.cagr)}</span> · <span style={{ fontFamily: MONO }}>{h?.benchmark ?? benchmarkName(r)} {fmtPct(h ? h.main.bench_cagr : r.metrics.benchmark.cagr)}</span> ·{" "}
              {(h?.main.start || r.period.start).slice(0, 4)}–{(h?.main.end || r.period.end).slice(0, 4)}
            </>
          ) : running ? (
            "Writing and running the code"
          ) : (
            (run.error ?? "No results")
          )}
        </span>
      </span>
      <span className="shrink-0 text-fs-12.5 font-medium text-fore-3 group-hover:text-fore">View results</span>
    </button>
  );
}

/* ------------------------------------------------------------------ split */

const MIN_CHAT = 340;
const MIN_PANEL = 420;
/** Below this pane width the panel covers the chat instead of sitting beside it. */
const OVERLAY_BELOW = MIN_CHAT + MIN_PANEL + 40;

/**
 * The chat with the results panel beside it. The divider drags (or moves with
 * the arrow keys); the panel's share is kept for the page visit.
 */
let savedShare = 0.56;

export function RunSplit({ run, open, onClose, children }: { run: LabRun | undefined; open: boolean; onClose: () => void; children: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [share, setShare] = useState(savedShare);
  const [dragging, setDragging] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    return observeSettledSize(el, (rect) => setWidth(Math.floor(rect.width)), 60);
  }, []);
  const overlay = width > 0 && width < OVERLAY_BELOW;
  const panelW = Math.round(Math.min(Math.max(width * share, MIN_PANEL), Math.max(MIN_PANEL, width - MIN_CHAT)));
  const setClamped = (s: number) => {
    const next = Math.min(Math.max(s, MIN_PANEL / Math.max(width, 1)), 1 - MIN_CHAT / Math.max(width, 1));
    savedShare = next;
    setShare(next);
  };
  const shown = open && !!run;
  // Covered by the panel: the chat cannot take focus (React 18 has no `inert` prop).
  const chat = useRef<HTMLDivElement>(null);
  useEffect(() => {
    chat.current?.toggleAttribute("inert", shown && overlay);
  }, [shown, overlay]);
  return (
    <div ref={box} className="relative flex min-h-0 min-w-0 flex-1">
      <div ref={chat} className="flex min-h-0 min-w-0 flex-1 flex-col" aria-hidden={shown && overlay ? true : undefined}>
        {children}
      </div>
      {shown ? (
        overlay ? (
          <div className="absolute inset-0 z-20 flex bg-surface">
            <RunPanel key={run.id} run={run} onClose={onClose} overlay />
          </div>
        ) : (
          <>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize results panel"
              aria-valuemin={Math.round((MIN_PANEL / Math.max(width, 1)) * 100)}
              aria-valuemax={Math.round((1 - MIN_CHAT / Math.max(width, 1)) * 100)}
              aria-valuenow={Math.round((panelW / Math.max(width, 1)) * 100)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                setClamped(share + (e.key === "ArrowLeft" ? 0.03 : -0.03));
              }}
              onPointerDown={(e) => {
                e.preventDefault();
                (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
                setDragging(true);
              }}
              onPointerMove={(e) => {
                if (!dragging || !box.current) return;
                const rect = box.current.getBoundingClientRect();
                setClamped((rect.right - e.clientX) / rect.width);
              }}
              onPointerUp={() => setDragging(false)}
              onPointerCancel={() => setDragging(false)}
              className={`group relative z-10 w-2 shrink-0 cursor-col-resize ${FOCUS}`}
            >
              <span className={`absolute inset-y-0 left-1/2 w-px -translate-x-1/2 transition-colors ${dragging ? "bg-line/30" : "bg-line/[0.08] group-hover:bg-line/20"}`} />
            </div>
            <div className="flex min-h-0 shrink-0" style={{ width: panelW }}>
              <RunPanel key={run.id} run={run} onClose={onClose} />
            </div>
          </>
        )
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ panel */

export function RunPanel({ run, onClose, overlay = false }: { run: LabRun; onClose: () => void; overlay?: boolean }) {
  const [tab, setTab] = useState<Tab>("overview");
  const box = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    return observeSettledSize(el, (rect) => setWidth(Math.floor(rect.width)), 60);
  }, []);
  // A narrow panel puts the sections in a row above the content.
  const rowNav = width > 0 && width < 600;
  const r = run.result;
  const stats = useRunStats(run);
  const split = stats?.split ?? null;
  const configs = run.audit?.multiple?.configs ?? r?.sweep?.configs_tried ?? 1;
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onNavKey = (e: KeyboardEvent, i: number) => {
    const back = rowNav ? "ArrowLeft" : "ArrowUp";
    const fwd = rowNav ? "ArrowRight" : "ArrowDown";
    if (e.key !== back && e.key !== fwd && e.key !== "Home" && e.key !== "End") return;
    e.preventDefault();
    const n = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (i + (e.key === fwd ? 1 : -1) + TABS.length) % TABS.length;
    setTab(TABS[n]!.id);
    tabRefs.current[n]?.focus();
  };

  return (
    <section ref={box} aria-label="Strategy test results" className={`flex min-h-0 min-w-0 flex-1 bg-surface ${rowNav ? "flex-col" : "flex-row"}`}>
      <nav
        aria-label="Result sections"
        className={rowNav ? "flex shrink-0 items-center gap-1 overflow-x-auto border-b border-line/[0.08] px-2 py-2" : "flex w-[168px] shrink-0 flex-col gap-0.5 border-r border-line/[0.08] p-2 pt-3"}
      >
        {overlay ? (
          <button type="button" onClick={onClose} className={`mb-1 inline-flex h-8 shrink-0 items-center gap-1 rounded-lg px-2 text-fs-13 text-quiet transition-colors hover:bg-line/[0.05] hover:text-fore ${FOCUS}`}>
            <ChevronLeft width={16} height={16} strokeWidth={1.75} aria-hidden />
            Chat
          </button>
        ) : null}
        <div role="tablist" aria-orientation={rowNav ? "horizontal" : "vertical"} className={rowNav ? "flex items-center gap-1" : "flex flex-col gap-0.5"}>
          {TABS.map((t, i) => {
            const active = t.id === tab;
            const I = t.icon;
            return (
              <button
                key={t.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`run-tab-${t.id}`}
                aria-selected={active}
                aria-controls={`run-panel-${t.id}`}
                tabIndex={active ? 0 : -1}
                onClick={() => setTab(t.id)}
                onKeyDown={(e) => onNavKey(e, i)}
                className={`flex h-9 shrink-0 items-center gap-2.5 rounded-lg px-2.5 text-left text-fs-13.5 transition-colors ${
                  active ? "bg-line/[0.06] font-medium text-fore" : "text-fore-4 hover:bg-line/[0.035] hover:text-fore"
                } ${FOCUS}`}
              >
                <I width={15} height={15} strokeWidth={1.75} aria-hidden />
                {t.label}
              </button>
            );
          })}
        </div>
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-line/[0.08] px-5 py-3.5">
          <div className="min-w-0">
            <h2 className="truncate text-fs-16 font-medium leading-fs-22 tracking-[-0.01em] text-fore">{r?.name ?? "Strategy test"}</h2>
            <p className="truncate text-fs-12.5 leading-fs-18 text-quiet">
              {r ? `${day(r.period.start)} – ${day(r.period.end)}${r.universe ? ` · ${r.universe}` : ""}` : run.status === "running" ? "Running…" : (run.error ?? "")}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-1.5">
            {configs > 1 ? (
              <span className="inline-flex h-6 items-center rounded-full bg-warn/10 px-2.5 text-fs-12 font-medium text-warn" title="The reported version is the best of the parameter combinations the test tried">
                Best of {configs.toLocaleString("en-US")} tried
              </span>
            ) : null}
            <StatusBadge run={run} />
            {overlay ? null : (
              <button type="button" aria-label="Close results" title="Close results" onClick={onClose} className={ICON_BUTTON}>
                <X width={16} height={16} strokeWidth={1.75} aria-hidden />
              </button>
            )}
          </div>
        </header>
        <div role="tabpanel" id={`run-panel-${tab}`} aria-labelledby={`run-tab-${tab}`} className="flex min-h-0 flex-1 flex-col">
          {tab === "overview" ? <PanelSources run={run}><Overview run={run} /></PanelSources> : null}
          {tab === "audit" ? <AuditChecks run={run} /> : null}
          {tab === "equity" ? r && r.series.dates.length > 1 ? <Equity r={r} oosStart={split?.oosStart ?? null} benchmark={stats?.benchmark ?? benchmarkName(r)} /> : <Empty run={run} what="An equity curve" /> : null}
          {tab === "trades" ? r ? <Trades r={r} cut={run.cut?.trades} closed={stats?.headline ? wholeTrades(stats.headline.main, stats.headline.secondary) : r.metrics.trades} /> : <Empty run={run} what="The trades" /> : null}
          {tab === "code" ? <CodeView run={run} /> : null}
          {tab === "logs" ? <Logs run={run} /> : null}
        </div>
      </div>
    </section>
  );
}

function StatusBadge({ run }: { run: LabRun }) {
  const s = run.status;
  const cls = s === "running" ? "bg-line/[0.05] text-fore-3" : s === "done" ? "bg-up/10 text-up" : "bg-down/10 text-down";
  return (
    <span className={`inline-flex h-6 items-center gap-1.5 rounded-full px-2.5 text-fs-12 font-medium ${cls}`}>
      {s === "running" ? <LoaderCircle width={12} height={12} strokeWidth={2} className="animate-spin" aria-hidden /> : null}
      {s === "running" ? "Running" : s === "done" ? "Done" : "Failed"}
    </span>
  );
}

function Empty({ run, what }: { run: LabRun; what: string }) {
  const last = run.logs[run.logs.length - 1];
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
      {run.status === "running" ? <LoaderCircle width={18} height={18} strokeWidth={2} className="animate-spin text-faint" aria-hidden /> : null}
      <p className="text-fs-13.5 text-fore-4">{run.status === "running" ? `${what} will show here when the test finishes.` : run.error ?? `${what} is not in this result.`}</p>
      {run.status === "running" && last ? (
        <p className="max-w-[420px] truncate text-fs-12 text-faint" style={{ fontFamily: MONO }}>
          {last.text.split("\n").filter(Boolean).pop()}
        </p>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ overview */

function Tile({ label, value, sub, toneOf, title }: { label: string; value: string; sub?: string; toneOf?: number | null; title?: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-1 rounded-xl border border-line/[0.08] bg-surface-3 px-3.5 py-3" title={title}>
      <span className="truncate text-fs-12 text-quiet">{label}</span>
      <span className={`truncate text-fs-20 font-medium leading-fs-26 tabular-nums ${toneOf !== undefined ? tone(toneOf) : "text-fore"}`} style={{ fontFamily: MONO }}>
        {value}
      </span>
      {sub ? <span className="truncate text-fs-11.5 text-faint">{sub}</span> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-fs-12 font-medium uppercase tracking-[0.06em] text-faint">{title}</h3>
      {children}
    </section>
  );
}

/** Closed trades over the whole test, from the headline. */
function wholeTrades(main: HeadlinePart, secondary: HeadlinePart[]): number | null {
  return (main.id === "whole" ? main : secondary.find((x) => x.id === "whole"))?.trades ?? null;
}

/**
 * The headline tiles. A selected strategy (a sweep, or a period set aside to
 * pick it) leads with the out-of-sample part, coloured only by its gap to the
 * benchmark; in sample and the whole test follow as a quieter secondary row.
 */
function Headline({ run }: { run: LabRun }) {
  const st = useRunStats(run);
  if (!st) return null;
  const h = st.headline;
  const B = h.benchmark;
  const x = h.main;
  const oos = h.scope === "oos";
  const ptsTitle = `Strategy CAGR minus the CAGR of ${B} (the benchmark), in percentage points a year`;
  // A long custom benchmark name goes in the tiles' small print and tooltip, not in the label.
  const short = isTickerName(B) ? B : "benchmark";
  const benchTitle = `Benchmark: ${benchmarkLong(B)}`;
  const tiles = (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))" }}>
      <Tile label="CAGR" value={fmtPct(x.cagr)} sub={`${B} ${fmtPct(x.bench_cagr)}`} toneOf={oos ? x.excess : x.cagr} title={benchTitle} />
      <Tile label={`vs ${short} (CAGR)`} value={fmtPts(x.excess)} sub={`a year, strategy minus ${B}`} toneOf={x.excess} title={ptsTitle} />
      <Tile label="Sharpe" value={num(x.sharpe)} sub={`${B} ${num(x.bench_sharpe)}`} title={benchTitle} />
      <Tile label="Max drawdown" value={fmtPct(x.max_dd)} sub={`${B} ${fmtPct(x.bench_max_dd)}`} toneOf={oos ? undefined : x.max_dd} title={benchTitle} />
    </div>
  );
  if (!oos) return tiles;
  return (
    <section aria-label="Headline" className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="text-fs-12 font-medium uppercase tracking-[0.06em] text-faint">{x.label}</h3>
        <span className="text-fs-11.5 text-faint">
          {day(x.start)} – {day(x.end)}
        </span>
      </div>
      {tiles}
      <ul className="flex flex-col gap-1 rounded-xl border border-line/[0.06] px-3.5 py-2.5 text-fs-12.5 leading-fs-19 text-fore-4">
        {h.secondary.map((p) => (
          <li key={p.id} className="flex flex-wrap gap-x-3">
            <span className="text-quiet">
              {p.label} · {day(p.start)} – {day(p.end)}
            </span>
            <span className="tabular-nums" style={{ fontFamily: MONO }}>
              CAGR {fmtPct(p.cagr)} · vs {short} {fmtPts(p.excess)} · Sharpe {num(p.sharpe)} · Max DD {fmtPct(p.max_dd)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** An event test from declared rules: the rules in plain words, what qualified and was traded, and the server's check of the trades. */
function RulesTested({ spec }: { spec: EventSpecInfo }) {
  const c = spec.check;
  return (
    <Section title="Rules tested">
      <ul className="flex list-disc flex-col gap-1 pl-5 text-fs-13 leading-fs-20 text-fore-2">
        {describeEventRules(spec.rules).map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
      <p className="text-fs-12.5 leading-fs-18 text-quiet">
        {eventCountsLine(spec)} Run by Falcon&apos;s event-backtest helper v{spec.helper_version} (no model-written code), rules hash{" "}
        <span style={{ fontFamily: MONO }}>{spec.hash}</span>: the same rules always give the same numbers.
      </p>
      {c ? (
        <div className={`flex gap-2.5 rounded-lg px-3 py-2 text-fs-13 leading-fs-20 text-fore-2 ${c.status === "flag" ? "bg-warn/[0.07]" : "bg-line/[0.04]"}`}>
          {c.status === "flag" ? (
            <TriangleAlert width={14} height={14} strokeWidth={2} className="mt-[3px] shrink-0 text-warn" aria-hidden />
          ) : (
            <Check width={14} height={14} strokeWidth={2.25} className={`mt-[3px] shrink-0 ${c.status === "pass" ? "text-up" : "text-faint"}`} aria-hidden />
          )}
          <span>{c.detail}</span>
        </div>
      ) : null}
    </Section>
  );
}

function Overview({ run }: { run: LabRun }) {
  const r = run.result;
  if (!r) return <Empty run={run} what="The results" />;
  const rows: [string, string][] = [
    ["Universe", r.universe || "n/a"],
    ["Period", `${day(r.period.start)} – ${day(r.period.end)}`],
    ["Costs", r.assumptions.costs_bps === null ? "n/a" : `${r.assumptions.costs_bps} bps per side`],
    ["Rebalance", r.assumptions.rebalance || "n/a"],
    ["Signal timing", r.assumptions.signal_lag || "n/a"],
  ];
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5">
      <EvidenceCard run={run} />
      <Headline run={run} />
      <KeyStats run={run} />
      <Benchmarks run={run} />
      <Caveats run={run} />
      {r.spec ? <RulesTested spec={r.spec} /> : null}

      <Section title="Assumptions">
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1.5 text-fs-13 leading-fs-20">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-quiet">{k}</dt>
              <dd className="min-w-0 text-fore-2">{v}</dd>
            </div>
          ))}
        </dl>
        {r.assumptions.notes.length ? (
          <ul className="flex list-disc flex-col gap-1 pl-5 text-fs-13 leading-fs-20 text-fore-3">
            {r.assumptions.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}
      </Section>

      {r.warnings.length || run.problems?.length || run.cut ? (
        <Section title="Warnings">
          <ul className="flex flex-col gap-2">
            {r.warnings.map((w, i) => (
              <li key={`w${i}`} className="flex gap-2.5 rounded-lg bg-warn/[0.07] px-3 py-2 text-fs-13 leading-fs-20 text-fore-2">
                <TriangleAlert width={14} height={14} strokeWidth={2} className="mt-[3px] shrink-0 text-warn" aria-hidden />
                <span>{w}</span>
              </li>
            ))}
            {run.problems?.map((p, i) => (
              <li key={`p${i}`} className="flex gap-2.5 px-3 text-fs-12.5 leading-fs-18 text-quiet">
                <span aria-hidden>·</span>
                <span>Result file: {p}</span>
              </li>
            ))}
            {run.cut ? (
              <li className="flex gap-2.5 px-3 text-fs-12.5 leading-fs-18 text-quiet">
                <span aria-hidden>·</span>
                <span>
                  Kept with the session in a smaller copy
                  {run.cut.points ? `: the curve as ${r.series.dates.length} of ${run.cut.points.toLocaleString("en-US")} points` : ""}
                  {run.cut.trades ? `${run.cut.points ? "," : ":"} the first ${r.trades.length} of ${run.cut.trades.toLocaleString("en-US")} trades` : ""}.
                </span>
              </li>
            ) : null}
          </ul>
        </Section>
      ) : null}

      <p className="text-fs-12 leading-fs-18 text-faint">Hypothetical results on past prices, with the assumptions above. They describe the past only, are not a prediction, and are not investment advice.</p>
    </div>
  );
}

/* ------------------------------------------------------------------ equity */

function Segmented<T extends string>({ label, options, value, onChange }: { label: string; options: { id: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-line/[0.05] p-0.5">
      {options.map((o, i) => {
        const on = o.id === value;
        return (
          <button
            key={o.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            onClick={() => onChange(o.id)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
              e.preventDefault();
              const n = (i + (e.key === "ArrowRight" ? 1 : -1) + options.length) % options.length;
              onChange(options[n]!.id);
              refs.current[n]?.focus();
            }}
            className={`h-7 rounded-md px-2.5 text-fs-12.5 transition-colors ${on ? "bg-surface font-medium text-fore shadow-[0_1px_2px_rgba(0,0,0,0.06)]" : "text-quiet hover:text-fore"} ${FOCUS}`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

type Range = "all" | "5y" | "3y" | "1y";
const RANGE_YEARS: Record<Exclude<Range, "all">, number> = { "5y": 5, "3y": 3, "1y": 1 };

function Equity({ r, oosStart, benchmark }: { r: RunResult; oosStart: string | null; benchmark: string }) {
  const [range, setRange] = useState<Range>("all");
  const s = r.series;
  const years = (Date.parse(s.dates[s.dates.length - 1]!) - Date.parse(s.dates[0]!)) / (365.25 * 86_400_000);
  const options = [{ id: "all" as Range, label: "All" }, ...(["5y", "3y", "1y"] as const).filter((k) => years > RANGE_YEARS[k] + 0.25).map((k) => ({ id: k as Range, label: k.toUpperCase() }))];

  const { dates, chart, dd } = useMemo(() => {
    let from = 0;
    if (range !== "all") {
      const cutoff = new Date(Date.parse(s.dates[s.dates.length - 1]!) - RANGE_YEARS[range] * 365.25 * 86_400_000).toISOString().slice(0, 10);
      from = Math.max(0, s.dates.findIndex((d) => d >= cutoff));
    }
    const dates = s.dates.slice(from);
    const eq = s.equity.slice(from);
    const bench = s.benchmark_equity.slice(from);
    const growth = (vals: (number | null)[]) => {
      const base = vals.find((v): v is number => v !== null && v > 0);
      const m = new Map<string, number>();
      if (!base) return m;
      vals.forEach((v, i) => {
        if (v !== null) m.set(dates[i]!, (v / base - 1) * 100);
      });
      return m;
    };
    const fall = (vals: (number | null)[]) => {
      const m = new Map<string, number>();
      let peak = -Infinity;
      vals.forEach((v, i) => {
        if (v === null) return;
        peak = Math.max(peak, v);
        m.set(dates[i]!, peak > 0 ? (v / peak - 1) * 100 : 0);
      });
      return m;
    };
    const chart: ChartSeries[] = [{ id: "strategy", label: r.name, color: INK, values: growth(eq) }];
    if (bench.some((v) => v !== null)) chart.push({ id: "spy", label: benchmarkLong(benchmark), color: SPY, weight: 1.5, values: growth(bench) });
    const dd: ChartSeries[] = [{ id: "dd", label: "Strategy, fall from its high", color: DD, weight: 1.5, values: fall(eq) }];
    if (bench.some((v) => v !== null)) dd.push({ id: "spydd", label: `${benchmark}, fall from its high`, color: SPY, weight: 1.25, dashed: true, values: fall(bench) });
    return { dates, chart, dd };
  }, [r.name, s, range, benchmark]);

  const last = dates[dates.length - 1];
  const download = () => {
    const blob = new Blob([seriesCsv(r)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${r.name.replace(/[^\w-]+/g, "_").slice(0, 60) || "strategy"}_equity.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-fs-14 font-medium text-fore">Growth vs {benchmark}</h3>
          <div className="flex items-center gap-2">
            {options.length > 1 ? <Segmented label="Period" options={options} value={range} onChange={setRange} /> : null}
            <button
              type="button"
              onClick={download}
              className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-line/[0.1] px-2.5 text-fs-12.5 font-medium text-fore-3 transition-colors hover:bg-line/[0.04] hover:text-fore ${FOCUS}`}
            >
              <Download width={14} height={14} strokeWidth={1.75} aria-hidden />
              CSV
            </button>
          </div>
        </div>
        {oosStart ? <p className="text-fs-12 leading-fs-18 text-faint">In sample to {day(oosStart)}; out of sample from {day(oosStart)} on (see Overview for both).</p> : null}
        <ChartLegend series={chart} last={last} />
        <EquityChart dates={dates} series={chart} height={280} />
      </div>
      <div className="flex flex-col gap-3">
        <h3 className="text-fs-14 font-medium text-fore">Drawdown</h3>
        <ChartLegend series={dd} last={undefined} />
        <EquityChart dates={dates} series={dd} height={150} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ trades */

type SortKey = "date" | "ticker" | "side" | "qty" | "weight" | "price" | "pnl";
const COLS: { key: SortKey; label: string; num: boolean; w: string }[] = [
  { key: "date", label: "Date", num: false, w: "minmax(96px,1.1fr)" },
  { key: "ticker", label: "Ticker", num: false, w: "minmax(64px,0.8fr)" },
  { key: "side", label: "Side", num: false, w: "minmax(48px,0.6fr)" },
  { key: "qty", label: "Qty", num: true, w: "minmax(64px,0.8fr)" },
  { key: "weight", label: "Weight", num: true, w: "minmax(64px,0.8fr)" },
  { key: "price", label: "Price", num: true, w: "minmax(72px,0.9fr)" },
  { key: "pnl", label: "P&L", num: true, w: "minmax(64px,0.8fr)" },
];
const ROW_H = 32;
const GRID = COLS.map((c) => c.w).join(" ");

function cell(t: RunTrade, k: SortKey): string {
  switch (k) {
    case "date":
      return t.date;
    case "ticker":
      return t.ticker;
    case "side":
      return t.side === "buy" ? "Buy" : "Sell";
    case "qty":
      return t.qty === null ? "" : Math.abs(t.qty) >= 1000 ? Math.round(t.qty).toLocaleString("en-US") : String(Number(t.qty.toFixed(2)));
    case "weight":
      return t.weight === null ? "" : fmtPct(t.weight, 1, false);
    case "price":
      return t.price === null ? "" : t.price.toFixed(2);
    case "pnl":
      return t.pnl === null ? "" : fmtPct(t.pnl);
  }
}

function Trades({ r, cut, closed }: { r: RunResult; cut?: number; closed: number | null }) {
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: "date", dir: 1 });
  const [side, setSide] = useState<"all" | "buy" | "sell">("all");
  const scroller = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ top: 0, h: 600 });
  const rows = useMemo(() => {
    const list = side === "all" ? [...r.trades] : r.trades.filter((t) => t.side === side);
    const k = sort.key;
    list.sort((a, b) => {
      const x = a[k];
      const y = b[k];
      if (x === y) return 0;
      if (x === null) return 1;
      if (y === null) return -1;
      return (x < y ? -1 : 1) * sort.dir;
    });
    return list;
  }, [r.trades, sort, side]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const update = () => setView({ top: el.scrollTop, h: el.clientHeight });
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro?.disconnect();
    };
  }, []);

  const startRow = Math.max(0, Math.floor(view.top / ROW_H) - 10);
  const endRow = Math.min(rows.length, Math.ceil((view.top + view.h) / ROW_H) + 10);
  const download = () => {
    const blob = new Blob([tradesCsv({ ...r, trades: rows })], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${r.name.replace(/[^\w-]+/g, "_").slice(0, 60) || "trades"}_trades.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1_000);
  };
  const total = r.trade_count > r.trades.length ? r.trade_count : r.trades.length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 px-5 py-3">
        <span className="text-fs-13 text-quiet">
          {rows.length.toLocaleString("en-US")} {rows.length === 1 ? "order" : "orders"}
          {cut || total > r.trades.length ? ` (first ${r.trades.length.toLocaleString("en-US")} of ${(cut ?? total).toLocaleString("en-US")} kept)` : ""}
          {closed !== null ? (
            <>
              {" · "}
              <span title={TRADES_DEFINITION} className="cursor-help underline decoration-line/25 decoration-dotted underline-offset-[3px]">
                {closed.toLocaleString("en-US")} closed {closed === 1 ? "trade" : "trades"}
              </span>
            </>
          ) : null}
        </span>
        <Segmented
          label="Side"
          options={[
            { id: "all", label: "All" },
            { id: "buy", label: "Buys" },
            { id: "sell", label: "Sells" },
          ]}
          value={side}
          onChange={setSide}
        />
        <button
          type="button"
          onClick={download}
          disabled={!rows.length}
          className={`ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-line/[0.1] px-2.5 text-fs-12.5 font-medium text-fore-3 transition-colors hover:bg-line/[0.04] hover:text-fore disabled:opacity-40 ${FOCUS}`}
        >
          <Download width={14} height={14} strokeWidth={1.75} aria-hidden />
          CSV
        </button>
      </div>
      <div role="table" aria-label="Trades" aria-rowcount={rows.length + 1} className="flex min-h-0 flex-1 flex-col border-t border-line/[0.08]">
        <div role="rowgroup">
          <div role="row" aria-rowindex={1} className="grid overflow-hidden border-b border-line/[0.08] bg-surface-3 px-5" style={{ gridTemplateColumns: GRID, scrollbarGutter: "stable" }}>
            {COLS.map((c) => {
              const on = sort.key === c.key;
              return (
                <div key={c.key} role="columnheader" aria-sort={on ? (sort.dir === 1 ? "ascending" : "descending") : "none"} className={c.num ? "text-right" : ""}>
                  <button
                    type="button"
                    onClick={() => setSort((s) => (s.key === c.key ? { key: c.key, dir: s.dir === 1 ? -1 : 1 } : { key: c.key, dir: c.num ? -1 : 1 }))}
                    className={`inline-flex h-8 items-center gap-1 text-fs-12 font-medium ${on ? "text-fore" : "text-quiet hover:text-fore"} ${FOCUS} rounded`}
                  >
                    {c.label}
                    {on ? sort.dir === 1 ? <ArrowUp width={12} height={12} strokeWidth={2} aria-hidden /> : <ArrowDown width={12} height={12} strokeWidth={2} aria-hidden /> : null}
                  </button>
                </div>
              );
            })}
          </div>
        </div>
        <div ref={scroller} role="rowgroup" className="min-h-0 flex-1 overflow-y-auto" style={{ scrollbarGutter: "stable" }} tabIndex={0} aria-label="Trade rows">
          {rows.length ? (
            <div style={{ height: rows.length * ROW_H, position: "relative" }}>
              {rows.slice(startRow, endRow).map((t, k) => {
                const i = startRow + k;
                return (
                  <div
                    key={i}
                    role="row"
                    aria-rowindex={i + 2}
                    className="absolute inset-x-0 grid items-center border-b border-line/[0.05] px-5 text-fs-12.5 tabular-nums text-fore-2"
                    style={{ top: i * ROW_H, height: ROW_H, gridTemplateColumns: GRID, fontFamily: MONO }}
                  >
                    {COLS.map((c) => (
                      <div key={c.key} role="cell" className={`truncate ${c.num ? "text-right" : ""} ${c.key === "pnl" ? tone(t.pnl) : c.key === "side" ? (t.side === "buy" ? "text-fore-2" : "text-quiet") : ""}`}>
                        {cell(t, c.key)}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="px-5 py-8 text-center text-fs-13 text-quiet">No trades in this result.</p>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ code */

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1_500);
        });
      }}
      className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-line/[0.1] px-2.5 text-fs-12.5 font-medium text-fore-3 transition-colors hover:bg-line/[0.04] hover:text-fore ${FOCUS}`}
    >
      {copied ? <Check width={14} height={14} strokeWidth={2} aria-hidden /> : <Copy width={14} height={14} strokeWidth={1.75} aria-hidden />}
      {copied ? "Copied" : label}
    </button>
  );
}

function CodeView({ run }: { run: LabRun }) {
  const code = run.code ?? "";
  const lines = useMemo(() => highlightPython(code), [code]);
  if (!code) return <Empty run={run} what="The code" />;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 items-center gap-3 px-5 py-3">
        <span className="min-w-0 truncate text-fs-12.5 text-quiet" style={{ fontFamily: MONO }}>
          {run.codePath || "backtest.py"} · {lines.length} lines · Python
        </span>
        <span className="ml-auto" />
        <CopyButton text={code} />
      </div>
      <div className="min-h-0 flex-1 overflow-auto border-t border-line/[0.08] bg-surface-3" tabIndex={0} aria-label="Python code">
        <pre className="min-w-max py-3 text-fs-12.5 leading-fs-20" style={{ fontFamily: MONO }}>
          <code>
            {lines.map((l, i) => (
              <div key={i} className="flex">
                <span className="w-12 shrink-0 select-none pr-4 text-right text-faint-2" aria-hidden>
                  {i + 1}
                </span>
                <span className="pr-6 text-fore-2">{l.length ? l : " "}</span>
              </div>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ logs */

function Logs({ run }: { run: LabRun }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (run.status === "running") end.current?.scrollIntoView({ block: "end" });
  }, [run.logs.length, run.status]);
  if (!run.logs.length) return <Empty run={run} what="The output" />;
  return (
    <div className="min-h-0 flex-1 overflow-auto px-5 py-4" tabIndex={0} aria-label="Run output">
      <ol className="flex flex-col gap-2.5 text-fs-12 leading-fs-18" style={{ fontFamily: MONO }}>
        {run.logs.map((l, i) => (
          <li key={i} className="min-w-0">
            {l.kind === "command" ? (
              <pre className="whitespace-pre-wrap break-words text-faint">
                <span className="select-none text-faint-2">$ </span>
                {l.text.length > 600 ? `${l.text.slice(0, 600)}…` : l.text}
              </pre>
            ) : l.kind === "data" ? (
              <p className="text-quiet">› {l.text}</p>
            ) : (
              <pre
                className={`whitespace-pre-wrap break-words rounded-lg px-3 py-2 ${
                  l.kind === "stderr" || l.kind === "error" ? "bg-down/[0.06] text-down" : "bg-surface-3 text-fore-2"
                }`}
              >
                {l.text}
              </pre>
            )}
          </li>
        ))}
      </ol>
      <div ref={end} />
      {run.status === "running" ? (
        <p className="mt-3 flex items-center gap-2 text-fs-12 text-faint">
          <LoaderCircle width={12} height={12} strokeWidth={2} className="animate-spin" aria-hidden />
          Running…
        </p>
      ) : null}
    </div>
  );
}
