import { useMemo } from "react";
import { cn } from "@/lib/utils";
import type { BriefingReport } from "../../../shared/briefing-types";
import { bookView, type BookTileView, type RiskBlockView, type WeightSegmentView } from "../../../shared/briefing-view";
import { RISK_BAND_COLOR } from "../../../shared/risk-card";
import BriefingSection from "./BriefingSection";
import { HEAD_CLASS, MONO_CLASS, QUIET_NOTE_CLASS, TONE_TEXT } from "./briefing-styles";

type Props = {
  report: BriefingReport | null;
  masked: boolean;
  loading: boolean;
  /** The engine's degraded line for the risk figures. */
  note?: string | null;
};

/**
 * The weight bar is drawn in one ink at falling strength, not in a colour per
 * name. Colour in this panel already means direction (green, red) and risk
 * band; a rainbow bar would borrow those hues for something that is neither,
 * and the legend carries the names anyway.
 */
const SEGMENT_OPACITY = [0.86, 0.66, 0.5, 0.36, 0.26];
const REST_OPACITY = 0.12;

function segmentOpacity(segment: WeightSegmentView, index: number): number {
  if (segment.side === "rest") return REST_OPACITY;
  return SEGMENT_OPACITY[Math.min(index, SEGMENT_OPACITY.length - 1)];
}

function Tile({ tile }: { tile: BookTileView }) {
  return (
    <div className="min-w-0">
      <div className={HEAD_CLASS}>{tile.label}</div>
      <div className={cn("mt-1 truncate text-[22px] font-medium leading-[1.2] tabular-nums", tile.tone === "none" ? "text-[#1d1b1b]" : TONE_TEXT[tile.tone])}>
        {tile.value}
      </div>
      {tile.sub ? <div className={cn(MONO_CLASS, "mt-0.5 truncate text-[11px] text-[#6b7280]")}>{tile.sub}</div> : null}
    </div>
  );
}

function Weights({ segments }: { segments: WeightSegmentView[] }) {
  return (
    <div className="mt-5">
      <div className="flex h-2 w-full gap-px overflow-hidden rounded-full" aria-hidden>
        {segments.map((segment, i) => (
          <span
            key={segment.ticker ?? "rest"}
            className="h-full bg-[#1d1b1b]"
            style={{ flexGrow: segment.share, flexBasis: 0, opacity: segmentOpacity(segment, i) }}
          />
        ))}
      </div>
      <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-1">
        {segments.map((segment, i) => (
          <li key={segment.ticker ?? "rest"} className="flex items-baseline gap-1.5 text-[11.5px] text-[#4b5563]">
            <span className="h-2 w-2 shrink-0 self-center rounded-[2px] bg-[#1d1b1b]" style={{ opacity: segmentOpacity(segment, i) }} aria-hidden />
            <span>{segment.label}</span>
            <span className={cn(MONO_CLASS, "text-[11px] text-[#6b7280]")}>{segment.weight}</span>
            {segment.sideNote ? <span className="text-[10.5px] text-[#9CA3AF]">{segment.sideNote}</span> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Risk({ risk, bandColor }: { risk: RiskBlockView; bandColor: string | null }) {
  return (
    <div className="mt-5 grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 border-t-[0.5px] border-black/[0.06] pt-4">
      <div>
        <div className={HEAD_CLASS}>Risk score</div>
        <div className="mt-1 flex items-baseline gap-2">
          <span className="text-[22px] font-medium leading-[1.2] tabular-nums text-[#1d1b1b]">{risk.score}</span>
          {risk.band ? (
            <span className="flex items-center gap-1.5 text-[12px] text-[#4b5563]">
              {/* The band's colour sits on the dot alone; the word stays ink so it reads at any band. */}
              <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: bandColor ?? "#9CA3AF" }} aria-hidden />
              {risk.band}
            </span>
          ) : null}
        </div>
      </div>
      <div className="min-w-0">
        {risk.sentence ? <p className="text-[13px] leading-[1.55] text-[#374151]">{risk.sentence}</p> : null}
        {risk.stats.length > 0 ? (
          <dl className="mt-2 flex flex-wrap gap-x-5 gap-y-1">
            {risk.stats.map((stat) => (
              <div key={stat.label} className="flex items-baseline gap-1.5">
                <dt className="text-[11.5px] text-[#9CA3AF]">{stat.label}</dt>
                <dd className={cn(MONO_CLASS, "text-[11.5px] text-[#4b5563]")}>{stat.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}
      </div>
    </div>
  );
}

/** What a highlight in this section is about, for the gloss. */
const GLOSS_CONTEXT =
  "The book and risk section of the handover briefing: equity, cash, exposure, the weights of the largest positions, and the risk score with its beta and volatility figures.";

export default function BookAndRisk({ report, masked, loading, note }: Props) {
  const view = useMemo(() => (report ? bookView(report, masked) : null), [report, masked]);
  const band = report?.risk?.band ?? null;
  const bandColor = band ? ((RISK_BAND_COLOR as Record<string, string>)[band] ?? null) : null;

  return (
    <BriefingSection label="BOOK AND RISK" loading={loading} skeletonRows={4} notes={[view?.unpricedNote]} glossContext={GLOSS_CONTEXT}>
      {view ? (
        <>
          <div className="mt-3 grid grid-cols-4 gap-4 max-[1279px]:grid-cols-2">
            {view.tiles.map((tile) => (
              <Tile key={tile.key} tile={tile} />
            ))}
          </div>
          {view.weights.length > 0 ? <Weights segments={view.weights} /> : null}
          {view.risk ? (
            <Risk risk={view.risk} bandColor={bandColor} />
          ) : (
            // The engine's own line (the fetch failed) says more than the view's
            // general one (no snapshot for this book), so it goes first.
            <p className={cn(QUIET_NOTE_CLASS, "mt-4")}>{note ?? view.riskNote}</p>
          )}
        </>
      ) : null}
    </BriefingSection>
  );
}
