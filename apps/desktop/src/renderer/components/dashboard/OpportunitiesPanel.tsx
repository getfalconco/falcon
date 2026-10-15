import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { motion, useReducedMotion } from "framer-motion";
import { SlidersHorizontal } from "lucide-react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import SelectionGloss from "@/components/dashboard/SelectionGloss";
import { useRiskSnapshot } from "@/hooks/useRiskSnapshot";
import { useLiveQuotes } from "@/hooks/useLivePrices";
import { concentrationShare, riskCardView, riskHoverView, type RiskHoverLine } from "../../../shared/risk-card";
import { paperAccountWeights } from "../../../shared/portfolio-weights";
import type { RiskBand } from "../../../shared/risk-types";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { readPaperAccount, subscribePaperAccount } from "@/lib/paper-account";
import { useHoveredPosition } from "@/lib/position-hover";

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
 *
 * Hovering or focusing a Positions row (lib/position-hover.ts) swaps the card
 * to that name for as long as the row is held: the masthead names it, the big
 * number is its share of the portfolio risk, and up to four lines carry its
 * weight, beta, 30-day vol against the book's, an earnings date inside the
 * event window and its correlation with the largest holding, each only when
 * the snapshot has it (`riskHoverView`). Leaving the row brings the score back.
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
/** The hovered name's share of the risk: ink, not a band colour, since a share has no band. */
const SHARE_COLOR = "#1d1b1b";

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

/** A hovered position's line: its label in the reader's language, its value as computed. */
function HoverLine({ line, locale }: { line: RiskHoverLine; locale: string }) {
  const { t } = useI18n();
  let label: string;
  let value: string;
  switch (line.kind) {
    case "weight":
      label = t("dashboard.risk.hover.weight");
      value = line.value;
      break;
    case "beta":
      label = t("dashboard.risk.hover.beta");
      value = line.value;
      break;
    case "volatility":
      label = t("dashboard.risk.hover.vol");
      value = line.portfolio ? t("dashboard.risk.hover.volValue", { vol: line.value, port: line.portfolio }) : line.value;
      break;
    case "earnings":
      label = t("dashboard.risk.hover.earnings");
      value = new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" }).format(new Date(line.due_at));
      break;
    case "correlation":
      label = t("dashboard.risk.hover.correlation", { ticker: line.ticker });
      value = line.value;
      break;
  }
  return (
    <div className="flex items-baseline justify-between gap-3 py-[3px]">
      <dt className="truncate text-[#6b7280]">{label}</dt>
      <dd className="shrink-0 tabular-nums text-[#1d1b1b]">{value}</dd>
    </div>
  );
}

export default function OpportunitiesPanel({ onDuplicate, onRemove }: Props = {}) {
  const { t, locale } = useI18n();
  const reduceMotion = useReducedMotion();
  const hovered = useHoveredPosition();
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
  // While a Positions row is hovered or focused, the card reads that name
  // from the same snapshot; a demo score in flight keeps the portfolio view.
  const hover =
    view.kind === "score" && !view.pending ? riskHoverView(latest?.snapshot, hovered, weights) : null;

  // The masthead every card carries: the label, and the three-dot menu with
  // Duplicate and Delete module. The card's settings glyph rides beside the
  // dots; it opens nothing yet, as before.
  const header = (
    <ChartCardHeader
      label={hover ? t("dashboard.risk.hover.label", { ticker: hover.ticker }) : t("dashboard.risk.label")}
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

  // The swap between the portfolio and a hovered name: a short fade of the
  // incoming read, nothing that moves, and none at all under reduced motion.
  const fade = reduceMotion
    ? { initial: false as const }
    : { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.18, ease: "easeOut" as const } };
  // A hovered name with no share to draw leaves the dial empty (all rest).
  const shareFrac = hover?.shareFrac == null ? 0 : hover.shareFrac;
  const segments = hover
    ? [
        { frac: shareFrac, color: SHARE_COLOR },
        { frac: 1 - shareFrac, color: REST_COLOR },
      ]
    : [
        { frac, color: scoreColor },
        { frac: 1 - frac, color: REST_COLOR },
      ];

  return (
    <div className={shell} data-risk-state="score" data-risk-hover={hover?.ticker}>
      {header}

      <div className="relative z-10" aria-live="polite">
        {hover ? (
          <motion.div key={`hover:${hover.ticker}`} {...fade}>
            {hover.share != null ? (
              <div className="mt-4 flex items-baseline gap-2">
                <span className="text-[52px] font-medium leading-none tabular-nums tracking-[-0.01em] text-[#1d1b1b]">
                  {hover.share}
                </span>
                <span className="text-[13px] font-normal leading-none text-[#9CA3AF]">{t("dashboard.risk.hover.shareOf")}</span>
              </div>
            ) : null}
            {hover.lines.length > 0 ? (
              <dl className={`${hover.share != null ? "mt-3" : "mt-4"} text-[12px] leading-snug`}>
                {hover.lines.map((line) => (
                  <HoverLine key={line.kind} line={line} locale={locale} />
                ))}
              </dl>
            ) : null}
          </motion.div>
        ) : (
          <motion.div key="portfolio" {...fade}>
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
          </motion.div>
        )}
      </div>

      {/* Gauge — oversized on purpose: it runs past the card's edges and the
          card clips it, so the arc reads as one big sweep. */}
      <div className="pointer-events-none absolute inset-x-0 bottom-0 h-[62%] overflow-hidden rounded-b-3xl">
        <motion.div
          key={hover ? `gauge:${hover.ticker}` : "gauge"}
          {...fade}
          className="absolute bottom-[-14%] left-1/2 w-[150%] -translate-x-1/2"
        >
          <GaugeArc segments={segments} />
        </motion.div>
      </div>
    </div>
  );
}
