import { Fragment, useEffect, useMemo, useState } from "react";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { agoLabel } from "@/lib/dashboard-dates";
import { useNewsFeed } from "@/lib/news-feed-store";
import { cn } from "@/lib/utils";
import NewsArticleModal from "@/components/dashboard/NewsArticleModal";
import { SKELETON } from "@/components/earnings/earnings-ui";
import { chainNews, type ChainNewsRow } from "../../../../shared/chain-news";
import type { LinkRole, StockGraph } from "../../../../shared/stock-graph";
import type { NewsFeedArticle } from "../../../../shared/news-feed";
import { nodeLabel } from "../graph/ego-layout";
import { useStockGraph } from "../graph/use-stock-graph";
import type { StockSectionProps } from "./types";

/**
 * Stock tab: news from the chain. Stories that do not name this stock but
 * reach it through its filing links in one or two hops, each with its path
 * ("TSM → supplier → NVDA"). The stories are the News card's own feed (the
 * cached `news:feed`), titled with Falcon's headline when the engine wrote
 * one; the paths are the filing graph's (`stock:graph`). A row opens the
 * article panel the News card uses.
 */

const ROLE_KEY: Record<LinkRole, MessageKey> = {
  supplier: "stocktab.chain.role.supplier",
  customer: "stocktab.chain.role.customer",
  competitor: "stocktab.chain.role.competitor",
  partner: "stocktab.chain.role.partner",
  dependency: "stocktab.chain.role.dependency",
  dependent: "stocktab.chain.role.dependent",
};

function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(id);
  }, [intervalMs]);
  return now;
}

function labelOf(graph: StockGraph, id: string): string {
  const node = graph.nodes.find((n) => n.id === id);
  return nodeLabel(node?.ticker ?? null, node?.name ?? id);
}

function Path({ row, graph }: { row: ChainNewsRow; graph: StockGraph }) {
  const { t } = useI18n();
  const parts = row.path.nodes.map((id) => labelOf(graph, id));
  const roles = row.path.steps.map((s) => t(ROLE_KEY[s.role]));
  const text = parts.flatMap((p, i) => (i < roles.length ? [p, roles[i]!] : [p])).join(" → ");
  return (
    <span className="flex shrink-0 items-center gap-1 text-[11.5px] text-content-secondary" title={t("stocktab.chain.path", { path: text })}>
      {parts.map((p, i) => (
        <Fragment key={i}>
          <span className={cn(i === 0 ? "font-medium text-content-body" : "", i === parts.length - 1 && "text-content-tertiary")}>{p}</span>
          {i < roles.length ? (
            <>
              <span aria-hidden className="text-content-tertiary">→</span>
              <span>{roles[i]}</span>
              <span aria-hidden className="text-content-tertiary">→</span>
            </>
          ) : null}
        </Fragment>
      ))}
    </span>
  );
}

export default function ChainNewsSection({ ticker }: StockSectionProps) {
  const { t, locale } = useI18n();
  const symbol = ticker.trim().toUpperCase();
  const graphState = useStockGraph(symbol);
  const feed = useNewsFeed();
  const now = useNow();
  const [open, setOpen] = useState<NewsFeedArticle | null>(null);

  const graph = graphState.status === "ready" ? graphState.graph : null;
  // Re-ranked when the feed or the graph changes, not on every clock tick.
  const rows = useMemo(
    () => (graph && feed.value ? chainNews(feed.value, graph, { now: Math.floor(Date.now() / 1000), limit: 10 }) : []),
    [graph, feed.value],
  );

  // No graph (never researched, or no bridge): the Graph section says so; nothing to add here.
  if (graphState.status === "unavailable") return null;
  if (graph && graph.links.length === 0) return null;

  if (graphState.status === "loading" || !feed.settled) {
    return (
      <div className="space-y-2" aria-hidden>
        {[0, 1, 2].map((i) => (
          <div key={i} className={cn(SKELETON, "h-4", i === 1 ? "w-3/4" : "w-5/6")} />
        ))}
      </div>
    );
  }

  if (rows.length === 0) {
    return <p className="py-1 text-[13px] text-content-secondary">{t("stocktab.chain.empty")}</p>;
  }

  return (
    <>
      <ul className="divide-y divide-black/[0.06]">
        {rows.map((row) => (
          <li key={row.article.id}>
            <button
              type="button"
              onClick={() => setOpen(row.article)}
              className="app-no-drag flex w-full min-w-0 cursor-pointer items-center gap-3 rounded-lg px-1 py-2 text-left outline-none transition-colors hover:bg-black/[0.03] focus-visible:bg-black/[0.04]"
            >
              <span className="min-w-0 flex-1 truncate text-[13px] text-content-primary" title={row.title}>
                {row.title}
              </span>
              {graph ? <Path row={row} graph={graph} /> : null}
              <span className="min-w-12 shrink-0 whitespace-nowrap text-right text-[11.5px] tabular-nums text-content-tertiary">
                {agoLabel(row.article.datetime, now, locale, t("stocktab.chain.justNow"))}
              </span>
            </button>
          </li>
        ))}
      </ul>
      <NewsArticleModal article={open} onClose={() => setOpen(null)} />
    </>
  );
}
