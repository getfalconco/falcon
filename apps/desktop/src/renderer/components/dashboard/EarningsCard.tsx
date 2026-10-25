import type { ReactNode } from "react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import { useHeldTickers, useWatchlistTickers } from "@/components/calendar/use-calendar-data";
import { RowBadges, SKELETON, TickerButton, useSay } from "@/components/earnings/earnings-ui";
import EarningsLogo from "@/components/earnings/EarningsLogo";
import { EARNINGS_DAYS, useEarnings, useProfileSectors } from "@/lib/earnings-store";
import { cn } from "@/lib/utils";
import { cardRows, countdownLine, dayDate, nyToday, reportedLine, shortCompanyName } from "../../../shared/earnings-view";

type Props = {
  onDuplicate?: () => void;
  onRemove?: () => void;
  /** View Earnings: opens the home screen's Earnings tab. */
  onOpenEarnings?: () => void;
};

/** How many reports the card lists. */
const ROWS = 6;

function Skeleton() {
  return (
    <div className="space-y-5 pt-1" aria-hidden>
      {["w-[70%]", "w-[56%]", "w-[64%]", "w-[50%]"].map((w) => (
        <div key={w} className="space-y-1.5">
          <div className={cn(SKELETON, "h-3", w)} />
          <div className={cn(SKELETON, "h-2.5 w-[34%]")} />
        </div>
      ))}
    </div>
  );
}

/**
 * Earnings on the dashboard: the next reports of the names the reader holds
 * and watches, then, when those are fewer than the card holds, the rest of
 * the "For you" list, as a countdown ("NVDA reports in 12 days"), each with its day
 * and whether the date is the company's or an estimate. The ticker opens the
 * stock; View Earnings opens the tab, as View Calendar does for the calendar.
 * It shares the tab's answer (lib/earnings-store), so neither asks twice.
 */
export default function EarningsCard({ onDuplicate, onRemove, onOpenEarnings }: Props) {
  const { say, lang, t } = useSay();
  const held = useHeldTickers();
  const watchlist = useWatchlistTickers();
  const sectors = useProfileSectors();
  // The tab's default answer: the reader's names first, then the rest of "For you" to fill the card.
  const state = useEarnings("foryou", held, watchlist, sectors);
  const answer = state.value;
  const today = answer?.today ?? nyToday();
  const rows = answer ? cardRows(answer.rows, today, ROWS) : [];
  const none = held.length === 0 && watchlist.length === 0 && answer !== undefined && rows.length === 0;

  let body: ReactNode;
  if (none) {
    body = <p className="flex flex-1 items-center justify-center px-4 text-center text-[13px] leading-[1.5] text-content-tertiary">{t("earnings.card.noNames")}</p>;
  } else if (!answer && state.error !== null) {
    body = (
      <p className="flex flex-1 items-center justify-center px-4 text-center text-[13px] leading-[1.5] text-content-secondary">
        {state.error === "restart" ? t("earnings.error.restart") : t("earnings.card.failed")}
      </p>
    );
  } else if (!answer) {
    body = <Skeleton />;
  } else {
    body =
      rows.length === 0 ? (
        <p className="flex flex-1 items-center justify-center px-4 text-center text-[13px] leading-[1.5] text-content-tertiary">{t("earnings.card.empty", { count: EARNINGS_DAYS })}</p>
      ) : (
        <ul className="scrollbar-meridian -mx-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
          {rows.map((row) => (
            <li key={row.ticker} className="flex items-center gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-ink/[0.04]">
              <span className="flex w-[86px] shrink-0 items-center gap-1.5">
                <EarningsLogo ticker={row.ticker} />
                <TickerButton row={row} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] leading-[1.4] text-content-primary">
                  {row.phase === "reported" ? reportedLine(row, today, say, lang) : countdownLine(row, today, say, lang)}
                </span>
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  <span className="truncate text-[11.5px] text-content-tertiary" title={row.company ?? undefined}>
                    {dayDate(row.date, lang)}
                    {row.company ? ` · ${shortCompanyName(row.company)}` : ""}
                  </span>
                  <RowBadges row={{ ...row, held: false, watchlist: false }} />
                </span>
              </span>
            </li>
          ))}
        </ul>
      );
  }

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      <ChartCardHeader
        label={t("earnings.card.label")}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        onOpen={onOpenEarnings}
        openLabel={t("earnings.card.view")}
      />
      <div className="flex min-h-0 flex-1 flex-col pt-4">
        {body}
      </div>
    </div>
  );
}
