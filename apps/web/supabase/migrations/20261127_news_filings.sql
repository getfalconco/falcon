-- SEC EDGAR filings in Falcon's news flow, filled by the filings sweeper
-- (apps/web/lib/news/filings.ts): every minute it polls EDGAR's latest-filings
-- feed for material-event and financing forms (8-K, 8-K/A, 6-K, Schedule 13D,
-- S-1, S-3, F-1, F-3, 424B1/3/4/5/7 prospectuses, 425 merger communications,
-- SC TO-T and SC 14D9 tender offers), keeps filers that map to a ticker in the
-- news universe (public.news_sweep_state.universe), and catches up from
-- EDGAR's daily form indexes. Runs as the Netlify scheduled function
-- apps/web/netlify/functions/filings-sweep.mts, or locally with
-- `pnpm --filter web filings:sweep`. Read with public.news_items by
-- lib/news/store.ts (GET /api/news, Falcon AI's list_news).
--
-- Filings live in their own table, not in news_items, because the deployed
-- Finnhub sweeper prunes every news_items row older than 14 days and filings
-- are kept 90 days. news_items is unchanged, so the deployed code keeps working.
--
-- news_filings: one row per accession number. id = 1e15 + the accession's
-- digits read as a number (0001493152-26-050606 -> 1e15 + 149315226050606 =
-- 1149315226050606, a safe JavaScript integer). Finnhub article ids are below
-- 1e9, so the two id ranges never meet and readers can merge both tables.
-- A row is inserted as soon as the feed lists the filing (headline from the
-- form and 8-K item numbers), then enriched from the filing's header and its
-- press release (EX-99.1) or main document: enriched_at is set when done,
-- enrich_tries counts attempts (given up after 5).
--
-- filing_sweep_state: a single row with the CIK -> ticker map (refreshed
-- daily from SEC company_tickers_exchange.json), the feed rotation cursor,
-- the daily indexes already read, and a lease so only one sweeper calls EDGAR
-- at a time.
--
-- Server only: reached with DATABASE_URL; no API role can read or write.
--
-- Rollback (run by hand if needed):
--   drop table if exists public.news_filings;
--   drop table if exists public.filing_sweep_state;
--   notify pgrst, 'reload schema';

create table if not exists public.news_filings (
  id bigint primary key check (id >= 1000000000000000),
  accession text not null unique,
  cik text not null,
  company text not null default '',
  symbols text[] not null default '{}',
  form text not null,
  items text[] not null default '{}',
  headline text not null,
  summary text not null default '',
  url text not null,
  documents jsonb not null default '[]',
  published_at timestamptz not null,
  fetched_at timestamptz not null default now(),
  enriched_at timestamptz,
  enrich_tries smallint not null default 0
);

create index if not exists news_filings_published_at_idx on public.news_filings (published_at desc);
create index if not exists news_filings_symbols_idx on public.news_filings using gin (symbols);
create index if not exists news_filings_pending_idx on public.news_filings (published_at desc) where enriched_at is null;

create table if not exists public.filing_sweep_state (
  id smallint primary key default 1 check (id = 1),
  ciks jsonb not null default '{}',
  ciks_at timestamptz,
  feed_cursor integer not null default 0,
  index_days text[] not null default '{}',
  lease_owner text,
  lease_until timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.filing_sweep_state (id) values (1) on conflict (id) do nothing;

alter table public.news_filings enable row level security;
alter table public.filing_sweep_state enable row level security;
revoke all on public.news_filings from anon, authenticated, public;
revoke all on public.filing_sweep_state from anon, authenticated, public;
grant all on public.news_filings to service_role;
grant all on public.filing_sweep_state to service_role;

notify pgrst, 'reload schema';
