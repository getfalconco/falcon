-- Daily stock prices for the whole universe (packages/engine/src/prices/daily.ts,
-- the "Daily prices" step of .github/workflows/options-daily.yml).
--
--   prices_daily:  one row per ticker and New York session: Databento
--                  EQUS.SUMMARY ohlcv-1d (the consolidated official daily
--                  summary across US venues), UNADJUSTED, as Databento sends
--                  it. `ticker` is the graph's form (BRK-B, not BRK.B).
--                  Starts 2024-07-01 (the dataset's first day).
--   prices_splits: share splits found in those bars (source 'detected': an
--                  overnight jump matching a standard split ratio with flat
--                  dollar volume), since Databento's corporate actions need a
--                  separate subscription. `ratio` is new shares per old share
--                  (10 for a 10-for-1 split, 0.1 for a 1-for-10 reverse
--                  split); `date` is the first session at the new count.
--                  /api/prices divides earlier prices by the product of later
--                  ratios. A row with source 'manual' is never overwritten by
--                  the detector (use it to add a missed split or, with ratio
--                  1, to cancel a false one).
--
-- Databento spend of the price jobs goes into public.options_spend (callers
-- prices-daily@... and prices-backfill@...), next to the options jobs.
--
-- Written by the engine (DATABASE_URL), read by the website with the service
-- role, like options_daily: RLS on with no policies, nothing granted to anon
-- or authenticated. Additive and idempotent; applied by
-- `pnpm --filter @falcon/engine run migrate`.
--
-- Rollback:
--   drop table if exists public.prices_splits;
--   drop table if exists public.prices_daily;

create table if not exists public.prices_daily (
  ticker text not null,
  date date not null,
  open double precision not null,
  high double precision not null,
  low double precision not null,
  close double precision not null,
  volume bigint not null,
  source text not null default 'EQUS.SUMMARY',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (ticker, date)
);

create index if not exists prices_daily_date_idx on public.prices_daily (date desc);

alter table public.prices_daily enable row level security;
revoke all on table public.prices_daily from anon, authenticated;

create table if not exists public.prices_splits (
  ticker text not null,
  date date not null,
  ratio double precision not null check (ratio > 0),
  source text not null default 'detected',
  detail text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (ticker, date)
);

alter table public.prices_splits enable row level security;
revoke all on table public.prices_splits from anon, authenticated;

comment on table public.prices_daily is
  'Unadjusted daily OHLCV per ticker and session (Databento EQUS.SUMMARY ohlcv-1d), written by packages/engine prices-daily, read by /api/prices.';
comment on table public.prices_splits is
  'Share splits per ticker (ratio = new shares per old share), detected from prices_daily or entered by hand; /api/prices adjusts with them.';
comment on table public.options_spend is
  'Databento spend ledger of the engine data jobs (options-daily, prices-daily, prices-backfill callers): persistent monthly caps.';
