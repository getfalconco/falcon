-- Daily options data for the whole universe (packages/engine/src/options/daily.ts,
-- .github/workflows/options-daily.yml), and its persistent Databento spend ledger.
--
--   options_daily:  one row per ticker and New York session. `metrics` holds the
--                   card block (@falcon/ripple RippleOptions, with ivPct), the
--                   numbers the engine rebuilds blocks from, and the IV
--                   percentile (engine store.ts StoredMetrics). A row with
--                   `skip` set records why a chain was unusable that session
--                   (not bought again, never served). About 90 days are kept
--                   (the engine prunes older rows) for the IV percentile.
--   options_latest: each ticker's newest usable row of the last 10 days
--                   (what /api/options?all=1 serves).
--   options_spend:  one row per Databento ledger line of the options jobs
--                   (charge or refund), so the monthly cap survives lost caches.
--
-- Written by the engine (DATABASE_URL), read by the website with the service
-- role, like sightings_cards: RLS on with no policies, nothing granted to anon
-- or authenticated. Additive and idempotent; applied by
-- `pnpm --filter @falcon/engine run migrate`.
--
-- Rollback:
--   drop view if exists public.options_latest;
--   drop table if exists public.options_daily;
--   drop table if exists public.options_spend;

create table if not exists public.options_daily (
  ticker text not null,
  as_of date not null,
  metrics jsonb,
  skip text,
  source text not null default 'daily',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (ticker, as_of),
  check (metrics is not null or skip is not null)
);

create index if not exists options_daily_as_of_idx on public.options_daily (as_of desc);

alter table public.options_daily enable row level security;
revoke all on table public.options_daily from anon, authenticated;

create or replace view public.options_latest
  with (security_invoker = true) as
  select distinct on (ticker)
    ticker,
    as_of,
    metrics -> 'block' as block,
    (metrics ->> 'ivPct')::int as iv_pct,
    (metrics ->> 'ivDays')::int as iv_days
  from public.options_daily
  where skip is null and metrics is not null and as_of >= current_date - 10
  order by ticker, as_of desc;

revoke all on table public.options_latest from anon, authenticated;

create table if not exists public.options_spend (
  id bigserial primary key,
  at timestamptz not null,
  caller text not null,
  kind text not null check (kind in ('charge', 'refund')),
  dataset text not null,
  schema text not null,
  symbols int not null default 0,
  start_at text,
  end_at text,
  cost_usd double precision not null,
  key text not null,
  note text,
  created_at timestamptz not null default now(),
  unique (caller, key, kind, at)
);

create index if not exists options_spend_at_idx on public.options_spend (at);

alter table public.options_spend enable row level security;
revoke all on table public.options_spend from anon, authenticated;

comment on table public.options_daily is
  'Options data per ticker and session (OPRA via Databento), written by packages/engine options-daily, read by /api/options.';
comment on view public.options_latest is
  'Newest usable options_daily row per ticker over the last 10 days.';
comment on table public.options_spend is
  'Databento spend ledger of the engine options jobs (persistent monthly cap).';
