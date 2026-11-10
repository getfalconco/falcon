"use client";

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { motion, useReducedMotion, type MotionProps } from "framer-motion";
import { Loader2 } from "lucide-react";
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
import AuthSplitShell from "../components/AuthSplitShell";
import GetStartedButton from "../components/GetStartedButton";
import {
  ChoiceRows,
  Chips,
  type FilingsResult,
  GEIST,
  HoldToCommit,
  MONO,
  MappingList,
  ResultView,
  SERIF,
  StockPicker,
  UNDERLINE_INPUT,
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
const EASE_SOFT = [0.4, 0, 0.2, 1] as const;

/* Step change: the chosen option settles for a beat, the question lifts away
   softly, then the next one arrives piece by piece (headline first). Back runs
   the same motion the other way up. */
const EASE_CALM = [0.22, 1, 0.36, 1] as const;
const CONFIRM_MS = 160;
const EXIT_MS = 170;
const EXIT_Y = 10;
const ENTER_Y = 12;
const ENTER_S = 0.3;
const STAGGER_S = 0.04;
/** Options after the fourth arrive with it, so long lists never drag. */
const MAX_STAGGERED_OPTIONS = 4;

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

const QUIET_BUTTON = "text-xs uppercase tracking-[0.18em] text-[#9a9a9a] outline-none transition-colors hover:text-[#1d1b1b] focus-visible:text-[#1d1b1b]";

function WelcomeContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const reduceMotion = useReducedMotion();
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<WelcomeAnswers>(EMPTY_ANSWERS);
  const [restored, setRestored] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [filings, setFilings] = useState<FilingsResult | null>(null);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const indexRef = useRef(index);
  indexRef.current = index;
  // Set while a step change plays; blocks a second one from starting.
  const pendingRef = useRef<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busy = confirming || leaving;

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

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  /** Moves to `target`; `confirm` lets the chosen option settle first. */
  const goTo = useCallback(
    (target: number, confirm = false) => {
      if (target < 0 || target >= STEP_IDS.length || pendingRef.current !== null) return;
      setDirection(target >= indexRef.current ? 1 : -1);
      if (reduceMotion) {
        setIndex(target);
        return;
      }
      pendingRef.current = target;
      const later = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
      const leave = () => {
        setLeaving(true);
        later(EXIT_MS, () => {
          pendingRef.current = null;
          setIndex(target);
          setLeaving(false);
          setConfirming(false);
        });
      };
      if (confirm) {
        setConfirming(true);
        later(CONFIRM_MS, leave);
      } else {
        leave();
      }
    },
    [reduceMotion],
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

  const canGoNext = !finishing && !busy && step !== "loading" && stepDone(step, answers);
  const canGoBack = !finishing && !busy && index > 0 && step !== "loading" && step !== "result";

  const next = useCallback(() => {
    if (!canGoNext) return;
    if (isLast) {
      void finish();
      return;
    }
    // Keep the server copy current as answers come in; never waits on it.
    if (step !== "intro" && step !== "alone" && step !== "brief") void save();
    goTo(index + 1, isChoiceStep(step) || step === "sectors" || step === "heard");
  }, [canGoNext, finish, goTo, index, isLast, save, step]);

  const back = useCallback(() => {
    if (canGoBack) goTo(index - 1);
  }, [canGoBack, goTo, index]);

  // Loading: fetch real filings for their tickers, move on after the list.
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

  const loadingMs = reduceMotion ? 1500 : LOADING_MS;

  useEffect(() => {
    if (step !== "loading") return;
    void fetchFilings();
    void save();
    const timer = setTimeout(() => goTo(STEP_IDS.indexOf("result")), loadingMs);
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
        // On a button Enter already clicks it (an option selects itself).
        event.preventDefault();
        next();
      } else if (isChoiceStep(step) && !busy && /^[1-9]$/.test(event.key)) {
        const { field, options } = CHOICE_STEPS[step];
        const option = options[Number(event.key) - 1];
        if (option) update({ [field]: option.id } as Partial<WelcomeAnswers>);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [back, busy, next, step, update]);

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
    setTimeout(() => goTo(STEP_IDS.indexOf("loading")), reduceMotion ? 300 : 900);
  }, [goTo, reduceMotion, save, update]);

  const copy = copyFor(step, answers);

  /** Entrance for the `order`th piece of the step (0 is the headline). */
  const enter = (order: number): MotionProps =>
    reduceMotion
      ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.15 } }
      : {
          initial: { opacity: 0, y: ENTER_Y * direction },
          animate: { opacity: 1, y: 0 },
          transition: { duration: ENTER_S, ease: EASE_CALM, delay: order * STAGGER_S },
        };
  const choiceCount = isChoiceStep(step) ? Math.min(CHOICE_STEPS[step].options.length, MAX_STAGGERED_OPTIONS) : 1;
  const bodyOrder = copy.subtitle ? 2 : 1;
  const actionsOrder = bodyOrder + choiceCount;

  function body() {
    if (isChoiceStep(step)) {
      const { field, options } = CHOICE_STEPS[step];
      return (
        <ChoiceRows
          label={copy.title}
          options={options}
          value={answers[field]}
          onChange={(id) => update({ [field]: id } as Partial<WelcomeAnswers>)}
          confirming={confirming}
          optionMotion={(i) => enter(bodyOrder + Math.min(i, MAX_STAGGERED_OPTIONS - 1))}
        />
      );
    }
    switch (step) {
      case "sectors":
        return (
          <Chips
            label={copy.title}
            options={SECTORS}
            value={answers.sectors}
            confirming={confirming}
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
          <div>
            <Chips
              label={copy.title}
              options={HEARD_ABOUT}
              value={answers.heardAbout ? [answers.heardAbout] : []}
              confirming={confirming}
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
                placeholder="Tell us in a few words"
                aria-label="Where did you hear about Falcon?"
                maxLength={MAX_OTHER_LENGTH}
                className={`mt-6 ${UNDERLINE_INPUT}`}
                style={{ fontFamily: GEIST }}
              />
            ) : null}
          </div>
        );
      case "commit":
        return <HoldToCommit committed={answers.committed === true} onCommit={onCommit} />;
      case "loading":
        return <MappingList tickers={answers.stocks.map((s) => s.ticker)} durationMs={loadingMs} />;
      case "result":
        return <ResultView score={blindSpotScore(answers)} filings={filings ?? { state: "loading" }} />;
      default:
        return null;
    }
  }

  function actions() {
    if (step === "loading") return null;
    if (step === "commit" && !answers.committed) return null;
    if (step === "notify") {
      return (
        <>
          <GetStartedButton
            type="button"
            onClick={() => void answerNotifications(true)}
            className="h-[45px] w-[260px] pl-4 pr-3.5"
            label="Turn on alerts"
            showArrow={false}
          />
          <button
            type="button"
            onClick={() => void answerNotifications(false)}
            className={QUIET_BUTTON}
            style={{ fontFamily: MONO }}
          >
            Not now
          </button>
        </>
      );
    }
    return (
      <GetStartedButton
        type="button"
        onClick={next}
        disabled={!canGoNext}
        className="h-[45px] w-[260px] pl-4 pr-3.5"
        showArrow={false}
        label={
          <>
            {finishing ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
            {step === "intro" ? "Get started" : isLast ? "Continue to Falcon" : "Continue"}
          </>
        }
      />
    );
  }

  const progress = (index + 1) / STEP_IDS.length;
  const bodyNode = body();

  return (
    <>
      <div className="flex flex-1 flex-col justify-center px-6 py-10 sm:px-12 sm:py-16">
        <div className="mx-auto w-full max-w-[460px]">
          {/* Progress: a hairline that fills as the steps go by (as in the application flow). */}
          <div className="mb-10 sm:mb-12">
            <div
              role="progressbar"
              aria-label="Setup progress"
              aria-valuemin={1}
              aria-valuemax={STEP_IDS.length}
              aria-valuenow={index + 1}
              className="h-px w-full bg-black/10"
            >
              <motion.div
                className="h-px bg-[#1d1b1b]"
                initial={false}
                animate={{ width: `${progress * 100}%` }}
                transition={{ duration: reduceMotion ? 0 : 0.5, ease: EASE_SOFT }}
              />
            </div>
          </div>

          {restored ? (
            <motion.div
              key={step}
              initial={false}
              animate={
                leaving
                  ? { opacity: 0, y: -EXIT_Y * direction, filter: "blur(3px)" }
                  : { opacity: 1, y: 0, filter: "blur(0px)" }
              }
              transition={{ duration: EXIT_MS / 1000, ease: EASE_CALM }}
            >
              <motion.h1
                {...enter(0)}
                className="text-[26px] leading-[34px] text-[#1d1b1b] [text-wrap:balance] sm:text-[30px] sm:leading-[38px]"
                style={{ fontFamily: SERIF, fontWeight: 400 }}
              >
                {copy.title}
              </motion.h1>
              {copy.subtitle ? (
                <motion.p
                  {...enter(1)}
                  className="mt-3 text-[14px] leading-[22px] text-[#767676]"
                  style={{ fontFamily: GEIST }}
                >
                  {copy.subtitle}
                </motion.p>
              ) : null}

              {bodyNode ? (
                isChoiceStep(step) ? (
                  // The options carry their own staggered entrance.
                  <div className="mt-8">{bodyNode}</div>
                ) : (
                  <motion.div {...enter(bodyOrder)} className="mt-8">
                    {bodyNode}
                  </motion.div>
                )
              ) : null}

              <motion.div
                {...enter(bodyNode ? actionsOrder : bodyOrder)}
                className="mt-10 flex flex-col items-start gap-4"
              >
                {actions()}
                <button
                  type="button"
                  onClick={back}
                  aria-hidden={!canGoBack}
                  tabIndex={canGoBack ? 0 : -1}
                  className={`${QUIET_BUTTON} ${canGoBack ? "opacity-100" : "pointer-events-none opacity-0"}`}
                  style={{ fontFamily: MONO }}
                >
                  &larr; Back
                </button>
              </motion.div>
            </motion.div>
          ) : null}
        </div>
      </div>
    </>
  );
}

export default function WelcomeFlow() {
  // The shell sits outside Suspense so it mounts once: its widening from the
  // login's split plays a single time and the glass never restarts.
  return (
    <AuthSplitShell wide>
      <Suspense fallback={null}>
        <WelcomeContent />
      </Suspense>
    </AuthSplitShell>
  );
}
