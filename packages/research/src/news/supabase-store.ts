/**
 * Shared backend store for classified material news events.
 *
 * Same pattern as ../propagation/supabase-store.ts: the writer uses the
 * service-role key (bypassing RLS) so the headless worker, the desktop app and
 * mobile all read the same feed. Local JSON files remain the offline copy.
 * Every call degrades to a no-op when Supabase isn't configured — a backend
 * outage must never break a poll.
 */
import type { MaterialNewsEvent, PropagationEvent } from "../propagation/types.js";

const SUPABASE_HEADERS = {
  "User-Agent": "MeridianWorker/1.0",
  "Content-Type": "application/json",
};

/** Columns persisted to public.material_news_events. */
type StoredRow = {
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
  merged_from: string[] | null;
  event_date: string;
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

export function isNewsEventBackendConfigured(): boolean {
  return supabaseConfig() !== null;
}

function eventDate(event: MaterialNewsEvent): string {
  const ms = Number(event.article_datetime) * 1000;
  const d = Number.isFinite(ms) && ms > 0 ? new Date(ms) : new Date(event.classified_at);
  const iso = Number.isFinite(d.getTime()) ? d.toISOString() : new Date().toISOString();
  return iso.slice(0, 10);
}

function toRow(event: MaterialNewsEvent | PropagationEvent): StoredRow {
  const propagation = event as PropagationEvent;
  return {
    id: event.id,
    article_id: Number(event.article_id) || 0,
    ticker: event.ticker,
    headline: event.headline,
    source_url: event.source_url ?? "",
    source_urls: Array.isArray(propagation.source_urls)
      ? propagation.source_urls
      : event.source_url
        ? [event.source_url]
        : [],
    article_datetime: Number(event.article_datetime) || 0,
    classified_at: event.classified_at,
    event_type: event.event_type,
    affected_ticker: event.affected_ticker,
    direction_on_primary: event.direction_on_primary,
    summary: event.summary ?? "",
    confidence: Number(event.confidence) || 0,
    merged_from: propagation.merged_from ?? null,
    event_date: eventDate(event),
  };
}

/**
 * Upsert a batch of classified events (merge on id). Best-effort — logs and
 * returns on failure rather than throwing into the poll loop.
 */
export async function persistEventsToSupabase(
  events: Array<MaterialNewsEvent | PropagationEvent>,
): Promise<void> {
  if (events.length === 0) return;

  const config = supabaseConfig();
  if (!config) {
    console.warn(
      "[events] SUPABASE_SERVICE_ROLE_KEY missing — events stay local-only, not shared across devices",
    );
    return;
  }

  const rows = events.map(toRow);

  try {
    const res = await fetch(`${config.url}/rest/v1/material_news_events`, {
      method: "POST",
      headers: {
        ...supabaseAuthHeaders(config.serviceKey),
        Prefer: "resolution=merge-duplicates,return=minimal",
      },
      body: JSON.stringify(rows),
    });

    if (!res.ok) {
      console.warn(
        "[events] Supabase upsert failed:",
        res.status,
        (await res.text().catch(() => "")).slice(0, 300),
      );
      return;
    }
    console.info(`[events] synced ${rows.length} event(s) to Supabase`);
  } catch (err) {
    console.warn("[events] Supabase upsert failed:", err instanceof Error ? err.message : err);
  }
}
