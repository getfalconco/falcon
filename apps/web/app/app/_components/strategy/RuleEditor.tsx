"use client";

import { useEffect, useState, type ReactNode } from "react";
import { Plus, X } from "lucide-react";
import { LIMITS, type Condition, type ConditionType, type Strategy } from "@falcon/backtest";
import { resolvedWindow, type RunSettings } from "@/lib/workspace/strategies";
import { MONO } from "../parts";

/* ------------------------------------------------------------------ */
/* Small controls                                                      */
/* ------------------------------------------------------------------ */

const FIELD =
  "h-8 rounded-md border border-black/10 bg-white px-2 text-[12.5px] text-[#1d1b1b] outline-none transition-colors hover:border-black/25 focus:border-black/45";

export function NumberField({
  value,
  onChange,
  empty = false,
  min,
  max,
  step,
  width = 64,
  label,
  placeholder,
}: {
  value: number | null;
  onChange: (v: number | null) => void;
  /** Blank is allowed and means null. */
  empty?: boolean;
  min?: number;
  max?: number;
  step?: number;
  width?: number;
  label: string;
  placeholder?: string;
}) {
  const [text, setText] = useState(value === null ? "" : String(value));
  useEffect(() => {
    // Follow outside changes (a template, parsed text) without fighting the typing.
    setText((t) => (Number(t) === value && t.trim() !== "" ? t : value === null ? "" : String(value)));
  }, [value]);
  return (
    <input
      type="number"
      inputMode="decimal"
      aria-label={label}
      title={label}
      value={text}
      min={min}
      max={max}
      step={step ?? "any"}
      placeholder={placeholder}
      onChange={(e) => {
        const t = e.target.value;
        setText(t);
        if (t.trim() === "") {
          if (empty) onChange(null);
          return;
        }
        const n = Number(t);
        if (Number.isFinite(n)) onChange(n);
      }}
      onBlur={() => setText(value === null ? "" : String(value))}
      className={`${FIELD} tabular-nums [appearance:textfield] placeholder:text-[#b0b0ab] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none`}
      style={{ width, fontFamily: MONO }}
    />
  );
}

export function Select<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <select aria-label={label} title={label} value={value} onChange={(e) => onChange(e.target.value as T)} className={`${FIELD} pr-6`}>
      {options.map(([v, l]) => (
        <option key={v} value={v}>
          {l}
        </option>
      ))}
    </select>
  );
}

function TickerField({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string | null;
  onChange: (v: string | null) => void;
  label: string;
  placeholder: string;
}) {
  return (
    <input
      aria-label={label}
      title={label}
      value={value ?? ""}
      placeholder={placeholder}
      maxLength={12}
      onChange={(e) => {
        const t = e.target.value.toUpperCase().replace(/\s+/g, "");
        onChange(t ? t : null);
      }}
      className={`${FIELD} w-[86px] uppercase placeholder:normal-case placeholder:text-[#b0b0ab]`}
      style={{ fontFamily: MONO }}
    />
  );
}

function Words({ children }: { children: ReactNode }) {
  return <span className="text-[12.5px] text-[#767676]">{children}</span>;
}

/* ------------------------------------------------------------------ */
/* Conditions                                                          */
/* ------------------------------------------------------------------ */

const TYPE_LABEL: Record<ConditionType, string> = {
  price_vs_ma: "Price vs moving average",
  ma_cross: "Moving average cross",
  rsi: "RSI",
  n_day_return: "N-day return",
  gap: "Opening gap",
  breakout: "New high or low",
  earnings_surprise: "Earnings surprise",
  ripple_event: "Ripple card",
};

const CROSS = [
  ["above", "is above"],
  ["below", "is below"],
  ["crosses_above", "crosses above"],
  ["crosses_below", "crosses below"],
] as const;
const SIDE = [
  ["above", "above"],
  ["below", "below"],
] as const;
const MA = [
  ["sma", "simple"],
  ["ema", "exponential"],
] as const;

