-- One written explanation per Insight headline, shared by every install.
-- Written by the desktop main process with the service-role key; readers only
-- ever go through that process, so no anon policy is granted here.
create table if not exists public.insight_explanations (
  cache_key text primary key,
  run_id text not null,
  headline text not null,
  summary text not null,
  points jsonb not null default '[]'::jsonb,
  model text not null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists insight_explanations_run_id_idx
  on public.insight_explanations (run_id);

alter table public.insight_explanations enable row level security;
