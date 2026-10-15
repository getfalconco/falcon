-- portfolio_snapshots retention support.
--
-- The engine (apps/falcon-engine/src/portfolio-retention.ts) now downsamples
-- old rows: one per minute after a day, one per hour after 7 days, one per
-- day after 90 days. It walks each user's rows oldest first with a keyset on
-- (ts, id) and finds users with a keyset on user_id. This index makes both a
-- pure range scan (no re-reading earlier pages, no sort on the id tie-break).
-- It also serves the desktop/mobile chart read (user_id = auth.uid(),
-- ts >= cutoff, order by ts desc) with a backward scan.
--
-- Large table: a plain CREATE INDEX blocks inserts while it builds. To avoid
-- that, run the statement by hand in the SQL editor as
--   create index concurrently if not exists portfolio_snapshots_user_ts_id
--     on public.portfolio_snapshots (user_id, ts, id);
-- (CONCURRENTLY cannot run inside a migration transaction.)
create index if not exists portfolio_snapshots_user_ts_id
  on public.portfolio_snapshots (user_id, ts, id);

-- The original (user_id, ts desc) index from apps/desktop/supabase/
-- portfolio_tracking.sql is redundant once the one above exists. Drop it only
-- after confirming the new index is valid:
--   drop index if exists public.portfolio_snapshots_user_ts;
