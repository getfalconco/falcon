import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Loader2 } from "lucide-react";
import { EASE } from "@meridian/ui";
import type { User } from "@supabase/supabase-js";
import type { ExperienceLevel, SectorId } from "../../../shared/user-preferences";
import { SECTOR_IDS } from "../../../shared/user-preferences";
import type { StockCatalogEntry } from "../../../shared/stock-catalog";
import {
  DASHBOARD_CARD_ORDER,
  defaultDeskCards,
  deskCardOrder,
  inCardOrder,
  type DashboardCard,
  type HoldingPeriod,
  type PositionsMode,
} from "../../../shared/onboarding-desk";
import {
  DESK_CARD_LABEL_KEYS,
  EXPERIENCE_OPTIONS,
  HOLDING_OPTIONS,
  SECTOR_LABEL_KEYS,
} from "@/lib/onboarding-copy";
import { hasFullName, readPreferences, saveFullName, saveOnboardingProfile } from "@/lib/user-preferences";
import { inferCountry, submitOnboardingSurvey } from "@/lib/onboarding";
import { readFirstReading, requestCoverage, type FirstReading } from "@/lib/onboarding-reading";
import { writeCardOrder } from "@/lib/card-order";
import { CANVAS_LAYOUT_KEY } from "@/lib/canvas-layout";
import { DASHBOARD_CONFIG, isCardHidden } from "@/lib/dashboard-config";
import { getAccessToken } from "@/lib/broker-links";
import { heldSymbols } from "@/lib/portfolio-coverage";
import { getWatchlist, toggleFollow } from "@/lib/watchlist";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  OnboardingContinueButton,
  OnboardingOptionButton,
  OnboardingProgress,
  OnboardingShell,
  OnboardingSkipLink,
  onboardingInputClass,
} from "@/components/onboarding/onboarding-ui";
import TickerField from "@/components/onboarding/TickerField";
import { listNames, wordFact } from "@/components/onboarding/reading-words";

/**
 * Setup: five screens and a closing, about a minute. Every question changes
 * something the reader sees: the name greets them, their names fill the
 * watchlist and the first reading, the holding period picks the desk, the
 * depth sets how much is explained, and the desk screen is the dashboard
 * they open. It ends on a sentence about their own positions rather than a
 * "Finish" button.
 *
 *   name -> holdings (-> sectors, only when no tickers were given) -> holding
 *        -> depth -> desk -> reading
 */

type Step = "name" | "holdings" | "sectors" | "holding" | "depth" | "desk" | "reading";

/** The steps the counter counts; the sectors fallback stands in for holdings. */
const COUNTED: Step[] = ["holdings", "holding", "depth", "desk"];

/** Where the flow can open. The preview harness also opens on the holdings sub-screens. */
export type OnboardingStep = Step | "tickers" | "watch" | "brokerage";

/** Starting answers, for the preview harness. */
export type OnboardingPreset = {
  tickers?: string[];
  mode?: PositionsMode;
  holding?: HoldingPeriod;
  reading?: FirstReading;
};

type Props = {
  user: User;
  shellReady: boolean;
  onNameCaptured: () => void;
  onBackToName: () => void;
  onComplete: () => void;
  /** Where to open; the preview harness uses it to show one step. Defaults by whether a name is saved. */
  initialStep?: OnboardingStep;
  preset?: OnboardingPreset;
};

/** How "What do you hold?" is being answered on its second screen. */
type EntryMode = "tickers" | "watch" | "brokerage";

const VISIBLE_CARDS = DASHBOARD_CARD_ORDER.filter((card) => !isCardHidden(card));

const enter = {
  initial: { opacity: 0, x: 16 },
  animate: { opacity: 1, x: 0 },
  exit: { opacity: 0, y: -8 },
  transition: { duration: 0.45, ease: EASE },
};

function Title({ children, size = "md" }: { children: React.ReactNode; size?: "md" | "lg" }) {
  return (
    <h1
      className={cn(
        "font-serif font-normal tracking-[0.01em] text-white",
        size === "lg" ? "text-[2.5rem] leading-[1.2]" : "text-[2rem] leading-[1.25]",
      )}
    >
      {children}
    </h1>
  );
}

