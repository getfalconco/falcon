import { FUNNEL_TEST_MODE, apiUrl } from "./env";
import { accessToken } from "./supabase";

/**
 * The welcome funnel's options, answers and score. Mirrors the website's
 * apps/web/lib/onboarding.ts (same ids, labels and scoring) so answers saved
 * from the app match what POST /api/onboarding accepts.
 */

type Option<Id extends string> = { readonly id: Id; readonly label: string };

export const GOALS = [
  { id: "grow_wealth", label: "Grow my wealth faster" },
  { id: "catch_big_moves", label: "Stop missing big moves" },
  { id: "protect_portfolio", label: "Protect my portfolio" },
  { id: "smarter_investor", label: "Become a smarter investor" },
] as const satisfies readonly Option<string>[];

export const TENURES = [
  { id: "less_than_one_year", label: "Less than 1 year" },
  { id: "one_to_three_years", label: "1 to 3 years" },
  { id: "three_to_ten_years", label: "3 to 10 years" },
  { id: "ten_plus_years", label: "10+ years" },
] as const satisfies readonly Option<string>[];

export const PORTFOLIO_SIZES = [
  { id: "under_10k", label: "Under $10K" },
  { id: "10k_50k", label: "$10K to $50K" },
  { id: "50k_250k", label: "$50K to $250K" },
  { id: "250k_plus", label: "$250K+" },
] as const satisfies readonly Option<string>[];

export const FRUSTRATIONS = [
  { id: "news_too_late", label: "I hear about news too late" },
  { id: "too_much_noise", label: "Too much noise" },
  { id: "unclear_impact", label: "I don't know how news hits my stocks" },
  { id: "emotional_trading", label: "I trade on emotion" },
] as const satisfies readonly Option<string>[];

export const MISSED_MOVES = [
  { id: "often", label: "Often" },
  { id: "sometimes", label: "Sometimes" },
  { id: "rarely", label: "Rarely" },
] as const satisfies readonly Option<string>[];

export const RESEARCH_TIMES = [
  { id: "under_15_min", label: "Under 15 min" },
  { id: "15_to_60_min", label: "15 to 60 min" },
  { id: "over_1_hour", label: "1h+" },
] as const satisfies readonly Option<string>[];

export const SECTORS = [
  { id: "technology", label: "Technology" },
  { id: "semiconductors", label: "Semiconductors" },
  { id: "healthcare", label: "Healthcare" },
  { id: "financials", label: "Financials" },
  { id: "energy", label: "Energy" },
  { id: "consumer", label: "Consumer" },
  { id: "industrials", label: "Industrials" },
  { id: "communication", label: "Communication" },
  { id: "real_estate", label: "Real estate" },
  { id: "utilities", label: "Utilities" },
  { id: "materials", label: "Materials" },
  { id: "crypto", label: "Crypto" },
] as const satisfies readonly Option<string>[];

export const HEARD_ABOUT = [
  { id: "x_twitter", label: "X / Twitter" },
  { id: "reddit", label: "Reddit" },
  { id: "youtube", label: "YouTube" },
  { id: "tiktok", label: "TikTok" },
  { id: "friend", label: "A friend" },
  { id: "search", label: "Search" },
  { id: "other", label: "Other" },
] as const satisfies readonly Option<string>[];

export type GoalId = (typeof GOALS)[number]["id"];
export type TenureId = (typeof TENURES)[number]["id"];
export type PortfolioSizeId = (typeof PORTFOLIO_SIZES)[number]["id"];
export type FrustrationId = (typeof FRUSTRATIONS)[number]["id"];
export type MissedMovesId = (typeof MISSED_MOVES)[number]["id"];
export type ResearchTimeId = (typeof RESEARCH_TIMES)[number]["id"];
export type SectorId = (typeof SECTORS)[number]["id"];
export type HeardAboutId = (typeof HEARD_ABOUT)[number]["id"];
export type NotificationAnswer = "granted" | "denied" | "default" | "unsupported" | "skipped";

/** A holding from the portfolio step; shares and value only when the source had them. */
export type PickedStock = { ticker: string; name: string; shares?: number; value?: number };

export type WelcomeAnswers = {
  goal?: GoalId;
  tenure?: TenureId;
  portfolioSize?: PortfolioSizeId;
  frustration?: FrustrationId;
  missedMoves?: MissedMovesId;
  researchTime?: ResearchTimeId;
  sectors: SectorId[];
  stocks: PickedStock[];
  /** Chose "Skip" on the portfolio step. */
  portfolioSkipped?: boolean;
  heardAbout?: HeardAboutId;
  heardAboutOther?: string;
  notifications?: NotificationAnswer;
  committed?: boolean;
};

export const EMPTY_ANSWERS: WelcomeAnswers = { sectors: [], stocks: [] };

export const MAX_STOCKS = 30;
export const MAX_OTHER_LENGTH = 80;
export const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

/**
 * "Blind spot score", 0 to 100, from the member's own answers only (same
 * formula as the website). Higher means more blind spots.
 */
export function blindSpotScore(answers: WelcomeAnswers): number {
  const missed = { often: 35, sometimes: 22, rarely: 8 }[answers.missedMoves ?? "sometimes"];
  const time = { under_15_min: 25, "15_to_60_min": 15, over_1_hour: 8 }[answers.researchTime ?? "15_to_60_min"];
  const frustration = answers.frustration
    ? { news_too_late: 15, unclear_impact: 15, too_much_noise: 12, emotional_trading: 10 }[answers.frustration]
    : 10;
  const stocks = Math.min(15, answers.stocks.length * 1.5);
  const goal = answers.goal
    ? { catch_big_moves: 10, protect_portfolio: 8, grow_wealth: 6, smarter_investor: 6 }[answers.goal]
    : 6;
  return Math.max(0, Math.min(100, Math.round(missed + time + frustration + stocks + goal)));
}

async function withTimeout(input: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sends the answers so far to the website's POST /api/onboarding with the
 * member's session. Never throws. Funnel test mode never sends anything.
 */
export async function saveWelcomeAnswers(answers: WelcomeAnswers, completed = false): Promise<void> {
  if (FUNNEL_TEST_MODE) return;
  const token = await accessToken();
  if (!token) return;
  try {
    await withTimeout(
      apiUrl("/api/onboarding"),
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...answers, completed }),
      },
      4000,
    );
  } catch {
    // Fail soft: the funnel never blocks on the server.
  }
}

/** Company names for tickers from the website's SEC list ({} on any failure). */
export async function tickerNames(tickers: string[]): Promise<Record<string, string>> {
  if (tickers.length === 0) return {};
  try {
    const res = await fetch(apiUrl(`/api/tickers?symbols=${encodeURIComponent(tickers.join(","))}`));
    const body = (await res.json()) as { names?: Record<string, string> };
    return body.names ?? {};
  } catch {
    return {};
  }
}
