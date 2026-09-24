import { cn } from "@/lib/utils";

/**
 * The Hour/Day/Week/Month/Quarter/Year selector — active option dark with a
 * thin underline. A wide card sets it beside the balance; a narrow one drops
 * it under the number, the only place left with the width to hold six words
 * without running into it.
 *
 * The selector is controlled: the card already owns which timeframe the
 * chart is drawing, and a second copy of that here would be one to disagree
 * with it the moment the selector is moved between those two layouts.
 */

export const TIMEFRAMES = ["Hour", "Day", "Week", "Month", "Quarter", "Year"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export default function TimeframeControls({
  value,
  onChange,
  compact = false,
  className,
}: {
  value: Timeframe;
  onChange?: (tf: Timeframe) => void;
  /** Tighter type and spacing, for a card too narrow for the full row. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center", compact ? "gap-3.5" : "gap-6", className)}>
      {TIMEFRAMES.map((tf) => {
        const isActive = value === tf;
        return (
          <button
            key={tf}
            type="button"
            onClick={() => onChange?.(tf)}
            className={cn(
              "app-no-drag relative pb-1 transition-colors",
              compact ? "text-[12px]" : "text-[13.5px]",
              isActive
                ? "text-[#1d1b1b]"
                : "text-[rgb(156,163,175)] hover:text-[rgb(107,114,128)]",
            )}
          >
            {tf}
            {isActive ? (
              // Flat, square-edged rule — no border rounding artifacts
              <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-[#1d1b1b]" />
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