export function defaultCondition(type: ConditionType): Condition {
  switch (type) {
    case "price_vs_ma":
      return { type, ticker: null, ma: "sma", period: 200, op: "above" };
    case "ma_cross":
      return { type, ticker: null, fastMa: "sma", fastPeriod: 50, slowMa: "sma", slowPeriod: 200, op: "crosses_above" };
    case "rsi":
      return { type, ticker: null, period: 14, op: "below", value: 30 };
    case "n_day_return":
      return { type, ticker: null, days: 5, op: "below", pct: -5 };
    case "gap":
      return { type, ticker: null, op: "above", pct: 2 };
    case "breakout":
      return { type, ticker: null, days: 50, op: "new_high" };
    case "earnings_surprise":
      return { type, ticker: null, op: "above", pct: 5, daysAfter: 1 };
    case "ripple_event":
      return { type, relation: null, direction: "up", minConfidence: null, maxDegree: 1, daysAfter: 1 };
  }
}

const P = LIMITS.maxIndicatorPeriod;

function ConditionFields({ c, set }: { c: Condition; set: (c: Condition) => void }) {
  const refTicker =
    "ticker" in c && c.type !== "earnings_surprise" ? (
      <>
        <Words>on</Words>
        <TickerField label="Read on ticker" placeholder="each ticker" value={c.ticker} onChange={(ticker) => set({ ...c, ticker })} />
      </>
    ) : null;
  switch (c.type) {
    case "price_vs_ma":
      return (
        <>
          <Words>Close</Words>
          <Select label="Relation" value={c.op} options={CROSS} onChange={(op) => set({ ...c, op })} />
          <Words>its</Words>
          <NumberField label="Average length in days" value={c.period} min={2} max={P} step={1} width={60} onChange={(v) => set({ ...c, period: Math.round(v ?? c.period) })} />
          <Words>day</Words>
          <Select label="Average type" value={c.ma} options={MA} onChange={(ma) => set({ ...c, ma })} />
          <Words>average</Words>
          {refTicker}
        </>
      );
    case "ma_cross":
      return (
        <>
          <NumberField label="Fast average length" value={c.fastPeriod} min={2} max={P} step={1} width={56} onChange={(v) => set({ ...c, fastPeriod: Math.round(v ?? c.fastPeriod) })} />
          <Words>day</Words>
          <Select label="Fast average type" value={c.fastMa} options={MA} onChange={(fastMa) => set({ ...c, fastMa })} />
          <Select label="Relation" value={c.op} options={CROSS} onChange={(op) => set({ ...c, op })} />
          <NumberField label="Slow average length" value={c.slowPeriod} min={2} max={P} step={1} width={56} onChange={(v) => set({ ...c, slowPeriod: Math.round(v ?? c.slowPeriod) })} />
          <Words>day</Words>
          <Select label="Slow average type" value={c.slowMa} options={MA} onChange={(slowMa) => set({ ...c, slowMa })} />
          {refTicker}
        </>
      );
    case "rsi":
      return (
        <>
          <NumberField label="RSI period" value={c.period} min={2} max={100} step={1} width={52} onChange={(v) => set({ ...c, period: Math.round(v ?? c.period) })} />
          <Words>day RSI</Words>
          <Select label="Relation" value={c.op} options={CROSS} onChange={(op) => set({ ...c, op })} />
          <NumberField label="RSI level" value={c.value} min={0} max={100} width={56} onChange={(v) => set({ ...c, value: v ?? c.value })} />
          {refTicker}
        </>
      );
    case "n_day_return":
      return (
        <>
          <NumberField label="Days" value={c.days} min={1} max={P} step={1} width={52} onChange={(v) => set({ ...c, days: Math.round(v ?? c.days) })} />
          <Words>day return</Words>
          <Select label="Relation" value={c.op} options={SIDE} onChange={(op) => set({ ...c, op })} />
          <NumberField label="Percent" value={c.pct} min={-100} max={1000} width={60} onChange={(v) => set({ ...c, pct: v ?? c.pct })} />
          <Words>%</Words>
          {refTicker}
        </>
      );
    case "gap":
      return (
        <>
          <Words>Open vs previous close</Words>
          <Select label="Relation" value={c.op} options={SIDE} onChange={(op) => set({ ...c, op })} />
          <NumberField label="Gap percent" value={c.pct} min={-100} max={100} width={60} onChange={(v) => set({ ...c, pct: v ?? c.pct })} />
          <Words>%</Words>
          {refTicker}
        </>
      );
    case "breakout":
      return (
        <>
          <Words>Close at a new</Words>
          <NumberField label="Lookback days" value={c.days} min={2} max={P} step={1} width={56} onChange={(v) => set({ ...c, days: Math.round(v ?? c.days) })} />
          <Words>day</Words>
          <Select
            label="High or low"
            value={c.op}
            options={[
              ["new_high", "high"],
              ["new_low", "low"],
            ]}
            onChange={(op) => set({ ...c, op })}
          />
          {refTicker}
        </>
      );
    case "earnings_surprise":
      return (
        <>
          <NumberField label="Trading days after the release" value={c.daysAfter} min={1} max={LIMITS.maxDaysAfter} step={1} width={48} onChange={(v) => set({ ...c, daysAfter: Math.round(v ?? c.daysAfter) })} />
          <Words>day after</Words>
          <TickerField label="Whose earnings" placeholder="the stock" value={c.ticker} onChange={(ticker) => set({ ...c, ticker })} />
          <Words>reports, EPS surprise</Words>
          <Select label="Relation" value={c.op} options={SIDE} onChange={(op) => set({ ...c, op })} />
          <NumberField label="Surprise percent" value={c.pct} min={-1000} max={1000} width={56} onChange={(v) => set({ ...c, pct: v ?? c.pct })} />
          <Words>%</Words>
        </>
      );
    case "ripple_event":
      return (
        <>
          <NumberField label="Trading days after the card" value={c.daysAfter} min={1} max={LIMITS.maxDaysAfter} step={1} width={48} onChange={(v) => set({ ...c, daysAfter: Math.round(v ?? c.daysAfter) })} />
          <Words>day after a card reaches it as</Words>
          <Select
            label="Relation"
            value={c.relation ?? "any"}
            options={[
              ["any", "any link"],
              ["customer", "customer"],
              ["supplier", "supplier"],
              ["competitor", "competitor"],
              ["peer", "peer"],
            ]}
            onChange={(v) => set({ ...c, relation: v === "any" ? null : v })}
          />
          <Words>direction</Words>
          <Select
            label="Direction"
            value={c.direction ?? "any"}
            options={[
              ["any", "any"],
              ["up", "up"],
              ["down", "down"],
              ["unclear", "unclear"],
            ]}
            onChange={(v) => set({ ...c, direction: v === "any" ? null : v })}
          />
          <Select
            label="Degree"
            value={String(c.maxDegree ?? "any") as "1" | "2" | "any"}
            options={[
              ["1", "direct links"],
              ["2", "up to 2nd degree"],
              ["any", "any degree"],
            ]}
            onChange={(v) => set({ ...c, maxDegree: v === "any" ? null : v === "1" ? 1 : 2 })}
          />
        </>
      );
  }
}

