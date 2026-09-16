import { requireSupabase } from "@/lib/supabase";

/**
 * Classified material news events and relationship-graph edges, both written to
 * Supabase by apps/news-worker (see packages/research/src/news/supabase-store.ts
 * and .../propagation/graph-supabase-store.ts). Read-only here.
 */

export type MaterialNewsEvent = {
  id: string;
  article_id: number;
  ticker: string;
  headline: string;
  source_url: string;
  source_urls: string[];
  article_datetime: number;
  classified_at: string;
  event_type: string;
  affected_ticker: string;
  direction_on_primary: string;
  summary: string;
  confidence: number;
  event_date: string;
};

const EVENT_COLUMNS =
  "id,article_id,ticker,headline,source_url,source_urls,article_datetime,classified_at," +
  "event_type,affected_ticker,direction_on_primary,summary,confidence,event_date";

export async function listNewsEvents(options?: {
  days?: number;
  ticker?: string;
  limit?: number;
}): Promise<MaterialNewsEvent[]> {
  const client = requireSupabase();
  const days = options?.days ?? 30;
  const sinceSec = Math.floor((Date.now() - days * 24 * 60 * 60 * 1000) / 1000);

  let query = client
    .from("material_news_events")
    .select(EVENT_COLUMNS)
    .gte("article_datetime", sinceSec)
    .order("article_datetime", { ascending: false })
    .limit(options?.limit ?? 200);

  if (options?.ticker) query = query.eq("ticker", options.ticker.toUpperCase());

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as MaterialNewsEvent[];
}

/* --------------------------------- graph --------------------------------- */

export type GraphEdge = {
  id: string;
  root_ticker: string;
  counterparty_id: string;
  counterparty_name: string;
  counterparty_ticker: string | null;
  category: string;
  subtype: string;
  confidence: number;
  strength: number | null;
  strength_tier: string | null;
  evidence_quote: string;
  source_url: string;
};

const EDGE_COLUMNS =
  "id,root_ticker,counterparty_id,counterparty_name,counterparty_ticker,category," +
  "subtype,confidence,strength,strength_tier,evidence_quote,source_url";

/** Edges where `ticker` is the root — i.e. who this company touches. */
export async function listEdgesFor(ticker: string): Promise<GraphEdge[]> {
  const client = requireSupabase();
  const symbol = ticker.trim().toUpperCase();

  const { data, error } = await client
    .from("graph_edges")
    .select(EDGE_COLUMNS)
    .eq("root_ticker", symbol)
    .order("confidence", { ascending: false })
    .limit(200);

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as GraphEdge[];
}

/** Edges pointing back at `ticker` — who touches this company. */
export async function listEdgesInto(ticker: string): Promise<GraphEdge[]> {
  const client = requireSupabase();
  const symbol = ticker.trim().toUpperCase();

  const { data, error } = await client
    .from("graph_edges")
    .select(EDGE_COLUMNS)
    .eq("counterparty_ticker", symbol)
    .order("confidence", { ascending: false })
    .limit(200);

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as GraphEdge[];
}

/** Relationship categories, coloured consistently with the desktop graph. */
export const CATEGORY_ORDER = [
  "supplier",
  "customer",
  "partner",
  "competitor",
  "dependency",
] as const;
