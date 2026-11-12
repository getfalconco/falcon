import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { BackButton, PrimaryButton, SecondaryButton } from "@/components/Buttons";
import { ENTER_Y, Reveal } from "@/components/Reveal";
import { TextField } from "@/components/TextField";
import { apiUrl } from "@/lib/env";
import { haptics } from "@/lib/haptics";
import { saveHoldings } from "@/lib/holdings";
import { HOME_ROUTE, currentUserId } from "@/lib/home";
import { requestAlertPermission } from "@/lib/notifications";
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
  TICKER_PATTERN,
  type NotificationAnswer,
  type SectorId,
  type WelcomeAnswers,
  blindSpotScore,
  saveWelcomeAnswers,
} from "@/lib/onboarding";
import { PortfolioConnect } from "@/features/welcome/PortfolioConnect";
import {
  ChoiceRows,
  Chips,
  type FilingsResult,
  HoldToCommit,
  MappingList,
  ResultView,
} from "@/features/welcome/Steps";
import { EASE_CALM, EASE_SOFT, GUTTER, colors, fonts } from "@/theme";

/**
 * The welcome funnel, step for step the website's /welcome
 * (apps/web/app/welcome/WelcomeFlow.tsx): same questions, copy, options,
 * interstitials, score and SEC filings result, as full-screen phone steps.
 */

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
  "connect",
  "heard",
  "notify",
  "commit",
  "loading",
  "result",
] as const;
type StepId = (typeof STEP_IDS)[number];

const LOADING_MS = 3200;
/** The chosen option settles for a beat, then the step lifts away. */
const CONFIRM_MS = 160;
const EXIT_MS = 180;
const EXIT_Y = 10;
const MAX_STAGGERED_OPTIONS = 4;

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

function titleFor(step: StepId, answers: WelcomeAnswers): string {
  switch (step) {
    case "intro":
      return "Welcome to Falcon";
    case "goal":
      return "What's your main goal?";
    case "tenure":
      return "How long have you been investing?";
    case "portfolio":
      return "How big is your portfolio?";
    case "frustration":
      return "What frustrates you most?";
    case "missed":
      return "Have you ever missed a big move because you found out too late?";
    case "alone":
      return "You're not alone.";
    case "research":
      return "How much time do you spend on research daily?";
    case "brief":
      return "Falcon gives you what matters in 30 seconds.";
    case "sectors":
      return "Which sectors do you follow?";
    case "connect":
      return "Connect your portfolio";
    case "heard":
      return "Where did you hear about Falcon?";
    case "notify":
      return "Get alerted when a ripple hits your portfolio.";
    case "commit":
      return "I'll check my Exposure every morning";
    case "loading":
      return answers.stocks.length
        ? `Mapping connections for your ${stockCount(answers.stocks.length)}...`
        : "Mapping connections for your sectors...";
    case "result":
      return "Your blind spot score";
  }
}

