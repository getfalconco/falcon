import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { SlidersHorizontal } from "lucide-react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import SelectionGloss from "@/components/dashboard/SelectionGloss";
import { useRiskSnapshot } from "@/hooks/useRiskSnapshot";
import { useLiveQuotes } from "@/hooks/useLivePrices";
import { concentrationShare, riskCardView } from "../../../shared/risk-card";
import { paperAccountWeights } from "../../../shared/portfolio-weights";
import type { RiskBand } from "../../../shared/risk-types";
import { useT, type MessageKey } from "@/lib/i18n";
import { readPaperAccount, subscribePaperAccount } from "@/lib/paper-account";

/**
 * Right-hand card of the bottom row: the portfolio risk score over a big
 * half-circle arc — band-coloured for the score, grey for the rest — drawn larger
 * than the card so its edges clip it.
 *
 * Risk Engine contract (spec §8): the card reads the latest snapshot only
 * (score · band · driver sentence · computed_at · empty) through
 * `riskCardView`, never recomputes, never reaches into engine internals.
 *
 * The number on the card is always the signed-in user's own snapshot score.
 * Without one there is no number at all: the card says it is calculating, that
 * there is nothing to score, or that the score could not be loaded (with Try
 * again). It used to print a hard-coded placeholder whenever no snapshot came back,
 * which read as a real score for anyone the engine had not scored yet.
 */

/**
 * Gauge colour follows the snapshot's band (spec §4/§8: an elevated score must
 * never read as green/safe): low green · moderate amber · elevated orange · high red.
 * The filled arc is the safe share (100 − score), so low risk = long green arc,
 * high risk = short red arc.
 */
const BAND_COLOR: Record<RiskBand, string> = {
  low: "#16A34A",
  moderate: "#CA8A04",
  elevated: "#EA580C",
  high: "#DC2626",
};
const REST_COLOR = "#E4E5E1";

/** The band's word on this card. The Risk Engine's own label table
 *  (`RISK_BAND_LABEL`) stays English for the surfaces that read it. */
const BAND_KEY: Record<RiskBand, MessageKey> = {
  low: "dashboard.risk.band.low",
  moderate: "dashboard.risk.band.moderate",
  elevated: "dashboard.risk.band.elevated",
  high: "dashboard.risk.band.high",
};

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

/** Whether the book holds anything at all, long or short. */
function readHoldsPositions(): boolean {
  return Object.values(readPaperAccount().positions).some((p) => Number.isFinite(p.shares) && p.shares !== 0);
}

type Props = {
  onDuplicate?: () => void;
  onRemove?: () => void;
};

export default function OpportunitiesPanel({ onDuplicate, onRemove }: Props = {}) {
  const t = useT();
  const { latest, pending, status, syncFailed, retry } = useRiskSnapshot();
  const holdsPositions = useSyncExternalStore(subscribePaperAccount, readHoldsPositions, () => false);
  const view = riskCardView({ latest, status, syncFailed, pending, holdsPositions });
  // The account and the prints the Positions card values it with: the same
  // store, the same quote hook over the same symbols, the same weight
  // function. A concentration sentence quotes its percentage from these, so
  // the two cards print one figure for a name, not 24.8% here and 30% there.
  const [account, setAccount] = useState(readPaperAccount);
  useEffect(() => subscribePaperAccount(() => setAccount(readPaperAccount())), []);
  const symbolsKey = Object.keys(account.positions).sort().join(",");
  const quotes = useLiveQuotes(symbolsKey);
  const weights = useMemo(() => {
    const prices: Record<string, number> = {};
    for (const [symbol, q] of Object.entries(quotes)) prices[symbol] = q.price;
    return paperAccountWeights(account, prices);
  }, [account, quotes]);

  // The masthead every card carries: the label, and the three-dot menu with
  // Duplicate and Delete module. The card's settings glyph rides beside the
  // dots; it opens nothing yet, as before.
  const header = (
    <ChartCardHeader
      label={t("dashboard.risk.label")}
      onDuplicate={onDuplicate}
      onRemove={onRemove}
      actions={
        <button
          type="button"
          data-no-lift
          aria-label={t("dashboard.risk.settings")}
          className="app-no-drag text-[#4b5563] transition-colors hover:text-[#1d1b1b]"
        >
          <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </button>
      }
    />
  );

  const shell = "relative flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150";

  // No score of the user's own: say where things stand, in one line, and
  // never print a number.
  if (view.kind !== "score") {
    const line =
      view.kind === "calculating"
        ? t("dashboard.risk.calculating")
        : view.kind === "empty"
          ? t("dashboard.risk.empty")
          : view.kind === "error"
            ? t("dashboard.risk.error")
            : view.kind === "off"
              ? t("dashboard.risk.off")
              : null;
    return (
      <div className={shell} data-risk-state={view.kind}>
        {header}
        <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-[13px] text-[#9CA3AF]">
          {line ? <p className={view.kind === "calculating" ? "animate-pulse" : undefined}>{line}</p> : null}
          {view.kind === "error" ? (
            <button
              type="button"
              data-no-lift
              onClick={retry}
              className="app-no-drag text-[12px] font-medium text-[#4b5563] underline-offset-2 transition-colors hover:text-[#1d1b1b] hover:underline"
            >
              {t("dashboard.risk.retry")}
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  const share = concentrationShare(view, weights);
  const sentence =
    share == null
      ? view.sentence
      : share.pct == null
        ? t("dashboard.risk.concentrationLargest", { ticker: share.ticker })
        : t("dashboard.risk.concentration", { pct: share.pct, ticker: share.ticker });
  const score = view.score;
  // The arc shows the safe share of the dial: a low score fills it almost
  // fully (green), a high score leaves only a short red arc (Kuzey, 2026-08-23).
  // The number stays the risk score itself.
  const frac = Math.max(0, Math.min(1, 1 - score / 100));
  // Loading (demo toggled, a fresh score is on its way): grey gauge, dimmed number.
  const loading = view.pending;
  const scoreColor = loading ? REST_COLOR : BAND_COLOR[view.band];

  return (
    <div className={shell} data-risk-state="score">
      {header}

      {/* Headline: the risk score, big */}
      <div className="relative z-10 mt-4 flex items-baseline gap-1">
        <span className={`text-[52px] font-medium leading-none tabular-nums tracking-[-0.01em] ${loading ? "animate-pulse text-[#9CA3AF]" : "text-[#1d1b1b]"}`}>
          {loading ? "··" : score}
        </span>
        <span className="text-[22px] font-normal leading-none tabular-nums text-[#9CA3AF]">/100</span>
      </div>
      {loading ? (
        <p className="relative z-10 mt-2 animate-pulse text-[12px] leading-snug text-[#9CA3AF]">{t("dashboard.risk.computing")}</p>
      ) : (
        // Same select-a-word gloss as the Insight headline: highlight a term
        // in the driver sentence to get its meaning.
        <SelectionGloss context={`${view.band} risk · ${sentence}`}>
          <p className="relative z-10 mt-2 text-[12px] leading-snug text-[#6b7280]">
            <span className="font-medium" style={{ color: scoreColor }}>{t(BAND_KEY[view.band])}</span>
            {" · "}
            {sentence}
          </p>
        </SelectionGloss>
      )}

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
