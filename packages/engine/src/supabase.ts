/**
 * Writes cards to Supabase: table public.sightings_cards, one jsonb row per
 * card keyed by the card id (migration:
 * apps/web/supabase/migrations/20261112_sightings_cards.sql, stale columns in
 * 20261113_sightings_cards_stale.sql). Connects with
 * DATABASE_URL (Postgres connection string of the Supabase project).
 */

import pg from "pg";
import type { RippleCard } from "@falcon/ripple";

export type CardRow = {
  id: string;
  sector: string;
  event_ticker: string;
  event_at: string;
  tickers: string[];
  generated_at: string;
  card: RippleCard;
};

/** The row a card is stored as. Pure. */
export function cardRow(card: RippleCard): CardRow {
  return {
    id: card.id,
    sector: card.sector,
    event_ticker: card.event.ticker,
    event_at: card.event.occurredAt,
    tickers: [card.event.ticker, ...card.hits.map((h) => h.ticker)],
    generated_at: card.generatedAt,
    card,
  };
}

function client(databaseUrl: string): pg.Client {
  const local = /@(localhost|127\.0\.0\.1)(:|\/)/.test(databaseUrl);
  return new pg.Client({ connectionString: databaseUrl, ssl: local ? false : { rejectUnauthorized: false } });
}

export const UPSERT_SQL = `insert into public.sightings_cards (id, sector, event_ticker, event_at, tickers, generated_at, card, stale, stale_at)
  values ($1, $2, $3, $4, $5, $6, $7, false, null)
  on conflict (id) do update set
    sector = excluded.sector,
    event_ticker = excluded.event_ticker,
    event_at = excluded.event_at,
    tickers = excluded.tickers,
    generated_at = excluded.generated_at,
    card = excluded.card,
    stale = false,
    stale_at = null,
    updated_at = now()`;

export const MARK_STALE_SQL = `update public.sightings_cards
  set stale = true, stale_at = now(), updated_at = now()
  where sector = $1 and not stale and event_at < $2`;

export type PublishResult = { upserted: number; markedStale: number; fresh: number };

/** The instant before which a card's event is stale: `keepDays` before `nowMs`. Pure. */
export function staleCutoff(nowMs: number, keepDays: number): Date {
  return new Date(nowMs - keepDays * 86_400_000);
}

/**
 * One transaction: upsert the run's cards (keyed by card id, so the same
 * event never makes a second row), then mark the sector's cards whose event
 * is older than `keepDays` stale. Nothing is deleted.
 */
export async function publishCards(
  databaseUrl: string,
  sector: string,
  cards: RippleCard[],
  opts: { keepDays: number; nowMs?: number },
): Promise<PublishResult> {
  const cutoff = staleCutoff(opts.nowMs ?? Date.now(), opts.keepDays);
  const db = client(databaseUrl);
  await db.connect();
  try {
    await db.query("begin");
    let upserted = 0;
    for (const card of cards) {
      const r = cardRow(card);
      await db.query(UPSERT_SQL, [r.id, r.sector, r.event_ticker, r.event_at, r.tickers, r.generated_at, JSON.stringify(r.card)]);
      upserted++;
    }
    const stale = await db.query(MARK_STALE_SQL, [sector, cutoff.toISOString()]);
    const fresh = await db.query<{ n: string }>("select count(*)::text as n from public.sightings_cards where sector = $1 and not stale", [sector]);
    await db.query("commit");
    return { upserted, markedStale: stale.rowCount ?? 0, fresh: Number(fresh.rows[0]?.n ?? 0) };
  } catch (err) {
    await db.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    await db.end();
  }
}

/** Upserts cards without touching staleness (kept for scripts). */
export async function upsertCards(databaseUrl: string, cards: RippleCard[]): Promise<number> {
  if (cards.length === 0) return 0;
  const db = client(databaseUrl);
  await db.connect();
  try {
    let n = 0;
    for (const card of cards) {
      const r = cardRow(card);
      await db.query(UPSERT_SQL, [r.id, r.sector, r.event_ticker, r.event_at, r.tickers, r.generated_at, JSON.stringify(r.card)]);
      n++;
    }
    return n;
  } finally {
    await db.end();
  }
}

export async function runSql(databaseUrl: string, sql: string): Promise<void> {
  const db = client(databaseUrl);
  await db.connect();
  try {
    await db.query(sql);
  } finally {
    await db.end();
  }
}
