import { useEffect, useRef, useState } from "react";
import { LineChart } from "lucide-react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import ConnectPortfolioEmpty, { usePortfolioConnected } from "@/components/dashboard/ConnectPortfolioEmpty";
import PortfolioChart from "@/components/dashboard/PortfolioChart";
import PortfolioValueHeadline from "@/components/dashboard/PortfolioValueHeadline";
import TimeframeControls, { type Timeframe } from "@/components/dashboard/TimeframeControls";

/**
 * The balance and its chart as a card like any other: it sits in the grid,
 * lifts, drags, resizes, duplicates and deletes exactly as Positions does.
 * It used to be a block of its own above the grid, with a dock beside it and
 * a full-screen mode — every one of those made it a different kind of thing
 * from the cards under it, and none of them survives here.
 *
 * Everything inside is sized from the card's own width: the number holds its
 * 76px while there is room and steps down from there; the selector sits
 * beside it until the two would touch, then drops under it. One measurement
 * feeds both, so they can never disagree about how much room there is.
 */
export default function PortfolioValueCard({
  masked = false,
  onDuplicate,
  onRemove,
}: {
  masked?: boolean;
  onDuplicate?: () => void;
  onRemove?: () => void;
}) {
  const [timeframe, setTimeframe] = useState<Timeframe>("Month");
  const [scrubValue, setScrubValue] = useState<number | null>(null);
  /** Nothing linked yet — a balance of zero over a flat line says nothing. */
  const connected = usePortfolioConnected();

  const rootRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => setWidth(el.getBoundingClientRect().width);
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    measure();
    return () => ro.disconnect();
  }, []);

  // The width the balance actually has: the card less its padding.
  const inner = Math.max(0, width - 40);
  const headlineSize = inner > 0 ? Math.round(Math.min(76, Math.max(34, (76 * inner) / 1100))) : 76;
  const stacked = inner > 0 && inner < 860;

  return (
    <div
      ref={rootRef}
      className="grid h-full w-full grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
    >
      <ChartCardHeader onDuplicate={onDuplicate} onRemove={onRemove} />

      {!connected ? (
        <div className="row-span-2 min-h-0">
          <ConnectPortfolioEmpty
            Icon={LineChart}
            line="No account linked yet. Connect a brokerage or open a Falcon paper account to track your portfolio's value."
          />
        </div>
      ) : (
      <>
      {/* The band: the balance centred on the card, the selector at its
          right — or under it, once the card is too narrow for the two to
          share a line. */}
      <div className="relative mt-4 flex shrink-0 items-center">
        <div className="flex w-full flex-col items-center">
          <PortfolioValueHeadline overrideValue={scrubValue} masked={masked} size={headlineSize} />
          {stacked ? (
            <TimeframeControls value={timeframe} onChange={setTimeframe} compact className="mt-4" />
          ) : null}
        </div>
        {stacked ? null : (
          <div className="absolute right-0 top-1/2 -translate-y-1/2">
            <TimeframeControls value={timeframe} onChange={setTimeframe} />
          </div>
        )}
      </div>

      {/* The plot takes whatever height the card has left — drag the card
          taller and the chart grows, not a band of white above it. */}
      <div className="mt-2 flex min-h-0 min-w-0 flex-col">
        <PortfolioChart timeframe={timeframe} showGrowth showSp500 fill onScrub={setScrubValue} />
      </div>
      </>
      )}
    </div>
  );
}
