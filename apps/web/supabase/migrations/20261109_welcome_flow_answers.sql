-- Welcome flow (apps/web/app/welcome): the answers a member gives right after
-- signing in, on their existing onboarding_responses row (one per user),
-- written server-side by POST /api/onboarding with the service role.
--
-- Already in the table and reused: investing_tenure, research_frustration,
-- sectors, watchlist (tickers), heard_about. Added here:

alter table public.onboarding_responses
  add column if not exists main_goal text,
  add column if not exists portfolio_size text,
  add column if not exists missed_moves text,
  add column if not exists research_time text,
  add column if not exists heard_about_other text,
  add column if not exists notifications_permission text,
  add column if not exists morning_commitment boolean,
  add column if not exists welcome_completed_at timestamptz;

-- portfolio_size feeds pricing: only these four values may ever be stored.
alter table public.onboarding_responses
  drop constraint if exists onboarding_responses_portfolio_size_check,
  drop constraint if exists onboarding_responses_main_goal_check;
alter table public.onboarding_responses
  add constraint onboarding_responses_portfolio_size_check
    check (portfolio_size is null or portfolio_size in ('under_10k', '10k_50k', '50k_250k', '250k_plus')),
  add constraint onboarding_responses_main_goal_check
    check (main_goal is null or main_goal in (
      'grow_wealth', 'catch_big_moves', 'protect_portfolio', 'smarter_investor'
    ));

notify pgrst, 'reload schema';
