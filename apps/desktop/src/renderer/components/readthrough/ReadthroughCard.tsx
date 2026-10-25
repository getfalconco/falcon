import type { ReactNode } from "react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import { useWatchlistTickers } from "@/components/calendar/use-calendar-data";
import { SKELETON, useSay } from "@/components/earnings/earnings-ui";
import EarningsLogo from "@/components/earnings/EarningsLogo";
import { useHeldPositions, useReadthroughRadar } from "@/lib/readthrough-store";
import { cn } from "@/lib/utils";
import { nyToday } from "../../../shared/earnings-view";
import { cardRows, headLine, sinceLine, statsLine } from "../../../shared/readthrough-view";
import { LinkLine, NamePill } from "./readthrough-ui";

type Props = {
  onDuplicate?: () => void;
  onRemove?: () => void;
  /** Opens the Earnings tab at its Read-through section. */
  onOpenReadthrough?: () => void;
};

/** How many pairs the card lists. */
const ROWS = 4;

function Skeleton() {
  return (
    <div className="space-y-5 pt-1" aria-hidden>
      {["w-[70%]", "w-[58%]", "w-[64%]", "w-[52%]"].map((w) => (
        <div key={w} className="space-y-1.5">
          <div className={cn(SKELETON, "h-3", w)} />
          <div className={cn(SKELETON, "h-2.5 w-[46%]")} />
          <div className={cn(SKELETON, "h-2.5 w-[30%]")} />
        </div>
      ))}
    </div>
  );
}

function Quiet({ children, tone = "text-content-tertiary" }: { children: ReactNode; tone?: string }) {
  return <p className={cn("flex flex-1 items-center justify-center px-4 text-center text-[13px] leading-[1.5]", tone)}>{children}</p>;
}

/**
 * Read-through on the dashboard: the linked companies of the reader's names
 * that report soon or just did, ranked by how much the reader's name has
 * measurably moved on their past report days (weighted by the account), each
 * in plain words: "TSM reports Thu, Oct 16 · NVDA moved with it 6 of the
 * last 8 times · average 2.1% on the day". The arrow opens the Earnings
 * tab's Read-through section with every pair and the figures behind them.
 */
export default function ReadthroughCard({ onDuplicate, onRemove, onOpenReadthrough }: Props) {
  const { say, lang, t } = useSay();
  const held = useHeldPositions();
  const watchlist = useWatchlistTickers();
  const state = useReadthroughRadar(held, watchlist);
  const answer = state.value;
  const today = answer?.today ?? nyToday();
  const rows = answer ? cardRows(answer.rows, ROWS) : [];
  const none = held.length === 0 && watchlist.length === 0;

  let body: ReactNode;
  if (none) body = <Quiet>{t("readthrough.card.noNames")}</Quiet>;
  else if (!answer && state.error !== null) {
    body = <Quiet tone="text-content-secondary">{state.error === "restart" ? t("readthrough.error.restart") : t("readthrough.card.failed")}</Quiet>;
  } else if (!answer) body = <Skeleton />;
  else if (rows.length === 0) body = <Quiet>{answer.links === 0 ? t("readthrough.card.noLinks") : t("readthrough.card.empty")}</Quiet>;
  else {
    body = (
      <ul className="scrollbar-meridian -mx-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
        {rows.map((row) => {
          const since = sinceLine(row, say, lang);
          return (
            <li key={row.id} className="flex items-start gap-2.5 rounded-xl px-2 py-2 transition-colors hover:bg-ink/[0.04]">
              <span className="shrink-0 pt-px">
                <EarningsLogo ticker={row.counterparty} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[12.5px] leading-[1.4] text-content-primary">{headLine(row, today, say, lang)}</span>
                <span className={cn("mt-0.5 block text-[12px] leading-[1.4] tabular-nums", row.stats ? "text-content-body" : "text-content-tertiary")}>{statsLine(row, say, lang)}</span>
                {since ? <span className="block text-[12px] leading-[1.4] tabular-nums text-content-body">{since}</span> : null}
                <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
                  <LinkLine row={row} />
                  <NamePill row={row} />
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      <ChartCardHeader
        label={t("readthrough.card.label")}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        onOpen={onOpenReadthrough}
        openLabel={t("readthrough.card.view")}
      />
      <div className="flex min-h-0 flex-1 flex-col pt-4">{body}</div>
    </div>
  );
}
