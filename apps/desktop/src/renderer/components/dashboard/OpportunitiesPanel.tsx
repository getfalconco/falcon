import { SlidersHorizontal } from "lucide-react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import SelectionGloss from "@/components/dashboard/SelectionGloss";
import { useRiskSnapshot } from "@/hooks/useRiskSnapshot";
import { riskCardModel } from "../../../shared/risk-card";
import type { RiskBand } from "../../../shared/risk-types";

/**
 * Right-hand card of the bottom row: the portfolio risk score over a big
 * half-circle arc — band-coloured for the score, grey for the rest — drawn larger
 * than the card so its edges clip it.
 *
 * Risk Engine contract (spec §8): the card reads the latest snapshot only
 * (score · band · driver sentence · computed_at · empty) through
 * `riskCardModel`, never recomputes, never reaches into engine internals.
 * Behind `riskCardEnabled` (data/risk/config.json, default false): while the
 * flag is off this renders the static 72/100 placeholder exactly as before —
 * the live card is a separate design pass.
 */

const PLACEHOLDER_SCORE = 72;

/**
 * Gauge colour follows the snapshot's band (spec §4/§8: a 72 must never read
 * as green/safe): low green · moderate amber · elevated orange · high red.
 * The filled arc is the safe share (100 − score), so low risk = long green arc,
 * high risk = short red arc. The flag-off placeholder (72) sits in elevated.
 */
const BAND_COLOR: Record<RiskBand, string> = {
  low: "#16A34A",
  moderate: "#CA8A04",
  elevated: "#EA580C",
  high: "#DC2626",
};
const REST_COLOR = "#E4E5E1";

function GaugeArc({
  segments,
}: {
  segments: Array<{ frac: number; color: string }>;
}) {
  const CX = 170;
  const CY = 172;
  const R = 150;
  const GAP_DEG = 0; // segments sit flush against each other
  const active = segments.filter((s) => s.frac > 0.001);
  if (active.length === 0) return null;
  const span = 180 - GAP_DEG * Math.max(active.length - 1, 0);
  const rad = (d: number) => (d * Math.PI) / 180;
  let angle = 180;
  const paths = active.map((s) => {
    const sweep = s.frac * span;
    const a0 = angle;
    const a1 = angle - sweep;
    angle = a1 - GAP_DEG;
    return {
      d: `M${(CX + R * Math.cos(rad(a0))).toFixed(2)},${(CY - R * Math.sin(rad(a0))).toFixed(2)} A${R},${R} 0 0 1 ${(CX + R * Math.cos(rad(a1))).toFixed(2)},${(CY - R * Math.sin(rad(a1))).toFixed(2)}`,
      color: s.color,
    };
  });
  return (
    <svg viewBox="0 0 340 185" className="w-full" aria-hidden>
      {paths.map((p, i) => (
        <path
          key={i}
          d={p.d}
          fill="none"
          stroke={p.color}
          strokeWidth="10"
          strokeLinecap="butt"
        />
      ))}
    </svg>
  );
}

type Props = {
  onDuplicate?: () => void;
  onRemove?: () => void;
};

export default function OpportunitiesPanel({ onDuplicate, onRemove }: Props = {}) {
  const { latest, pending } = useRiskSnapshot();
  const model = riskCardModel(latest);
  const liveScore = model.kind === "score" ? model.score : null;
  const score = liveScore ?? PLACEHOLDER_SCORE;
  // The arc shows the safe share of the dial: a low score fills it almost
  // fully (green), a high score leaves only a short red arc (Kuzey, 2026-08-23).
  // The number stays the risk score itself.
  const frac = Math.max(0, Math.min(1, 1 - score / 100));
  const band: RiskBand = model.kind === "score" ? model.band : "elevated";
  // Loading (demo toggled, a fresh score is on its way): grey gauge, dimmed number.
  const loading = pending && model.kind !== "hidden";
  const scoreColor = loading ? REST_COLOR : BAND_COLOR[band];

  // The masthead every card carries: the label, and the three-dot menu with
  // Duplicate and Delete module. The card's settings glyph rides beside the
  // dots; it opens nothing yet, as before.
  const header = (
    <ChartCardHeader
      label="RISK SCORE"
      onDuplicate={onDuplicate}
      onRemove={onRemove}
      actions={
        <button
          type="button"
          data-no-lift
          aria-label="Risk score settings"
          className="app-no-drag text-[#4b5563] transition-colors hover:text-[#1d1b1b]"
        >
          <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </button>
      }
    />
  );

  if (model.kind === "empty" && !loading) {
    return (
      <div className="relative flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
        {header}
        <div className="flex flex-1 items-center justify-center text-[13px] text-[#9CA3AF]">No open positions.</div>
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      {header}

      {/* Headline: the risk score, big */}
      <div className="relative z-10 mt-4 flex items-baseline gap-1">
        <span className={`text-[52px] font-medium leading-none tabular-nums tracking-[-0.01em] ${loading ? "animate-pulse text-[#9CA3AF]" : "text-[#1d1b1b]"}`}>
          {loading ? "··" : score}
        </span>
        <span className="text-[22px] font-normal leading-none tabular-nums text-[#9CA3AF]">/100</span>
      </div>
      {loading ? (
        <p className="relative z-10 mt-2 animate-pulse text-[12px] leading-snug text-[#9CA3AF]">Computing risk for this portfolio…</p>
      ) : model.kind === "score" ? (
        // Same select-a-word gloss as the Insight headline: highlight a term
        // in the driver sentence to get its meaning.
        <SelectionGloss context={`${model.band} risk · ${model.sentence}`}>
          <p className="relative z-10 mt-2 text-[12px] leading-snug text-[#6b7280]">
            <span className="font-medium" style={{ color: scoreColor }}>{model.band.charAt(0).toUpperCase() + model.band.slice(1)}</span>
            {" · "}
            {model.sentence}
          </p>
        </SelectionGloss>
      ) : null}

      {/* Gauge — oversized on purpose: it runs past the card's edges and the
          card clips it, so the arc reads as one big sweep. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%] overflow-hidden rounded-b-3xl">
        <div className="absolute bottom-[-14%] left-1/2 w-[150%] -translate-x-1/2">
          <GaugeArc
            segments={[
              { frac, color: scoreColor },
              { frac: 1 - frac, color: REST_COLOR },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
