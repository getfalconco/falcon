import NumberFlow from "@number-flow/react";
import { ArrowDown, ArrowUp, Moon, Sunrise, Sunset } from "lucide-react";
import { formatChangeAmount, formatChangePercent, netWorthChange } from "@/components/dashboard/net-worth-format";
import type { Timeframe } from "@/components/dashboard/TimeframeControls";
import { usePortfolioBalance } from "@/hooks/usePortfolioBalance";
import { marketSessionLabel, useMarketSession } from "@/hooks/useMarketSession";
import { useI18n, type MessageKey } from "@/lib/i18n";

/**
 * Hero number for the Net worth card: the live portfolio value (cash +
 * live-priced positions + connected brokerage), set large and light and left
 * aligned, with the market session under it, in the same type and inks as
 * the Allocation card's figure and caption.
 *
 * Beside it, how far it has come over the chart's window: the change as a
 * share with an arrow, green or red, and under that the dollars in muted
 * type, "+$34,586 in 1 month". While the chart is scrubbed the figure is the
 * hovered point's and the change runs from the window's start to it, so the
 * two always describe the same point on the line.
 */

const CHANGE_KEY: Record<Timeframe, MessageKey> = {
  Hour: "dashboard.portfolioValue.change.hour",
  Day: "dashboard.portfolioValue.change.day",
  Week: "dashboard.portfolioValue.change.week",
  Month: "dashboard.portfolioValue.change.month",
  Quarter: "dashboard.portfolioValue.change.quarter",
  Year: "dashboard.portfolioValue.change.year",
};

export default function PortfolioValueHeadline({
  overrideValue,
  masked = false,
  size = 76,
  start,
  timeframe,
}: {
  /** While scrubbing the chart, the hovered point's value shows instead. */
  overrideValue?: number | null;
  /** Privacy mode: digits render as stars. */
  masked?: boolean;
  /**
   * Type size in pixels. The caller sets it from the width it has to give:
   * held at 76 the number simply runs off a narrowed card, or into the
   * change beside it.
   */
  size?: number;
  /** The value the chart's window starts from; null until the chart has one. */
  start: number | null;
  timeframe: Timeframe;
}) {
  const { locale, t } = useI18n();
  const balance = usePortfolioBalance();
  const shown = overrideValue ?? balance;
  const session = useMarketSession();
  const sessionLabel = marketSessionLabel(session);

  const change = netWorthChange(shown, start);
  const tone =
    change == null || change.amount === 0
      ? "text-content-tertiary"
      : change.amount > 0
        ? "text-[var(--positive)]"
        : "text-[var(--negative)]";

  return (
    <div className="flex select-none flex-wrap items-start gap-x-6 gap-y-3">
      <div className="flex min-w-0 flex-col items-start">
        {masked ? (
          <span
            className="font-sans font-light leading-none tracking-[-0.03em] tabular-nums text-content-primary"
            style={{ fontSize: size }}
          >
            $*****
          </span>
        ) : (
          <NumberFlow
            value={shown}
            format={{
              style: "currency",
              currency: "USD",
              minimumFractionDigits: 2,
              maximumFractionDigits: 2,
            }}
            className="font-sans font-light leading-none tracking-[-0.03em] tabular-nums text-content-primary"
            style={{ fontSize: size }}
          />
        )}
        {/* Which session the number is priced from — outside regular hours that
            is the last extended-hours print, not the close. */}
        {sessionLabel ? (
          <span className="mt-3 flex items-center gap-1.5 text-[12px] leading-none text-content-tertiary">
            {session === "pre" ? (
              <Sunrise className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            ) : session === "post" ? (
              <Sunset className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            ) : session === "regular" ? (
              <span aria-hidden className="h-[7px] w-[7px] rounded-full bg-[var(--teal)]" />
            ) : (
              <Moon className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
            )}
            {t(sessionLabel)}
          </span>
        ) : null}
      </div>

      {change ? (
        <div className="flex min-w-0 flex-col" style={{ paddingTop: Math.round(size * 0.1) }}>
          {change.ratio != null ? (
            <span className={`flex items-center gap-1 font-sans text-[13px] font-medium leading-tight tabular-nums ${tone}`}>
              {change.amount > 0 ? (
                <ArrowUp className="h-3 w-3" strokeWidth={2.25} aria-hidden />
              ) : change.amount < 0 ? (
                <ArrowDown className="h-3 w-3" strokeWidth={2.25} aria-hidden />
              ) : null}
              {formatChangePercent(change.ratio, locale, change.amount === 0)}
            </span>
          ) : null}
          <span className="mt-1 whitespace-nowrap font-sans text-[12px] leading-tight tabular-nums text-content-tertiary">
            {t(CHANGE_KEY[timeframe], { amount: formatChangeAmount(change.amount, locale, masked) })}
          </span>
        </div>
      ) : null}
    </div>
  );
}
