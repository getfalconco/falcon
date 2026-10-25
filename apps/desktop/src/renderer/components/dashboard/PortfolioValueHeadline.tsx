import { ArrowDown, ArrowUp, Moon, Sunrise, Sunset } from "lucide-react";
import DotMatrixNumber, { matrixColumns } from "@/components/dashboard/DotMatrixNumber";
import {
  formatBalance,
  formatChangeAmount,
  formatChangePercent,
  netWorthChange,
} from "@/components/dashboard/net-worth-format";
import type { Timeframe } from "@/components/dashboard/TimeframeControls";
import { usePortfolioBalance } from "@/hooks/usePortfolioBalance";
import { marketSessionLabel, useMarketSession } from "@/hooks/useMarketSession";
import { useI18n, type MessageKey } from "@/lib/i18n";

/**
 * The Net Worth card's headline: the live balance (cash, live-priced
 * positions and a connected brokerage) as a dot-matrix figure, left aligned
 * under the card's label, with how far it has come over the chart's window
 * beside it: the change as a share in green or red, and under that in
 * dollars, "+$34,586 in 1 month".
 *
 * While the chart is scrubbed the figure is the hovered point's and the
 * change runs from the window's start to it, so the two always describe the
 * same point on the line.
 */

const CHANGE_KEY: Record<Timeframe, MessageKey> = {
  Hour: "dashboard.portfolioValue.change.hour",
  Day: "dashboard.portfolioValue.change.day",
  Week: "dashboard.portfolioValue.change.week",
  Month: "dashboard.portfolioValue.change.month",
  Quarter: "dashboard.portfolioValue.change.quarter",
  Year: "dashboard.portfolioValue.change.year",
};

/** The widest the dots get (the figure is seven of these tall), and the smallest they shrink to. */
const MAX_PITCH = 8;
const MIN_PITCH = 3;
/** Room kept beside the figure for the change; below this the change goes under it instead. */
const CHANGE_ROOM = 176;
const SIDE_BY_SIDE_FROM = 420;
/** The figure is sized as if it were at least this many columns wide, so a short balance does not balloon. */
const MIN_COLUMNS = 32;

export default function PortfolioValueHeadline({
  overrideValue,
  masked = false,
  width,
  start,
  timeframe,
}: {
  /** While scrubbing the chart, the hovered point's value shows instead. */
  overrideValue?: number | null;
  /** Privacy mode: digits render as stars. */
  masked?: boolean;
  /** The width the headline has, in pixels; the figure is sized from it. */
  width: number;
  /** The value the chart's window starts from; null until the chart has one. */
  start: number | null;
  timeframe: Timeframe;
}) {
  const { locale, t } = useI18n();
  const balance = usePortfolioBalance();
  const scrubbing = overrideValue != null;
  const shown = overrideValue ?? balance;

  const text = formatBalance(shown, locale, masked);
  const sideBySide = width >= SIDE_BY_SIDE_FROM;
  const room = sideBySide ? width - CHANGE_ROOM : width;
  const pitch =
    width > 0
      ? Math.max(MIN_PITCH, Math.min(MAX_PITCH, room / Math.max(matrixColumns(text), MIN_COLUMNS)))
      : MAX_PITCH;

  const change = netWorthChange(shown, start);
  const tone =
    change == null || change.amount === 0
      ? "var(--glow-muted)"
      : change.amount > 0
        ? "var(--glow-up)"
        : "var(--glow-down)";

  return (
    <div className="flex select-none flex-wrap items-start gap-x-5 gap-y-2">
      <span className="sr-only">{text}</span>
      <DotMatrixNumber text={text} pitch={pitch} fast={scrubbing} />
      {change ? (
        <div className="flex min-w-0 flex-col" style={{ paddingTop: sideBySide ? pitch * 0.4 : 0 }}>
          {change.ratio != null ? (
            <span
              className="flex items-center gap-1 font-sans text-[13px] font-medium leading-tight tabular-nums"
              style={{ color: tone }}
            >
              {change.amount > 0 ? (
                <ArrowUp className="h-3 w-3" strokeWidth={2.25} aria-hidden />
              ) : change.amount < 0 ? (
                <ArrowDown className="h-3 w-3" strokeWidth={2.25} aria-hidden />
              ) : null}
              {formatChangePercent(change.ratio, locale, change.amount === 0)}
            </span>
          ) : null}
          <span
            className="mt-0.5 whitespace-nowrap font-sans text-[12px] leading-tight tabular-nums"
            style={{ color: "var(--glow-muted)" }}
          >
            {t(CHANGE_KEY[timeframe], { amount: formatChangeAmount(change.amount, locale, masked) })}
          </span>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Which session the balance is priced from, small, beside the card's label:
 * outside regular hours it is the last extended-hours print, not the close.
 */
export function MarketSessionTag() {
  const { t } = useI18n();
  const session = useMarketSession();
  const label = marketSessionLabel(session);
  if (!label) return null;
  return (
    <span
      className="flex select-none items-center gap-1 self-center font-sans text-[10.5px] leading-none"
      style={{ color: session === "regular" ? "var(--glow-up)" : "var(--glow-label)" }}
    >
      {session === "pre" ? (
        <Sunrise className="h-3 w-3" strokeWidth={1.75} aria-hidden />
      ) : session === "post" ? (
        <Sunset className="h-3 w-3" strokeWidth={1.75} aria-hidden />
      ) : session === "regular" ? (
        <span aria-hidden className="h-[6px] w-[6px] rounded-full bg-current" />
      ) : (
        <Moon className="h-3 w-3" strokeWidth={1.75} aria-hidden />
      )}
      {t(label)}
    </span>
  );
}
