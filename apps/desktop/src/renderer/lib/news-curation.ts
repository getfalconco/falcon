import type { NewsFeedArticle } from "../../shared/news-feed";

/**
 * What the News card lists, decided from the engine's `falcon` field on each
 * story (packages/research/src/news/curation.ts holds the threshold and its
 * documentation). The card shows a story only when the engine said "show" and
 * gave it a title: Falcon's headline, or for a filing or press release a
 * neutral line built from the filing type and company. Everything else
 * (unclassified, low or no materiality, roundups, recaps, repeats of an
 * event already listed) stays off the card.
 *
 * A story with no `falcon` field comes from an engine older than this rule.
 * It is held back too: the publisher's headline is never a row title, and an
 * unread story has no verdict to clear the bar with.
 *
 * The Market, Sector and Positions views and the search all run over this
 * curated set, never over the raw feed.
 */

export type CuratedStory = NewsFeedArticle & {
  falcon: NonNullable<NewsFeedArticle["falcon"]> & { headline: string };
};

export function isCurated(a: NewsFeedArticle): a is CuratedStory {
  return a.falcon?.decision === "show" && typeof a.falcon.headline === "string" && a.falcon.headline.trim() !== "";
}

/** The stories the card may show, in the feed's order (newest first). */
export function curatedStories(articles: readonly NewsFeedArticle[]): CuratedStory[] {
  return articles.filter(isCurated);
}

/** The row title: always Falcon's line. */
export function storyTitle(a: CuratedStory): string {
  return a.falcon.headline.trim();
}

/** The names a story is about: the ones it is material for, else (a primary source) the ones it was filed under. */
export function storyTickers(a: Pick<NewsFeedArticle, "tickers" | "falcon">): string[] {
  const out: string[] = [];
  const source = a.falcon && a.falcon.tickers.length > 0 ? a.falcon.tickers : a.tickers;
  for (const t of source) {
    const name = t.trim().toUpperCase();
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

export type StoryScope = "market" | "sector" | "positions";

/**
 * One view of the curated set. Positions keeps stories material for a held
 * name; Sector, stories whose names sit in the sector; the search matches
 * Falcon's title, the summary, the source and the names (not the publisher's
 * headline, which the row does not show).
 */
export function storiesInView(
  stories: readonly CuratedStory[],
  view: { scope: StoryScope; sector: string | null; held: readonly string[]; query: string },
): CuratedStory[] {
  const heldSet = new Set(view.held.map((t) => t.toUpperCase()));
  const needle = view.query.trim().toLowerCase();
  return stories.filter((a) => {
    const names = storyTickers(a);
    if (view.scope === "positions" && !names.some((t) => heldSet.has(t))) return false;
    if (view.scope === "sector" && view.sector && !a.sectors.includes(view.sector)) return false;
    if (!needle) return true;
    return (
      storyTitle(a).toLowerCase().includes(needle) ||
      a.source.toLowerCase().includes(needle) ||
      a.summary.toLowerCase().includes(needle) ||
      names.some((t) => t.toLowerCase().includes(needle))
    );
  });
}
