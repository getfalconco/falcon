/**
 * Shared backend store for relationship graph edges.
 *
 * Same service-role pattern as ./supabase-store.ts. The graph is built from SEC
 * filings by step1 and normally lives in a local data/graph.json; syncing it
 * here lets mobile and the admin panel render the same relationships.
 */

const SUPABASE_HEADERS = {
  "User-Agent": "MeridianWorker/1.0",
  "Content-Type": "application/json",
};

/** Minimal edge shape shared with apps/desktop/src/shared/graph-types.ts. */
export type GraphEdgeLike = {
  id: string;
  root_ticker: string;
  counterparty_id: string;
  counterparty_name: string;
  counterparty_ticker: string | null;
  category: string;
  subtype?: string;
  confidence?: number;
  strength?: number;
  strength_tier?: string;
  evidence_quote?: string;
  source_url?: string;
  valid_from?: string;
};

type StoredRow = {
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
  valid_from: string | null;
  updated_at: string;
};

function supabaseConfig(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

function supabaseAuthHeaders(serviceKey: string): Record<string, string> {
  return { ...SUPABASE_HEADERS, apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
}

export function isGraphBackendConfigured(): boolean {
  return supabaseConfig() !== null;
}

function toRow(edge: GraphEdgeLike): StoredRow {
  return {
    id: edge.id,
    root_ticker: edge.root_ticker,
    counterparty_id: edge.counterparty_id,
    counterparty_name: edge.counterparty_name,
    counterparty_ticker: edge.counterparty_ticker ?? null,
    category: edge.category,
    subtype: edge.subtype ?? "",
    confidence: Number(edge.confidence) || 0,
    strength: typeof edge.strength === "number" ? edge.strength : null,
    strength_tier: edge.strength_tier ?? null,
    evidence_quote: edge.evidence_quote ?? "",
    source_url: edge.source_url ?? "",
    valid_from: edge.valid_from ?? null,
    updated_at: new Date().toISOString(),
  };
}

/**
 * Upsert graph edges (merge on id). Chunked because a full graph can exceed a
 * comfortable single request body. Best-effort, never throws.
 */
export async function persistGraphToSupabase(edges: GraphEdgeLike[]): Promise<void> {
  if (edges.length === 0) return;

  const config = supabaseConfig();
  if (!config) {
    console.warn("[graph] SUPABASE_SERVICE_ROLE_KEY missing — graph stays local-only");
    return;
  }

  const rows = edges.map(toRow);
  const CHUNK = 500;
  let synced = 0;

  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    try {
      const res = await fetch(`${config.url}/rest/v1/graph_edges`, {
        method: "POST",
        headers: {
          ...supabaseAuthHeaders(config.serviceKey),
          Prefer: "resolution=merge-duplicates,return=minimal",
        },
        body: JSON.stringify(chunk),
      });

      if (!res.ok) {
        console.warn(
          "[graph] Supabase upsert failed:",
          res.status,
          (await res.text().catch(() => "")).slice(0, 300),
        );
        return;
      }
      synced += chunk.length;
    } catch (err) {
      console.warn("[graph] Supabase upsert failed:", err instanceof Error ? err.message : err);
      return;
    }
  }

  console.info(`[graph] synced ${synced} edge(s) to Supabase`);
}
