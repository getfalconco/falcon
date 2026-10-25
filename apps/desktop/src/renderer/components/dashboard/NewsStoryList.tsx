import StockIcon from "@/components/stock/StockIcon";
import { cn } from "@/lib/utils";
import { useI18n } from "@/lib/i18n";
import { agoLabel } from "@/lib/dashboard-dates";
import { eventTypeLabel } from "@/lib/event-type-labels";
import { storyTickers, storyTitle, type CuratedStory } from "@/lib/news-curation";

/** Names shown per story before the rest fold into "+n". */
const TICKERS_SHOWN = 4;

/**
 * The News card's rows: Falcon's headline as the title (never the
 * publisher's), then source, age and, for a story that moves its lead name
 * one way, the event type in that direction's colour, then the names it is
 * material for. Kept apart from the card so it renders (and tests) on its own.
 */
export default function NewsStoryList({
  stories,
  now,
  onOpen,
}: {
  stories: readonly CuratedStory[];
  now: number;
  onOpen: (story: CuratedStory) => void;
}) {
  const { t, locale } = useI18n();
  return (
    <ul className="flex flex-col">
      {stories.map((a) => {
        const names = storyTickers(a);
        const extra = names.length - TICKERS_SHOWN;
        const dir = a.falcon.direction;
        return (
          <li key={a.id} className="border-b-[0.5px] border-black/[0.06] last:border-b-0">
            <button
              type="button"
              onClick={() => onOpen(a)}
              className="app-no-drag group block w-full py-2.5 text-left"
            >
              <p className="line-clamp-2 text-[13px] font-medium leading-snug text-content-primary underline-offset-[3px] group-hover:underline">
                {storyTitle(a)}
              </p>
              <div className="mt-1 flex items-center gap-1.5 text-[11px] text-content-tertiary">
                {a.source ? <span className="truncate">{a.source}</span> : null}
                {a.source ? <span aria-hidden>·</span> : null}
                <span className="shrink-0 tabular-nums">{agoLabel(a.datetime, now, locale, t("dashboard.news.justNow"))}</span>
                {a.falcon.event_type && (dir === "positive" || dir === "negative") ? (
                  <>
                    <span aria-hidden>·</span>
                    <span className={cn("shrink-0 font-medium", dir === "positive" ? "text-tone-positive" : "text-tone-negative")}>
                      {eventTypeLabel(a.falcon.event_type, t)}
                    </span>
                  </>
                ) : null}
              </div>
              {names.length > 0 ? (
                <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                  {names.slice(0, TICKERS_SHOWN).map((name) => (
                    <span
                      key={name}
                      className="flex items-center gap-1 rounded-full bg-black/[0.04] py-0.5 pl-0.5 pr-2 text-[11px] font-semibold text-content-primary"
                    >
                      <span className="flex h-4 w-4 items-center justify-center overflow-hidden rounded-full bg-white">
                        <StockIcon symbol={name} size="sm" className="h-3 w-3 object-contain" />
                      </span>
                      {name}
                    </span>
                  ))}
                  {extra > 0 ? <span className="text-[11px] text-content-tertiary">+{extra}</span> : null}
                </div>
              ) : null}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
