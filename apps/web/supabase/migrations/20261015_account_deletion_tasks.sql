-- Account deletion: cleanup tasks that must outlive the account they describe.
--
-- When an account is deleted (apps/research-worker POST /api/account/delete,
-- or apps/web /api/account/delete), one row per cleanup is written here
-- BEFORE the auth user is deleted: the account's SnapTrade user, and its risk
-- data on the engine. A cleanup that fails stays 'pending' with a backoff and
-- the research-worker retries it every 5 minutes (src/account-deletion.ts).
--
-- No foreign key to auth.users on purpose: the rows must survive the delete.
-- The payload holds only what the retry needs (the SnapTrade user id, which
-- is not a secret: SnapTrade's delete call is signed with Falcon's consumer
-- key). Service role only; no client ever reads this table.

create table if not exists public.account_deletion_tasks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  task text not null check (task in ('snaptrade_user', 'engine_risk')),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'pending' check (status in ('pending', 'done', 'failed', 'cancelled')),
  attempts integer not null default 0,
  last_error text,
  next_attempt_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists account_deletion_tasks_due_idx
  on public.account_deletion_tasks (next_attempt_at)
  where status = 'pending';

create index if not exists account_deletion_tasks_user_idx
  on public.account_deletion_tasks (user_id);

alter table public.account_deletion_tasks enable row level security;

revoke all on table public.account_deletion_tasks from public, anon, authenticated;
grant all on table public.account_deletion_tasks to service_role;

-- The SnapTrade user secret is encrypted by the application (AES-256-GCM,
-- key in SNAPTRADE_SECRET_KEY on the research-worker). The column keeps its
-- type: a sealed value reads `enc:v1:<nonce>:<tag>:<ciphertext>`, and rows
-- written before encryption are re-sealed the next time they are read.
comment on column public.snaptrade_secrets.user_secret is
  'SnapTrade user secret. enc:v1:<nonce>:<tag>:<ciphertext> = AES-256-GCM sealed by the app (SNAPTRADE_SECRET_KEY, AAD = user_id); any other value is a legacy plaintext row awaiting lazy re-encryption.';

notify pgrst, 'reload schema';
