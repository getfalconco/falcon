"use client";

import { useMemo } from "react";
import { NOTHING_CLEARED, type RippleCard } from "@falcon/ripple";
import { useWorkspace } from "./context";
import { FeedNotice } from "./FeedNotice";
import { EmptyState, SectionTitle, feedEmpty } from "./parts";
import { ExplainSections, SightingCardBody, SightingSources, useExplain } from "./explain";
import { EVIDENCE_TITLES, LATEST_ROWS, TodayHeader, latestMix, useNothingCleared, usePortfolioEmptyTitle, useToday } from "./tabs/DashboardTab";
import BrandMark from "../../components/BrandMark";

/** A card that opens in place on a phone instead of in a tab. */
function CompactCard({ card, focusSet }: { card: RippleCard; focusSet: Set<string> }) {
  const ex = useExplain(card);
  return (
    <details className="group rounded-lg border border-line/[0.08] bg-surface px-4 py-3.5 [&_summary::-webkit-details-marker]:hidden">
      <summary className="cursor-pointer list-none outline-none">
        <SightingCardBody
          card={card}
          highlight={focusSet}
          maxHits={4}
          interactive={false}
          footer={<span className="shrink-0 text-fs-12 text-quiet group-open:hidden">Read more</span>}
        />
      </summary>
      <div className="mt-4 flex flex-col gap-5 border-t border-line/[0.06] pt-4">
        <ExplainSections ex={ex} />
        <section>
          <h2 className="text-fs-13 font-medium text-fore">Sources</h2>
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
  const { feed, focusSet, feedStatus } = useWorkspace();
  const summary = useToday();
  const nothingCleared = useNothingCleared();
  const portfolioEmpty = usePortfolioEmptyTitle();
  const portfolio = useMemo(() => summary.portfolio.slice(0, 3), [summary]);
  const opportunities = useMemo(() => summary.opportunities.slice(0, 2), [summary]);
  // Every event type and strength level, newest first; cards already shown above are not repeated.
  const latest = useMemo(() => {
    const shown = new Set([...portfolio, ...opportunities].map((c) => c.id));
    return latestMix((feed?.cards ?? []).filter((c) => !shown.has(c.id)), LATEST_ROWS - shown.size);
  }, [feed, portfolio, opportunities]);
  return (
    <div className="min-h-[100dvh] bg-canvas">
      <div className="mx-auto flex w-full max-w-[560px] flex-col gap-6 px-5 pb-12 pt-5">
        <div className="flex items-center gap-2">
          <BrandMark size={20} />
          <span className="text-fs-14 text-fore">Falcon</span>
        </div>
        <FeedNotice />
        <TodayHeader compact />
        <section>
          <SectionTitle count={summary.portfolio.length}>{EVIDENCE_TITLES.portfolio}</SectionTitle>
          <div className="mt-2 flex flex-col gap-3">
            {portfolio.length ? (
              portfolio.map((c) => <CompactCard key={c.id} card={c} focusSet={focusSet} />)
            ) : (
              <EmptyState title={portfolioEmpty} />
            )}
          </div>
        </section>
        <section>
          <SectionTitle count={summary.opportunities.length}>{EVIDENCE_TITLES.opportunities}</SectionTitle>
          <div className="mt-2 flex flex-col gap-3">
            {opportunities.length ? (
              opportunities.map((c) => <CompactCard key={c.id} card={c} focusSet={focusSet} />)
            ) : (
              <EmptyState title={feedEmpty(feedStatus, nothingCleared ? NOTHING_CLEARED : "No opportunities right now")} />
            )}
          </div>
        </section>
        {latest.length ? (
          <section>
            <SectionTitle count={feed?.cards.length ?? 0}>Latest sightings</SectionTitle>
            <div className="mt-2 flex flex-col gap-3">
              {latest.map((c) => (
                <CompactCard key={c.id} card={c} focusSet={focusSet} />
              ))}
            </div>
          </section>
        ) : null}
        <p className="text-center text-fs-12 text-faint">The full workspace opens on a wider screen</p>
      </div>
    </div>
  );
}
