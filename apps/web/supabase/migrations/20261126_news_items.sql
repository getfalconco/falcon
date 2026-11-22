-- Company news for every US-listed company, filled by the news sweeper
-- (apps/web/lib/news/store.ts): it walks the Finnhub US universe (common
-- stocks, ADRs and REITs on NYSE, Nasdaq, NYSE American, NYSE Arca, Cboe BZX)
-- one symbol at a time, calls /company-news for the last 3 days and upserts
-- the articles here. Runs every minute as the Netlify scheduled function
-- apps/web/netlify/functions/news-sweep.mts, or locally with
-- `pnpm --filter web news:sweep`. Read by GET /api/news.
--
-- news_items: one row per Finnhub article id. The same article listed under
-- several tickers has the same id, so `symbols` collects every ticker it was
-- seen under. Rows older than 14 days are pruned by the sweeper.
--
-- news_sweep_state: a single row with the universe (refreshed at most daily),
-- the cursor (last symbol fetched) and a lease, so only one sweeper (Netlify
-- or a local run) calls Finnhub at a time.
--
-- Server only: reached with DATABASE_URL; no API role can read or write.
--
-- Rollback (run by hand if needed):
--   drop table if exists public.news_items;
--   drop table if exists public.news_sweep_state;
--   notify pgrst, 'reload schema';

create table if not exists public.news_items (
  id bigint primary key,
  symbols text[] not null default '{}',
  headline text not null,
  summary text not null default '',
  source text not null default '',
  url text not null,
  image text not null default '',
  category text not null default '',
  published_at timestamptz not null,
  fetched_at timestamptz not null default now()
);

create index if not exists news_items_published_at_idx on public.news_items (published_at desc);
create index if not exists news_items_symbols_idx on public.news_items using gin (symbols);

create table if not exists public.news_sweep_state (
  id smallint primary key default 1 check (id = 1),
  universe text[] not null default '{}',
  universe_at timestamptz,
  last_symbol text,
  passes integer not null default 0,
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.news_sweep_state (id) values (1) on conflict (id) do nothing;

alter table public.news_items enable row level security;
alter table public.news_sweep_state enable row level security;
revoke all on public.news_items from anon, authenticated, public;
revoke all on public.news_sweep_state from anon, authenticated, public;
grant all on public.news_items to service_role;
grant all on public.news_sweep_state to service_role;

notify pgrst, 'reload schema';
