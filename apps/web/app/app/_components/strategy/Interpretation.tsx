"use client";

import { useEffect, useMemo, useState } from "react";
import {
  checkFormula,
  describeSpec,
  formulasOf,
  resolvePeriod,
  validateSpec,
  type CheckEnv,
  type ParamSpec,
  type SpecIssue,
  type StrategySpecV2,
} from "@falcon/backtest";
import { MONO, Panel, SectionTitle } from "../parts";

const LINK = "text-[12px] text-[#4b4b48] underline decoration-black/20 underline-offset-2 outline-none hover:text-[#1d1b1b] focus-visible:decoration-black/60";

/**
 * The interpretation card (design 3.1 step 3): it gates the run. Numbered
 * rules come from describe(spec) (operator templates, never model text);
 * assumptions, what the rules cannot know, parameters as sliders, what could
 * not be expressed, and the editable formula with live checker errors.
 */
export function Interpretation({
  spec,
  assumptions,
  notExpressible,
  confirmed,
  running,
  onSpec,
  onRun,
}: {
  spec: StrategySpecV2;
  assumptions: string[];
  notExpressible: string[];
  confirmed: boolean;
  running: boolean;
  /** source "slider" also re-runs when the strategy already ran. */
  onSpec: (spec: StrategySpecV2, source: "slider" | "formula" | "settings") => void;
  onRun: () => void;
}) {
  const check = useMemo(() => validateSpec(spec), [spec]);
  const desc = useMemo(() => (check.ok ? describeSpec(check.spec, check.uses) : null), [check]);
  const [showFormula, setShowFormula] = useState(false);

  return (
    <section>
      <SectionTitle
        action={
          <button type="button" onClick={() => setShowFormula((v) => !v)} aria-expanded={showFormula} className={LINK}>
            {showFormula ? "Hide formula" : "Formula view"}
          </button>
        }
      >
        Rules
      </SectionTitle>
      <Panel className="mt-2 flex flex-col gap-4 px-5 py-4">
        {desc ? (
          <ol className="flex flex-col gap-1.5">
            {desc.rules.map((l) => (
              <li key={l} className="text-[13px] leading-[20px] text-[#2d2b2a]">
                {l}
              </li>
            ))}
          </ol>
        ) : (
          <Issues issues={check.ok ? [] : check.issues} />
        )}

        {assumptions.length ? (
          <Block title="Assumptions">
            {assumptions.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </Block>
        ) : null}
        {notExpressible.length ? (
          <Block title="Not expressible, left out">
            {notExpressible.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </Block>
        ) : null}
        {desc ? (
          <Block title="What the rules cannot know at each date">
            {desc.cannotKnow.map((a) => (
              <li key={a}>{a}</li>
            ))}
          </Block>
        ) : null}

        {Object.keys(spec.params).length ? (
          <div className="flex flex-col gap-3 border-t border-black/[0.06] pt-3">
            <span className="text-[11px] uppercase tracking-[0.14em] text-[#1d1b1b]/45" style={{ fontFamily: MONO }}>
              Parameters
            </span>
            {Object.entries(spec.params).map(([name, p]) => (
              <Slider
                key={name}
                name={name}
                label={desc?.paramLabels[name] ?? name}
                p={p}
                onCommit={(value) => onSpec({ ...spec, params: { ...spec.params, [name]: { ...p, value } } }, "slider")}
              />
            ))}
          </div>
        ) : null}

        <Settings spec={spec} onSpec={(s) => onSpec(s, "settings")} />

        {showFormula ? <FormulaView spec={spec} onSpec={(s) => onSpec(s, "formula")} /> : null}

        <div className="flex flex-wrap items-center gap-3 border-t border-black/[0.06] pt-3">
          <button
            type="button"
            onClick={onRun}
            disabled={!check.ok || running}
            className="inline-flex h-9 items-center rounded-lg bg-[#1c1917] px-4 text-[13px] text-[rgb(231,231,231)] outline-none transition-colors hover:bg-[#0f0d0b] focus-visible:ring-2 focus-visible:ring-black/30 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {running ? "Running" : confirmed ? "Run again" : "Run these rules"}
          </button>
          <span className="text-[12px] text-[#767676]">Each run counts as a trial of this strategy.</span>
        </div>
      </Panel>
    </section>
  );
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-[11px] uppercase tracking-[0.14em] text-[#1d1b1b]/45" style={{ fontFamily: MONO }}>
        {title}
      </span>
      <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-4 text-[12.5px] leading-[19px] text-[#4b4b48]">{children}</ul>
    </div>
  );
}

function Issues({ issues }: { issues: SpecIssue[] }) {
  if (!issues.length) return null;
  return (
    <ul className="flex flex-col gap-1" aria-live="polite">
      {issues.slice(0, 6).map((i, k) => (
        <li key={`${i.path}-${k}`} className="text-[12px] leading-[18px] text-[#b3432f]">
          {i.message}
          {i.hint ? <span className="text-[#767676]"> {i.hint}</span> : null}
        </li>
      ))}
    </ul>
  );
}

function fmt(p: ParamSpec, v: number): string {
  const s = Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4)));
  return p.type === "pct" ? `${s}%` : s;
}

