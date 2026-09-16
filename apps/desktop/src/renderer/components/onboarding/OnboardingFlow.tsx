import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, Loader2 } from "lucide-react";
import { EASE } from "@meridian/ui";
import type { User } from "@supabase/supabase-js";
import type { ExperienceLevel, SectorId } from "../../../shared/user-preferences";
import { SECTOR_IDS } from "../../../shared/user-preferences";
import type { OnboardingSurveyAnswers } from "../../../shared/onboarding-survey";
import {
  EXPERIENCE_OPTIONS,
  INVESTOR_ROLE_OPTIONS,
  RESEARCH_FOCUS_OPTIONS,
  SECTOR_LABELS,
  SECTOR_PREVIEWS,
} from "@/lib/onboarding-copy";
import {
  hasFullName,
  readPreferences,
  saveFullName,
  saveOnboardingProfile,
} from "@/lib/user-preferences";
import { submitOnboardingSurvey } from "@/lib/onboarding";
import { cn } from "@/lib/utils";
import {
  OnboardingContinueButton,
  OnboardingCountrySelect,
  OnboardingOptionButton,
  OnboardingProgress,
  OnboardingShell,
  OnboardingSkipLink,
  onboardingInputClass,
} from "@/components/onboarding/onboarding-ui";

type LinearStep = "intro" | "country" | "role" | "tenure" | "focus" | "sectors" | "heard_about";

const LINEAR_STEPS: LinearStep[] = [
  "intro",
  "country",
  "role",
  "tenure",
  "focus",
  "sectors",
  "heard_about",
];

type Step = "name" | LinearStep | "beat";

const SECTOR_BEAT_MS = 4800;

type Props = {
  user: User;
  shellReady: boolean;
  onNameCaptured: () => void;
  onBackToName: () => void;
  onComplete: () => void;
};

function firstName(fullName: string): string {
  const part = fullName.trim().split(/\s+/)[0];
  return part || fullName.trim();
}

type SelectStepProps<T extends string> = {
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  options: { id: T; label: string }[];
  value: T | null;
  onSelect: (id: T) => void;
  onContinue: () => void;
};

function SelectStep<T extends string>({
  title,
  subtitle,
  options,
  value,
  onSelect,
  onContinue,
}: SelectStepProps<T>) {
  return (
    <OnboardingShell>
      <header className="text-center">
        <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-white">
          {title}
        </h1>
        {subtitle ? (
          <p className="mt-4 text-sm leading-relaxed text-[#888888]">{subtitle}</p>
        ) : null}
      </header>

      <div className="mt-8 space-y-2">
        {options.map((option) => (
          <OnboardingOptionButton
            key={option.id}
            selected={value === option.id}
            onClick={() => onSelect(option.id)}
          >
            {option.label}
          </OnboardingOptionButton>
        ))}
      </div>

      <OnboardingContinueButton disabled={!value} onClick={onContinue} className="mt-6">
        Continue
      </OnboardingContinueButton>
    </OnboardingShell>
  );
}

