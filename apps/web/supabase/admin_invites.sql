-- Single-use invite links that grant an internal role (staff | manager | talent).
-- Created by an admin in the web admin panel, claimed once by a signed-in user.
-- Only the service role (which bypasses RLS) reads/writes this table.

create table if not exists public.admin_invites (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  role text not null check (role in ('staff', 'deputy', 'leader', 'talent_manager')),
  created_by text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  claimed_at timestamptz,
  claimed_by uuid references auth.users(id) on delete set null,
  claimed_email text
);

create index if not exists admin_invites_token_idx on public.admin_invites (token);
create index if not exists admin_invites_created_idx on public.admin_invites (created_at desc);

alter table public.admin_invites enable row level security;
-- Intentionally no policies: the web server uses the service-role key, which
-- bypasses RLS. No anon/authenticated client should ever touch this table.
