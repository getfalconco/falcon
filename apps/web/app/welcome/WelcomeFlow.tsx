"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, useReducedMotion } from "framer-motion";
import { BellRing, ChevronLeft, ChevronRight, GraduationCap, Loader2, ShieldCheck, TrendingUp } from "lucide-react";
import { EASE } from "@meridian/ui";
import { SITE_URL, isAppHost } from "@/lib/app-host";
import {
  EMPTY_ANSWERS,
  FRUSTRATIONS,
  GOALS,
  HEARD_ABOUT,
  MAX_OTHER_LENGTH,
  MISSED_MOVES,
  PORTFOLIO_SIZES,
  RESEARCH_TIMES,
  SECTORS,
  TENURES,
  type NotificationAnswer,
  type SectorId,
  type WelcomeAnswers,
  blindSpotScore,
  readProgress,
  safeInternalPath,
  saveWelcomeAnswers,
  writeProgress,
} from "@/lib/onboarding";
import { isSupabaseConfigured, requireSupabase } from "@/lib/supabase";
import GetStartedButton from "../components/GetStartedButton";
import MarketOrbit from "./MarketOrbit";
import { AlertArt, BriefArt, RippleArt } from "./Visuals";
import {
  ChoiceCards,
  Chips,
  type ChoiceOption,
  type FilingsResult,
  HoldToCommit,
  MappingAnimation,
  ResultView,
  StockPicker,
} from "./Steps";

const STEP_IDS = [
  "intro",
  "goal",
  "tenure",
  "portfolio",
  "frustration",
  "missed",
  "alone",
  "research",
  "brief",
  "sectors",
  "stocks",
  "heard",
  "notify",
  "commit",
  "loading",
  "result",
] as const;
type StepId = (typeof STEP_IDS)[number];

const LOADING_MS = 3200;

/** Single choice steps: which answer they fill and with what options. */
const CHOICE_STEPS = {
  goal: { field: "goal", options: GOALS },
  tenure: { field: "tenure", options: TENURES },
  portfolio: { field: "portfolioSize", options: PORTFOLIO_SIZES },
  frustration: { field: "frustration", options: FRUSTRATIONS },
  missed: { field: "missedMoves", options: MISSED_MOVES },
  research: { field: "researchTime", options: RESEARCH_TIMES },
} as const;
type ChoiceStepId = keyof typeof CHOICE_STEPS;

function isChoiceStep(step: StepId): step is ChoiceStepId {
  return step in CHOICE_STEPS;
}

const GOAL_ICONS: Record<string, ChoiceOption["icon"]> = {
  grow_wealth: TrendingUp,
  catch_big_moves: BellRing,
  protect_portfolio: ShieldCheck,
  smarter_investor: GraduationCap,
};

function stockCount(n: number) {
  return `${n} ${n === 1 ? "stock" : "stocks"}`;
}

function copyFor(step: StepId, answers: WelcomeAnswers): { title: string; subtitle?: string } {
  switch (step) {
    case "intro":
      return { title: "Welcome to Falcon", subtitle: "Let's set up Falcon around what you care about." };
    case "goal":
      return { title: "What's your main goal?", subtitle: "Pick the one that matters most to you right now." };
    case "tenure":
      return { title: "How long have you been investing?" };
    case "portfolio":
      return { title: "How big is your portfolio?", subtitle: "A rough range is fine." };
    case "frustration":
      return { title: "What frustrates you most?", subtitle: "Pick the closest one." };
    case "missed":
      return { title: "Have you ever missed a big move because you found out too late?" };
    case "alone":
      return { title: "You're not alone.", subtitle: "Falcon spots ripples before they're priced in." };
    case "research":
      return { title: "How much time do you spend on research daily?" };
    case "brief":
      return { title: "Falcon gives you what matters in 30 seconds.", subtitle: "Less time reading, more time deciding." };
    case "sectors":
      return { title: "Which sectors do you follow?", subtitle: "Pick as many as you like." };
    case "stocks":
      return { title: "Add your stocks", subtitle: "Start with the ones you own or watch most." };
    case "heard":
      return { title: "Where did you hear about Falcon?" };
    case "notify":
      return {
        title: "Get alerted when a ripple hits your portfolio.",
        subtitle: "Only for news that touches your stocks.",
      };
    case "commit":
      return { title: "I'll check my Exposure every morning", subtitle: "A small habit that keeps you ahead." };
    case "loading":
      return { title: `Mapping connections for your ${stockCount(answers.stocks.length)}...` };
    case "result":
      return {
        title: "Your blind spot score",
        subtitle: "Higher means more of your stocks' news is likely to reach you late.",
      };
  }
}

