-- Falcon AI (the Desk chat) per account: sessions and memory.
--
-- Until this is applied the app keeps both in the browser (localStorage):
-- /api/desk/sessions answers { available: false } while the table is missing
-- and the client never calls it again in that page visit
-- (apps/web/app/app/_components/lab/session-store.ts).
--
-- The API routes write with the service role and always filter by the
-- signed-in member's id; RLS also lets a member read and write only their own
-- rows with their own token.

create table if not exists public.desk_sessions (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- The client's id (a UUID from crypto.randomUUID, text so older ids still fit).
  id text not null check (char_length(id) between 1 and 64),
  title text not null default 'New session' check (char_length(title) <= 200),
  pinned boolean not null default false,
  sort_order integer not null default 0,
  folder text check (folder is null or char_length(folder) <= 100),
  -- LabMessage[] (apps/web/app/app/_components/lab/sessions.ts), pruned like the browser copy.
  messages jsonb not null default '[]'::jsonb check (jsonb_typeof(messages) = 'array'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists desk_sessions_user_order_idx on public.desk_sessions (user_id, pinned desc, sort_order);

alter table public.desk_sessions enable row level security;

drop policy if exists desk_sessions_own_select on public.desk_sessions;
drop policy if exists desk_sessions_own_insert on public.desk_sessions;
drop policy if exists desk_sessions_own_update on public.desk_sessions;
drop policy if exists desk_sessions_own_delete on public.desk_sessions;
create policy desk_sessions_own_select on public.desk_sessions for select to authenticated using (user_id = auth.uid());
create policy desk_sessions_own_insert on public.desk_sessions for insert to authenticated with check (user_id = auth.uid());
create policy desk_sessions_own_update on public.desk_sessions for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy desk_sessions_own_delete on public.desk_sessions for delete to authenticated using (user_id = auth.uid());

-- What Falcon AI remembers about a member across sessions (lib/desk/memory.ts):
-- short preferences and facts saved with the remember tool, at most 30 per member.
create table if not exists public.desk_memory (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null check (char_length(id) between 1 and 64),
  text text not null check (char_length(text) between 1 and 200),
  created_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.desk_memory enable row level security;

drop policy if exists desk_memory_own_select on public.desk_memory;
drop policy if exists desk_memory_own_insert on public.desk_memory;
drop policy if exists desk_memory_own_update on public.desk_memory;
drop policy if exists desk_memory_own_delete on public.desk_memory;
create policy desk_memory_own_select on public.desk_memory for select to authenticated using (user_id = auth.uid());
create policy desk_memory_own_insert on public.desk_memory for insert to authenticated with check (user_id = auth.uid());
create policy desk_memory_own_update on public.desk_memory for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy desk_memory_own_delete on public.desk_memory for delete to authenticated using (user_id = auth.uid());

notify pgrst, 'reload schema';
