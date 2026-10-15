import { repairArticleText, repairMojibake } from "@meridian/research/news";

/**
 * The news feed's text, repaired on its way into this process: a provider
 * summary that arrived as mojibake ("weekâ€™s" for "week's") is fixed before
 * the feed cache keeps it or the renderer shows it. The engine repairs at
 * ingestion too; this covers an engine that does not yet, and rows it filed
 * before it did. Anything that is not an ok feed answer passes through as is.
 */
export function repairFeedText(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as { ok?: unknown; articles?: unknown };
  if (v.ok !== true || !Array.isArray(v.articles)) return value;
  return {
    ...v,
    articles: v.articles.map((a: unknown) => (a && typeof a === "object" ? repairArticleText(a as Record<string, unknown>) : a)),
  };
}

/**
 * Stored material events, repaired on the way to the renderer: an event filed
 * before ingestion repaired provider mojibake still carries the raw headline
 * (and a summary written from it). Anything that is not an ok events answer
 * passes through as is.
 */
export function repairEventsText(value: unknown): unknown {
  if (!value || typeof value !== "object") return value;
  const v = value as { ok?: unknown; events?: unknown };
  if (v.ok !== true || !Array.isArray(v.events)) return value;
  return {
    ...v,
    events: v.events.map((e: unknown) => {
      if (!e || typeof e !== "object") return e;
      const row = e as { headline?: unknown; summary?: unknown };
      return {
        ...row,
        ...(typeof row.headline === "string" ? { headline: repairMojibake(row.headline) } : {}),
        ...(typeof row.summary === "string" ? { summary: repairMojibake(row.summary) } : {}),
      };
    }),
  };
}