function ConditionList({
  conditions,
  onChange,
  emptyText,
  min = 0,
}: {
  conditions: Condition[];
  onChange: (cs: Condition[]) => void;
  emptyText: string;
  min?: number;
}) {
  const [adding, setAdding] = useState<ConditionType | "">("");
  return (
    <div className="flex flex-col gap-2">
      {conditions.length === 0 ? <p className="text-[12.5px] text-[#9a9a9a]">{emptyText}</p> : null}
      {conditions.map((c, i) => (
        <div key={i} className="flex flex-wrap items-center gap-x-2 gap-y-1.5 rounded-md border border-black/[0.06] bg-[#fafaf8] px-2.5 py-2">
          <Select
            label="Condition type"
            value={c.type}
            options={Object.entries(TYPE_LABEL) as [ConditionType, string][]}
            onChange={(t) => onChange(conditions.map((x, j) => (j === i ? defaultCondition(t) : x)))}
          />
          <ConditionFields c={c} set={(next) => onChange(conditions.map((x, j) => (j === i ? next : x)))} />
          <button
            type="button"
            aria-label="Remove condition"
            title="Remove"
            disabled={conditions.length <= min}
            onClick={() => onChange(conditions.filter((_, j) => j !== i))}
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-md text-[#9a9a9a] outline-none transition-colors hover:bg-black/[0.05] hover:text-[#1d1b1b] focus-visible:ring-2 focus-visible:ring-black/20 disabled:opacity-30"
          >
            <X width={14} height={14} aria-hidden />
          </button>
        </div>
      ))}
      {conditions.length < LIMITS.maxConditions ? (
        <label className="inline-flex items-center gap-1.5 self-start text-[12.5px] text-[#4b4b48]">
          <Plus width={13} height={13} aria-hidden />
          <select
            aria-label="Add a condition"
            value={adding}
            onChange={(e) => {
              const t = e.target.value as ConditionType;
              if (t) onChange([...conditions, defaultCondition(t)]);
              setAdding("");
            }}
            className="h-7 cursor-pointer rounded-md bg-transparent pr-1 text-[12.5px] text-[#4b4b48] outline-none hover:text-[#1d1b1b] focus-visible:ring-2 focus-visible:ring-black/20"
          >
            <option value="">Add condition</option>
            {(Object.entries(TYPE_LABEL) as [ConditionType, string][]).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Universe                                                            */
/* ------------------------------------------------------------------ */

function UniverseField({ tickers, onChange }: { tickers: string[]; onChange: (t: string[]) => void }) {
  const [text, setText] = useState("");
  const add = (raw: string) => {
    const next = raw
      .toUpperCase()
      .split(/[\s,;]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    if (!next.length) return;
    onChange(Array.from(new Set([...tickers, ...next])).slice(0, LIMITS.maxTickers));
    setText("");
  };
  return (
    <div className="flex min-h-[36px] flex-wrap items-center gap-1.5 rounded-md border border-black/10 bg-white px-1.5 py-1 focus-within:border-black/45">
      {tickers.map((t) => (
        <span key={t} className="inline-flex h-[24px] items-center gap-1 rounded border border-black/10 bg-[#f6f6f3] pl-1.5 pr-0.5 text-[11.5px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
          {t}
          <button
            type="button"
            aria-label={`Remove ${t}`}
            onClick={() => onChange(tickers.filter((x) => x !== t))}
            className="inline-flex h-5 w-5 items-center justify-center rounded text-[#9a9a9a] outline-none hover:text-[#1d1b1b] focus-visible:ring-2 focus-visible:ring-black/20"
          >
            <X width={11} height={11} aria-hidden />
          </button>
        </span>
      ))}
      <input
        aria-label="Add tickers"
        value={text}
        placeholder={tickers.length ? "Add" : "Tickers, e.g. SPY QQQ"}
        onChange={(e) => {
          const v = e.target.value;
          if (/[\s,;]$/.test(v)) add(v);
          else setText(v);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            add(text);
          } else if (e.key === "Backspace" && !text && tickers.length) onChange(tickers.slice(0, -1));
        }}
        onBlur={() => add(text)}
        className="h-[24px] min-w-[90px] flex-1 bg-transparent px-1 text-[12px] uppercase text-[#1d1b1b] outline-none placeholder:normal-case placeholder:text-[#b0b0ab]"
        style={{ fontFamily: MONO }}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The editor                                                          */
/* ------------------------------------------------------------------ */

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-2 border-t border-black/[0.06] py-3.5 first:border-t-0 first:pt-0 md:grid-cols-[150px_minmax(0,1fr)] md:gap-4">
      <div>
        <div className="text-[12.5px] text-[#1d1b1b]">{label}</div>
        {hint ? <div className="mt-0.5 text-[11.5px] leading-[16px] text-[#9a9a9a]">{hint}</div> : null}
      </div>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function Inline({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">{children}</div>;
}

export function RuleEditor({
  rules,
  settings,
  onRules,
  onSettings,
}: {
  rules: Strategy;
  settings: RunSettings;
  onRules: (r: Strategy) => void;
  onSettings: (s: RunSettings) => void;
}) {
  const win = resolvedWindow(settings);
  const setExit = (p: Partial<Strategy["exit"]>) => onRules({ ...rules, exit: { ...rules.exit, ...p } });
  return (
    <div className="flex flex-col">
      <Row label="Tickers" hint={`Up to ${LIMITS.maxTickers}, counting tickers that conditions read`}>
        <UniverseField tickers={rules.universe} onChange={(universe) => onRules({ ...rules, universe })} />
      </Row>

      <Row label="Entry" hint="Read on each close, filled at the next open">
        <div className="mb-2">
          <Inline>
            <Words>Enter when</Words>
            <Select
              label="Entry mode"
              value={rules.entry.mode}
              options={[
                ["all", "all of these hold"],
                ["any", "any of these holds"],
              ]}
              onChange={(mode) => onRules({ ...rules, entry: { ...rules.entry, mode } })}
            />
          </Inline>
        </div>
        <ConditionList
          conditions={rules.entry.conditions}
          min={1}
          emptyText="Add at least one entry condition."
          onChange={(conditions) => onRules({ ...rules, entry: { ...rules.entry, conditions } })}
        />
      </Row>

      <Row label="Exit" hint="The first of these closes a position">
        <ConditionList
          conditions={rules.exit.conditions}
          emptyText="No exit conditions."
          onChange={(conditions) => setExit({ conditions })}
        />
        <div className="mt-3">
          <Inline>
            <Words>Hold at most</Words>
            <NumberField label="Max holding days" empty placeholder="any" value={rules.exit.maxHoldingDays} min={1} max={LIMITS.maxHoldingDays} step={1} width={60} onChange={(v) => setExit({ maxHoldingDays: v === null ? null : Math.round(v) })} />
            <Words>trading days. Stop loss</Words>
            <NumberField label="Stop loss percent" empty placeholder="none" value={rules.exit.stopLossPct} min={0.5} max={95} width={60} onChange={(v) => setExit({ stopLossPct: v })} />
            <Words>%, take profit</Words>
            <NumberField label="Take profit percent" empty placeholder="none" value={rules.exit.takeProfitPct} min={0.5} max={1000} width={60} onChange={(v) => setExit({ takeProfitPct: v })} />
            <Words>%</Words>
          </Inline>
        </div>
      </Row>

      <Row label="Sizing">
        <Inline>
          <Words>At most</Words>
          <NumberField label="Max positions" value={rules.sizing.maxPositions} min={1} max={LIMITS.maxTickers} step={1} width={52} onChange={(v) => onRules({ ...rules, sizing: { ...rules.sizing, maxPositions: Math.round(v ?? rules.sizing.maxPositions) } })} />
          <Words>positions,</Words>
          <NumberField label="Percent of equity per position" empty placeholder="equal" value={rules.sizing.positionPct} min={1} max={100} width={64} onChange={(v) => onRules({ ...rules, sizing: { ...rules.sizing, positionPct: v } })} />
          <Words>% of equity each. Rebalance</Words>
          <Select
            label="Rebalance"
            value={rules.rebalance}
            options={[
              ["none", "never"],
              ["weekly", "weekly"],
              ["monthly", "monthly"],
            ]}
            onChange={(rebalance) => onRules({ ...rules, rebalance })}
          />
        </Inline>
      </Row>

      <Row label="Window and costs" hint={`Daily bars, from ${LIMITS.earliestDate.slice(0, 4)}, at most ${LIMITS.maxYears} years`}>
        <Inline>
          <input
            type="date"
            aria-label="Start date"
            value={win.start}
            min={LIMITS.earliestDate}
            max={win.end}
            onChange={(e) => onSettings({ ...settings, start: e.target.value || null })}
            className={FIELD}
            style={{ fontFamily: MONO }}
          />
          <Words>to</Words>
          <input
            type="date"
            aria-label="End date"
            value={win.end}
            min={win.start}
            onChange={(e) => onSettings({ ...settings, end: e.target.value || null })}
            className={FIELD}
            style={{ fontFamily: MONO }}
          />
          {settings.start || settings.end ? (
            <button
              type="button"
              onClick={() => onSettings({ ...settings, start: null, end: null })}
              className="text-[12px] text-[#767676] underline decoration-black/20 underline-offset-2 hover:text-[#1d1b1b]"
            >
              Last 10 years
            </button>
          ) : null}
        </Inline>
        <div className="mt-2">
          <Inline>
            <Words>Capital $</Words>
            <NumberField label="Starting capital" value={settings.initialCapital} min={LIMITS.minCapital} max={LIMITS.maxCapital} step={1000} width={96} onChange={(v) => onSettings({ ...settings, initialCapital: v ?? settings.initialCapital })} />
            <Words>commission</Words>
            <NumberField label="Commission in basis points" value={settings.commissionBps} min={0} max={LIMITS.maxBps} width={52} onChange={(v) => onSettings({ ...settings, commissionBps: v ?? settings.commissionBps })} />
            <Words>bps, slippage</Words>
            <NumberField label="Slippage in basis points" value={settings.slippageBps} min={0} max={LIMITS.maxBps} width={52} onChange={(v) => onSettings({ ...settings, slippageBps: v ?? settings.slippageBps })} />
            <Words>bps per fill</Words>
          </Inline>
        </div>
      </Row>
    </div>
  );
}
