-- One written explanation per (Insight headline, affected name), shared by
-- every install. Written by the desktop main process with the service-role
-- key; readers only ever go through that process, so no anon policy here.
create table if not exists public.insight_pair_explanations (
  cache_key text primary key,
  run_id text not null,
  target text not null,
  headline text not null,
  outlook jsonb,
  why text not null,
  precedent text not null,
  this_time text not null,
  watch jsonb not null default '[]'::jsonb,
  model text not null,
  generated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists insight_pair_explanations_run_id_idx
  on public.insight_pair_explanations (run_id);

alter table public.insight_pair_explanations enable row level security;

-- Added after the first rows landed; existing ones simply have no outlook.
alter table public.insight_pair_explanations
  add column if not exists outlook jsonb;
