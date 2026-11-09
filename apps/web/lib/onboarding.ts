import type { SupabaseClient } from "@supabase/supabase-js";
import { FUNNEL_TEST_MODE } from "./funnel-test-mode";

/**
 * The welcome flow shown on the app host right after sign-in (/welcome).
 * Shared by the login screen (should it run?), the flow itself (answers,
 * local resume, save) and POST /api/onboarding (which values it accepts).
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

/** Used for pricing: only these four values are ever stored. */
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

export const NOTIFICATION_ANSWERS = ["granted", "denied", "default", "unsupported", "skipped"] as const;

export type GoalId = (typeof GOALS)[number]["id"];
export type TenureId = (typeof TENURES)[number]["id"];
export type PortfolioSizeId = (typeof PORTFOLIO_SIZES)[number]["id"];
export type FrustrationId = (typeof FRUSTRATIONS)[number]["id"];
export type MissedMovesId = (typeof MISSED_MOVES)[number]["id"];
export type ResearchTimeId = (typeof RESEARCH_TIMES)[number]["id"];
export type SectorId = (typeof SECTORS)[number]["id"];
export type HeardAboutId = (typeof HEARD_ABOUT)[number]["id"];
export type NotificationAnswer = (typeof NOTIFICATION_ANSWERS)[number];

export type PickedStock = { ticker: string; name: string };

export type WelcomeAnswers = {
  goal?: GoalId;
  tenure?: TenureId;
  portfolioSize?: PortfolioSizeId;
  frustration?: FrustrationId;
  missedMoves?: MissedMovesId;
  researchTime?: ResearchTimeId;
  sectors: SectorId[];
  stocks: PickedStock[];
  heardAbout?: HeardAboutId;
  heardAboutOther?: string;
  notifications?: NotificationAnswer;
  committed?: boolean;
};

export const EMPTY_ANSWERS: WelcomeAnswers = { sectors: [], stocks: [] };

export const MAX_STOCKS = 30;
export const MAX_OTHER_LENGTH = 80;
export const TICKER_PATTERN = /^[A-Z][A-Z0-9.-]{0,9}$/;

export function isOneOf<Id extends string>(options: readonly Option<Id>[], value: unknown): value is Id {
  return typeof value === "string" && options.some((option) => option.id === value);
}

export function isGoalId(value: unknown): value is GoalId {
  return isOneOf(GOALS, value);
}

/**
 * "Blind spot score", 0 to 100: how likely news on the member's stocks is to
 * reach them late, from their own answers only. Higher means more blind
 * spots. Deterministic; no outside data.
 *   missed moves  often 35 · sometimes 22 · rarely 8
 *   research time under 15 min 25 · 15 to 60 min 15 · 1h+ 8
 *   frustration   too late or unclear impact 15 · noise 12 · emotion 10
 *   stocks        1.5 per stock tracked, up to 15
 *   goal          stop missing moves 10 · protect 8 · grow or learn 6
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

/**
 * Only allow same-origin, root-relative redirect targets. Rejects absolute
 * URLs (`https://evil.com`), protocol-relative (`//evil.com`), and the
 * backslash trick (`/\evil.com`) that browsers normalise to a host.
 */
export function safeInternalPath(path: string | null | undefined, fallback: string): string {
  if (typeof path !== "string" || !path.startsWith("/")) return fallback;
  if (path.startsWith("//") || path.startsWith("/\\")) return fallback;
  return path;
}

/* ------------------------------------------------------------------ */
/* Local state: completion flag and resumable progress                 */
/* ------------------------------------------------------------------ */

const DONE_KEY_PREFIX = "falcon.welcome.done";
const PROGRESS_KEY = "falcon.welcome.progress";

function doneKey(userId: string | null): string {
  return userId ? `${DONE_KEY_PREFIX}:${userId}` : DONE_KEY_PREFIX;
}

/** True when this browser already finished the welcome flow for `userId`. */
export function readWelcomeDone(userId: string | null): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(doneKey(userId)) !== null;
  } catch {
    return false;
  }
}

export function markWelcomeDone(userId: string | null): void {
  if (typeof window === "undefined" || FUNNEL_TEST_MODE) return;
  try {
    localStorage.setItem(doneKey(userId), new Date().toISOString());
    localStorage.removeItem(PROGRESS_KEY);
  } catch {
    // Private mode or storage full: the flow just shows again next time.
  }
}

export type WelcomeProgress = { step: string; answers: WelcomeAnswers };

