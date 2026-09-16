import { useState } from "react";
import { Maximize, Minimize, SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Right-side chart controls: two icon buttons on top, an Hour/Day/Week/Month/
 * Quarter/Year selector underneath — active option dark with a thin underline.
 */

const TIMEFRAMES = ["Hour", "Day", "Week", "Month", "Quarter", "Year"] as const;
export type Timeframe = (typeof TIMEFRAMES)[number];

export default function TimeframeControls({
  onChange,
  expanded = false,
  onToggleExpanded,
}: {
  onChange?: (tf: Timeframe) => void;
  /** Chart is filling the workspace. */
  expanded?: boolean;
  onToggleExpanded?: () => void;
}) {
  const [active, setActive] = useState<Timeframe>("Month");

  return (
    <div className="flex flex-col items-end gap-7">
      <div className="flex items-center gap-8 pr-1">
        <button
          type="button"
          aria-label="Chart settings"
          className="app-no-drag text-[#4b5563] transition-colors hover:text-[#1d1b1b]"
        >
          <SlidersHorizontal className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
        </button>
        <button
          type="button"
          onClick={onToggleExpanded}
          aria-label={expanded ? "Exit full screen" : "Expand chart"}
          aria-pressed={expanded}
          className="app-no-drag text-[#4b5563] transition-colors hover:text-[#1d1b1b]"
        >
          {expanded ? (
            <Minimize className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
          ) : (
            <Maximize className="h-[18px] w-[18px]" strokeWidth={1.75} aria-hidden />
          )}
        </button>
      </div>

      <div className="flex items-center gap-6">
        {TIMEFRAMES.map((tf) => {
          const isActive = active === tf;
          return (
            <button
              key={tf}
              type="button"
              onClick={() => {
                setActive(tf);
                onChange?.(tf);
              }}
              className={cn(
                "app-no-drag relative pb-1 text-[13.5px] transition-colors",
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
    </div>
  );
}
