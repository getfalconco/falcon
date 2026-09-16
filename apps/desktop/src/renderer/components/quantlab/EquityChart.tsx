import { useMemo, useState } from "react";
import type { EquityCurve } from "../../../shared/quantlab-types";
import { pct } from "./quantlab-format";

/**
 * The strategy against buy-and-hold S&P 500.
 *
 * This is the headline of the Results tab because it is the one picture
 * everybody can read. It is drawn on a log scale: on a linear axis a five-year
 * curve makes the recent end look like all the action, and an early drawdown
 * becomes invisible. Equal percentage moves should look equal.
 *
 * The dashed line marks where out-of-sample begins — everything to the right
 * of it is the part the rule was NOT shaped against, and is the only stretch
 * that means much.
 */
export default function EquityChart({
  curves,
  oosFrom,
  hasEdge,
}: {
  curves: EquityCurve[];
  oosFrom: string | null;
  /** Whether the out-of-sample stats found an edge; null when undecidable. */
  hasEdge: boolean | null;
}) {
  const [horizon, setHorizon] = useState(curves[0]?.horizon ?? 0);
  const curve = curves.find((c) => c.horizon === horizon) ?? curves[0] ?? null;

  const geometry = useMemo(() => {
    if (!curve || curve.points.length < 2) return null;
    const W = 1000;
    const H = 260;
    const padL = 4;
    const padR = 4;
    const padT = 10;
    const padB = 18;

    const values = curve.points.flatMap((p) => [p.s, p.b]).filter((v) => v > 0);
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    // Log scale: equal percentage moves get equal vertical space.
    const logLo = Math.log(lo);
    const logHi = Math.log(hi);
    const span = logHi - logLo || 1;

    const x = (i: number) => padL + (i / (curve.points.length - 1)) * (W - padL - padR);
    const y = (v: number) => padT + (1 - (Math.log(Math.max(v, 1e-6)) - logLo) / span) * (H - padT - padB);

    const line = (pick: (p: (typeof curve.points)[number]) => number) =>
      curve.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(pick(p)).toFixed(1)}`).join(" ");

    const oosIndex = oosFrom ? curve.points.findIndex((p) => p.d >= oosFrom) : -1;
    return {
      W,
      H,
      strategy: line((p) => p.s),
      benchmark: line((p) => p.b),
      baseline: y(1),
      oosX: oosIndex > 0 ? x(oosIndex) : null,
      first: curve.points[0].d,
      last: curve.points[curve.points.length - 1].d,
    };
  }, [curve, oosFrom]);

  if (!curve || !geometry) return null;

  const vsIndex =
    curve.strategy_total != null && curve.benchmark_total != null
      ? curve.strategy_total - curve.benchmark_total
      : null;

  // The chart and the verdict can legitimately disagree: a portfolio curve is
  // driven by WHAT was held and for how long, while the verdict measures what
  // the rule added per trade. A rule that only ever buys high-beta names in a
  // bull market beats the index while adding nothing. When that happens, say so
  // here rather than letting the picture quietly overrule the measurement.
  const flattering = hasEdge === false && vsIndex != null && vsIndex > 0;

  return (
    <div className="mt-4 rounded-lg border border-[#e0e0da] bg-white px-4 py-3">
      <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
        <span className="text-[10px] font-medium tracking-[0.08em] text-[#9CA3AF]">
          GROWTH vs BUY-AND-HOLD S&amp;P 500
        </span>
        {curves.length > 1 && (
          <div className="flex items-center gap-1">
            {curves.map((c) => (
              <button
                key={c.horizon}
                onClick={() => setHorizon(c.horizon)}
                className={`rounded px-1.5 py-0.5 text-[10px] tabular-nums transition-colors ${
                  c.horizon === curve.horizon ? "bg-[#1d1b1b] text-white" : "text-[#9CA3AF] hover:bg-[#eeeee8]"
                }`}
              >
                {c.horizon}d
              </button>
            ))}
          </div>
        )}
        <span className="ml-auto text-[10px] text-[#9CA3AF] tabular-nums">
          {geometry.first} → {geometry.last}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-baseline gap-x-6 gap-y-1">
        <Figure label="Strategy" value={curve.strategy_total} accent="#189E9A" />
        <Figure label="S&P 500" value={curve.benchmark_total} accent="#9CA3AF" />
        <Figure
          label="Difference"
          value={vsIndex}
          accent={vsIndex != null && vsIndex >= 0 ? "#1d7a55" : "#b23b3b"}
        />
        <div className="ml-auto flex items-baseline gap-4 text-[10px] text-[#9CA3AF] tabular-nums">
          <span>worst fall {pct(curve.strategy_max_drawdown)} vs {pct(curve.benchmark_max_drawdown)} index</span>
          <span>invested {(curve.exposure * 100).toFixed(0)}% of the time</span>
        </div>
      </div>

      {flattering ? (
        <p className="mt-2 rounded-md border border-[#e0d9c8] bg-[#faf6ec] px-3 py-2 text-[11px] leading-relaxed text-[#8a7a55]">
          This curve beats the index, but the verdict above says the rule has no edge — and the verdict is the one to
          believe. A portfolio curve reflects <em>what</em> was held and for how long; buying high-beta names in a
          rising market beats the index without the rule contributing anything. The per-trade measurement is what
          isolates the rule.
        </p>
      ) : (
        <p className="mt-1 text-[11px] leading-relaxed text-[#6b7280]">
          What this portfolio did — not proof the rule works. It was invested {(curve.exposure * 100).toFixed(0)}% of
          the time, so it is partly a bet on being in the market at all; the verdict above is what isolates the rule.
        </p>
      )}

      <svg
        viewBox={`0 0 ${geometry.W} ${geometry.H}`}
        className="mt-2 w-full"
        style={{ height: 200 }}
        preserveAspectRatio="none"
      >
        {/* Break-even */}
        <line x1={0} y1={geometry.baseline} x2={geometry.W} y2={geometry.baseline} stroke="#e0e0da" strokeWidth={1} />
        {geometry.oosX != null && (
          <line
            x1={geometry.oosX}
            y1={0}
            x2={geometry.oosX}
            y2={geometry.H}
            stroke="#c0c0ba"
            strokeWidth={1}
            strokeDasharray="4 4"
          />
        )}
        <path d={geometry.benchmark} fill="none" stroke="#c0c0ba" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
        <path d={geometry.strategy} fill="none" stroke="#189E9A" strokeWidth={2} vectorEffect="non-scaling-stroke" />
      </svg>

      <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-[#9CA3AF]">
        <Swatch color="#189E9A" label="Strategy" />
        <Swatch color="#c0c0ba" label="S&P 500 (buy and hold)" />
        {geometry.oosX != null && <span>· dashed line = out-of-sample begins</span>}
        <span className="w-full">{curve.assumption}</span>
      </div>
    </div>
  );
}

function Figure({ label, value, accent, hint }: { label: string; value: number | null; accent: string; hint?: string }) {
  return (
    <div className="flex items-baseline gap-1.5" title={hint}>
      <span className="text-[11px] text-[#9CA3AF]">{label}</span>
      <span className="text-[18px] tabular-nums" style={{ color: accent }}>
        {pct(value, 1)}
      </span>
    </div>
  );
}

function Swatch({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="inline-block h-[2px] w-4 rounded" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}
