-- Falcon AI daily usage per member (apps/web/lib/desk/limits.ts): dollars of
-- model spend and requests per New York day, for the daily budget
-- (DESK_DAILY_USD, default $5; DESK_DAILY_REQUESTS, default 300).
--
--   desk_usage:      one row per member and New York day.
--   desk_usage_add:  atomic increment (insert or add), called by the website
--                    over PostgREST rpc with the service role.
--
-- Written and read only with the service role: RLS on with no policies,
-- nothing granted to anon or authenticated. Additive and idempotent. Until it
-- is applied, the website keeps usage in memory per instance.
--
-- Rollback:
--   drop function if exists public.desk_usage_add(uuid, date, numeric, integer);
--   drop table if exists public.desk_usage;

create table if not exists public.desk_usage (
  user_id uuid not null,
  day date not null,
  usd numeric(12, 6) not null default 0,
  requests integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (user_id, day)
);

create index if not exists desk_usage_day_idx on public.desk_usage (day desc);

alter table public.desk_usage enable row level security;
revoke all on public.desk_usage from anon, authenticated;

create or replace function public.desk_usage_add(p_user uuid, p_day date, p_usd numeric, p_requests integer)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into public.desk_usage as u (user_id, day, usd, requests, updated_at)
  values (p_user, p_day, greatest(p_usd, 0), greatest(p_requests, 0), now())
  on conflict (user_id, day) do update
    set usd = u.usd + excluded.usd,
        requests = u.requests + excluded.requests,
        updated_at = now();
$$;

revoke all on function public.desk_usage_add(uuid, date, numeric, integer) from public, anon, authenticated;
grant execute on function public.desk_usage_add(uuid, date, numeric, integer) to service_role;
