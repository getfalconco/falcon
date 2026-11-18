-- The scoreboard: Falcon's forecasts against the options market's
-- (packages/engine/src/study/scoreboard.ts). One row per matchup, written at
-- the forecast's creation with the market's number of the same session, and
-- completed once its horizon has closed.
--
--   kind = 'forecast'  one Falcon forecast (a ripple_forecasts row; key
--                      'rf:<id>'), horizon = window_days sessions. Market: the
--                      ATM IV interpolated in total variance to the horizon's
--                      last session from options_daily.metrics.raw.term, x
--                      sqrt(L/252) x sqrt(2/pi); market_adj_pct takes
--                      beta^2 VIX^2 out of the variance (Falcon's abnormal units).
--   kind = 'earnings'  one earnings release (historical_events, event_kind
--                      'earnings'; key 'earn:<ticker>:<event_date>'). Market:
--                      options_daily.metrics.earnings_straddle of the session
--                      before the reaction day (15:45 New York, first expiry
--                      covering the reaction): (call_mid + put_mid) / spot.
--                      Falcon: the trailing mean |reaction| over the company's
--                      4 to 8 earlier releases (raw units, like the straddle).
--   market_method 'card_block': no options_daily row for the name that
--                      session; the Sightings card's own options block
--                      (impliedMove5 / impliedMove20) is used when the horizon
--                      is 5 or 20 sessions.
--
-- Units: percent (4.1 = 4.1%), volatilities as fractions (0.42), like the
-- engine's raw metrics. Moves are measured from the close of base_date (the
-- options snapshot session, the last completed session at creation) to the
-- close of exit_date (horizon_sessions NYSE sessions later); abnormal = stock
-- minus its SPDR sector ETF over the same closes (SPY when no sector).
--
-- Written once at creation (market side frozen; the market columns are never
-- updated), outcome columns filled by a later resolver run. Internal research
-- data like ripple_forecasts: RLS on, no policies, nothing granted to anon or
-- authenticated; read by the Falcon AI /scoreboard tool with the service role.
-- Additive and idempotent; NOT applied yet (founder's go-ahead first). Apply
-- with `pnpm --filter @falcon/engine run migrate`.
--
-- Rollback:
--   drop table if exists public.forecast_matchups;

create table if not exists public.forecast_matchups (
  key text primary key,
  kind text not null check (kind in ('forecast', 'earnings')),
  forecast_id bigint references public.ripple_forecasts(id),
  event_id text,
  card_id text,
  ticker text not null,
  created_at timestamptz not null,
  recorded_at timestamptz not null default now(),
  horizon_sessions int not null check (horizon_sessions between 1 and 63),
  base_date date not null,
  exit_date date not null,

  -- Falcon's side at creation.
  falcon_sign int not null check (falcon_sign in (-1, 0, 1)),
  falcon_abs_pct double precision,
  falcon_signed_pct double precision,
  falcon_source text check (falcon_source in ('record', 'documented', 'trailing_reactions')),
  falcon_sample int,
  tier text check (tier in ('measured', 'documented', 'watch')),
  confidence text check (confidence in ('low', 'medium', 'high')),
  family text,
  published boolean,
  model_version text,

  -- The market's side at creation (never updated).
  market_method text not null check (market_method in ('term_interp', 'earnings_straddle', 'card_block')),
  market_raw_pct double precision,
  market_adj_pct double precision,
  market_iv double precision,
  market_interp text,
  atm_iv30 double precision,
  skew double precision,
  spot double precision,
  beta double precision,
  vix double precision,
  options_as_of timestamptz,
  options_session date,
  options_lag_sessions int,
  straddle jsonb,
  units text not null check (units in ('abnormal', 'raw')),

  -- The outcome (null until exit_date has closed).
  benchmark text,
  realized_raw_pct double precision,
  benchmark_pct double precision,
  realized_abn_pct double precision,
  price_source text,
  resolved_at timestamptz,

  -- Scores (scoreMatchup), stored with the outcome for fast reads.
  dir_hit boolean,
  falcon_err double precision,
  market_err double precision,
  ratio double precision,
  pnl_dir double precision,
  pnl_straddle double precision,
  pnl_vol double precision,
  score_version text
);

create index if not exists forecast_matchups_ticker_idx on public.forecast_matchups (ticker, base_date desc);
create index if not exists forecast_matchups_exit_idx on public.forecast_matchups (exit_date) where resolved_at is null;
create index if not exists forecast_matchups_kind_idx on public.forecast_matchups (kind, base_date desc);

alter table public.forecast_matchups enable row level security;
revoke all on table public.forecast_matchups from anon, authenticated;

comment on table public.forecast_matchups is
  'Scoreboard: Falcon forecast vs the options market''s implied move, one row per matchup (packages/engine study/scoreboard.ts). Internal.';
