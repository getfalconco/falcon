-- Run once in the Supabase SQL editor.
-- Shared second-order signals ("opportunities") — propagation output, synced from
-- the desktop main process (service role) so every device and the admin panel can
-- read the same set instead of each desktop keeping a local-only JSON copy.

create table if not exists public.second_order_signals (
  id text primary key,
  event_id text not null,
  signal_date date not null,
  root_ticker text not null,
  terminal_ticker text not null,
  direction text not null,
  mechanical_direction text not null,
  judge_adjusted boolean not null default false,
  magnitude text not null,
  timeframe text not null,
  path_confidence double precision not null default 0,
  priced_in_status text not null,
  price_change_pct double precision,
  price_at_signal double precision,
  expected_move_pct double precision,
  expected_days double precision,
  target_price double precision,
  priced_in_pct double precision,
  precedent_avg_5d double precision,
  precedent_n double precision,
  precedent_direction_consistency double precision,
  event_type text not null,
  event_datetime bigint not null,
  event_summary text not null default '',
  reasoning text not null default '',
  mechanism text not null default '',
  path jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '[]'::jsonb,
  supporting_events jsonb,
  last_supported_at timestamptz,
  outcome_1d jsonb,
  outcome_5d jsonb,
  outcome_20d jsonb,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

-- Common query paths: newest-first listing, and per-ticker / per-day filters.
create index if not exists second_order_signals_generated_at_idx
  on public.second_order_signals (generated_at desc);
create index if not exists second_order_signals_signal_date_idx
  on public.second_order_signals (signal_date desc);
create index if not exists second_order_signals_terminal_ticker_idx
  on public.second_order_signals (terminal_ticker);

-- Safe to re-run on an existing table (added after the initial deploy).
alter table public.second_order_signals
  add column if not exists expected_move_pct double precision;
alter table public.second_order_signals
  add column if not exists expected_days double precision;
alter table public.second_order_signals
  add column if not exists target_price double precision;
alter table public.second_order_signals
  add column if not exists priced_in_pct double precision;
alter table public.second_order_signals
  add column if not exists last_supported_at timestamptz;
alter table public.second_order_signals
  add column if not exists precedent_avg_5d double precision;
alter table public.second_order_signals
  add column if not exists precedent_n double precision;
alter table public.second_order_signals
  add column if not exists precedent_direction_consistency double precision;

alter table public.second_order_signals enable row level security;

-- Only approved members read. The approved flag lives in app_metadata (embedded
-- in the JWT), which only the service role can write — a self-signed-up waitlist
-- account is `authenticated` but must not see the product's signal feed.
drop policy if exists "Authenticated users can read second-order signals" on public.second_order_signals;
drop policy if exists "Approved members can read second-order signals" on public.second_order_signals;
create policy "Approved members can read second-order signals"
  on public.second_order_signals
  for select
  to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'approved')::boolean, false));

-- Service role (desktop main process) bypasses RLS for upserts.
