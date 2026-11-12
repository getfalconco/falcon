"use client";

import type { RippleCard } from "@falcon/ripple";
import { useWorkspace } from "./context";
import { FeedNotice } from "./FeedNotice";
import { DirectionMark, EmptyState, KindLabel, MONO, SectionTitle, feedEmpty, timeAgo } from "./parts";
import { TodayHeader, useToday } from "./tabs/DashboardTab";
import BrandMark from "../../components/BrandMark";

/** A card that opens in place on a phone instead of in a tab. */
function CompactCard({ card, focusSet }: { card: RippleCard; focusSet: Set<string> }) {
  const hits = [...card.hits].sort((a, b) => Number(focusSet.has(b.ticker)) - Number(focusSet.has(a.ticker)));
  return (
    <details className="group rounded-lg border border-black/[0.08] bg-white px-4 py-3.5 [&_summary::-webkit-details-marker]:hidden">
      <summary className="cursor-pointer list-none outline-none">
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
            {card.event.ticker}
          </span>
          <KindLabel kind={card.event.kind} />
          <span className="ml-auto text-[12px] text-[#9a9a9a]">{timeAgo(card.event.occurredAt)}</span>
        </div>
        <h3 className="mt-2 text-[15px] leading-[21px] text-[#1d1b1b]">{card.event.headline}</h3>
        <ul className="mt-3 flex flex-col gap-1.5 border-t border-black/[0.06] pt-3">
          {hits.slice(0, 3).map((h) => (
            <li key={h.ticker} className="flex items-center gap-3 text-[13px]">
              <span className="w-12 text-[12px] text-[#1d1b1b]" style={{ fontFamily: MONO }}>
                {h.ticker}
              </span>
              <span className="min-w-0 flex-1 truncate text-[#767676]">{h.companyName}</span>
              <DirectionMark direction={h.direction} />
            </li>
          ))}
        </ul>
      </summary>
      <div className="mt-3 flex flex-col gap-3 border-t border-black/[0.06] pt-3">
        <p className="text-[13px] leading-[20px] text-[#4b4b48]">{card.event.summary}</p>
        {hits.map((h) => (
          <p key={h.ticker} className="text-[13px] leading-[20px] text-[#4b4b48]">
            <span className="text-[#1d1b1b]" style={{ fontFamily: MONO }}>
              {h.ticker}{" "}
            </span>
            {h.mechanism}
          </p>
        ))}
      </div>
    </details>
  );
}

/** Below about 1024px: the Today screen, one column, as on the phone. */
export function CompactToday() {
  const { focusSet, feedStatus, focus } = useWorkspace();
  const summary = useToday();
  return (
    <div className="min-h-[100dvh] bg-[#fdfdfd]">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-5 pb-12 pt-5">
        <div className="flex items-center gap-2">
          <BrandMark size={20} />
          <span className="text-[14px] text-[#1d1b1b]">Falcon</span>
        </div>
        <FeedNotice />
        <TodayHeader compact />
        <section>
          <SectionTitle count={summary.portfolio.length}>Hitting your portfolio</SectionTitle>
          <div className="mt-2 flex flex-col gap-3">
            {summary.portfolio.length ? (
              summary.portfolio.slice(0, 3).map((c) => <CompactCard key={c.id} card={c} focusSet={focusSet} />)
            ) : (
              <EmptyState title={feedEmpty(feedStatus, focus.length ? "Nothing is hitting your portfolio" : "Your focus list is empty")} />
            )}
          </div>
        </section>
        <section>
          <SectionTitle count={summary.opportunities.length}>Opportunities</SectionTitle>
          <div className="mt-2 flex flex-col gap-3">
            {summary.opportunities.length ? (
              summary.opportunities.slice(0, 2).map((c) => <CompactCard key={c.id} card={c} focusSet={focusSet} />)
            ) : (
              <EmptyState title={feedEmpty(feedStatus, "No opportunities right now")} />
            )}
          </div>
        </section>
        <p className="text-center text-[12px] text-[#9a9a9a]">The full workspace opens on a wider screen</p>
      </div>
    </div>
  );
}