/** A parameter as a slider; the change is committed (a new version, a re-run) on release. */
function Slider({ name, label, p, onCommit }: { name: string; label: string; p: ParamSpec; onCommit: (v: number) => void }) {
  const [v, setV] = useState(p.value);
  useEffect(() => setV(p.value), [p.value]);
  const commit = () => {
    if (v !== p.value) onCommit(v);
  };
  return (
    <label className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1">
      <span className="text-[12.5px] text-[#1d1b1b]">
        {label.charAt(0).toUpperCase() + label.slice(1)} <span className="text-[#9a9a9a]" style={{ fontFamily: MONO }}>${name}</span>
      </span>
      <span className="text-[12.5px] tabular-nums text-[#1d1b1b]" style={{ fontFamily: MONO }}>
        {fmt(p, v)}
      </span>
      <input
        type="range"
        min={p.min}
        max={p.max}
        step={p.step}
        value={v}
        onChange={(e) => setV(Number(e.target.value))}
        onPointerUp={commit}
        onKeyUp={commit}
        onBlur={commit}
        className="col-span-2 h-1.5 w-full cursor-pointer accent-[#1d1b1b]"
      />
    </label>
  );
}

const INPUT = "h-8 rounded-md border border-black/10 bg-white px-2 text-[12.5px] text-[#1d1b1b] outline-none hover:border-black/25 focus:border-black/45";

