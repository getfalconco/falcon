-- Falcon 60-day live paper book. Service-role only (admin + news-worker).
-- Applied remotely as migration paper_competition_60d.

create table if not exists public.paper_competition_runs (
  id text primary key,
  title text not null,
  status text not null default 'active'
    check (status in ('active', 'completed', 'paused')),
  started_at timestamptz not null default now(),
  ends_at timestamptz not null,
  initial_cash numeric not null default 10000,
  cash numeric not null default 10000,
  spy_start numeric,
  peak_nav numeric not null default 10000,
  policy jsonb not null default '{}'::jsonb,
  last_tick_at timestamptz,
  last_tick_summary text,
  notes text,
  created_at timestamptz not null default now()
);

create table if not exists public.paper_competition_decisions (
  id uuid primary key default gen_random_uuid(),
  run_id text not null references public.paper_competition_runs(id) on delete cascade,
  signal_id text not null,
  ticker text not null,
  direction text not null,
  generated_at timestamptz,
  verdict text not null check (verdict in ('skipped', 'filled', 'fill_failed')),
  skip_reason text,
  path_confidence double precision,
  magnitude text,
  priced_in_status text,
  headline text,
  event_summary text,
  reasoning text,
  mechanism text,
  expected_move_pct double precision,
  expected_days double precision,
  snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (run_id, signal_id)
);

create index if not exists paper_competition_decisions_run_created_idx
  on public.paper_competition_decisions (run_id, created_at desc);

create table if not exists public.paper_competition_positions (
  id uuid primary key default gen_random_uuid(),
  run_id text not null references public.paper_competition_runs(id) on delete cascade,
  signal_id text not null,
  ticker text not null,
  direction text not null,
  shares numeric not null,
  weight numeric not null,
  notional_usd numeric not null,
  entry_price numeric not null,
  entry_at timestamptz not null default now(),
  entry_source text,
  planned_exit_at timestamptz not null,
  exit_price numeric,
  exit_at timestamptz,
  exit_reason text,
  pnl_usd numeric,
  return_pct numeric,
  status text not null default 'open' check (status in ('open', 'closed')),
  headline text,
  path_confidence double precision,
  event_summary text,
  reasoning text,
  mechanism text,
  created_at timestamptz not null default now()
);

create index if not exists paper_competition_positions_run_status_idx
  on public.paper_competition_positions (run_id, status);

create table if not exists public.paper_competition_events (
  id bigint generated always as identity primary key,
  run_id text not null references public.paper_competition_runs(id) on delete cascade,
  ts timestamptz not null default now(),
  stage text not null,
  message text not null,
  signal_id text,
  ticker text,
  payload jsonb not null default '{}'::jsonb
);

create index if not exists paper_competition_events_run_ts_idx
  on public.paper_competition_events (run_id, ts desc);

create table if not exists public.paper_competition_snapshots (
  id bigint generated always as identity primary key,
  run_id text not null references public.paper_competition_runs(id) on delete cascade,
  ts timestamptz not null default now(),
  cash numeric not null,
  positions_value numeric not null,
  nav numeric not null,
  spy_price numeric,
  spy_nav numeric,
  open_count integer not null default 0,
  peak_nav numeric not null,
  drawdown_pct numeric not null default 0
);

create index if not exists paper_competition_snapshots_run_ts_idx
  on public.paper_competition_snapshots (run_id, ts desc);

alter table public.paper_competition_runs enable row level security;
alter table public.paper_competition_decisions enable row level security;
alter table public.paper_competition_positions enable row level security;
alter table public.paper_competition_events enable row level security;
alter table public.paper_competition_snapshots enable row level security;

revoke all on public.paper_competition_runs from anon, authenticated;
revoke all on public.paper_competition_decisions from anon, authenticated;
revoke all on public.paper_competition_events from anon, authenticated;
revoke all on public.paper_competition_positions from anon, authenticated;
revoke all on public.paper_competition_snapshots from anon, authenticated;
