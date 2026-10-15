import { useMemo } from "react";
import { useSay } from "@/components/earnings/earnings-ui";
import { useGuidancePeek } from "@/components/stock-tab/use-guidance";
import { useTabActive } from "@/components/stock-tab/use-tab-active";
import { useEstimateRevisions } from "@/lib/estimates-store";
import { useImpliedMoves } from "@/lib/implied-move-store";
import { useHeldPositions, useReadthroughRadar } from "@/lib/readthrough-store";
import { openStock } from "@/lib/stock-open";
import type { CalEvent } from "./calendar-model";
import { earningsFacts, earningsTarget, type EarningsTarget } from "./earnings-facts";
import { useWatchlistTickers } from "./use-calendar-data";

/**
 * An earnings date's figures on its card (earnings-facts.ts says which and
 * from where), read through the same stores the Earnings and Stock tabs use,
 * so an answer either already holds is shown at once. Nothing is drawn
 * until a line has something to say, and every ask stops while the Calendar
 * tab is behind another one.
 */
export default function EarningsFacts({ event, today, onClose }: { event: CalEvent; today: string; onClose: () => void }) {
  const target = useMemo(() => earningsTarget(event, today), [event, today]);
  return target ? <Facts target={target} onClose={onClose} /> : null;
}

const NONE: never[] = [];

function Facts({ target, onClose }: { target: EarningsTarget; onClose: () => void }) {
  const { say, lang, t } = useSay();
  const active = useTabActive();
  const impliedAsk = useMemo(() => (active && target.impliedAsk ? [target.impliedAsk] : NONE), [active, target.impliedAsk]);
  const implied = useImpliedMoves(impliedAsk)[target.ticker] ?? null;
  const estimates = useEstimateRevisions(active && target.upcoming ? [target.ticker] : NONE)[target.ticker] ?? null;
  // The radar the dashboard card and the Earnings tab ask, for the same names: one shared answer.
  const held = useHeldPositions();
  const watchlist = useWatchlistTickers();
  const radar = useReadthroughRadar(active && held.length > 0 ? held : NONE, active && held.length > 0 ? watchlist : NONE);
  // What this run holds, else main's disk: never a full read from here.
  const guidance = useGuidancePeek(active ? target.ticker : null);

  const lines = earningsFacts(target, { implied, estimates, guidance, readthrough: radar.value?.rows ?? null }, say, lang);
  if (lines.length === 0) return null;
  return (
    <div className="mt-3 border-t border-black/[0.06] pl-[20px] pt-2.5">
      <ul className="space-y-1">
        {lines.map((line) => (
          <li key={line.id} data-selectable title={line.hint} className="select-text text-[12px] leading-[1.45] text-[#4b5563]">
            {line.text}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={() => {
          openStock(target.ticker);
          onClose();
        }}
        className="app-no-drag mt-2 text-[12px] font-medium text-[#1d1b1b] underline-offset-2 transition-colors hover:underline"
      >
        {t("calendar.detail.openInStockTab")}
      </button>
    </div>
  );
}
