-- Heartbeat/health telemetry for the always-on engines (currently the Railway
-- news-worker). One row per engine id, upserted every cycle. The web admin
-- "Engine health" tab reads it; writers use the service-role key (bypasses RLS).

create table if not exists public.engine_health (
  id text primary key,                 -- engine identifier, e.g. 'news-worker'
  updated_at timestamptz not null default now(),
  started_at timestamptz,              -- process boot time (for uptime)
  status text not null default 'ok',   -- 'ok' | 'error'
  last_error text,
  last_poll_at timestamptz,
  last_summary text,
  articles_checked integer,
  new_events integer,
  signals_saved integer,
  events_deduped integer,
  cycle_ms integer,
  poll_interval_ms integer,
  cycles integer,                      -- total cycles since boot
  errors integer,                      -- total error cycles since boot
  version text
);

alter table public.engine_health enable row level security;
-- No policies: only the service role (which bypasses RLS) reads/writes.
