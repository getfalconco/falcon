import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { MotionGlobalConfig } from "framer-motion";
import type { User } from "@supabase/supabase-js";
import "../globals.css";
import LoginPage, { type LoginPageMode } from "../pages/LoginPage";
import AnimatedGradientPanel from "../components/AnimatedGradientPanel";
import OtpForm from "../components/OtpForm";
import OnboardingFlow, { type OnboardingPreset, type OnboardingStep } from "../components/onboarding/OnboardingFlow";
import HeardAboutPrompt from "../components/onboarding/HeardAboutPrompt";
import { selectFirstReading, untrackedTickers, type ReadingEdge } from "../../shared/first-reading";
import { isHoldingPeriod, isPositionsMode } from "../../shared/onboarding-desk";
import type { StockCatalogEntry } from "../../shared/stock-catalog";
import { newYorkToday } from "../lib/onboarding-reading";
import SetPasswordForm from "../components/SetPasswordForm";
import WaitlistStatusCard from "../components/WaitlistStatusCard";
import { applyTheme, getStoredTheme } from "../lib/theme";
import { applyLanguage, setLanguage, useT } from "../lib/i18n";
import { isLanguageCode } from "../lib/i18n/languages";

/**
 * Scratch harness: the screens before the dashboard, in the window's own
 * size (1060 x 680), so their copy can be read in every language without
 * signing in. Supabase is not configured here, so a submit shows the
 * "not available in this build" line rather than reaching a server.
 *
 *   ?screen=login        sign in (default); also: onboarding, waitlist,
 *                        otp, reset, setpw, ticket (the waitlist card with
 *                        a member number and a grant date), and step
 *                        heard (the one-week "how did you hear" card, on
 *                        the dashboard's background)
 *   ?step=holdings       with screen=step: open onboarding on that step
 *                        (name, holdings, tickers, watch, brokerage,
 *                        sectors, holding, depth, desk, reading)
 *   ?tickers=NVDA,SOFI   the names already given (desk, reading); fixture
 *                        data knows NVDA, TSM, AAPL, MSFT and SOFI, and the
 *                        Tracker in it lacks SOFI
 *   ?holding=days        the holding period already chosen (desk)
 *   ?mode=watch          how "What do you hold?" was answered (reading)
 *   ?lang=tr-TR          show the screens in that language (kept, as a pick would be)
 *   ?theme=dark          draw in that theme for this load only
 *   ?still=1             skip motion, so a hidden or throttled tab steps
 *                        through onboarding without waiting on frames
 */

const params = new URLSearchParams(location.search);
const themeParam = params.get("theme");
applyTheme(themeParam === "dark" || themeParam === "light" ? themeParam : getStoredTheme());
const langParam = params.get("lang");
if (isLanguageCode(langParam)) setLanguage(langParam);
applyLanguage();
const screen = params.get("screen") ?? "login";
if (params.get("still") === "1") MotionGlobalConfig.skipAnimations = true;

const FAKE_USER = {
  id: "56b7a75c-ac79-4e42-8286-26596d02622d",
  email: "reader@example.com",
  app_metadata: {},
  aud: "authenticated",
  created_at: "2026-08-01T00:00:00.000Z",
  user_metadata:
    params.get("named") === "0"
      ? {}
      : { full_name: "Kuzey Kovalak", experience: "ten_plus_pro", sectors: [params.get("sector") ?? "semiconductors"] },
} as unknown as User;

const noop = () => undefined;

/*
 * Fixture data for the setup screens: a small catalog for the ticker field,
 * a relationship graph and earnings dates for the first reading, and a
 * Tracker that has every name but SOFI. Nothing leaves the page.
 */
