-- Ripple Engine v1: judge once (docs/design/ripple-engine-v1.md 5.1, a3).
-- One row per (event, candidate set): the voted answers of the judge for an
-- event, reused by later runs as long as the event's candidates (and the
-- judge prompt version, part of the hash) are unchanged. Written by
-- packages/engine (src/ledger.ts, insert ... on conflict do nothing).
-- Internal research data: RLS on, no policies, so the anon and
-- authenticated roles (the anon key ships in the iPhone app) read nothing.
-- Idempotent; applied by `pnpm --filter @falcon/engine run migrate`.

create table if not exists public.ripple_judgments (
  event_id text not null,
  candidates_hash text not null,
  judged_at timestamptz not null default now(),
  models text[] not null default '{}',
  votes jsonb not null,
  hits jsonb not null,
  cost_usd real,
  primary key (event_id, candidates_hash)
);

alter table public.ripple_judgments enable row level security;
revoke all on table public.ripple_judgments from anon, authenticated;

comment on table public.ripple_judgments is
  'Ripple Engine judge-once store: voted judge answers per (event_id, candidates_hash). Internal; written by packages/engine.';
