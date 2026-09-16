-- Shared brokerage links (SnapTrade live accounts) + secret store.
--
-- 1. broker_links — snapshot of connected live brokerages. Desktop renderer and
--    mobile read this with the anon key + RLS. Writes go through Electron main
--    / research-worker with the service-role key so SnapTrade secrets never
--    reach a renderer.
-- 2. snaptrade_secrets — SnapTrade userId + userSecret, keyed by auth.users.
--    No SELECT policy for authenticated/anon; only service_role.
--
-- Paper trading is a separate table: public.paper_portfolios.
-- Run this in the Supabase SQL editor (or via ensure-broker-links-schema).

create table if not exists public.broker_links (
  user_id uuid primary key references auth.users (id) on delete cascade,
  snaptrade_user_id text,
  connected boolean not null default false,
  total numeric not null default 0,
  accounts jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.broker_links enable row level security;

drop policy if exists "broker_links_select_own" on public.broker_links;
create policy "broker_links_select_own"
  on public.broker_links
  for select
  to authenticated
  using ((select auth.uid()) = user_id);

grant select on table public.broker_links to authenticated;
grant all on table public.broker_links to service_role;
revoke insert, update, delete on table public.broker_links from anon, authenticated;

create table if not exists public.snaptrade_secrets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  snaptrade_user_id text not null,
  user_secret text not null,
  updated_at timestamptz not null default now()
);

alter table public.snaptrade_secrets enable row level security;

revoke all on table public.snaptrade_secrets from public, anon, authenticated;
grant all on table public.snaptrade_secrets to service_role;

notify pgrst, 'reload schema';