/** Period, capital and costs. Costs below the liquidity floor are raised to it by the engine. */
function Settings({ spec, onSpec }: { spec: StrategySpecV2; onSpec: (s: StrategySpecV2) => void }) {
  const w = resolvePeriod(spec);
  const [open, setOpen] = useState(false);
  return (
    <div className="border-t border-black/[0.06] pt-3">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className={LINK}>
        {open ? "Hide period and costs" : `Period ${w.start} to ${w.end}, $${spec.capital.toLocaleString("en-US")}, ${spec.execution.commission_bps} bp commission, spread ${spec.execution.spread === "auto" ? "by liquidity" : `${spec.execution.spread} bp`}`}
      </button>
      {open ? (
        <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
          <Field label="Start">
            <input type="date" className={INPUT} value={spec.period.start ?? ""} onChange={(e) => onSpec({ ...spec, period: { ...spec.period, start: e.target.value || null } })} />
          </Field>
          <Field label="End">
            <input type="date" className={INPUT} value={spec.period.end ?? ""} onChange={(e) => onSpec({ ...spec, period: { ...spec.period, end: e.target.value || null } })} />
          </Field>
          <Field label="Capital ($)">
            <input type="number" min={1000} step={1000} className={INPUT} value={spec.capital} onChange={(e) => onSpec({ ...spec, capital: Math.max(1000, Number(e.target.value) || 100000) })} />
          </Field>
          <Field label="Commission (bp)">
            <input type="number" min={0} max={200} step={0.5} className={INPUT} value={spec.execution.commission_bps} onChange={(e) => onSpec({ ...spec, execution: { ...spec.execution, commission_bps: Math.max(0, Number(e.target.value) || 0) } })} />
          </Field>
          <Field label="Half-spread (bp, blank = by liquidity)">
            <input
              type="number"
              min={0}
              max={500}
              step={0.5}
              className={INPUT}
              value={spec.execution.spread === "auto" ? "" : spec.execution.spread}
              onChange={(e) => onSpec({ ...spec, execution: { ...spec.execution, spread: e.target.value === "" ? "auto" : Math.max(0, Number(e.target.value)) } })}
            />
          </Field>
          <Field label="Benchmark">
            <select className={INPUT} value={spec.benchmark} onChange={(e) => onSpec({ ...spec, benchmark: e.target.value as StrategySpecV2["benchmark"] })}>
              <option value="SPY">SPY</option>
              <option value="equal_weight_universe">Equal-weight universe</option>
            </select>
          </Field>
        </div>
      ) : null}
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-[11.5px] text-[#767676]">
      {label}
      {children}
    </label>
  );
}

/** Editable FSL with live checker errors; a valid edit becomes a new version on "Apply". */
function FormulaView({ spec, onSpec }: { spec: StrategySpecV2; onSpec: (s: StrategySpecV2) => void }) {
  const formulas = useMemo(() => formulasOf(spec), [spec]);
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => setDraft({}), [spec]);
  const env: CheckEnv = {
    mode: spec.portfolio.mode,
    params: spec.params,
    defs: spec.defs,
    weightTickers: spec.portfolio.mode === "weights" ? Object.keys(spec.portfolio.weights) : undefined,
  };
  const candidate = useMemo(() => applyDrafts(spec, draft), [spec, draft]);
  const full = useMemo(() => validateSpec(candidate), [candidate]);
  const dirty = Object.keys(draft).length > 0;
  const rows = [
    ...formulas.map((f) => ({ key: f.path, label: f.path.replace("portfolio.", "").replace("weights.", "weight "), src: f.src, role: f.role })),
    ...Object.entries(spec.defs).map(([k, v]) => ({ key: `defs.${k}`, label: k, src: v, role: null })),
  ];
  return (
    <div className="flex flex-col gap-3 border-t border-black/[0.06] pt-3">
      <span className="text-[11px] uppercase tracking-[0.14em] text-[#1d1b1b]/45" style={{ fontFamily: MONO }}>
        Formula (FSL)
      </span>
      {rows.map((r) => {
        const value = draft[r.key] ?? r.src;
        const live = r.role ? checkFormula(value, r.role, env) : null;
        return (
          <label key={r.key} className="flex flex-col gap-1">
            <span className="text-[12px] text-[#767676]" style={{ fontFamily: MONO }}>
              {r.label}
            </span>
            <textarea
              value={value}
              rows={Math.min(4, Math.max(1, Math.ceil(value.length / 70)))}
              spellCheck={false}
              onChange={(e) => setDraft({ ...draft, [r.key]: e.target.value })}
              className="resize-y rounded-md border border-black/10 bg-[#fbfbfa] px-2.5 py-1.5 text-[12.5px] leading-[18px] text-[#1d1b1b] outline-none hover:border-black/25 focus:border-black/45"
              style={{ fontFamily: MONO }}
            />
            {live && !live.ok ? (
              <span className="text-[12px] leading-[17px] text-[#b3432f]">
                {live.error}
                {live.hint ? <span className="text-[#767676]"> {live.hint}</span> : null}
              </span>
            ) : null}
          </label>
        );
      })}
      {dirty ? (
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={!full.ok}
            onClick={() => full.ok && onSpec(full.spec)}
            className="inline-flex h-8 items-center rounded-md border border-black/15 px-3 text-[12.5px] text-[#1d1b1b] outline-none hover:bg-[#efefec] focus-visible:border-black/45 disabled:opacity-40"
          >
            Apply formula
          </button>
          <button type="button" onClick={() => setDraft({})} className={LINK}>
            Discard
          </button>
          {!full.ok ? <Issues issues={full.issues} /> : null}
        </div>
      ) : null}
    </div>
  );
}

function applyDrafts(spec: StrategySpecV2, draft: Record<string, string>): StrategySpecV2 {
  const s = structuredClone(spec);
  for (const [k, v] of Object.entries(draft)) {
    if (k.startsWith("defs.")) s.defs[k.slice(5)] = v;
    else if (k === "universe.filter" && s.universe.kind === "rule") s.universe.filter = v.trim() || null;
    else if (k.startsWith("portfolio.weights.") && s.portfolio.mode === "weights") s.portfolio.weights[k.slice("portfolio.weights.".length)] = v;
    else if (k === "portfolio.tiebreak.by" && s.portfolio.mode === "rules" && s.portfolio.tiebreak !== "seeded") s.portfolio.tiebreak.by = v;
    else if (k.startsWith("portfolio.")) {
      const field = k.slice("portfolio.".length);
      (s.portfolio as Record<string, unknown>)[field] = field === "exit" || field === "filter" ? v.trim() || null : v;
    }
  }
  return s;
}