const CATALOG: StockCatalogEntry[] = [
  { symbol: "AAPL", companyName: "Apple Inc." },
  { symbol: "AMD", companyName: "Advanced Micro Devices, Inc." },
  { symbol: "MSFT", companyName: "Microsoft Corporation" },
  { symbol: "NVDA", companyName: "NVIDIA Corporation" },
  { symbol: "SOFI", companyName: "SoFi Technologies, Inc." },
  { symbol: "TSM", companyName: "Taiwan Semiconductor Manufacturing Company Limited" },
];
const EDGES: ReadingEdge[] = [
  { root_ticker: "NVDA", counterparty_ticker: "TSM", counterparty_name: "Taiwan Semiconductor", category: "supplier", confidence: 0.98, strength: 0.6, strength_tier: "important", filing_date: "2026-02-25", form: "10-K" },
  { root_ticker: "NVDA", counterparty_ticker: "AMD", counterparty_name: "AMD", category: "competitor", confidence: 0.95, strength: 0.3, strength_tier: "marginal", filing_date: "2026-02-25", form: "10-K" },
  { root_ticker: "AAPL", counterparty_ticker: "TSM", counterparty_name: "TSMC", category: "supplier", confidence: 0.97, strength: 0.6, strength_tier: "important", filing_date: "2025-10-31", form: "10-K" },
  { root_ticker: "MSFT", counterparty_ticker: "NVDA", counterparty_name: "NVIDIA", category: "supplier", confidence: 0.9, strength: 0.3, strength_tier: "marginal", filing_date: "2025-07-30", form: "10-K" },
];
function daysFromToday(days: number): string {
  const d = new Date(`${newYorkToday()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const EARNINGS = [
  { ticker: "NVDA", date: daysFromToday(12), estimated: false },
  { ticker: "MSFT", date: daysFromToday(19), estimated: true },
];
const TRACKED = ["AAPL", "AMD", "MSFT", "NVDA", "TSM"];

(window as unknown as { meridian: unknown }).meridian = {
  searchStockSymbols: async (query: string, limit = 50) => {
    const q = query.trim().toLowerCase();
    return CATALOG.filter((e) => e.symbol.toLowerCase().includes(q) || e.companyName.toLowerCase().includes(q)).slice(0, limit);
  },
  connectBrokerage: async () => ({ ok: true, configured: true, url: "https://example.com" }),
  syncPortfolioHoldings: async (symbols: string[]) => ({ ok: true, queued: symbols.filter((s) => !TRACKED.includes(s)), covered: [] }),
  getGraphData: async () => ({ ok: true, path: "", graph: { generatedAt: "", pipelineVersion: 1, nodeCount: 0, edgeCount: EDGES.length, nodes: [], edges: EDGES, reverseIndex: {} } }),
  getCalendarCorporate: async ({ symbols }: { symbols: string[] }) => ({
    ok: true,
    events: EARNINGS.filter((e) => symbols.includes(e.ticker)).map((e) => ({ id: e.ticker, kind: "earnings", title: "", detail: null, ...e })),
    sectors: Object.fromEntries(symbols.map((s) => [s, s === "SOFI" ? "Financials" : "Technology"])),
    unavailable: [],
    skipped: [],
  }),
  getTrackerStatus: async () => ({ ok: true, status: { tickers: TRACKED.map((ticker) => ({ ticker, backfilled: true })) } }),
  submitOnboardingSurvey: async () => ({ ok: true }),
};

const presetTickers = (params.get("tickers") ?? "NVDA,SOFI").split(",").map((t) => t.trim().toUpperCase()).filter(Boolean);
const presetMode = params.get("mode");
const presetHolding = params.get("holding") ?? "weeks_months";
const PRESET: OnboardingPreset = {
  tickers: presetTickers,
  mode: isPositionsMode(presetMode) ? presetMode : "tickers",
  holding: isHoldingPeriod(presetHolding) ? presetHolding : "weeks_months",
  reading: {
    facts: selectFirstReading({ tickers: presetTickers, edges: EDGES, earnings: EARNINGS, today: newYorkToday() }),
    started: untrackedTickers(presetTickers, TRACKED),
    notTracked: [],
    sectors: [],
  },
};


/** LoginPage's two columns, for the screens it only reaches mid-flow. */
function Frame({ children, expanded = false }: { children: ReactNode; expanded?: boolean }) {
  const columns = expanded ? "minmax(0, 0.28fr) minmax(0, 0.72fr)" : "minmax(0, 0.82fr) minmax(0, 1.18fr)";
  return (
    <div className="grid h-full overflow-hidden" style={{ gridTemplateColumns: columns }}>
      <div className="min-w-0 overflow-hidden">
        <AnimatedGradientPanel />
      </div>
      <div className="auth-surface relative flex h-full min-w-0 flex-col bg-background">{children}</div>
    </div>
  );
}

function Screen() {
  const t = useT();
  if (screen === "otp" || screen === "reset") {
    const reset = screen === "reset";
    return (
      <Frame>
        <OtpForm
          email="reader@example.com"
          otpType={reset ? "recovery" : "signup"}
          title={t(reset ? "auth.otp.resetTitle" : "auth.otp.confirmTitle")}
          subtitle={t(reset ? "auth.otp.resetSubtitle" : "auth.otp.confirmSubtitle")}
          onVerified={noop}
          onBack={noop}
        />
      </Frame>
    );
  }
  if (screen === "step") {
    return (
      <Frame expanded>
        <OnboardingFlow
          user={FAKE_USER}
          shellReady
          initialStep={(params.get("step") ?? "holdings") as OnboardingStep}
          preset={PRESET}
          onNameCaptured={noop}
          onBackToName={noop}
          onComplete={noop}
        />
      </Frame>
    );
  }
  if (screen === "heard") {
    const weekAgo = new Date(Date.now() - 9 * 86_400_000).toISOString();
    const user = {
      ...FAKE_USER,
      id: `preview-${Date.now()}`,
      user_metadata: { ...FAKE_USER.user_metadata, onboarding_complete: true, onboarding_completed_at: weekAgo },
    } as unknown as User;
    return (
      <div className="relative h-full bg-background">
        <HeardAboutPrompt user={user} className="absolute bottom-6 right-9" />
      </div>
    );
  }
  if (screen === "setpw") {
    return (
      <Frame>
        <SetPasswordForm onSuccess={noop} onWaitlist={noop} />
      </Frame>
    );
  }
  if (screen === "ticket") {
    return (
      <Frame>
        <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-10">
          <WaitlistStatusCard
            fullName="Kuzey Kovalak"
            memberNumber={params.get("member") === "none" ? null : 7}
            grantedAt="2026-10-04T12:00:00.000Z"
            animate={false}
          />
        </div>
      </Frame>
    );
  }
  const mode: LoginPageMode = screen === "onboarding" || screen === "waitlist" ? screen : "login";
  return (
    <LoginPage
      mode={mode}
      user={mode === "onboarding" ? FAKE_USER : null}
      onSuccess={noop}
      onWaitlist={noop}
      onProfileComplete={noop}
    />
  );
}

createRoot(document.getElementById("root")!).render(
  <div className="flex min-h-screen items-start justify-start bg-fill-strong p-4">
    <div className="relative overflow-hidden shadow-xl" style={{ width: 1060, height: 680 }}>
      <Screen />
    </div>
  </div>,
);
