-- Sightings cards age out: the daily engine run (GitHub Actions
-- .github/workflows/sightings.yml) marks a card stale once its event is older
-- than the kept window (7 days by default). /api/sightings serves only cards
-- that are not stale. A card that a later run writes again is fresh again.
-- Idempotent; applied by `pnpm --filter @falcon/engine run migrate`.

alter table public.sightings_cards add column if not exists stale boolean not null default false;
alter table public.sightings_cards add column if not exists stale_at timestamptz;

create index if not exists sightings_cards_fresh_idx on public.sightings_cards (event_at desc) where not stale;
