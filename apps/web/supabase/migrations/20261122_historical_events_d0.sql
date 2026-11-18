-- historical_events: single-day moves and the kind of each Item 2.02 filing
-- (packages/engine/scripts/earnings-events.ts, phases classify + build + write).
--
--   stock_return_d0 / etf_return_d0     close(d0) / close(d-1) - 1, the event day alone.
--   stock_return_d1 / etf_return_d1     close(d1) / close(d0) - 1, the next session alone.
--   abnormal_return_d0 / _d1            stock - ETF on that day (same ETF and price
--                                       source as the two-day columns).
--   The two-day columns are unchanged: (1 + r_d0)(1 + r_d1) - 1 = r_d0_d1 for the
--   stock and the ETF; abnormal_return_d0_d1 compounds each leg first, so it is
--   not abnormal_return_d0 + abnormal_return_d1. d0 can be set while the d1
--   columns are NULL (the d1 close is not in yet).
--   event_kind     'earnings' (the quarterly or annual results release),
--                  'preliminary' (pre-announced or estimated results, guidance
--                  changes outside a results release), 'operational_update'
--                  (production and deliveries, monthly sales or traffic,
--                  operating statistics), 'other' (8-K/A re-filings, investor
--                  days, recasts, second filings in a reporting window).
--   kind_reason    the evidence: timing against the 10-Q / 10-K window and/or the
--                  filing's own wording.
--
-- Additive and idempotent. Rollback:
--   alter table public.historical_events
--     drop column if exists abnormal_return_d0, drop column if exists stock_return_d0,
--     drop column if exists etf_return_d0, drop column if exists abnormal_return_d1,
--     drop column if exists stock_return_d1, drop column if exists etf_return_d1,
--     drop column if exists event_kind, drop column if exists kind_reason;
--   drop index if exists public.historical_events_kind_ticker_date_idx;

alter table public.historical_events
  add column if not exists abnormal_return_d0 double precision,
  add column if not exists stock_return_d0 double precision,
  add column if not exists etf_return_d0 double precision,
  add column if not exists abnormal_return_d1 double precision,
  add column if not exists stock_return_d1 double precision,
  add column if not exists etf_return_d1 double precision,
  add column if not exists event_kind text,
  add column if not exists kind_reason text;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'historical_events_event_kind_check') then
    alter table public.historical_events
      add constraint historical_events_event_kind_check
      check (event_kind is null or event_kind in ('earnings', 'preliminary', 'operational_update', 'other'));
  end if;
end $$;

create index if not exists historical_events_kind_ticker_date_idx on public.historical_events (event_kind, ticker, event_date desc);

comment on column public.historical_events.abnormal_return_d0 is 'Event day alone: stock_return_d0 - etf_return_d0.';
comment on column public.historical_events.abnormal_return_d1 is 'Next session alone: stock_return_d1 - etf_return_d1.';
comment on column public.historical_events.event_kind is 'earnings | preliminary | operational_update | other (see kind_reason).';
