-- Ripple Engine output: one Sightings card per row, the card itself as jsonb
-- in the @falcon/ripple RippleCard shape. Written by packages/engine
-- (service role / DATABASE_URL), read by the website's /api/sightings route
-- with the service role. No client reads it directly, so RLS is on with no
-- policies.

create table if not exists public.sightings_cards (
  id text primary key,
  sector text not null,
  event_ticker text not null,
  event_at timestamptz not null,
  -- The event company first, then every hit's ticker, for portfolio filters.
  tickers text[] not null default '{}',
  generated_at timestamptz not null,
  card jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists sightings_cards_event_at_idx on public.sightings_cards (event_at desc);
create index if not exists sightings_cards_tickers_idx on public.sightings_cards using gin (tickers);

alter table public.sightings_cards enable row level security;

comment on table public.sightings_cards is
  'Ripple Engine Sightings cards (RippleCard jsonb, keyed by card id). Written by packages/engine, read by /api/sightings.';
