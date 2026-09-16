-- Run once in the Supabase SQL editor.
-- Classified material news events — the input side of propagation. Written by
-- the news-worker (service role) so mobile/web can read the same feed instead
-- of it living only in the worker's local JSON files.

create table if not exists public.material_news_events (
  id text primary key,
  article_id bigint not null,
  ticker text not null,
  headline text not null,
  source_url text not null default '',
  source_urls jsonb not null default '[]'::jsonb,
  article_datetime bigint not null,
  classified_at timestamptz not null default now(),
  event_type text not null,
  affected_ticker text not null,
  direction_on_primary text not null,
  summary text not null default '',
  confidence double precision not null default 0,
  merged_from jsonb,
  event_date date not null,
  created_at timestamptz not null default now()
);

-- Newest-first listing, plus per-ticker and per-day filters.
create index if not exists material_news_events_datetime_idx
  on public.material_news_events (article_datetime desc);
create index if not exists material_news_events_event_date_idx
  on public.material_news_events (event_date desc);
create index if not exists material_news_events_ticker_idx
  on public.material_news_events (ticker);

alter table public.material_news_events enable row level security;

-- Only approved members read (approved flag is service-role-written app_metadata,
-- embedded in the JWT). Waitlist accounts are `authenticated` but not approved.
drop policy if exists "Authenticated users can read news events" on public.material_news_events;
drop policy if exists "Approved members can read news events" on public.material_news_events;
create policy "Approved members can read news events"
  on public.material_news_events
  for select
  to authenticated
  using (coalesce((auth.jwt() -> 'app_metadata' ->> 'approved')::boolean, false));

-- Service role (news-worker) bypasses RLS for upserts.

notify pgrst, 'reload schema';
