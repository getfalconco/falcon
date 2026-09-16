-- Run once in Supabase SQL editor (or via apps/desktop migration script).
-- Per-user automated tracking agents created from signal follow-ups.

create table if not exists public.tracking_agents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  watch_condition text not null,
  check_frequency text not null default 'daily',
  signal_id text,
  tickers jsonb not null default '[]'::jsonb,
  metrics jsonb not null default '[]'::jsonb,
  goal text,
  source_headline text,
  company_name text,
  last_checked_at timestamptz,
  status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tracking_agents_check_frequency_chk
    check (check_frequency in ('daily', 'weekly')),
  constraint tracking_agents_status_chk
    check (status in ('active', 'paused', 'triggered'))
);

create index if not exists tracking_agents_user_id_idx
  on public.tracking_agents (user_id, created_at desc);

alter table public.tracking_agents enable row level security;

drop policy if exists "Users can read own tracking agents" on public.tracking_agents;
create policy "Users can read own tracking agents"
  on public.tracking_agents
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own tracking agents" on public.tracking_agents;
create policy "Users can insert own tracking agents"
  on public.tracking_agents
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own tracking agents" on public.tracking_agents;
create policy "Users can update own tracking agents"
  on public.tracking_agents
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "Users can delete own tracking agents" on public.tracking_agents;
create policy "Users can delete own tracking agents"
  on public.tracking_agents
  for delete
  to authenticated
  using (auth.uid() = user_id);

-- PostgREST schema cache (Supabase API) picks up new tables after notify.
notify pgrst, 'reload schema';

-- Safe upgrades for existing installs
alter table public.tracking_agents add column if not exists company_name text;
alter table public.tracking_agents add column if not exists last_checked_at timestamptz;

alter table public.tracking_agents drop constraint if exists tracking_agents_status_chk;
alter table public.tracking_agents add constraint tracking_agents_status_chk
  check (status in ('active', 'paused', 'triggered'));