/** Answers and step saved in this browser, cleaned of anything unknown. */
export function readProgress(): WelcomeProgress | null {
  // Funnel test mode: every run starts at step 1.
  if (typeof window === "undefined" || FUNNEL_TEST_MODE) return null;
  try {
    const raw = localStorage.getItem(PROGRESS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { step?: unknown; answers?: Record<string, unknown> };
    const a = parsed.answers ?? {};
    const answers: WelcomeAnswers = {
      goal: isOneOf(GOALS, a.goal) ? a.goal : undefined,
      tenure: isOneOf(TENURES, a.tenure) ? a.tenure : undefined,
      portfolioSize: isOneOf(PORTFOLIO_SIZES, a.portfolioSize) ? a.portfolioSize : undefined,
      frustration: isOneOf(FRUSTRATIONS, a.frustration) ? a.frustration : undefined,
      missedMoves: isOneOf(MISSED_MOVES, a.missedMoves) ? a.missedMoves : undefined,
      researchTime: isOneOf(RESEARCH_TIMES, a.researchTime) ? a.researchTime : undefined,
      sectors: Array.isArray(a.sectors) ? a.sectors.filter((s): s is SectorId => isOneOf(SECTORS, s)) : [],
      stocks: Array.isArray(a.stocks)
        ? (a.stocks as unknown[])
            .filter(
              (s): s is PickedStock =>
                typeof s === "object" &&
                s !== null &&
                typeof (s as PickedStock).ticker === "string" &&
                TICKER_PATTERN.test((s as PickedStock).ticker) &&
                typeof (s as PickedStock).name === "string",
            )
            .slice(0, MAX_STOCKS)
        : [],
      heardAbout: isOneOf(HEARD_ABOUT, a.heardAbout) ? a.heardAbout : undefined,
      heardAboutOther:
        typeof a.heardAboutOther === "string" ? a.heardAboutOther.slice(0, MAX_OTHER_LENGTH) : undefined,
      notifications: NOTIFICATION_ANSWERS.includes(a.notifications as NotificationAnswer)
        ? (a.notifications as NotificationAnswer)
        : undefined,
      committed: a.committed === true ? true : undefined,
    };
    return { step: typeof parsed.step === "string" ? parsed.step : "intro", answers };
  } catch {
    return null;
  }
}

export function writeProgress(progress: WelcomeProgress): void {
  if (typeof window === "undefined" || FUNNEL_TEST_MODE) return;
  try {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
  } catch {
    // Storage unavailable: no resume, the flow still works.
  }
}

/* ------------------------------------------------------------------ */
/* Server calls (all fail soft)                                        */
/* ------------------------------------------------------------------ */

async function withTimeout(input: string, init: RequestInit, ms: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: controller.signal, cache: "no-store" });
  } finally {
    clearTimeout(timer);
  }
}

async function currentSession(client: SupabaseClient | null) {
  if (!client) return null;
  try {
    return (await client.auth.getSession()).data.session;
  } catch {
    return null;
  }
}

/**
 * Whether the signed-in member still has to see the welcome flow. Checks this
 * browser first, then the server. Any failure (no session, Supabase down)
 * counts as "not done yet": the flow never blocks the way on.
 */
export async function needsWelcome(client: SupabaseClient | null): Promise<boolean> {
  // Funnel test mode: always run the flow, finished before or not.
  if (FUNNEL_TEST_MODE) return true;
  const session = await currentSession(client);
  if (!session) return !readWelcomeDone(null);
  if (readWelcomeDone(session.user.id)) return false;
  try {
    const res = await withTimeout(
      "/api/onboarding",
      { headers: { Authorization: `Bearer ${session.access_token}` } },
      2500,
    );
    if (!res.ok) return true;
    const body = (await res.json()) as { completed?: boolean };
    if (body.completed === true) {
      markWelcomeDone(session.user.id);
      return false;
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * Sends the answers given so far to POST /api/onboarding with the member's own
 * session. Never throws. With `completed`, also marks the flow done in this
 * browser whether or not the server took it.
 */
export async function saveWelcomeAnswers(
  client: SupabaseClient | null,
  answers: WelcomeAnswers,
  completed = false,
): Promise<void> {
  // Funnel test mode: test runs never reach onboarding_responses.
  if (FUNNEL_TEST_MODE) return;
  const session = await currentSession(client);
  try {
    if (session) {
      await withTimeout(
        "/api/onboarding",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
          },
          body: JSON.stringify({ ...answers, completed }),
        },
        4000,
      );
    }
  } catch {
    // Fail soft: Supabase may be unreachable. Answers stay in this browser.
  } finally {
    if (completed) markWelcomeDone(session?.user.id ?? null);
  }
}
