/**
 * Writes cards to Supabase: table public.sightings_cards, one jsonb row per
 * card keyed by the card id (migration:
 * apps/web/supabase/migrations/20261112_sightings_cards.sql). Connects with
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

export async function upsertCards(databaseUrl: string, cards: RippleCard[]): Promise<number> {
  if (cards.length === 0) return 0;
  const db = client(databaseUrl);
  await db.connect();
  try {
    let n = 0;
    for (const card of cards) {
      const r = cardRow(card);
      await db.query(
        `insert into public.sightings_cards (id, sector, event_ticker, event_at, tickers, generated_at, card)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (id) do update set
           sector = excluded.sector,
           event_ticker = excluded.event_ticker,
           event_at = excluded.event_at,
           tickers = excluded.tickers,
           generated_at = excluded.generated_at,
           card = excluded.card,
           updated_at = now()`,
        [r.id, r.sector, r.event_ticker, r.event_at, r.tickers, r.generated_at, JSON.stringify(r.card)],
      );
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
