-- Tracker (Engine1) universe — the server-authoritative list of tickers every
-- install tracks. Desktop installs read it at start (merged with local
-- discovery) and write to it when a ticker is added (e.g. a new portfolio
-- holding) or removed. Removed tickers stay as rows with active=false so no
-- install resurrects them from a stale local cache.
--
-- Access model (no service-role key on the desktop):
--   * read  — anon + authenticated (the list is just ticker symbols)
--   * write — authenticated users only, with their own JWT
create table if not exists public.tracker_universe (
  ticker      text primary key,
  active      boolean not null default true,
  source      text,                                  -- 'seed' | 'portfolio' | 'manual' | 'discovery' | 'desktop'
  added_at    timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

alter table public.tracker_universe enable row level security;

drop policy if exists tracker_universe_read on public.tracker_universe;
create policy tracker_universe_read
  on public.tracker_universe for select
  to anon, authenticated
  using (true);

drop policy if exists tracker_universe_insert on public.tracker_universe;
create policy tracker_universe_insert
  on public.tracker_universe for insert
  to authenticated
  with check (true);

drop policy if exists tracker_universe_update on public.tracker_universe;
create policy tracker_universe_update
  on public.tracker_universe for update
  to authenticated
  using (true)
  with check (true);

-- Deliberately no delete policy: removal is `active=false`, never a row delete.

create index if not exists tracker_universe_active_idx on public.tracker_universe (active);