export default function OnboardingFlow({
  user,
  shellReady,
  onNameCaptured,
  onBackToName,
  onComplete,
}: Props) {
  const initial = readPreferences(user);
  const [step, setStep] = useState<Step>(hasFullName(user) ? "intro" : "name");
  const [fullName, setFullName] = useState(initial.fullName);
  const [nameInput, setNameInput] = useState(initial.fullName);
  const [investorRole, setInvestorRole] = useState<OnboardingSurveyAnswers["investorRole"]>(null);
  const [investorRoleOther, setInvestorRoleOther] = useState("");
  const [experience, setExperience] = useState<ExperienceLevel | null>(initial.experience);
  const [focus, setFocus] = useState<OnboardingSurveyAnswers["researchFocus"]>(null);
  const [sectors, setSectors] = useState<SectorId[]>(initial.sectors);
  const [previewSector, setPreviewSector] = useState<SectorId | null>(initial.sectors[0] ?? null);
  const [country, setCountry] = useState("");
  const [heardAbout, setHeardAbout] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingAfterShell, setPendingAfterShell] = useState(false);

  useEffect(() => {
    if (pendingAfterShell && shellReady && step === "name" && fullName.trim()) {
      setPendingAfterShell(false);
      setStep("intro");
    }
  }, [pendingAfterShell, shellReady, step, fullName]);

  useEffect(() => {
    if (step !== "beat") return;
    const timer = window.setTimeout(() => {
      void finishAfterBeat();
    }, SECTOR_BEAT_MS);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- finish once when beat mounts
  }, [step]);

  function goNext() {
    setError(null);
    setStep((s) => {
      const idx = LINEAR_STEPS.indexOf(s as LinearStep);
      if (idx === -1) return s;
      return idx + 1 < LINEAR_STEPS.length ? LINEAR_STEPS[idx + 1]! : "beat";
    });
  }

  function goBack() {
    if (step === "name" || loading || pendingAfterShell) return;
    setError(null);
    if (step === "intro") {
      setStep("name");
      onBackToName();
      return;
    }
    if (step === "beat") {
      setStep(LINEAR_STEPS[LINEAR_STEPS.length - 1]!);
      return;
    }
    const idx = LINEAR_STEPS.indexOf(step);
    if (idx > 0) setStep(LINEAR_STEPS[idx - 1]!);
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
      setError(err instanceof Error ? err.message : "Could not save your name.");
    } finally {
      setLoading(false);
    }
  }

  function toggleSector(id: SectorId) {
    setSectors((current) => {
      if (current.includes(id)) {
        const next = current.filter((s) => s !== id);
        setPreviewSector((prev) => (prev === id ? next[next.length - 1] ?? null : prev));
        return next;
      }
      setPreviewSector(id);
      return [...current, id];
    });
  }

  async function finishAfterBeat() {
    if (!experience || sectors.length === 0 || !fullName.trim() || loading) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await saveOnboardingProfile({
        fullName: fullName.trim(),
        experience,
        sectors,
      });
      void submitOnboardingSurvey({
        fullName: fullName.trim(),
        investorRole,
        investorRoleOther:
          investorRole === "other" ? investorRoleOther.trim() || null : null,
        investingTenure: experience,
        researchFocus: focus,
        sectors,
        country: country.trim() || null,
        heardAbout: heardAbout.trim() || null,
      });
      onComplete();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save your preferences.");
      setStep(LINEAR_STEPS[LINEAR_STEPS.length - 1]!);
    } finally {
      setLoading(false);
    }
  }

  const experienceAck = EXPERIENCE_OPTIONS.find((o) => o.id === experience)?.acknowledgment;
  const beatCopy = previewSector ? SECTOR_PREVIEWS[previewSector] : null;
  const showChrome = step !== "name" && step !== "beat";
  const progressIndex = showChrome ? LINEAR_STEPS.indexOf(step as LinearStep) + 1 : 0;

  return (
    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
      {showChrome ? (
        <>
          <button
            type="button"
            onClick={goBack}
            disabled={loading}
            aria-label="Back"
            className="app-no-drag absolute left-8 top-14 z-50 flex h-8 w-8 items-center justify-center text-white/40 transition hover:bg-white/[0.06] hover:text-white/70"
          >
            <ArrowLeft className="h-4 w-4" strokeWidth={1.75} />
          </button>
          <OnboardingProgress index={progressIndex} total={LINEAR_STEPS.length} />
        </>
      ) : null}

      <AnimatePresence mode="wait">
        {step === "name" ? (
          <motion.div
            key="name"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex h-full flex-col"
          >
            <OnboardingShell>
              <header className="text-center">
                <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-white">
                  How should we
                  <br />
                  call you?
                </h1>
              </header>

              <input
                id="name"
                name="name"
                type="text"
                autoComplete="name"
                autoFocus
                placeholder="Your name"
                aria-label="Your name"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void handleNameContinue();
                }}
                className={cn(onboardingInputClass, "mt-8")}
              />

              {error ? <p className="mt-3 text-center text-xs text-red-400">{error}</p> : null}

              <OnboardingContinueButton
                disabled={!nameInput.trim() || pendingAfterShell}
                loading={loading || pendingAfterShell}
                onClick={() => void handleNameContinue()}
                className="mt-3"
              >
                {loading || pendingAfterShell ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
                ) : null}
                Continue
              </OnboardingContinueButton>
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "intro" ? (
          <motion.div
            key="intro"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex h-full flex-col"
          >
            <OnboardingShell>
              <header className="text-center">
                <h1 className="font-serif text-[2.5rem] font-normal leading-[1.2] tracking-[0.01em] text-white">
                  {firstName(fullName)}.
                </h1>
                <p className="mt-5 text-sm leading-relaxed text-[#888888]">
                  A few quick questions, then Falcon reads the market for you.
                </p>
              </header>
              <OnboardingContinueButton onClick={goNext}>Continue</OnboardingContinueButton>
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "country" ? (
          <motion.div
            key="country"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex h-full flex-col"
          >
            <OnboardingShell>
              <header className="text-center">
                <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-white">
                  Where are you
                  <br />
                  based?
                </h1>
              </header>

              <div className="mt-8">
                <OnboardingCountrySelect value={country || null} onChange={setCountry} />
              </div>

              <OnboardingContinueButton disabled={!country} onClick={goNext} className="mt-6">
                Continue
              </OnboardingContinueButton>
              {!country ? <OnboardingSkipLink onClick={goNext} /> : null}
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "role" ? (
          <motion.div
            key="role"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex h-full flex-col"
          >
            <OnboardingShell>
              <header className="text-center">
                <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-white">
                  How would you
                  <br />
                  describe yourself?
                </h1>
              </header>

              <div className="mt-8 space-y-2">
                {INVESTOR_ROLE_OPTIONS.map((option) => (
                  <OnboardingOptionButton
                    key={option.id}
                    selected={investorRole === option.id}
                    subtitle={option.subtitle}
                    onClick={() => setInvestorRole(option.id)}
                  >
                    {option.label}
                  </OnboardingOptionButton>
                ))}

                <AnimatePresence initial={false}>
                  {investorRole === "other" ? (
                    <motion.div
                      key="role-other"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: "auto", opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.28, ease: EASE }}
                      className="overflow-hidden"
                    >
                      <input
                        type="text"
                        autoFocus
                        placeholder="Tell us in a few words"
                        aria-label="Tell us in a few words"
                        value={investorRoleOther}
                        onChange={(e) => setInvestorRoleOther(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" && investorRoleOther.trim()) goNext();
                        }}
                        className={cn(onboardingInputClass, "mt-2")}
                      />
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>

              <OnboardingContinueButton
                disabled={
                  !investorRole || (investorRole === "other" && !investorRoleOther.trim())
                }
                onClick={goNext}
                className="mt-6"
              >
                Continue
              </OnboardingContinueButton>
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "tenure" ? (
          <motion.div
            key="tenure"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex h-full flex-col"
          >
            <OnboardingShell>
              <header className="text-center">
                <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-white">
                  How long have you
                  <br />
                  been investing?
                </h1>
                <p className="mt-4 text-sm leading-relaxed text-[#888888]">
                  This sets how much we explain, and how much we skip.
                </p>
              </header>

              <div className="mt-8 space-y-2">
                {EXPERIENCE_OPTIONS.map((option) => (
                  <OnboardingOptionButton
                    key={option.id}
                    selected={experience === option.id}
                    onClick={() => setExperience(option.id)}
                  >
                    {option.label}
                  </OnboardingOptionButton>
                ))}
              </div>

              <div className="mt-5 flex min-h-[2.75rem] items-start justify-center">
                <AnimatePresence mode="wait" initial={false}>
                  {experienceAck ? (
                    <motion.p
                      key={experience}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      transition={{ duration: 0.3, ease: EASE }}
                      className="text-center text-sm leading-relaxed text-white/30"
                    >
                      {experienceAck}
                    </motion.p>
                  ) : null}
                </AnimatePresence>
              </div>

              <OnboardingContinueButton disabled={!experience} onClick={goNext} className="mt-3">
                Continue
              </OnboardingContinueButton>
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "focus" ? (
          <motion.div
            key="focus"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex h-full flex-col"
          >
            <SelectStep
              title="What's your primary focus?"
              options={RESEARCH_FOCUS_OPTIONS}
              value={focus}
              onSelect={setFocus}
              onContinue={goNext}
            />
          </motion.div>
        ) : null}

        {step === "sectors" ? (
          <motion.div
            key="sectors"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex h-full flex-col"
          >
            <OnboardingShell>
              <header className="text-center">
                <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-white">
                  What do you follow?
                </h1>
                <p className="mt-4 text-sm leading-relaxed text-[#888888]">
                  Pick a few. This shapes what Falcon surfaces first.
                </p>
              </header>

              <div className="mt-8 flex flex-wrap justify-center gap-2">
                {SECTOR_IDS.map((id) => {
                  const selected = sectors.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleSector(id)}
                      className={cn(
                        "app-no-drag border px-3 py-2 text-sm transition",
                        selected
                          ? "border-white/25 bg-white/[0.06] text-white"
                          : "border-white/10 text-white/60 hover:border-white/20 hover:text-white",
                      )}
                    >
                      {SECTOR_LABELS[id]}
                    </button>
                  );
                })}
              </div>

              {error ? <p className="mt-6 text-center text-xs text-red-400">{error}</p> : null}

              <OnboardingContinueButton
                disabled={sectors.length === 0 || loading}
                onClick={() => {
                  if (sectors.length === 0) return;
                  goNext();
                }}
                className="mt-10"
              >
                Continue
              </OnboardingContinueButton>
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "heard_about" ? (
          <motion.div
            key="heard_about"
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.45, ease: EASE }}
            className="flex h-full flex-col"
          >
            <OnboardingShell>
              <header className="text-center">
                <h1 className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-white">
                  How did you hear
                  <br />
                  about Falcon?
                </h1>
              </header>

              <input
                type="text"
                autoFocus
                placeholder="Twitter, a friend, a newsletter…"
                aria-label="How did you hear about Falcon?"
                value={heardAbout}
                onChange={(e) => setHeardAbout(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") goNext();
                }}
                className={cn(onboardingInputClass, "mt-8")}
              />

              {error ? <p className="mt-4 text-center text-xs text-red-400">{error}</p> : null}

              <OnboardingContinueButton
                disabled={loading}
                loading={loading}
                onClick={goNext}
                className="mt-6"
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
                Finish
              </OnboardingContinueButton>
              {!heardAbout.trim() ? <OnboardingSkipLink onClick={goNext} /> : null}
            </OnboardingShell>
          </motion.div>
        ) : null}

        {step === "beat" && beatCopy ? (
          <motion.div
            key="sector-beat"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.55, ease: EASE }}
            className="flex h-full flex-col"
          >
            <div className="flex min-h-0 flex-1 flex-col items-center justify-center px-10">
              <motion.p
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.6, ease: EASE, delay: 0.08 }}
                className="max-w-[26rem] text-center font-serif text-[1.35rem] font-normal leading-[1.45] tracking-[0.01em] text-white"
              >
                {beatCopy}
              </motion.p>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
