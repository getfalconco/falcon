import { useState, type ReactNode } from "react";
import ChartCardHeader from "@/components/dashboard/ChartCardHeader";
import { useHeldTickers, useWatchlistTickers } from "@/components/calendar/use-calendar-data";
import { SKELETON, useSay } from "@/components/earnings/earnings-ui";
import { useInsiderActivity } from "@/lib/insiders-store";
import { openStock } from "@/lib/stock-open";
import { cn } from "@/lib/utils";
import type { InsiderEvent } from "../../../shared/insider-types";
import { cardEvents, displayName, eventDate, eventSpan, eventTitle, pathText, safeSecUrl, tradeLine } from "../../../shared/insider-view";

type Props = {
  onDuplicate?: () => void;
  onRemove?: () => void;
};

/** How many events the card lists; the list scrolls past the card's height. */
const ROWS = 12;

function Skeleton() {
  return (
    <div className="space-y-4 pt-1" aria-hidden>
      {["w-[78%]", "w-[66%]", "w-[72%]", "w-[60%]", "w-[70%]"].map((w) => (
        <div key={w} className={cn(SKELETON, "h-3", w)} />
      ))}
    </div>
  );
}

function Quiet({ children, tone = "text-[#9CA3AF]" }: { children: ReactNode; tone?: string }) {
  return <p className={cn("flex flex-1 items-center justify-center px-4 text-center text-[13px] leading-[1.5]", tone)}>{children}</p>;
}

/** A sec.gov link set as quiet text; nothing when the address is not on sec.gov. */
function SecLink({ url, label, title }: { url: string | null; label: string; title: string }) {
  const safe = safeSecUrl(url);
  if (!safe) return null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void window.meridian?.openExternal(safe);
      }}
      title={title}
      aria-label={title}
      className="app-no-drag shrink-0 text-[#9CA3AF] underline-offset-2 outline-none hover:text-[#4b5563] hover:underline focus-visible:underline"
    >
      {label}
    </button>
  );
}

/** What sits under an opened row: the link that brings the company in, each trade or the filing, each with its form. */
function Detail({ event }: { event: InsiderEvent }) {
  const { say, lang, t } = useSay();
  const path = pathText(event, say);
  return (
    <div className="space-y-1 pb-1.5 pl-[68px] pr-1 text-[11.5px] leading-[1.45] text-[#6b7280]">
      {path && event.via ? (
        <p className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{path}</span>
          <span aria-hidden>·</span>
          <SecLink url={event.via.sourceUrl} label={t("insiders.detail.filing")} title={t("insiders.detail.openLink", { ticker: event.ticker, holding: event.via.holding })} />
        </p>
      ) : null}
      {event.trades.map((trade) => (
        <p key={`${trade.accession}:${trade.code}`} className="flex min-w-0 items-center gap-1.5 tabular-nums">
          <span className="min-w-0 truncate">{tradeLine(trade, say, lang)}</span>
          <span aria-hidden>·</span>
          <SecLink url={trade.url} label={t("insiders.detail.form4")} title={t("insiders.detail.openForm4", { name: displayName(trade.name) })} />
        </p>
      ))}
      {event.filing ? (
        <p className="flex min-w-0 items-center gap-1.5 tabular-nums">
          <span className="truncate">{eventSpan(event, say, lang)}</span>
          <span aria-hidden>·</span>
          <SecLink url={event.filing.url} label={event.filing.form} title={t("insiders.detail.openFiling", { form: event.filing.form })} />
        </p>
      ) : null}
    </div>
  );
}

/**
 * Insider activity on the dashboard: clusters of insider purchases, unplanned
 * sales by the CEO or CFO, and new 13D and 13G filings, at the reader's names
 * and at the companies their filings link them to, most significant first
 * (main/insiders/detect.ts). One line per event: ticker, what was filed,
 * date. A row opens to the trades and the forms behind it; the arrow opens
 * the chosen row's company (the top one until a row is chosen) in the Stock
 * tab.
 */
export default function InsidersCard({ onDuplicate, onRemove }: Props) {
  const { say, lang, t } = useSay();
  const held = useHeldTickers();
  const watchlist = useWatchlistTickers();
  const none = held.length === 0 && watchlist.length === 0;
  const state = useInsiderActivity(none ? null : { held, watchlist });
  const answer = state.value;
  const events = answer ? cardEvents(answer.events, ROWS) : [];
  const [openId, setOpenId] = useState<string | null>(null);
  const chosen = events.find((e) => e.id === openId) ?? events[0] ?? null;

  let body: ReactNode;
  if (none) body = <Quiet>{t("insiders.card.noNames")}</Quiet>;
  else if (!answer && state.error !== null) {
    body = <Quiet tone="text-[#6b7280]">{state.error === "restart" ? t("insiders.error.restart") : t("insiders.card.failed")}</Quiet>;
  } else if (!answer) body = <Skeleton />;
  else if (events.length === 0 && answer.pending > 0) {
    body = <Quiet>{answer.pending === 1 ? t("insiders.card.readingOne") : t("insiders.card.reading", { count: answer.pending })}</Quiet>;
  } else if (events.length === 0) body = <Quiet>{t("insiders.card.empty")}</Quiet>;
  else {
    body = (
      <ul className="scrollbar-meridian -mx-2 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-2">
        {events.map((event) => {
          const open = event.id === openId;
          const path = pathText(event, say);
          const title = eventTitle(event, say, lang);
          return (
            <li key={event.id} className={cn("rounded-xl transition-colors", open ? "bg-black/[0.04]" : "hover:bg-black/[0.04]")}>
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setOpenId(open ? null : event.id)}
                // The whole line on hover too, since a closed row truncates it.
                title={path ? `${title}\n${path}` : title}
                className="app-no-drag flex w-full min-w-0 items-baseline gap-3 rounded-xl px-2 py-2 text-left outline-none focus-visible:bg-black/[0.05]"
              >
                <span className="w-12 shrink-0 truncate text-[12.5px] font-medium text-[#1d1b1b]">{event.ticker}</span>
                <span className={cn("min-w-0 flex-1 text-[12.5px] leading-[1.4] text-[#1d1b1b]", !open && "truncate")}>{title}</span>
                <span className="shrink-0 text-[12px] tabular-nums text-[#9CA3AF]">{eventDate(event, lang)}</span>
              </button>
              {open ? <Detail event={event} /> : null}
            </li>
          );
        })}
      </ul>
    );
  }

  const footer =
    answer && !none ? (
      <p className="shrink-0 pt-3 text-[11px] leading-[1.4] text-[#9CA3AF]">
        {t("insiders.card.source")}
        {answer.pending > 0 && events.length > 0 ? ` · ${t("insiders.card.readingMore", { count: answer.pending })}` : ""}
      </p>
    ) : null;

  return (
    <div className="flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      <ChartCardHeader
        label={t("insiders.card.label")}
        onDuplicate={onDuplicate}
        onRemove={onRemove}
        onOpen={chosen ? () => openStock(chosen.ticker) : undefined}
        openLabel={chosen ? t("insiders.card.view", { ticker: chosen.ticker }) : undefined}
      />
      <div className="flex min-h-0 flex-1 flex-col pt-4">{body}</div>
      {footer}
    </div>
  );
}