/** Whether the answers let the member move past `step`. */
function stepDone(step: StepId, answers: WelcomeAnswers): boolean {
  if (isChoiceStep(step)) return answers[CHOICE_STEPS[step].field] !== undefined;
  switch (step) {
    case "sectors":
      return answers.sectors.length > 0;
    case "stocks":
      return answers.stocks.length > 0;
    case "heard":
      return answers.heardAbout !== undefined;
    case "notify":
      return answers.notifications !== undefined;
    case "commit":
      return answers.committed === true;
    case "loading":
      return false;
    default:
      return true;
  }
}

function Swirls() {
  return (
    <svg
      className="pointer-events-none absolute inset-0 h-full w-full"
      viewBox="0 0 1440 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden
    >
      <g className="welcome-swirl" fill="none" strokeLinecap="round">
        <path
          d="M -120 640 C 180 380, 420 880, 660 610 S 1000 170, 1200 430 S 1500 780, 1620 520"
          stroke="#ffffff"
          strokeOpacity="0.7"
          strokeWidth="44"
        />
        <path
          d="M -120 640 C 180 380, 420 880, 660 610 S 1000 170, 1200 430 S 1500 780, 1620 520"
          stroke="#34a8bd"
          strokeOpacity="0.08"
          strokeWidth="1.5"
        />
      </g>
      <g className="welcome-swirl welcome-swirl-b" fill="none" strokeLinecap="round">
        <path
          d="M 1580 120 C 1300 40, 1120 330, 1300 420 S 1480 220, 1260 140 S 900 160, 820 -60"
          stroke="#ffffff"
          strokeOpacity="0.6"
          strokeWidth="34"
        />
        <path
          d="M -140 210 C 120 60, 330 330, 520 230 S 760 20, 900 -80"
          stroke="#ffffff"
          strokeOpacity="0.5"
          strokeWidth="26"
        />
      </g>
    </svg>
  );
}

const ROUND_BUTTON =
  "flex h-12 w-12 shrink-0 items-center justify-center rounded-full outline-none transition-[background-color,opacity,box-shadow] duration-200 focus-visible:ring-2 focus-visible:ring-[#1a7f95]/40 disabled:cursor-not-allowed";

function WelcomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [answers, setAnswers] = useState<WelcomeAnswers>(EMPTY_ANSWERS);
  const [restored, setRestored] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [filings, setFilings] = useState<FilingsResult | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;

  const step = STEP_IDS[index];
  const isLast = index === STEP_IDS.length - 1;
  const client = useMemo(() => (isSupabaseConfigured ? requireSupabase() : null), []);

  // Resume where this browser left off, but never past an unanswered step.
  useEffect(() => {
    const saved = readProgress();
    if (saved) {
      let target = Math.max(0, STEP_IDS.indexOf(saved.step as StepId));
      if (target >= STEP_IDS.indexOf("loading")) target = STEP_IDS.indexOf("loading");
      const firstOpen = STEP_IDS.findIndex((id, i) => i < target && !stepDone(id, saved.answers));
      setAnswers(saved.answers);
      setIndex(firstOpen === -1 ? target : firstOpen);
    }
    setRestored(true);
  }, []);

  useEffect(() => {
    if (restored && !finishing) writeProgress({ step, answers });
  }, [answers, finishing, restored, step]);

  const update = useCallback((patch: Partial<WelcomeAnswers>) => {
    setAnswers((prev) => ({ ...prev, ...patch }));
  }, []);

  const save = useCallback(
    (completed = false) => saveWelcomeAnswers(client, answersRef.current, completed),
    [client],
  );

  const goTo = useCallback(
    (target: number) => {
      if (target < 0 || target >= STEP_IDS.length) return;
      setDirection(target > index ? 1 : -1);
      setIndex(target);
    },
    [index],
  );

  const finish = useCallback(async () => {
    setFinishing(true);
    await save(true);
    // Same place the login screen sent members before this flow existed.
    const dest = safeInternalPath(searchParams.get("next"), "/");
    const target = dest.startsWith("/welcome") || dest.startsWith("/admin") ? "/" : dest;
    if (isAppHost(window.location.host)) {
      window.location.assign(`${SITE_URL}${target}`);
      return;
    }
    router.push(target);
  }, [router, save, searchParams]);

  const canGoNext = !finishing && step !== "loading" && stepDone(step, answers);
  const canGoBack = !finishing && index > 0 && step !== "loading" && step !== "result";

  const next = useCallback(() => {
    if (!canGoNext) return;
    if (isLast) {
      void finish();
      return;
    }
    // Keep the server copy current as answers come in; never waits on it.
    if (step !== "intro" && step !== "alone" && step !== "brief") void save();
    goTo(index + 1);
  }, [canGoNext, finish, goTo, index, isLast, save, step]);

  const back = useCallback(() => {
    if (canGoBack) goTo(index - 1);
  }, [canGoBack, goTo, index]);

  // Loading: fetch real filings for their tickers, move on after the animation.
  const tickersKey = answers.stocks.map((s) => s.ticker).join(",");
  const fetchFilings = useCallback(async () => {
    setFilings({ state: "loading" });
    try {
      const res = await fetch(`/api/filings?tickers=${encodeURIComponent(tickersKey)}`);
      const body = (await res.json()) as { ok?: boolean; count?: number; items?: [] };
      if (!res.ok || !body.ok) throw new Error("filings");
      setFilings({ state: "ok", count: body.count ?? 0, items: body.items ?? [] });
    } catch {
      setFilings({ state: "error" });
    }
  }, [tickersKey]);

  useEffect(() => {
    if (step !== "loading") return;
    void fetchFilings();
    void save();
    const timer = setTimeout(() => {
      setDirection(1);
      setIndex(STEP_IDS.indexOf("result"));
    }, reduceMotion ? 1500 : LOADING_MS);
    return () => clearTimeout(timer);
    // Runs once per visit to the loading step.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  useEffect(() => {
    if (step === "result" && filings === null) void fetchFilings();
  }, [fetchFilings, filings, step]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.metaKey || event.ctrlKey || event.altKey || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable='true']")) return;
      const onControl = target?.closest("button, a") != null;

      if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      } else if (event.key === "Enter" && !onControl) {
        // On a button Enter already clicks it (a card selects itself).
        event.preventDefault();
        next();
      } else if (isChoiceStep(step) && /^[1-9]$/.test(event.key)) {
        const { field, options } = CHOICE_STEPS[step];
        const option = options[Number(event.key) - 1];
        if (option) update({ [field]: option.id } as Partial<WelcomeAnswers>);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [back, next, step, update]);

  async function answerNotifications(ask: boolean) {
    let result: NotificationAnswer = "skipped";
    if (ask) {
      result = "unsupported";
      if (typeof window !== "undefined" && "Notification" in window) {
        try {
          result = await Notification.requestPermission();
        } catch {
          result = "default";
        }
      }
    }
    update({ notifications: result });
    answersRef.current = { ...answersRef.current, notifications: result };
    void save();
    goTo(STEP_IDS.indexOf("notify") + 1);
  }

  const onCommit = useCallback(() => {
    update({ committed: true });
    answersRef.current = { ...answersRef.current, committed: true };
    void save();
    setTimeout(() => {
      setDirection(1);
      setIndex(STEP_IDS.indexOf("loading"));
    }, reduceMotion ? 300 : 900);
  }, [reduceMotion, save, update]);

  const copy = copyFor(step, answers);
  const offset = reduceMotion ? 0 : 28 * direction;
  const longTitle = copy.title.length > 32;
  const visualStep = step === "intro" || step === "alone" || step === "brief" || step === "notify" || step === "loading";
  const progress = index / (STEP_IDS.length - 1);

  function body() {
    if (isChoiceStep(step)) {
      const { field, options } = CHOICE_STEPS[step];
      const withIcons = step === "goal" ? options.map((o) => ({ ...o, icon: GOAL_ICONS[o.id] })) : options;
      return (
        <ChoiceCards
          label={copy.title}
          options={withIcons}
          value={answers[field]}
          onChange={(id) => update({ [field]: id } as Partial<WelcomeAnswers>)}
        />
      );
    }
    switch (step) {
      case "intro":
        return <MarketOrbit />;
      case "alone":
        return <RippleArt />;
      case "brief":
        return <BriefArt />;
      case "sectors":
        return (
          <Chips
            label={copy.title}
            options={SECTORS}
            value={answers.sectors}
            onToggle={(id) => {
              const s = id as SectorId;
              setAnswers((prev) => ({
                ...prev,
                sectors: prev.sectors.includes(s) ? prev.sectors.filter((x) => x !== s) : [...prev.sectors, s],
              }));
            }}
          />
        );
      case "stocks":
        return <StockPicker value={answers.stocks} onChange={(stocks) => update({ stocks })} onDone={next} />;
      case "heard":
        return (
          <div className="flex w-full max-w-[600px] flex-col items-center gap-4">
            <Chips
              label={copy.title}
              options={HEARD_ABOUT}
              value={answers.heardAbout ? [answers.heardAbout] : []}
              onToggle={(id) => update({ heardAbout: id as WelcomeAnswers["heardAbout"] })}
            />
            {answers.heardAbout === "other" ? (
              <input
                autoFocus
                value={answers.heardAboutOther ?? ""}
                onChange={(e) => update({ heardAboutOther: e.target.value.slice(0, MAX_OTHER_LENGTH) })}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    next();
                  }
                }}
                placeholder="Tell us where"
                aria-label="Where did you hear about Falcon?"
                maxLength={MAX_OTHER_LENGTH}
                className="h-12 w-full max-w-[360px] rounded-2xl border border-black/[0.08] bg-white/85 px-4 text-[15px] text-[#1d1b1b] outline-none backdrop-blur-sm transition placeholder:text-[#9a9a9a] focus:border-[#1a7f95]/60"
              />
            ) : null}
          </div>
        );
      case "notify":
        return (
          <div className="flex w-full flex-col items-center gap-8">
            <AlertArt />
            <div className="flex flex-col items-center gap-3">
              <GetStartedButton
                type="button"
                onClick={() => void answerNotifications(true)}
                className="h-11 w-[240px] pl-4 pr-3.5"
                label="Turn on alerts"
              />
              <button
                type="button"
                onClick={() => void answerNotifications(false)}
                className="rounded-md px-2 py-1 text-[13px] text-[#5f6a6d] underline-offset-4 outline-none hover:text-[#1d1b1b] hover:underline focus-visible:ring-2 focus-visible:ring-[#1a7f95]/40"
              >
                Not now
              </button>
            </div>
          </div>
        );
      case "commit":
        return <HoldToCommit committed={answers.committed === true} onCommit={onCommit} />;
      case "loading":
        return <MappingAnimation tickers={answers.stocks.map((s) => s.ticker)} durationMs={reduceMotion ? 1500 : LOADING_MS} />;
      case "result":
        return <ResultView score={blindSpotScore(answers)} filings={filings ?? { state: "loading" }} />;
    }
  }

  if (!restored) return <div className="welcome-bg absolute inset-0" />;

  return (
    <div className="welcome-bg absolute inset-0 flex flex-col overflow-hidden font-sans text-[#1d1b1b]">
      <Swirls />

      <motion.div
        key={step}
        initial={{ opacity: 0, x: offset }}
        animate={{ opacity: 1, x: 0 }}
        transition={{ duration: reduceMotion ? 0.15 : 0.45, ease: EASE }}
        className="relative flex min-h-0 flex-1 flex-col"
      >
        <header className="shrink-0 px-6 pt-[max(env(safe-area-inset-top),40px)] text-center sm:pt-14">
          <h1
            className={`mx-auto max-w-[720px] font-serif font-normal leading-[1.15] tracking-[0.005em] text-[#1d1b1b] [text-wrap:balance] ${
              longTitle ? "text-[1.7rem] sm:text-[2.5rem]" : "text-[2.1rem] sm:text-[3.1rem]"
            }`}
          >
            {copy.title}
          </h1>
          {copy.subtitle ? (
            <p className="mx-auto mt-3 max-w-[440px] text-[15px] leading-relaxed text-[#5f6a6d] [text-wrap:balance] sm:mt-4 sm:text-base">
              {copy.subtitle}
            </p>
          ) : null}
        </header>

        <main
          className={`flex min-h-0 flex-1 flex-col items-center px-5 py-6 sm:px-6 ${
            visualStep ? "overflow-hidden" : "overflow-y-auto overflow-x-hidden"
          }`}
        >
          <div className={`flex w-full justify-center ${step === "stocks" ? "mt-2 sm:mt-6" : "my-auto"}`}>{body()}</div>
        </main>
      </motion.div>

      <nav
        aria-label="Welcome steps"
        className="relative mx-auto flex w-full max-w-[600px] shrink-0 items-center justify-between gap-4 px-5 pb-[max(env(safe-area-inset-bottom),22px)] pt-3 sm:px-6 sm:pb-10"
      >
        <button
          type="button"
          onClick={back}
          disabled={!canGoBack}
          aria-label="Back"
          className={`${ROUND_BUTTON} border border-black/10 bg-white/85 text-[#1d1b1b] shadow-[0_4px_14px_rgba(0,0,0,0.05)] hover:bg-white disabled:opacity-35 disabled:hover:bg-white/85`}
        >
          <ChevronLeft className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </button>

        <div
          role="progressbar"
          aria-label="Setup progress"
          aria-valuemin={1}
          aria-valuemax={STEP_IDS.length}
          aria-valuenow={index + 1}
          aria-valuetext={`Step ${index + 1} of ${STEP_IDS.length}`}
          className="h-1 w-full max-w-[240px] overflow-hidden rounded-full bg-black/[0.08]"
        >
          <div
            className="h-full rounded-full bg-[#1c1917] transition-[width] duration-500 ease-out motion-reduce:transition-none"
            style={{ width: `${Math.max(4, progress * 100)}%` }}
          />
        </div>

        <button
          type="button"
          onClick={next}
          disabled={!canGoNext && !finishing}
          aria-busy={finishing}
          aria-label={isLast ? "Finish and continue" : "Next"}
          className={`${ROUND_BUTTON} bg-[#1c1917] text-[#f2f2f2] shadow-[0_8px_20px_rgba(28,25,23,0.22)] hover:bg-[#0f0d0b] disabled:opacity-30 disabled:shadow-none disabled:hover:bg-[#1c1917]`}
        >
          {finishing ? (
            <Loader2 className="h-5 w-5 animate-spin" aria-hidden />
          ) : (
            <ChevronRight className="h-5 w-5" strokeWidth={1.75} aria-hidden />
          )}
        </button>
      </nav>
    </div>
  );
}

export default function WelcomeFlow() {
  return (
    <Suspense fallback={<div className="welcome-bg absolute inset-0" />}>
      <WelcomeContent />
    </Suspense>
  );
}