/** Whether the answers let the member move past `step`. */
function stepDone(step: StepId, answers: WelcomeAnswers): boolean {
  if (isChoiceStep(step)) return answers[CHOICE_STEPS[step].field] !== undefined;
  switch (step) {
    case "sectors":
      return answers.sectors.length > 0;
    case "connect":
      return (
        (answers.stocks.length > 0 && answers.stocks.every((s) => TICKER_PATTERN.test(s.ticker))) ||
        (answers.stocks.length === 0 && answers.portfolioSkipped === true)
      );
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

export default function Welcome() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const reduceMotion = useReducedMotion();
  // Funnel test mode or not, the app keeps no local progress yet: every run starts at step 1.
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<WelcomeAnswers>(EMPTY_ANSWERS);
  const [direction, setDirection] = useState<1 | -1>(1);
  const [confirming, setConfirming] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [finishing, setFinishing] = useState(false);
  const [filings, setFilings] = useState<FilingsResult | null>(null);
  const answersRef = useRef(answers);
  answersRef.current = answers;
  const indexRef = useRef(index);
  indexRef.current = index;
  const pendingRef = useRef<number | null>(null);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const busy = confirming || leaving;

  const step = STEP_IDS[index];
  const isLast = index === STEP_IDS.length - 1;

  const exit = useSharedValue(0);
  const progress = useSharedValue(1 / STEP_IDS.length);

  useEffect(() => {
    progress.value = withTiming((index + 1) / STEP_IDS.length, {
      duration: reduceMotion ? 0 : 500,
      easing: EASE_SOFT,
    });
  }, [index, progress, reduceMotion]);

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const update = useCallback((patch: Partial<WelcomeAnswers>) => {
    setAnswers((prev) => ({ ...prev, ...patch }));
  }, []);

  const save = useCallback((completed = false) => saveWelcomeAnswers(answersRef.current, completed), []);

  /** Moves to `target`; `confirm` lets the chosen option settle first. */
  const goTo = useCallback(
    (target: number, confirm = false) => {
      if (target < 0 || target >= STEP_IDS.length || pendingRef.current !== null) return;
      const dir = target >= indexRef.current ? 1 : -1;
      setDirection(dir);
      if (reduceMotion) {
        setIndex(target);
        return;
      }
      pendingRef.current = target;
      const later = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
      const leave = () => {
        setLeaving(true);
        exit.value = withTiming(1, { duration: EXIT_MS, easing: EASE_CALM });
        later(EXIT_MS, () => {
          pendingRef.current = null;
          exit.value = 0;
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
    [exit, reduceMotion],
  );

  const finish = useCallback(async () => {
    setFinishing(true);
    haptics.tap();
    await save(true);
    // The holdings feed Today and Sightings (kept on the phone; in memory
    // only in funnel test mode), then the run continues into the home tabs.
    const { stocks, sectors } = answersRef.current;
    saveHoldings(stocks, sectors, await currentUserId());
    router.replace(HOME_ROUTE);
  }, [router, save]);

  const canGoNext = !finishing && !busy && step !== "loading" && stepDone(step, answers);
  const showBack = !finishing && step !== "loading" && step !== "result";

  const next = useCallback(() => {
    if (!canGoNext) return;
    if (isLast) {
      void finish();
      return;
    }
    haptics.tap();
    if (step !== "intro" && step !== "alone" && step !== "brief") void save();
    goTo(index + 1, isChoiceStep(step) || step === "sectors" || step === "heard");
  }, [canGoNext, finish, goTo, index, isLast, save, step]);

  const back = useCallback(() => {
    if (!showBack || busy) return;
    haptics.select();
    // The first step leaves the funnel for the landing screen.
    if (index === 0) {
      if (router.canGoBack()) router.back();
      else router.replace("/");
      return;
    }
    goTo(index - 1);
  }, [busy, goTo, index, router, showBack]);

  // Loading: fetch real SEC filings for their tickers, move on after the list.
  const tickersKey = answers.stocks.map((s) => s.ticker).join(",");
  const fetchFilings = useCallback(async () => {
    if (!tickersKey) {
      setFilings({ state: "none" });
      return;
    }
    setFilings({ state: "loading" });
    try {
      const res = await fetch(apiUrl(`/api/filings?tickers=${encodeURIComponent(tickersKey)}`));
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
    if (step === "result") haptics.success();
  }, [fetchFilings, filings, step]);

  async function answerNotifications(ask: boolean) {
    if (busy) return;
    haptics.tap();
    const result: NotificationAnswer = ask ? await requestAlertPermission() : "skipped";
    update({ notifications: result });
    answersRef.current = { ...answersRef.current, notifications: result };
    void save();
    goTo(STEP_IDS.indexOf("notify") + 1);
  }

  const onCommit = useCallback(() => {
    update({ committed: true });
    answersRef.current = { ...answersRef.current, committed: true };
    void save();
    timers.current.push(setTimeout(() => goTo(STEP_IDS.indexOf("loading")), reduceMotion ? 300 : 900));
  }, [goTo, reduceMotion, save, update]);

  /** "Skip" on the portfolio step: carry on with sectors and answers only. */
  const skipPortfolio = useCallback(() => {
    if (busy) return;
    haptics.tap();
    update({ stocks: [], portfolioSkipped: true });
    answersRef.current = { ...answersRef.current, stocks: [], portfolioSkipped: true };
    void save();
    goTo(STEP_IDS.indexOf("connect") + 1);
  }, [busy, goTo, save, update]);

  const title = titleFor(step, answers);
  const enterY = ENTER_Y * direction;
  const bodyOrder = 1;
  const choiceCount = isChoiceStep(step) ? Math.min(CHOICE_STEPS[step].options.length, MAX_STAGGERED_OPTIONS) : 1;
  const actionsOrder = bodyOrder + choiceCount;

  function body(): ReactNode {
    if (isChoiceStep(step)) {
      const { field, options } = CHOICE_STEPS[step];
      return (
        <ChoiceRows
          options={options}
          value={answers[field]}
          onChange={(id) => update({ [field]: id } as Partial<WelcomeAnswers>)}
          confirming={confirming}
          firstOrder={bodyOrder}
          maxStaggered={MAX_STAGGERED_OPTIONS}
        />
      );
    }
    switch (step) {
      case "sectors":
        return (
          <Chips
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
      case "connect":
        return (
          <PortfolioConnect
            value={answers.stocks}
            onChange={(stocks) => update({ stocks, portfolioSkipped: undefined })}
          />
        );
      case "heard":
        return (
          <View>
            <Chips
              options={HEARD_ABOUT}
              value={answers.heardAbout ? [answers.heardAbout] : []}
              confirming={confirming}
              onToggle={(id) => update({ heardAbout: id as WelcomeAnswers["heardAbout"] })}
            />
            {answers.heardAbout === "other" ? (
              <TextField
                autoFocus
                value={answers.heardAboutOther ?? ""}
                onChangeText={(text) => update({ heardAboutOther: text.slice(0, MAX_OTHER_LENGTH) })}
                onSubmitEditing={next}
                returnKeyType="next"
                placeholder="Tell us in a few words"
                accessibilityLabel="Where did you hear about Falcon?"
                maxLength={MAX_OTHER_LENGTH}
                style={styles.otherInput}
              />
            ) : null}
          </View>
        );
      case "loading":
        return (
          <MappingList
            items={
              answers.stocks.length
                ? answers.stocks.map((s) => s.ticker)
                : answers.sectors.map((id) => SECTORS.find((o) => o.id === id)?.label ?? id)
            }
            durationMs={loadingMs}
          />
        );
      case "result":
        return <ResultView score={blindSpotScore(answers)} filings={filings ?? { state: "loading" }} />;
      default:
        return null;
    }
  }

  function actions(): ReactNode {
    if (step === "loading") return null;
    if (step === "commit") {
      return <HoldToCommit committed={answers.committed === true} onCommit={onCommit} />;
    }
    if (step === "notify") {
      return (
        <View style={styles.actionStack}>
          <PrimaryButton label="Turn on alerts" onPress={() => void answerNotifications(true)} disabled={busy} />
          <SecondaryButton label="Not now" onPress={() => void answerNotifications(false)} disabled={busy} />
        </View>
      );
    }
    const primary = (
      <PrimaryButton
        label={step === "intro" ? "Get started" : isLast ? "Continue to Falcon" : "Continue"}
        onPress={next}
        disabled={!canGoNext && !finishing}
        loading={finishing}
      />
    );
    if (step === "connect") {
      return (
        <View style={styles.actionStack}>
          {primary}
          <SecondaryButton label="Skip" onPress={skipPortfolio} disabled={busy || finishing} />
        </View>
      );
    }
    return primary;
  }

  const exitStyle = useAnimatedStyle(() => ({
    opacity: 1 - exit.value,
    transform: [{ translateY: -EXIT_Y * direction * exit.value }],
  }));
  const progressStyle = useAnimatedStyle(() => ({ width: `${progress.value * 100}%` }));

  const bodyNode = body();
  const actionsNode = actions();

  return (
    <View style={[styles.screen, { paddingTop: insets.top }]}>
      <View style={styles.header}>
        <BackButton onPress={back} hidden={!showBack} disabled={busy} />
        <View
          accessibilityRole="progressbar"
          accessibilityLabel="Setup progress"
          accessibilityValue={{ min: 1, max: STEP_IDS.length, now: index + 1 }}
          style={styles.track}
        >
          <Animated.View style={[styles.trackFill, progressStyle]} />
        </View>
      </View>

      <KeyboardAvoidingView style={styles.flex} behavior={Platform.OS === "ios" ? "padding" : undefined}>
        <ScrollView
          style={styles.flex}
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="interactive"
          showsVerticalScrollIndicator={false}
        >
          <Animated.View key={step} style={exitStyle}>
            <Reveal order={0} distance={enterY}>
              <Text style={styles.title} accessibilityRole="header">
                {title}
              </Text>
            </Reveal>
            {bodyNode ? (
              isChoiceStep(step) ? (
                <View style={styles.body}>{bodyNode}</View>
              ) : (
                <Reveal order={bodyOrder} distance={enterY} style={styles.body}>
                  {bodyNode}
                </Reveal>
              )
            ) : null}
          </Animated.View>
        </ScrollView>

        {actionsNode ? (
          <Animated.View key={`actions-${step}`} style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) + 8 }, exitStyle]}>
            <Reveal order={bodyNode ? actionsOrder : bodyOrder} distance={enterY}>
              {actionsNode}
            </Reveal>
          </Animated.View>
        ) : (
          <View style={{ height: Math.max(insets.bottom, 16) + 8 }} />
        )}
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  header: {
    height: 56,
    flexDirection: "row",
    alignItems: "center",
    gap: 16,
    paddingLeft: GUTTER - 4,
    paddingRight: GUTTER,
  },
  track: { flex: 1, height: 2, borderRadius: 1, backgroundColor: "rgba(0, 0, 0, 0.08)", overflow: "hidden" },
  trackFill: { height: 2, borderRadius: 1, backgroundColor: colors.ink },
  content: { flexGrow: 1, paddingHorizontal: GUTTER, paddingTop: 28, paddingBottom: 24 },
  title: { fontFamily: fonts.serif, fontSize: 26, lineHeight: 36, color: colors.ink },
  body: { marginTop: 28 },
  otherInput: { marginTop: 20 },
  footer: { paddingHorizontal: GUTTER, paddingTop: 12, backgroundColor: colors.background },
  actionStack: { gap: 10 },
});
