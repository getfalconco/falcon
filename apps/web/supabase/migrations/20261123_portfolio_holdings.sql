-- The member's portfolio with sizes: accounts (balances) and positions from
-- a broker import (SnapTrade, read once), a screenshot or a CSV, and the
-- member's paper account (source 'paper').
--
-- The paper account lives here rather than in the old desktop app's
-- public.paper_portfolios: that table holds one row per user in the desktop
-- app's own positions format, and its rows are left untouched.
-- Types, validation and valuation: apps/web/lib/portfolio-holdings.ts;
-- reads and writes: apps/web/lib/portfolio-store.ts through
-- /api/portfolio/holdings and the import routes.
--
-- Until this is applied the app saves no sizes: the routes see the missing
-- table (isMissingTable), answer { available: false }, and the UI says sizes
-- are not stored yet. Tickers keep living in onboarding_responses.watchlist.
--
-- Not related to the old desktop app's paper_portfolios, portfolio_snapshots,
-- broker_links or snaptrade_secrets, which stay as they are.
--
-- Privacy:
--   * Amounts are personal financial data. ADMIN TOOLS MUST NEVER SELECT
--     THESE TABLES (no admin page, analytics query or export reads them).
--   * Account ids are 'screenshot', 'csv', 'paper' (the member's paper
--     account: a cash balance they chose, no positions yet; lib/paper-account.ts)
--     or 'b_' + 24 hex of
--     sha256(user_id:snaptrade_account_id): never the raw SnapTrade id, and
--     never the account number beyond its last 4 characters.
--   * A member can read only their own rows with their own token; every write
--     goes through the API routes with the service role.
--
-- Rollback (run by hand if needed):
--   drop table if exists public.portfolio_positions;
--   drop table if exists public.portfolio_accounts;
--   notify pgrst, 'reload schema';

create table if not exists public.portfolio_accounts (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null check (id ~ '^(screenshot|csv|paper|b_[0-9a-f]{24})$'),
  source text not null check (source in ('broker', 'screenshot', 'csv', 'paper')),
  name text check (name is null or char_length(name) <= 80),
  institution text check (institution is null or char_length(institution) <= 80),
  number_last4 text check (number_last4 is null or number_last4 ~ '^[A-Za-z0-9]{1,4}$'),
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  total_value numeric,
  cash numeric,
  buying_power numeric,
  holdings_unavailable boolean not null default false,
  as_of timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create table if not exists public.portfolio_positions (
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id text not null,
  kind text not null check (kind in ('stock', 'etf', 'fund', 'adr', 'option', 'crypto', 'future', 'other')),
  -- The instrument's own symbol: ticker, OCC option symbol, crypto symbol ("BTC").
  symbol text not null check (char_length(symbol) between 1 and 32),
  -- Equity ticker or an option's underlying, for matching Sightings and the graph; null for crypto, futures, others.
  ticker text check (ticker is null or char_length(ticker) <= 10),
  name text not null default '' check (char_length(name) <= 120),
  -- Negative for a short.
  quantity numeric,
  avg_cost numeric check (avg_cost is null or avg_cost >= 0),
  price numeric check (price is null or price >= 0),
  market_value numeric,
  -- Only when the source reported it (or its price and cost basis).
  unrealized_pnl numeric,
  currency text check (currency is null or currency ~ '^[A-Z]{3}$'),
  option_type text check (option_type is null or option_type in ('call', 'put')),
  strike numeric check (strike is null or strike > 0),
  expiry date,
  multiplier numeric check (multiplier is null or multiplier > 0),
  as_of timestamptz,
  updated_at timestamptz not null default now(),
  primary key (user_id, account_id, kind, symbol),
  foreign key (user_id, account_id) references public.portfolio_accounts (user_id, id) on delete cascade
);

create index if not exists portfolio_positions_user_ticker_idx on public.portfolio_positions (user_id, ticker);

alter table public.portfolio_accounts enable row level security;
alter table public.portfolio_positions enable row level security;

drop policy if exists portfolio_accounts_own_select on public.portfolio_accounts;
drop policy if exists portfolio_positions_own_select on public.portfolio_positions;
create policy portfolio_accounts_own_select on public.portfolio_accounts for select to authenticated using (user_id = auth.uid());
create policy portfolio_positions_own_select on public.portfolio_positions for select to authenticated using (user_id = auth.uid());

-- Writes by the service role only (the API routes); nothing for anon or public.
revoke all on public.portfolio_accounts from anon, public;
revoke all on public.portfolio_positions from anon, public;
revoke insert, update, delete, truncate on public.portfolio_accounts from authenticated;
revoke insert, update, delete, truncate on public.portfolio_positions from authenticated;
grant select on public.portfolio_accounts to authenticated;
grant select on public.portfolio_positions to authenticated;
grant all on public.portfolio_accounts to service_role;
grant all on public.portfolio_positions to service_role;

comment on table public.portfolio_accounts is 'Member portfolio accounts and balances (broker/screenshot/csv). Personal financial data: admin tools must never select this table.';
comment on table public.portfolio_positions is 'Member portfolio positions with sizes. Personal financial data: admin tools must never select this table.';

notify pgrst, 'reload schema';
