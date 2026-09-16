-- Run once in the Supabase SQL editor.
-- Counterparty relationship edges extracted from SEC filings (step1). These are
-- what propagation traverses; persisting them lets mobile/web render the graph
-- instead of it living only in the desktop's local data/graph.json.

create table if not exists public.graph_edges (
  id text primary key,
  root_ticker text not null,
  counterparty_id text not null,
  counterparty_name text not null,
  counterparty_ticker text,
  category text not null,
  subtype text not null default '',
  confidence double precision not null default 0,
  -- Edge-strength scoring (step1/strength.ts).
  strength double precision,
  strength_tier text,
  evidence_quote text not null default '',
  source_url text not null default '',
  valid_from text,
  updated_at timestamptz not null default now()
);

create index if not exists graph_edges_root_ticker_idx
  on public.graph_edges (root_ticker);
create index if not exists graph_edges_counterparty_ticker_idx
  on public.graph_edges (counterparty_ticker);

alter table public.graph_edges enable row level security;

-- Only approved members read (approved flag is service-role-written app_metadata,
-- embedded in the JWT). Waitlist accounts are `authenticated` but not approved.
drop policy if exists "Authenticated users can read graph edges" on public.graph_edges;
drop policy if exists "Approved members can read graph edges" on public.graph_edges;
create policy "Approved members can read graph edges"
  on public.graph_edges
  for select
  to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'approved')::boolean, false));

-- Service role (news-worker / desktop main) bypasses RLS for upserts.

notify pgrst, 'reload schema';
