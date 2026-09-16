-- Run once in the Supabase SQL editor.
-- Durable state for long-running compute jobs (Step-1 SEC research, propagation
-- runs). Previously an in-process Map in packages/research/src/step1/jobs.ts,
-- which died on restart and could not scale past one instance.

create table if not exists public.research_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null,
  ticker text,
  status text not null default 'queued',
  stage text not null default '',
  progress_current integer not null default 0,
  progress_total integer not null default 0,
  error text,
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint research_jobs_kind_chk
    check (kind in ('step1', 'propagation', 'daily_signal')),
  constraint research_jobs_status_chk
    check (status in ('queued', 'running', 'done', 'error'))
);

create index if not exists research_jobs_user_idx
  on public.research_jobs (user_id, created_at desc);
create index if not exists research_jobs_status_idx
  on public.research_jobs (status);

alter table public.research_jobs enable row level security;

-- Users watch their own jobs; the worker writes with the service role.
drop policy if exists "Users can read own jobs" on public.research_jobs;
create policy "Users can read own jobs"
  on public.research_jobs
  for select
  to authenticated
  using (auth.uid() = user_id);

notify pgrst, 'reload schema';
