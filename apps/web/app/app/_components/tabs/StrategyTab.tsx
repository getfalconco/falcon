"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Loader2, Play, Trash2 } from "lucide-react";
import {
  ASSUMPTIONS,
  CAVEATS,
  TEMPLATES,
  describeStrategy,
  validateRunConfig,
  validateStrategy,
  type BacktestResult,
  type Strategy,
} from "@falcon/backtest";
import {
  getRun,
  parseText,
  resolvedWindow,
  runKey,
  startRun,
  updateStrategy,
  useRunsVersion,
  type RunSettings,
  type SavedStrategy,
} from "@/lib/workspace/strategies";
import { useWorkspace } from "../context";
import { EmptyState, MONO, Panel, SERIF, SectionTitle, formatDate } from "../parts";
import { ChartLegend, EquityChart, type ChartSeries } from "../strategy/EquityChart";
import { RuleEditor } from "../strategy/RuleEditor";
import { MetricsTable, TradesList, type MetricColumn } from "../strategy/Results";

const INK = "#1d1b1b";
const SPY_COLOR = "#a3a39e";
/** Categorical slots in their fixed order (dataviz reference palette). */
const COMPARE_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"];
const MAX_COMPARE = COMPARE_COLORS.length;

/** The last finished run shown per strategy, so an edit does not blank the results. */
const shownKey = new Map<string, string>();

type CompareEntry = { id: string; label: string; rules: Strategy };

export function compareOptions(all: SavedStrategy[], selfId: string): CompareEntry[] {
  const saved = all.filter((s) => s.id !== selfId).map((s) => ({ id: s.id, label: s.rules.name || "Untitled strategy", rules: s.rules }));
  const names = new Set(saved.map((s) => s.label));
  const templates = TEMPLATES.filter((t) => !names.has(t.rules.name)).map((t) => ({ id: `template:${t.id}`, label: t.rules.name, rules: t.rules }));
  return [...saved, ...templates];
}

const FIELD_NAME: Record<string, string> = {
  period: "length",
  fastPeriod: "fast length",
  slowPeriod: "slow length",
  value: "level",
  pct: "percent",
  days: "days",
  daysAfter: "days after",
  stopLossPct: "Stop loss",
  takeProfitPct: "Take profit",
  maxHoldingDays: "Holding days",
  maxPositions: "Positions",
  positionPct: "Percent per position",
  name: "Name",
  initialCapital: "Capital",
  commissionBps: "Commission",
  slippageBps: "Slippage",
};

/** Validation messages in the editor's words ("Entry condition 1, length: at most 250"). */
function readable(error: string): string {
  if (/^universe: Too small/.test(error)) return "Add at least one ticker.";
  if (/^entry\.conditions: Too small/.test(error)) return "Add at least one entry condition.";
  const m = /^([\w.]+): (.*)$/.exec(error);
  if (!m) return error;
  const [, path, rest] = m;
  const parts = path!.split(".");
  let where = parts.map((p) => FIELD_NAME[p] ?? p).join(" ");
  const cond = /^(entry|exit)\.conditions\.(\d+)(?:\.(\w+))?$/.exec(path!);
  if (cond) where = `${cond[1] === "entry" ? "Entry" : "Exit"} condition ${Number(cond[2]) + 1}${cond[3] ? `, ${FIELD_NAME[cond[3]] ?? cond[3]}` : ""}`;
  else if (parts.length > 1) where = FIELD_NAME[parts[parts.length - 1]!] ?? where;
  const text = rest!
    .replace(/^Too big: expected (?:number|string|array) to (?:be|have) <=\s?(\S+).*$/, "at most $1")
    .replace(/^Too small: expected (?:number|string|array) to (?:be|have) >=\s?(\S+).*$/, "at least $1")
    .replace(/^Invalid input: expected number, received null$/, "needs a number");
  return `${where}: ${text}`;
}

function percentSeries(result: BacktestResult, pick: "strategy" | "benchmark"): Map<string, number> {
  const base = pick === "strategy" ? result.metrics.strategy.startValue : result.metrics.benchmark.startValue;
  const m = new Map<string, number>();
  for (const p of result.equity) m.set(p.date, (p[pick] / (base || 1) - 1) * 100);
  return m;
}

