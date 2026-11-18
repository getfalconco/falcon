-- The member's holdings over time, for the Dashboard's Equity chart: one row
-- every time the stored holdings change (a broker, screenshot or CSV import,
-- a paper account created or cleared, Clear portfolio, a pruned ticker list),
-- holding the FULL holdings from that moment on, never a diff. The chart is
-- rebuilt from these rows x market prices (apps/web/lib/workspace/equity.ts);
-- it starts at the first row, so it shows only real history.
--
-- Writes: apps/web/lib/portfolio-store.ts (recordSnapshot), after each write
-- to portfolio_accounts / portfolio_positions; skipped when nothing changed.
-- A member who already had holdings before this table gets a first row
-- ('initial') the first time the chart is asked for; their history starts then.
-- Reads: GET /api/portfolio/equity (the curve is computed on the server, so
-- quantities never leave it; the browser gets values only).
--
-- NOT the old desktop app's public.portfolio_snapshots, which stays untouched.
--
-- Privacy:
--   * Quantities and balances are personal financial data. ADMIN TOOLS MUST
--     NEVER SELECT THIS TABLE (no admin page, analytics query or export reads it).
--   * No names, institutions, account numbers or costs: account ids are the
--     same opaque ids as portfolio_accounts ('screenshot', 'csv', 'paper' or
--     'b_' + 24 hex of a hash), positions are {account_id, kind, symbol,
--     ticker, quantity, multiplier, currency, price}, cash is {account_id,
--     currency, cash}. `price` is the import's price per unit, used only for
--     options, futures and others, which have no price history here.
--   * A member can read only their own rows with their own token; every write
--     goes through the API routes with the service role. Rows go with the
--     account (on delete cascade).
--
-- Rollback (run by hand if needed):
--   drop table if exists public.portfolio_holdings_history;
--   notify pgrst, 'reload schema';

create table if not exists public.portfolio_holdings_history (
  user_id uuid not null references auth.users (id) on delete cascade,
  -- From when these holdings are in force.
  effective_at timestamptz not null,
  -- What changed them: an import's source, the paper account, Clear portfolio, a pruned
  -- ticker list, or the first row for a member who had holdings before this table.
  source text not null check (source in ('broker', 'screenshot', 'csv', 'paper', 'clear', 'prune', 'initial')),
  -- [{account_id, kind, symbol, ticker, quantity, multiplier, currency, price}], sorted; [] after Clear portfolio.
  positions jsonb not null default '[]'::jsonb check (jsonb_typeof(positions) = 'array' and jsonb_array_length(positions) <= 1000),
  -- [{account_id, currency, cash}]
  cash jsonb not null default '[]'::jsonb check (jsonb_typeof(cash) = 'array' and jsonb_array_length(cash) <= 100),
  created_at timestamptz not null default now(),
  primary key (user_id, effective_at)
);

alter table public.portfolio_holdings_history enable row level security;

drop policy if exists portfolio_holdings_history_own_select on public.portfolio_holdings_history;
create policy portfolio_holdings_history_own_select on public.portfolio_holdings_history for select to authenticated using (user_id = auth.uid());

-- Writes by the service role only (the API routes); nothing for anon or public.
revoke all on public.portfolio_holdings_history from anon, public;
revoke insert, update, delete, truncate on public.portfolio_holdings_history from authenticated;
grant select on public.portfolio_holdings_history to authenticated;
grant all on public.portfolio_holdings_history to service_role;

comment on table public.portfolio_holdings_history is 'Member holdings snapshots (full holdings each time they change) for the Equity chart. Personal financial data: admin tools must never select this table.';

notify pgrst, 'reload schema';
