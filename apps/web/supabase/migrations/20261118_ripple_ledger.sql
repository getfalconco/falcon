-- Ripple Engine v1: forward track record (docs/design/ripple-engine-v1.md 7.4, a7).
--   ripple_forecasts: one row per judged or built hit, published or not,
--     written before the outcome is known; created_at is the database clock.
--   ripple_outcomes:  the resolved outcome of a forecast (written by a later
--     resolver job); corrections are new rows.
-- Both are append-only: a trigger raises on any update or delete. RLS on with
-- no policies, and no grants to anon or authenticated: internal until a price
-- licence and counsel allow a public record.
-- Database roles (engine_writer, migrator) are not created here.
-- Idempotent; applied by `pnpm --filter @falcon/engine run migrate`.

create table if not exists public.ripple_forecasts (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  event_id text not null,
  card_id text not null,
  ticker text not null,
  tier text not null check (tier in ('measured', 'documented', 'watch')),
  family text,
  sign_pred int not null check (sign_pred in (-1, 0, 1)),
  window_days int not null,
  covariates jsonb not null default '{}'::jsonb,
  model_version text not null,
  card_sha256 text,
  published boolean not null default false
);

-- A later run that sees the same hit with the same tier, sign and publish
-- state adds no row (the engine inserts with on conflict do nothing).
create unique index if not exists ripple_forecasts_once
  on public.ripple_forecasts (event_id, card_id, ticker, tier, coalesce(family, ''), sign_pred, published, model_version);

create index if not exists ripple_forecasts_event_idx on public.ripple_forecasts (event_id);
create index if not exists ripple_forecasts_created_idx on public.ripple_forecasts (created_at);

create table if not exists public.ripple_outcomes (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  forecast_id bigint not null references public.ripple_forecasts(id),
  t0_date date,
  t0_open real,
  exit_date date,
  exit_close real,
  legs jsonb not null default '{}'::jsonb,
  controls jsonb not null default '[]'::jsonb,
  y real,
  net_pct real,
  delisted boolean not null default false,
  notes text
);

create index if not exists ripple_outcomes_forecast_idx on public.ripple_outcomes (forecast_id);

create or replace function public.ripple_append_only() returns trigger
  language plpgsql as $$
begin
  raise exception '% is append-only: % is not allowed', tg_table_name, tg_op;
end $$;

drop trigger if exists ripple_forecasts_append_only on public.ripple_forecasts;
create trigger ripple_forecasts_append_only
  before update or delete on public.ripple_forecasts
  for each row execute function public.ripple_append_only();

drop trigger if exists ripple_forecasts_no_truncate on public.ripple_forecasts;
create trigger ripple_forecasts_no_truncate
  before truncate on public.ripple_forecasts
  for each statement execute function public.ripple_append_only();

drop trigger if exists ripple_outcomes_append_only on public.ripple_outcomes;
create trigger ripple_outcomes_append_only
  before update or delete on public.ripple_outcomes
  for each row execute function public.ripple_append_only();

drop trigger if exists ripple_outcomes_no_truncate on public.ripple_outcomes;
create trigger ripple_outcomes_no_truncate
  before truncate on public.ripple_outcomes
  for each statement execute function public.ripple_append_only();

alter table public.ripple_forecasts enable row level security;
alter table public.ripple_outcomes enable row level security;
revoke all on table public.ripple_forecasts from anon, authenticated;
revoke all on table public.ripple_outcomes from anon, authenticated;

comment on table public.ripple_forecasts is
  'Ripple Engine forward ledger: one append-only row per judged or built hit. Internal.';
comment on table public.ripple_outcomes is
  'Ripple Engine forward ledger outcomes, append-only. Internal.';