function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

export function StrategyTab({ strategyId }: { strategyId: string }) {
  const { strategies, newStrategy } = useWorkspace();
  const s = strategies.find((x) => x.id === strategyId);
  if (!s) {
    return (
      <div className="mx-auto w-full max-w-[560px] px-7 py-16">
        <EmptyState title="This strategy is no longer saved">
          <button
            type="button"
            onClick={() => newStrategy()}
            className="inline-flex h-8 items-center rounded-lg border border-black/10 px-3 text-[12.5px] text-[#1d1b1b] outline-none transition-colors hover:bg-[#efefec] focus-visible:border-black/40"
          >
            New strategy
          </button>
        </EmptyState>
      </div>
    );
  }
  return <StrategyView key={s.id} s={s} />;
}

function StrategyView({ s }: { s: SavedStrategy }) {
  const { userId, strategies, openSighting, newStrategy, deleteStrategy } = useWorkspace();
  const update = useCallback((patch: Partial<SavedStrategy>) => updateStrategy(userId, s.id, patch), [s.id, userId]);
  useRunsVersion();

  const checked = useMemo(() => {
    const rules = validateStrategy(s.rules);
    const config = validateRunConfig({ ...resolvedWindow(s.settings), initialCapital: s.settings.initialCapital, commissionBps: s.settings.commissionBps, slippageBps: s.settings.slippageBps });
    const errors = [...(rules.ok ? [] : rules.errors), ...(config.ok ? [] : config.errors)];
    return { rules: rules.ok ? rules.value : null, errors };
  }, [s.rules, s.settings]);

  const key = checked.rules ? runKey(checked.rules, s.settings) : null;
  const run = getRun(key);
  const lastKey = run?.status === "done" ? key : (shownKey.get(s.id) ?? null);
  const last = getRun(lastKey);
  const shown = last?.status === "done" ? last.result : null;
  const stale = shown !== null && lastKey !== key;

  const compare = useMemo(() => {
    const options = compareOptions(strategies, s.id);
    return s.compareIds.map((id) => options.find((o) => o.id === id)).filter((o): o is CompareEntry => Boolean(o));
  }, [s.compareIds, s.id, strategies]);

  const runCompare = useCallback(
    (entries: CompareEntry[], settings: RunSettings) => {
      // One after another: gentle on the per-minute limit.
      void entries.reduce<Promise<unknown>>((p, c) => p.then(() => startRun(c.rules, settings)), Promise.resolve());
    },
    [],
  );

  const go = useCallback(
    (force = false) => {
      if (!checked.rules) return;
      const k = runKey(checked.rules, s.settings);
      void startRun(checked.rules, s.settings, { force }).then((r) => {
        if (r.status === "done") {
          shownKey.set(s.id, k);
          update({ ranAt: Date.now(), autorun: false });
        } else if (s.autorun) update({ autorun: false });
      });
      runCompare(compare, s.settings);
    },
    [checked.rules, compare, runCompare, s.autorun, s.id, s.settings, update],
  );

  // A reopened tab that ran before runs again on open (the server has the prices cached).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (s.ranAt && !s.autorun && checked.rules && !run) go();
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Backtest this, and rules just written from text: run as soon as they are in.
  useEffect(() => {
    if (s.autorun && checked.rules && run?.status !== "running") go();
    // `key` stands for the rules and settings.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.autorun, key]);

  const [editing, setEditing] = useState(() => !(s.origin.kind === "sighting" || s.ranAt));
  const running = run?.status === "running";
  const elapsed = useElapsed(running ? run.startedAt : null);
  const lines = useMemo(() => {
    try {
      return describeStrategy(s.rules);
    } catch {
      return [];
    }
  }, [s.rules]);

  return (
    <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-6 px-7 py-6">
      <Header s={s} update={update} onOpenSighting={openSighting} onDuplicate={() => newStrategy({ rules: { ...s.rules, name: `${s.rules.name} copy`.slice(0, 80) }, settings: s.settings, text: s.text, compareIds: s.compareIds })} onDelete={() => deleteStrategy(s.id)} />

      <Describe s={s} update={update} onRules={() => setEditing(true)} />

      <section>
        <SectionTitle
          action={
            <button
              type="button"
              onClick={() => setEditing((e) => !e)}
              aria-expanded={editing}
              className="text-[12px] text-[#4b4b48] underline decoration-black/20 underline-offset-2 outline-none hover:text-[#1d1b1b] focus-visible:decoration-black/60"
            >
              {editing ? "Hide editor" : "Edit rules"}
            </button>
          }
        >
          Rules
        </SectionTitle>
        <Panel className="mt-2 px-5 py-4">
          {lines.length ? (
            <ul className={`flex flex-col gap-1 ${editing ? "mb-4 border-b border-black/[0.06] pb-4" : ""}`}>
              {lines.map((l) => (
                <li key={l} className="text-[13px] leading-[20px] text-[#3d3b3a]">
                  {l}
                </li>
              ))}
            </ul>
          ) : null}
          {editing ? (
            <RuleEditor rules={s.rules} settings={s.settings} onRules={(rules) => update({ rules })} onSettings={(settings) => update({ settings })} />
          ) : null}
          {checked.errors.length ? (
            <ul className="mt-3 flex flex-col gap-0.5" aria-live="polite">
              {checked.errors.slice(0, 6).map((e) => (
                <li key={e} className="text-[12px] text-[#b3432f]">
                  {readable(e)}
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>
      </section>

      <RunBar
        settings={s.settings}
        disabled={!checked.rules}
        running={running}
        retrying={running && run.retrying}
        elapsed={elapsed}
        tickers={s.rules.universe.length}
        error={run?.status === "error" ? run : null}
        onRun={() => go(run?.status === "error")}
      />

      {!shown && s.origin.kind === "sighting" && !s.origin.hasHistory ? (
        <Panel className="px-5 py-4">
          <p className="text-[13px] leading-[20px] text-[#4b4b48]">
            Past {s.origin.eventTicker} events of this type are not in the backtest data yet. These rules read ripple card history, which is not
            connected, so a run would show no trades. Earnings cards test against the full earnings record.
          </p>
        </Panel>
      ) : null}

      {shown ? (
        <ResultsView
          s={s}
          result={shown}
          stale={stale}
          compare={compare}
          onCompare={(ids) => {
            update({ compareIds: ids });
            const added = compareOptions(strategies, s.id).filter((o) => ids.includes(o.id) && !s.compareIds.includes(o.id));
            runCompare(added, s.settings);
          }}
        />
      ) : null}
    </div>
  );
}

function Header({
  s,
  update,
  onOpenSighting,
  onDuplicate,
  onDelete,
}: {
  s: SavedStrategy;
  update: (p: Partial<SavedStrategy>) => void;
  onOpenSighting: (cardId: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  return (
    <header className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <span className="text-[11px] uppercase tracking-[0.16em] text-[#1d1b1b]/45" style={{ fontFamily: MONO }}>
          Strategy
        </span>
        <input
          aria-label="Strategy name"
          value={s.rules.name}
          maxLength={80}
          onChange={(e) => update({ rules: { ...s.rules, name: e.target.value } })}
          className="mt-1 block w-full rounded-md bg-transparent text-[26px] leading-[36px] text-[#1d1b1b] outline-none placeholder:text-[#c4c4c0] hover:bg-black/[0.02] focus:bg-black/[0.02]"
          style={{ fontFamily: SERIF }}
          placeholder="Untitled strategy"
        />
        {s.origin.kind === "sighting" ? (
          <p className="mt-1 text-[12.5px] text-[#767676]">
            {s.origin.hasHistory ? `Tests past ${s.origin.basis} on the companies the` : "Tests ripple cards like the"}{" "}
            <button
              type="button"
              onClick={() => onOpenSighting((s.origin as { cardId: string }).cardId)}
              className="text-[#4b4b48] underline decoration-black/20 underline-offset-2 outline-none hover:text-[#1d1b1b] focus-visible:decoration-black/60"
            >
              {s.origin.eventTicker} sighting
            </button>{" "}
            {s.origin.hasHistory ? "reaches." : "on the companies it reaches."}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 pt-5">
        {confirm ? (
          <span className="flex items-center gap-2 text-[12px] text-[#4b4b48]">
            Delete this strategy?
            <button type="button" onClick={onDelete} className="rounded-md px-2 py-1 text-[#b3432f] outline-none hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-black/20">
              Delete
            </button>
            <button type="button" onClick={() => setConfirm(false)} className="rounded-md px-2 py-1 outline-none hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-black/20">
              Keep
            </button>
          </span>
        ) : (
          <>
            <IconButton label="Duplicate" onClick={onDuplicate}>
              <Copy width={14} height={14} aria-hidden />
            </IconButton>
            <IconButton label="Delete" onClick={() => setConfirm(true)}>
              <Trash2 width={14} height={14} aria-hidden />
            </IconButton>
          </>
        )}
      </div>
    </header>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#767676] outline-none transition-colors hover:bg-black/[0.05] hover:text-[#1d1b1b] focus-visible:ring-2 focus-visible:ring-black/20"
    >
      {children}
    </button>
  );
}

function Describe({
  s,
  update,
  onRules,
}: {
  s: SavedStrategy;
  update: (p: Partial<SavedStrategy>) => void;
  onRules: () => void;
}) {
  const [text, setText] = useState(s.text);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "quiet" | "error"; text: string; list?: string[] } | null>(null);

  const submit = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setNote(null);
    const r = await parseText(t);
    setBusy(false);
    if (r.ok) {
      update({
        text: t,
        rules: r.rules,
        origin: { kind: "text" },
        parseNotes: { assumptions: r.assumptions, unsupported: r.unsupported },
        settings: { ...s.settings, start: r.range.start ?? s.settings.start, end: r.range.end ?? s.settings.end },
        autorun: true,
      });
      if (r.unsupported.length) setNote({ tone: "quiet", text: "Left out, the rules cannot express:", list: r.unsupported });
      return;
    }
    if (r.reason === "unavailable") {
      update({ text: t });
      setNote({ tone: "quiet", text: "Plain-English rules are not switched on yet. Start from a template or edit the rules below." });
      onRules();
      return;
    }
    setNote({ tone: "error", text: r.message, list: r.unsupported.length ? r.unsupported : undefined });
  };

  return (
    <section>
      <SectionTitle>Describe a strategy</SectionTitle>
      <Panel className="mt-2 px-4 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="flex items-start gap-2"
        >
          <textarea
            aria-label="Describe a strategy in plain English"
            value={text}
            rows={2}
            maxLength={2000}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void submit();
              }
            }}
            placeholder="For example: buy QQQ when its 2-day RSI is below 10, exit after 5 days"
            className="min-h-[44px] flex-1 resize-y rounded-md border border-black/10 bg-white px-3 py-2 text-[13px] leading-[19px] text-[#1d1b1b] outline-none transition-colors placeholder:text-[#b0b0ab] hover:border-black/25 focus:border-black/45"
          />
          <button
            type="submit"
            disabled={busy || !text.trim()}
            className="inline-flex h-[44px] shrink-0 items-center gap-2 rounded-md border border-black/10 px-3.5 text-[12.5px] text-[#1d1b1b] outline-none transition-colors hover:bg-[#efefec] focus-visible:border-black/40 disabled:opacity-40"
          >
            {busy ? <Loader2 width={13} height={13} className="animate-spin" aria-hidden /> : null}
            Write rules
          </button>
        </form>
        {note ? (
          <div className={`mt-2 text-[12px] ${note.tone === "error" ? "text-[#b3432f]" : "text-[#767676]"}`} role="status">
            {note.text}
            {note.list ? <span className="text-[#767676]"> {note.list.join("; ")}</span> : null}
          </div>
        ) : null}
        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-black/[0.06] pt-3">
          <span className="text-[12px] text-[#9a9a9a]">Start from</span>
          {TEMPLATES.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => {
                update({ rules: structuredClone(t.rules), text: t.text, origin: { kind: "template", templateId: t.id }, parseNotes: null });
                setText(t.text);
                setNote(null);
              }}
              className="inline-flex h-7 items-center rounded-md border border-black/10 bg-white px-2.5 text-[12px] text-[#4b4b48] outline-none transition-colors hover:border-black/25 hover:text-[#1d1b1b] focus-visible:border-black/45"
            >
              {t.rules.name}
            </button>
          ))}
        </div>
      </Panel>
    </section>
  );
}

function windowText(settings: RunSettings): string {
  const w = resolvedWindow(settings);
  const span = settings.start || settings.end ? `${formatDate(`${w.start}T12:00:00Z`)} to ${formatDate(`${w.end}T12:00:00Z`)}` : "Last 10 years";
  return `${span}, $${settings.initialCapital.toLocaleString("en-US")}, ${settings.commissionBps} bps commission, ${settings.slippageBps} bps slippage`;
}

function RunBar({
  settings,
  disabled,
  running,
  retrying,
  elapsed,
  tickers,
  error,
  onRun,
}: {
  settings: RunSettings;
  disabled: boolean;
  running: boolean;
  retrying: boolean;
  elapsed: number;
  tickers: number;
  error: { message: string; errors: string[] } | null;
  onRun: () => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={onRun}
          disabled={disabled || running}
          className="inline-flex h-9 items-center gap-2 rounded-lg bg-[#1c1917] px-4 text-[13px] text-[rgb(231,231,231)] outline-none transition-colors hover:bg-[#0f0d0b] focus-visible:ring-2 focus-visible:ring-black/30 disabled:cursor-not-allowed disabled:opacity-40"
        >
          {running ? <Loader2 width={14} height={14} className="animate-spin" aria-hidden /> : <Play width={13} height={13} aria-hidden />}
          {running ? "Running" : "Run backtest"}
        </button>
        <span className="text-[12px] text-[#767676]">{windowText(settings)}</span>
      </div>
      {running ? (
        <div role="status" aria-live="polite" className="flex items-center gap-3">
          <div className="relative h-[3px] w-[220px] overflow-hidden rounded-full bg-black/[0.07]">
            <div className="absolute inset-y-0 w-1/3 animate-[falcon-progress_1.2s_ease-in-out_infinite] rounded-full bg-[#1d1b1b]/70" />
          </div>
          <span className="text-[12px] text-[#767676]" style={{ fontFamily: MONO }}>
            {retrying ? "Still loading, trying again" : `Loading daily prices for ${tickers} ${tickers === 1 ? "ticker" : "tickers"}`} {elapsed}s
          </span>
          <style>{`@keyframes falcon-progress { 0% { left: -33% } 100% { left: 100% } }`}</style>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="text-[12.5px] text-[#b3432f]">
          {error.message}
          {error.errors.length > 1 ? <span className="text-[#767676]"> {error.errors.slice(1, 4).join("; ")}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function ResultsView({
  s,
  result,
  stale,
  compare,
  onCompare,
}: {
  s: SavedStrategy;
  result: BacktestResult;
  stale: boolean;
  compare: CompareEntry[];
  onCompare: (ids: string[]) => void;
}) {
  const { strategies } = useWorkspace();
  const name = s.rules.name.trim() || "This strategy";

  const compared = compare.map((c, i) => {
    const r = getRun(runKey(c.rules, s.settings));
    return { entry: c, color: COMPARE_COLORS[i]!, run: r };
  });

  const dates = useMemo(() => result.equity.map((p) => p.date), [result]);
  const series: ChartSeries[] = useMemo(() => {
    const out: ChartSeries[] = [{ id: "self", label: name, color: INK, values: percentSeries(result, "strategy") }];
    for (const c of compared) {
      if (c.run?.status === "done") out.push({ id: c.entry.id, label: c.entry.label, color: c.color, values: percentSeries(c.run.result, "strategy") });
    }
    out.push({ id: "spy", label: "SPY buy and hold", color: SPY_COLOR, weight: 1.5, values: percentSeries(result, "benchmark") });
    return out;
    // `compared` is rebuilt every render; its runs decide.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result, name, compared.map((c) => `${c.entry.id}:${c.run?.status}`).join("|")]);

  const columns: MetricColumn[] = [
    { id: "self", label: name, color: INK, metrics: result.metrics.strategy },
    ...compared.map((c) => ({
      id: c.entry.id,
      label: c.entry.label,
      color: c.color,
      metrics: c.run?.status === "done" ? c.run.result.metrics.strategy : null,
      status: c.run?.status === "running" ? "Running" : c.run?.status === "error" ? "Did not run" : "",
    })),
    { id: "spy", label: "SPY buy and hold", color: SPY_COLOR, metrics: result.metrics.benchmark },
  ];

  const options = compareOptions(strategies, s.id);
  const originNotes = s.origin.kind === "sighting" ? s.origin.notes : [];
  const parse = s.parseNotes;

  return (
    <section className={`flex flex-col gap-5 transition-opacity ${stale ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <SectionTitle>Results</SectionTitle>
        <span className="text-[12px] text-[#9a9a9a]">
          {stale ? "The rules changed since this run. " : ""}
          Historical simulation, {formatDate(`${result.period.start}T12:00:00Z`)} to {formatDate(`${result.period.end}T12:00:00Z`)}, {result.period.sessions.toLocaleString("en-US")} sessions
        </span>
      </div>

      <Panel className="px-5 py-4">
        <ChartLegend series={series} last={dates[dates.length - 1]} />
        <div className="mt-3">
          <EquityChart dates={dates} series={series} />
        </div>
        <ComparePicker options={options} selected={s.compareIds} colors={new Map(compared.map((c) => [c.entry.id, c.color]))} onChange={onCompare} />
      </Panel>

      <Panel className="px-5 py-3">
        <MetricsTable columns={columns} />
      </Panel>

      <section>
        <SectionTitle count={result.trades.length}>Trades</SectionTitle>
        <Panel className="mt-2 px-5 py-3">
          <TradesList result={result} />
        </Panel>
      </section>

      <footer className="flex flex-col gap-2 border-t border-black/[0.06] pt-4 text-[12px] leading-[18px] text-[#9a9a9a]">
        {[...result.warnings, ...originNotes, ...(parse?.assumptions ?? [])].map((w) => (
          <p key={w}>{w}</p>
        ))}
        {parse?.unsupported.length ? <p>Not in the rules: {parse.unsupported.join("; ")}</p> : null}
        {(result.caveats.length ? result.caveats : CAVEATS).map((c) => (
          <p key={c}>{c}</p>
        ))}
        <details>
          <summary className="cursor-pointer select-none text-[#767676] outline-none hover:text-[#1d1b1b] focus-visible:underline">How the simulation fills orders</summary>
          <ul className="mt-1.5 flex flex-col gap-1">
            {(result.assumptions.length ? result.assumptions : ASSUMPTIONS).map((a) => (
              <li key={a}>{a}</li>
            ))}
            <li>Prices: {result.sources.prices}{result.sources.earnings ? `, earnings: ${result.sources.earnings}` : ""}.</li>
          </ul>
        </details>
      </footer>
    </section>
  );
}

function ComparePicker({
  options,
  selected,
  colors,
  onChange,
}: {
  options: CompareEntry[];
  selected: string[];
  colors: Map<string, string>;
  onChange: (ids: string[]) => void;
}) {
  if (!options.length) return null;
  const full = selected.length >= MAX_COMPARE;
  return (
    <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-black/[0.06] pt-3">
      <span className="text-[12px] text-[#9a9a9a]">Compare with</span>
      {options.map((o) => {
        const on = selected.includes(o.id);
        return (
          <button
            key={o.id}
            type="button"
            aria-pressed={on}
            disabled={!on && full}
            onClick={() => onChange(on ? selected.filter((x) => x !== o.id) : [...selected, o.id])}
            className={`inline-flex h-7 max-w-[240px] items-center gap-1.5 rounded-md border px-2.5 text-[12px] outline-none transition-colors focus-visible:border-black/45 disabled:opacity-40 ${
              on ? "border-black/25 bg-black/[0.04] text-[#1d1b1b]" : "border-black/10 bg-white text-[#4b4b48] hover:border-black/25"
            }`}
          >
            {on ? <span className="h-[2px] w-3 shrink-0 rounded-full" style={{ background: colors.get(o.id) }} aria-hidden /> : null}
            <span className="truncate">{o.label}</span>
          </button>
        );
      })}
      <span className="text-[11.5px] text-[#b0b0ab]">Same window and costs as this strategy</span>
    </div>
  );
}
