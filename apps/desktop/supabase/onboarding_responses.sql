-- Run once in Supabase SQL editor (or via the app's auto-ensure on startup
-- when DATABASE_URL is set). Full onboarding questionnaire responses, kept
-- separate from the auth.users user_metadata fields that gate app access —
-- this table is the source of truth for the future admin panel.

create table if not exists public.onboarding_responses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references auth.users (id) on delete cascade,
  full_name text,
  phone text,
  investor_role text,
  investor_role_other text,
  investing_tenure text,
  research_focus text,
  research_trigger text,
  research_frustration text,
  research_method text,
  sectors jsonb not null default '[]'::jsonb,
  watchlist jsonb not null default '[]'::jsonb,
  wants_watchlist_signals boolean,
  update_frequency text,
  notify_second_order_effects boolean,
  country text,
  heard_about text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Additive column for pre-existing tables (create table above is a no-op then).
alter table public.onboarding_responses
  add column if not exists investor_role_other text;

create index if not exists onboarding_responses_user_id_idx
  on public.onboarding_responses (user_id);

alter table public.onboarding_responses enable row level security;

drop policy if exists "Users can read own onboarding response" on public.onboarding_responses;
create policy "Users can read own onboarding response"
  on public.onboarding_responses
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "Users can insert own onboarding response" on public.onboarding_responses;
create policy "Users can insert own onboarding response"
  on public.onboarding_responses
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "Users can update own onboarding response" on public.onboarding_responses;
create policy "Users can update own onboarding response"
  on public.onboarding_responses
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- PostgREST schema cache (Supabase API) picks up new tables after notify.
notify pgrst, 'reload schema';
