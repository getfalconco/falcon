"use client";

import { formulasOf, type StrategySpecV2 } from "@falcon/backtest";
import type { SpecVersion } from "@/lib/workspace/strategies";
import { MONO, Panel, SectionTitle, timeAgo } from "../parts";

const SOURCE: Record<SpecVersion["source"], string> = {
  chat: "by chat",
  template: "from a starter",
  formula: "formula edit",
  slider: "parameter",
  settings: "period or costs",
  import: "saved before v2",
  sighting: "from a Sighting",
  blank: "new",
};

/** What changed between two specs, field by field, in plain words. */
export function specDiff(a: StrategySpecV2, b: StrategySpecV2): string[] {
  const out: string[] = [];
  if (a.name !== b.name) out.push(`Name: "${a.name}" to "${b.name}"`);
  const ua = JSON.stringify(a.universe);
  const ub = JSON.stringify(b.universe);
  if (ua !== ub) {
    const t = (s: StrategySpecV2) => (s.universe.kind === "static" ? s.universe.tickers.join(", ") : s.universe.base);
    out.push(`Universe: ${t(a)} to ${t(b)}`);
  }
  if (a.portfolio.mode !== b.portfolio.mode) out.push(`Mode: ${a.portfolio.mode} to ${b.portfolio.mode}`);
  const fa = new Map(formulasOf(a).map((f) => [f.path, f.src]));
  const fb = new Map(formulasOf(b).map((f) => [f.path, f.src]));
  for (const k of Array.from(new Set(Array.from(fa.keys()).concat(Array.from(fb.keys()))))) {
    if (fa.get(k) !== fb.get(k)) out.push(`${k.replace("portfolio.", "")}: ${fa.get(k) ?? "none"} to ${fb.get(k) ?? "none"}`);
  }
  for (const k of Array.from(new Set(Object.keys(a.defs).concat(Object.keys(b.defs))))) {
    if (a.defs[k] !== b.defs[k]) out.push(`${k}: ${a.defs[k] ?? "none"} to ${b.defs[k] ?? "none"}`);
  }
  for (const k of Array.from(new Set(Object.keys(a.params).concat(Object.keys(b.params))))) {
    const pa = a.params[k];
    const pb = b.params[k];
    if (!pa) out.push(`$${k} added (${pb!.value})`);
    else if (!pb) out.push(`$${k} removed`);
    else if (pa.value !== pb.value) out.push(`$${k}: ${pa.value} to ${pb.value}`);
  }
  const keys = ["stop_pct", "trailing_pct", "take_profit_pct", "max_hold_days"] as const;
  for (const k of keys) if (a.risk[k] !== b.risk[k]) out.push(`${k.replace(/_/g, " ")}: ${a.risk[k] ?? "none"} to ${b.risk[k] ?? "none"}`);
  if (a.rebalance !== b.rebalance) out.push(`Rebalance: ${a.rebalance} to ${b.rebalance}`);
  if (JSON.stringify(a.period) !== JSON.stringify(b.period)) out.push(`Period: ${a.period.start ?? "default"}..${a.period.end ?? "today"} to ${b.period.start ?? "default"}..${b.period.end ?? "today"}`);
  if (JSON.stringify(a.execution) !== JSON.stringify(b.execution) || a.capital !== b.capital) out.push("Costs or capital changed");
  if (a.benchmark !== b.benchmark) out.push(`Benchmark: ${a.benchmark} to ${b.benchmark}`);
  return out;
}

export function Versions({ versions, current, onRestore }: { versions: SpecVersion[]; current: StrategySpecV2; onRestore: (v: SpecVersion) => void }) {
  if (versions.length < 2) return null;
  const list = [...versions].reverse();
  return (
    <section>
      <SectionTitle count={versions.length}>Versions</SectionTitle>
      <Panel className="mt-2 px-5 py-3">
        <ol className="flex flex-col gap-2.5">
          {list.map((v, i) => {
            const prev = list[i + 1];
            const diff = prev ? specDiff(prev.spec, v.spec) : [];
            const isCurrent = JSON.stringify(v.spec) === JSON.stringify(current);
            return (
              <li key={v.v} className="flex flex-col gap-0.5">
                <div className="flex items-baseline gap-2 text-[12.5px]">
                  <span className="text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                    v{v.v}
                  </span>
                  <span className="text-[#767676]">{SOURCE[v.source]}</span>
                  <span className="text-[11px] text-[#9a9a9a]">{timeAgo(new Date(v.at).toISOString())}</span>
                  {isCurrent ? (
                    <span className="text-[11px] text-[#9a9a9a]">current</span>
                  ) : (
                    <button type="button" onClick={() => onRestore(v)} className="text-[11.5px] text-[#4b4b48] underline decoration-black/20 underline-offset-2 outline-none hover:text-[#1d1b1b]">
                      Restore
                    </button>
                  )}
                </div>
                {diff.length ? (
                  <ul className="flex flex-col gap-0.5 pl-1">
                    {diff.slice(0, 6).map((d) => (
                      <li key={d} className="break-words text-[11.5px] leading-[16px] text-[#767676]" style={{ fontFamily: MONO }}>
                        {d}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Panel>
    </section>
  );
}
