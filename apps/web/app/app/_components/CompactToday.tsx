"use client";

import { NOTHING_CLEARED, type RippleCard } from "@falcon/ripple";
import { useWorkspace } from "./context";
import { FeedNotice } from "./FeedNotice";
import { EmptyState, SectionTitle, feedEmpty } from "./parts";
import { ExplainSections, SightingCardBody, SightingSources, useExplain } from "./explain";
import { TodayHeader, useNothingCleared, usePortfolioEmptyTitle, useToday } from "./tabs/DashboardTab";
import BrandMark from "../../components/BrandMark";

/** A card that opens in place on a phone instead of in a tab. */
function CompactCard({ card, focusSet }: { card: RippleCard; focusSet: Set<string> }) {
  const ex = useExplain(card);
  return (
    <details className="group rounded-lg border border-black/[0.08] bg-white px-4 py-3.5 [&_summary::-webkit-details-marker]:hidden">
      <summary className="cursor-pointer list-none outline-none">
        <SightingCardBody
          card={card}
          highlight={focusSet}
          maxHits={4}
          interactive={false}
          footer={<span className="shrink-0 text-[12px] text-[#767676] group-open:hidden">Read more</span>}
        />
      </summary>
      <div className="mt-4 flex flex-col gap-5 border-t border-black/[0.06] pt-4">
        <ExplainSections ex={ex} />
        <section>
          <h2 className="text-[13px] font-medium text-[#1d1b1b]">Sources</h2>
          <div className="mt-2">
            <SightingSources card={card} ex={ex} />
          </div>
        </section>
      </div>
    </details>
  );
}

/** Below about 1024px: the Today screen, one column, as on the phone. */
export function CompactToday() {
  const { focusSet, feedStatus } = useWorkspace();
  const summary = useToday();
  const nothingCleared = useNothingCleared();
  const portfolioEmpty = usePortfolioEmptyTitle();
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
              <EmptyState title={portfolioEmpty} />
            )}
          </div>
        </section>
        <section>
          <SectionTitle count={summary.opportunities.length}>Opportunities</SectionTitle>
          <div className="mt-2 flex flex-col gap-3">
            {summary.opportunities.length ? (
              summary.opportunities.slice(0, 2).map((c) => <CompactCard key={c.id} card={c} focusSet={focusSet} />)
            ) : (
              <EmptyState title={feedEmpty(feedStatus, nothingCleared ? NOTHING_CLEARED : "No opportunities right now")} />
            )}
          </div>
        </section>
        <p className="text-center text-[12px] text-[#9a9a9a]">The full workspace opens on a wider screen</p>
      </div>
    </div>
  );
}