function Subtitle({ children }: { children: React.ReactNode }) {
  return (
    <p className="mt-4 text-balance text-sm leading-relaxed text-[#888888] [word-break:auto-phrase]">{children}</p>
  );
}

/**
 * Writes the chosen desk where the dashboard reads it: the card order Add
 * Module and the canvas share (lib/card-order), which also marks every kind
 * as offered, so a card left off stays off on later launches. The saved canvas is cleared, so the
 * dashboard lays the chosen cards out afresh instead of reconciling an older
 * arrangement around them.
 */
function writeDesk(cards: DashboardCard[]): void {
  try {
    writeCardOrder(localStorage, deskCardOrder(cards, DASHBOARD_CONFIG.hiddenCards), DASHBOARD_CARD_ORDER);
    localStorage.removeItem(CANVAS_LAYOUT_KEY);
  } catch {
    /* a blocked store opens the default dashboard instead */
  }
}

/** Typed names go on the watchlist, which the calendar's earnings rows and the stock view read. */
function writeWatchlist(tickers: string[], names: Record<string, string>): void {
  const followed = new Set(getWatchlist().map((e) => e.ticker.toUpperCase()));
  // In reverse, since a follow goes to the top: the list reads in the order typed.
  for (const ticker of [...tickers].reverse()) {
    if (!followed.has(ticker)) toggleFollow({ ticker, companyName: names[ticker] ?? ticker });
  }
}

