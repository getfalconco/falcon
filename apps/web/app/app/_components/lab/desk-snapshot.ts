"use client";

import { cardExplain, type SightingsFeed } from "@falcon/ripple";
import { describeFilterToken, type AppContext } from "@/lib/desk/app-actions";
import type { SplitState, WorkspaceLayout } from "@/lib/workspace/layout";
import { readGraphFilters } from "./app-bridge";

/**
 * What the member is looking at, for Falcon AI (lib/desk/app-actions.ts
 * AppContext). The subject is the view on screen beside the Desk, or the last
 * view before the member switched to the Desk.
 */
export function deskSnapshot(
  s: { layout: WorkspaceLayout; primary: string | null; split: SplitState | null; describe: (t: string | null) => string; feed: SightingsFeed | null; portfolioTickers: readonly string[] },
  lastView: string | null,
  scope: string,
): AppContext {
  const isDesk = (t: string | null | undefined) => !!t && t.startsWith("strategy:");
  const name = (t: string | null) => (isDesk(t) ? "Falcon AI (research chat)" : s.describe(t));
  const onScreen = [s.primary, s.split?.other ?? null].filter((t): t is string => !!t && !isDesk(t) && t !== "help");
  const subject = onScreen[0] ?? lastView;
  const out: AppContext = {};
  if (s.primary) out.view = name(s.primary);
  if (s.split?.other) out.beside = name(s.split.other);
  if (!onScreen.length && subject) out.view = `${out.view ?? "Falcon AI"}; viewed just before: ${s.describe(subject)}`;
  out.tabs = s.layout.tabs.map((t) => (t.kind === "ticker" ? t.ticker : t.kind === "sighting" ? `sighting ${t.title ?? ""}`.trim() : t.kind === "strategy" ? "Falcon AI" : t.kind)).slice(0, 12);

  const filters = readGraphFilters(scope);
  const company = filters.find((f) => f.field === "company" && f.values.length === 1)?.values[0];
  if (subject?.startsWith("ticker:")) out.ticker = subject.slice(7);
  else if (subject?.startsWith("sighting:")) {
    const id = subject.slice(9);
    const card = s.feed?.cards.find((c) => c.id === id);
    if (card) {
      out.ticker = card.event.ticker;
      out.sighting = { id, title: cardExplain(card).title, ticker: card.event.ticker };
    }
  } else if (subject === "graph" && company) out.ticker = company;
  if (subject === "graph" || onScreen.includes("graph")) {
    if (filters.length) out.graphFilters = filters.map(describeFilterToken);
    if (company) out.graphTicker = company;
  }
  if (s.portfolioTickers.length) out.focus = s.portfolioTickers.slice(0, 200);
  return out;
}
