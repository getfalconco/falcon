-- Portfolio cloud tracking
--
-- 1. paper_portfolios  — each user's paper account (cash + positions), synced
--    up from the desktop whenever it changes. One row per user.
-- 2. portfolio_snapshots — net-worth time series written by the 24/7
--    news-worker (service role) every few minutes, so the chart keeps moving
--    while the desktop app is closed.
--
-- Run this in the Supabase SQL editor (or psql) once.

create table if not exists public.paper_portfolios (
  user_id uuid primary key references auth.users (id) on delete cascade,
  cash numeric not null default 0,
  positions jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.paper_portfolios enable row level security;

drop policy if exists "paper_portfolios_select_own" on public.paper_portfolios;
create policy "paper_portfolios_select_own"
  on public.paper_portfolios for select
  using (auth.uid() = user_id);

drop policy if exists "paper_portfolios_insert_own" on public.paper_portfolios;
create policy "paper_portfolios_insert_own"
  on public.paper_portfolios for insert
  with check (auth.uid() = user_id);

drop policy if exists "paper_portfolios_update_own" on public.paper_portfolios;
create policy "paper_portfolios_update_own"
  on public.paper_portfolios for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create table if not exists public.portfolio_snapshots (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  ts timestamptz not null default now(),
  value numeric not null
);

create index if not exists portfolio_snapshots_user_ts
  on public.portfolio_snapshots (user_id, ts desc);

alter table public.portfolio_snapshots enable row level security;

-- Owners read their own series; the worker writes with the service role
-- (bypasses RLS). Owners may also insert their own points (desktop seeding).
drop policy if exists "portfolio_snapshots_select_own" on public.portfolio_snapshots;
create policy "portfolio_snapshots_select_own"
  on public.portfolio_snapshots for select
  using (auth.uid() = user_id);

drop policy if exists "portfolio_snapshots_insert_own" on public.portfolio_snapshots;
create policy "portfolio_snapshots_insert_own"
  on public.portfolio_snapshots for insert
  with check (auth.uid() = user_id);

-- Resetting a paper account wipes its recorded series from the desktop.
drop policy if exists "portfolio_snapshots_delete_own" on public.portfolio_snapshots;
create policy "portfolio_snapshots_delete_own"
  on public.portfolio_snapshots for delete
  using (auth.uid() = user_id);