export default function OnboardingFlow({
  user,
  shellReady,
  onNameCaptured,
  onBackToName,
  onComplete,
  initialStep,
  preset,
}: Props) {
  const { t, tNodes, locale } = useI18n();
  const br = { br: <br /> };
  const initial = readPreferences(user);
  const presetEntry: EntryMode | null =
    initialStep === "tickers" || initialStep === "watch" || initialStep === "brokerage" ? initialStep : null;
  const [step, setStep] = useState<Step>(
    presetEntry ? "holdings" : (initialStep as Step | undefined) ?? (hasFullName(user) ? "holdings" : "name"),
  );
  const [fullName, setFullName] = useState(initial.fullName);
  const [nameInput, setNameInput] = useState(initial.fullName);

  // What do you hold?
  const [entry, setEntry] = useState<EntryMode | null>(presetEntry);
  const [brokerageOpened, setBrokerageOpened] = useState(presetEntry === "brokerage");
  const [connecting, setConnecting] = useState(false);
  const [tickers, setTickers] = useState<string[]>(preset?.tickers ?? []);
  const [names, setNames] = useState<Record<string, string>>({});
  const [positionsMode, setPositionsMode] = useState<PositionsMode | null>(preset?.mode ?? null);
  const [sectors, setSectors] = useState<SectorId[]>(initial.sectors);

  const [holding, setHolding] = useState<HoldingPeriod | null>(preset?.holding ?? initial.holdingPeriod);
  const [experience, setExperience] = useState<ExperienceLevel | null>(initial.experience);
  // The desk follows the holding period until the reader changes a card by hand.
  const [deskCards, setDeskCards] = useState<DashboardCard[]>(() =>
    preset?.holding ? defaultDeskCards(preset.holding) : initial.deskCards,
  );
  const [deskFor, setDeskFor] = useState<HoldingPeriod | null>(preset?.holding ?? null);
  const [deskTouched, setDeskTouched] = useState(false);

  const [reading, setReading] = useState<FirstReading | null>(preset?.reading ?? null);
  const readingRun = useRef(0);

  const [loading, setLoading] = useState(false);
  // A key, so the line follows a language change while it shows.
  const [error, setError] = useState<MessageKey | null>(null);
  const [pendingAfterShell, setPendingAfterShell] = useState(false);

  useEffect(() => {
    if (pendingAfterShell && shellReady && step === "name" && fullName.trim()) {
      setPendingAfterShell(false);
      setStep("holdings");
    }
  }, [pendingAfterShell, shellReady, step, fullName]);

  function go(next: Step) {
    setError(null);
    setStep(next);
  }

  function goBack() {
    if (step === "name" || loading || pendingAfterShell) return;
    setError(null);
    switch (step) {
      case "holdings":
        if (entry) {
          setEntry(null);
          return;
        }
        setStep("name");
        onBackToName();
        return;
      case "sectors":
        setStep("holdings");
        return;
      case "holding":
        // Back to wherever the names were given (or skipped).
        setStep(positionsMode === "none" || (positionsMode === "brokerage" && tickers.length === 0) ? "sectors" : "holdings");
        return;
      case "depth":
        setStep("holding");
        return;
      case "desk":
        setStep("depth");
        return;
      case "reading":
        setStep("desk");
        return;
    }
  }

  async function handleNameContinue() {
    const trimmed = nameInput.trim();
    if (!trimmed || loading) return;
    setLoading(true);
    setError(null);
    try {
      await saveFullName(trimmed);
      setFullName(trimmed);
      setPendingAfterShell(true);
      onNameCaptured();
    } catch (err) {
      console.warn("[onboarding] could not save the name:", err);
      setError("auth.onboarding.name.saveFailed");
    } finally {
      setLoading(false);
    }
  }

  /** "Connect a brokerage": the SnapTrade portal the dashboard's Add asset opens, in the browser. */
  async function connectBrokerage() {
    if (connecting) return;
    const connect = window.meridian?.connectBrokerage;
    if (!connect) {
      setError("auth.onboarding.brokerage.unavailable");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const res = await connect({ accessToken: await getAccessToken() });
      if (res.ok) {
        setBrokerageOpened(true);
        setEntry("brokerage");
      } else {
        setError(res.configured ? "dashboard.addAsset.startFailed" : "auth.onboarding.brokerage.unavailable");
      }
    } catch (err) {
      console.warn("[onboarding] brokerage connection did not open:", err);
      setError("dashboard.addAsset.startFailed");
    } finally {
      setConnecting(false);
    }
  }

  /**
   * Starts the first reading as soon as the names are known, so it is ready
   * by the closing screen: the names are handed to coverage first (the
   * Tracker fetches history for any it lacks), then the reading is gathered.
   */
  function startReading(names: string[]) {
    const run = ++readingRun.current;
    setReading(null);
    const all = Array.from(new Set([...names, ...heldSymbols()]));
    void requestCoverage(names)
      .then((requested) => readFirstReading(all, requested))
      .then((result) => {
        if (readingRun.current === run) setReading(result);
      })
      .catch(() => {
        if (readingRun.current === run) setReading({ facts: [], started: [], notTracked: [], sectors: [] });
      });
  }

  function finishHoldings() {
    if (tickers.length === 0) return;
    const mode: PositionsMode = entry === "watch" ? "watch" : entry === "brokerage" ? "brokerage" : "tickers";
    setPositionsMode(mode);
    startReading(tickers);
    go("holding");
  }

  /** No tickers: the sectors question stands in for them. */
  function skipTickers() {
    setTickers([]);
    setPositionsMode(entry === "brokerage" ? "brokerage" : "none");
    startReading([]);
    go("sectors");
  }

  function toggleSector(id: SectorId) {
    setSectors((current) => (current.includes(id) ? current.filter((s) => s !== id) : [...current, id]));
  }

  function enterDesk() {
    if (!holding) return;
    if (!deskTouched || deskFor === null || deskCards.length === 0) {
      setDeskCards(defaultDeskCards(holding));
      setDeskFor(holding);
    } else if (deskFor !== holding) {
      // A new holding period after hand edits: the edits were for the old desk.
      setDeskCards(defaultDeskCards(holding));
      setDeskFor(holding);
      setDeskTouched(false);
    }
    go("desk");
  }

  function toggleCard(card: DashboardCard) {
    setDeskTouched(true);
    setDeskCards((current) =>
      current.includes(card) ? current.filter((c) => c !== card) : inCardOrder([...current, card]),
    );
  }

  async function finish() {
    if (!experience || !holding || !fullName.trim() || loading || deskCards.length === 0) return;
    setLoading(true);
    setError(null);
    const mode = positionsMode ?? "none";
    const inferred = reading?.sectors ?? [];
    const finalSectors = tickers.length > 0 ? (inferred.length > 0 ? inferred : initial.sectors) : sectors;
    try {
      // Local first: saving the profile marks setup done, and the app moves
      // on to the dashboard the moment it does.
      if (tickers.length > 0) writeWatchlist(tickers, names);
      writeDesk(deskCards);
      void submitOnboardingSurvey({
        fullName: fullName.trim(),
        investorRole: null,
        investorRoleOther: null,
        investingTenure: experience,
        researchFocus: null,
        sectors: finalSectors,
        country: inferCountry(),
        heardAbout: null,
      });
      await saveOnboardingProfile({
        fullName: fullName.trim(),
        experience,
        sectors: finalSectors,
        holdingPeriod: holding,
        deskCards,
        positionsMode: mode,
      });
      onComplete();
    } catch (err) {
      console.warn("[onboarding] could not save preferences:", err);
      setError("auth.onboarding.saveFailed");
    } finally {
      setLoading(false);
    }
  }

  const experienceAckKey = EXPERIENCE_OPTIONS.find((o) => o.id === experience)?.acknowledgmentKey;
  const showChrome = step !== "name";
  const counted = step === "sectors" ? "holdings" : step;
  const progressIndex = COUNTED.indexOf(counted) + 1;
  const watching = positionsMode === "watch";

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {showChrome ? (
        <>
          <button
            type="button"
            onClick={goBack}
            disabled={loading}
            aria-label={t("auth.back")}
            className="app-no-drag absolute left-8 top-14 z-50 flex h-8 w-8 items-center justify-center text-white/40 transition hover:bg-white/[0.06] hover:text-white/70"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          </button>
          {progressIndex > 0 ? <OnboardingProgress index={progressIndex} total={COUNTED.length} /> : null}
        </>
      ) : null}

      <AnimatePresence mode="wait">
        {step === "name" ? (
          <motion.div key="name" {...enter} exit={{ opacity: 0 }} className="flex h-full flex-col">
            <OnboardingShell>
              <header className="text-center">
                <Title>{tNodes("auth.onboarding.name.title", br)}</Title>
              </header>

              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                autoFocus
                placeholder={t("auth.onboarding.name.placeholder")}
                aria-label={t("auth.onboarding.name.placeholder")}
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleNameContinue();
                }}
                className={cn(onboardingInputClass, "mt-8")}
              />

              {error ? (
                <p role="alert" className="mt-3 text-center text-xs text-red-400">
                  {t(error)}
                </p>
              ) : null}

              <OnboardingContinueButton
                disabled={!nameInput.trim() || pendingAfterShell}
                loading={loading || pendingAfterShell}
                onClick={() => void handleNameContinue()}
                className="mt-3"
              >
                {loading || pendingAfterShell ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {t("auth.continue")}
              </OnboardingContinueButton>
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "holdings" && !entry ? (
          <motion.div key="holdings" {...enter} className="flex h-full flex-col">
            <OnboardingShell>
              <header className="text-center">
                <Title>{t("auth.onboarding.holdings.title")}</Title>
              </header>

              <div className="mt-8 space-y-2">
                <OnboardingOptionButton selected={false} disabled={connecting} onClick={() => void connectBrokerage()}>
                  <span className="flex items-center gap-2">
                    {t("auth.onboarding.holdings.brokerage")}
                    {connecting ? <Loader2 className="h-3.5 w-3.5 animate-spin text-white/40" aria-hidden /> : null}
                  </span>
                </OnboardingOptionButton>
                <OnboardingOptionButton
                  selected={false}
                  onClick={() => {
                    setError(null);
                    setEntry("tickers");
                  }}
                >
                  {t("auth.onboarding.holdings.tickers")}
                </OnboardingOptionButton>
                <OnboardingOptionButton
                  selected={false}
                  onClick={() => {
                    setError(null);
                    setEntry("watch");
                  }}
                >
                  {t("auth.onboarding.holdings.none")}
                </OnboardingOptionButton>
              </div>

              {error ? (
                <p role="alert" className="mt-4 text-center text-xs text-red-400">
                  {t(error)}
                </p>
              ) : null}
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "holdings" && entry ? (
          <motion.div key={`holdings-${entry}`} {...enter} className="flex h-full flex-col">
            <OnboardingShell>
              <header className="text-center">
                <Title>{t(entry === "watch" ? "auth.onboarding.watch.title" : "auth.onboarding.holdings.title")}</Title>
                {entry === "brokerage" && brokerageOpened ? (
                  <Subtitle>{t("auth.onboarding.brokerage.opened")}</Subtitle>
                ) : null}
              </header>

              <div className="mt-8">
                <TickerField
                  tickers={tickers}
                  onChange={(next, added) => {
                    setTickers(next);
                    if (added?.length) {
                      setNames((prev) => ({
                        ...prev,
                        ...Object.fromEntries(
                          added.map((e: StockCatalogEntry) => [e.symbol.toUpperCase(), e.companyName]),
                        ),
                      }));
                    }
                  }}
                  onSubmit={finishHoldings}
                />
              </div>

              <OnboardingContinueButton disabled={tickers.length === 0} onClick={finishHoldings} className="mt-6">
                {t("auth.continue")}
              </OnboardingContinueButton>
              {tickers.length === 0 ? <OnboardingSkipLink onClick={skipTickers} /> : null}
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "sectors" ? (
          <motion.div key="sectors" {...enter} className="flex h-full flex-col">
            <OnboardingShell>
              <header className="text-center">
                <Title>{t("auth.onboarding.sectors.title")}</Title>
                <Subtitle>{t("auth.onboarding.sectors.subtitle")}</Subtitle>
              </header>

              <div className="mt-8 flex flex-wrap justify-center gap-2">
                {SECTOR_IDS.map((id) => {
                  const selected = sectors.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleSector(id)}
                      aria-pressed={selected}
                      className={cn(
                        "app-no-drag border px-3 py-2 text-sm transition",
                        selected
                          ? "border-white/25 bg-white/[0.06] text-white"
                          : "border-white/10 text-white/60 hover:border-white/20 hover:text-white",
                      )}
                    >
                      {t(SECTOR_LABEL_KEYS[id])}
                    </button>
                  );
                })}
              </div>

              <OnboardingContinueButton
                disabled={sectors.length === 0}
                onClick={() => go("holding")}
                className="mt-10"
              >
                {t("auth.continue")}
              </OnboardingContinueButton>
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "holding" ? (
          <motion.div key="holding" {...enter} className="flex h-full flex-col">
            <OnboardingShell>
              <header className="text-center">
                <Title>{tNodes("auth.onboarding.holding.title", br)}</Title>
              </header>
              <div className="mt-8 space-y-2">
                {HOLDING_OPTIONS.map((option) => (
                  <OnboardingOptionButton
                    key={option.id}
                    selected={holding === option.id}
                    onClick={() => setHolding(option.id)}
                  >
                    {t(option.labelKey)}
                  </OnboardingOptionButton>
                ))}
              </div>
              <OnboardingContinueButton disabled={!holding} onClick={() => go("depth")} className="mt-6">
                {t("auth.continue")}
              </OnboardingContinueButton>
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "depth" ? (
          <motion.div key="depth" {...enter} className="flex h-full flex-col">
            <OnboardingShell>
              <header className="text-center">
                <Title>{tNodes("auth.onboarding.depth.title", br)}</Title>
              </header>

              <div className="mt-8 space-y-2">
                {EXPERIENCE_OPTIONS.map((option) => (
                  <OnboardingOptionButton
                    key={option.id}
                    selected={experience === option.id}
                    onClick={() => setExperience(option.id)}
                  >
                    {t(option.labelKey)}
                  </OnboardingOptionButton>
                ))}
              </div>

              <div className="mt-5 flex min-h-[2.75rem] items-start justify-center">
                <AnimatePresence mode="wait" initial={false}>
                  {experienceAckKey ? (
                    <motion.p
                      key={experience}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3, ease: EASE }}
                      className="text-balance text-center text-sm leading-relaxed text-white/30 [word-break:auto-phrase]"
                    >
                      {t(experienceAckKey)}
                    </motion.p>
                  ) : null}
                </AnimatePresence>
              </div>

              <OnboardingContinueButton disabled={!experience} onClick={enterDesk} className="mt-3">
                {t("auth.continue")}
              </OnboardingContinueButton>
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "desk" ? (
          <motion.div key="desk" {...enter} className="flex h-full flex-col">
            <OnboardingShell>
              <header className="text-center">
                <Title>{t("auth.onboarding.desk.title")}</Title>
              </header>

              <div className="mt-8 grid grid-cols-2 gap-2">
                {VISIBLE_CARDS.map((card) => (
                  <OnboardingOptionButton
                    key={card}
                    toggle
                    selected={deskCards.includes(card)}
                    onClick={() => toggleCard(card)}
                  >
                    {t(DESK_CARD_LABEL_KEYS[card])}
                  </OnboardingOptionButton>
                ))}
              </div>

              <OnboardingContinueButton
                disabled={deskCards.length === 0}
                onClick={() => go("reading")}
                className="mt-6"
              >
                {t("auth.continue")}
              </OnboardingContinueButton>
              <p className="mt-4 text-center text-xs text-white/35">
                {t("auth.onboarding.desk.later", { addModule: t("modules.addButton") })}
              </p>
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "reading" ? (
          <motion.div
            key="reading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, ease: EASE }}
            className="flex h-full flex-col"
          >
            <OnboardingShell>
              <header className="text-center">
                <p className="text-[10px] uppercase tracking-[0.14em] text-white/35">
                  {t(watching ? "auth.onboarding.reading.titleWatch" : "auth.onboarding.reading.title")}
                </p>
              </header>

              <div className="mt-6 flex min-h-[7.5rem] flex-col items-center justify-center" aria-live="polite">
                {reading === null ? (
                  <p className="flex items-center gap-2 text-sm text-white/40">
                    <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
                    {t("auth.onboarding.reading.loading")}
                  </p>
                ) : (
                  <motion.div
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.5, ease: EASE }}
                    className="space-y-3 text-center"
                  >
                    {reading.facts.length > 0 ? (
                      reading.facts.map((fact, i) => (
                        <p
                          key={i}
                          className="text-balance font-serif text-[1.3rem] font-normal leading-[1.45] tracking-[0.01em] text-white [word-break:auto-phrase]"
                        >
                          {wordFact(t, fact, locale)}
                        </p>
                      ))
                    ) : (
                      <p className="text-balance font-serif text-[1.3rem] font-normal leading-[1.45] tracking-[0.01em] text-white [word-break:auto-phrase]">
                        {t(
                          tickers.length === 0 && heldSymbols().length === 0
                            ? "auth.onboarding.reading.noPositions"
                            : watching
                              ? "auth.onboarding.reading.nothingWatch"
                              : "auth.onboarding.reading.nothing",
                        )}
                      </p>
                    )}
                    {reading.started.length > 0 ? (
                      <p className="pt-2 text-xs text-white/40">
                        {t("auth.onboarding.reading.started", { names: listNames(reading.started, locale) })}
                      </p>
                    ) : null}
                    {reading.notTracked.length > 0 ? (
                      <p className="pt-2 text-xs text-white/40">
                        {t("auth.onboarding.reading.notTracked", { names: listNames(reading.notTracked, locale) })}
                      </p>
                    ) : null}
                  </motion.div>
                )}
              </div>

              {error ? (
                <p role="alert" className="mt-4 text-center text-xs text-red-400">
                  {t(error)}
                </p>
              ) : null}

              <OnboardingContinueButton disabled={loading} loading={loading} onClick={() => void finish()}>
                {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                {t("auth.onboarding.reading.open")}
              </OnboardingContinueButton>
            </OnboardingShell>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
