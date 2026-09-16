-- Run once in Supabase SQL editor.
-- Shared daily dashboard signal — same row for every user on a given US market date.

create table if not exists public.daily_top_signals (
  signal_date date primary key,
  id text not null,
  headline text not null,
  insight text not null,
  tickers jsonb not null default '[]'::jsonb,
  source_urls jsonb not null default '[]'::jsonb,
  generated_at timestamptz not null default now()
);

-- Safe to re-run on existing projects.
alter table public.daily_top_signals
  add column if not exists mechanism text not null default '';

-- Shared deep analysis + ticker trajectories so they are generated once
-- (by the first client of the day) and reused by every other user. Keeps AI
-- spend to a single generation per signal instead of one per user.
alter table public.daily_top_signals
  add column if not exists deep_analysis text;
alter table public.daily_top_signals
  add column if not exists deep_analysis_version text;
alter table public.daily_top_signals
  add column if not exists trajectories jsonb;
alter table public.daily_top_signals
  add column if not exists trajectories_version text;

alter table public.daily_top_signals enable row level security;

-- Only approved members read (approved flag is service-role-written app_metadata,
-- embedded in the JWT). Waitlist accounts are `authenticated` but not approved.
drop policy if exists "Authenticated users can read daily signals" on public.daily_top_signals;
drop policy if exists "Approved members can read daily signals" on public.daily_top_signals;
create policy "Approved members can read daily signals"
  on public.daily_top_signals
  for select
  to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'approved')::boolean, false));

-- Service role (desktop main process) bypasses RLS for upserts.
