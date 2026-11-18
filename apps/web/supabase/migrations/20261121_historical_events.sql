-- Historical earnings events (packages/engine/scripts/earnings-events.ts): one
-- row per 8-K or 8-K/A with item 2.02 (Results of Operations) filed since
-- 2016-01-01 by a company in the link graph, with its two-day abnormal return
-- against the company's SPDR sector ETF. Read by the Falcon AI /events command.
--
--   event_date              first NYSE session the market could react: the
--                           acceptance day when accepted before the close
--                           (16:00 New York, 13:00 on early-close days), else
--                           the next session.
--   abnormal_return_d0_d1   (1 + r_stock_d0)(1 + r_stock_d1) - (1 + r_etf_d0)(1 + r_etf_d1),
--                           r_d = close(d) / close(d - 1) - 1. NULL when a close is missing.
--   price_source            'yahoo' (stock and ETF from Yahoo adjusted closes),
--                           'mixed' (stock from Databento EQUS.SUMMARY prices_daily,
--                           split-adjusted; ETF from Yahoo), null when unpriced.
--   flags                   missing_price, etf_fallback_spy, amended,
--                           multiple_same_day, suspicious_move, before_first_price,
--                           cik_mismatch, price_source_disagree.
--   eps_surprise            analyst EPS surprise, NULL until a source is wired.
--
-- Written by the engine (DATABASE_URL); readable by signed-in members and the
-- service role, never by anon; no write policy, so only the service role (or
-- the table owner) writes. Additive and idempotent.
--
-- Rollback:
--   drop table if exists public.historical_events;

create table if not exists public.historical_events (
  id bigserial primary key,
  ticker text not null,
  event_date date not null,
  filed_at timestamptz not null,
  accession text not null,
  filing_url text not null,
  form text not null,
  sector_etf text,
  abnormal_return_d0_d1 double precision,
  stock_return_d0_d1 double precision,
  etf_return_d0_d1 double precision,
  price_source text,
  flags text[] not null default '{}',
  eps_surprise double precision,
  created_at timestamptz not null default now(),
  unique (ticker, accession)
);

create index if not exists historical_events_ticker_date_idx on public.historical_events (ticker, event_date desc);
create index if not exists historical_events_date_idx on public.historical_events (event_date desc);

alter table public.historical_events enable row level security;
revoke all on table public.historical_events from anon, authenticated;
grant select on table public.historical_events to authenticated;

drop policy if exists historical_events_read on public.historical_events;
create policy historical_events_read on public.historical_events
  for select to authenticated using (true);

comment on table public.historical_events is
  'Earnings 8-K (item 2.02) events since 2016 for link-graph companies with two-day sector-ETF abnormal returns; written by packages/engine earnings-events.';
