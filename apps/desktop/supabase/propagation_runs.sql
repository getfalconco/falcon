-- Propagation runs — the second-order engine's output, shared across installs.
--
-- Each desktop's propagation engine writes its runs to a local runs.json. A
-- fresh install therefore opens on an empty Insight card until its own engine
-- has produced something, and two installs never see the same run. This table
-- is the shared copy: every install pushes the runs it produces and pulls the
-- ones it hasn't seen, so the card reads the same network everywhere.
--
-- A run is stored whole, as the JSON the engine already emits (schema_version
-- inside the document), rather than decomposed into columns: the renderer
-- consumes the object as-is, the engine's shape is still moving, and at a few
-- KB per run there is nothing to gain from normalising it.
--
-- Access model (no service-role key on the desktop):
--   * read  — anon + authenticated
--   * write — authenticated users only, with their own JWT
create table if not exists public.propagation_runs (
  run_id       text primary key,
  incident_id  text not null,
  root_ticker  text not null,
  produced_at  timestamptz not null,
  superseded   boolean not null default false,
  synthetic    boolean not null default false,
  run          jsonb not null,
  pushed_by    text,                                 -- 'desktop' | 'worker' | 'seed'
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table public.propagation_runs enable row level security;

drop policy if exists propagation_runs_read on public.propagation_runs;
create policy propagation_runs_read
  on public.propagation_runs for select
  to anon, authenticated
  using (true);

drop policy if exists propagation_runs_insert on public.propagation_runs;
create policy propagation_runs_insert
  on public.propagation_runs for insert
  to authenticated
  with check (true);

drop policy if exists propagation_runs_update on public.propagation_runs;
create policy propagation_runs_update
  on public.propagation_runs for update
  to authenticated
  using (true)
  with check (true);

-- Deliberately no delete policy: a superseded run is marked, never removed,
-- so no install resurrects it from a stale local copy.

create index if not exists propagation_runs_produced_idx
  on public.propagation_runs (produced_at desc);
create index if not exists propagation_runs_incident_idx
  on public.propagation_runs (incident_id);
