import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { EASE } from "@meridian/ui";
import type { User } from "@supabase/supabase-js";
import AnimatedGradientPanel from "@/components/AnimatedGradientPanel";
import LoginForm from "@/components/LoginForm";
import OnboardingFlow from "@/components/onboarding/OnboardingFlow";
import WindowControls from "@/components/WindowControls";
import WaitlistView from "@/components/WaitlistView";
import { hasFullName } from "@/lib/user-preferences";

const PANEL_DEFAULT = "minmax(0, 0.82fr) minmax(0, 1.18fr)";
const PANEL_EXPANDED = "minmax(0, 0.28fr) minmax(0, 0.72fr)";

const EXPAND_MS = 650;
const TESTIMONIAL_FADE_MS = 550;

export type LoginPageMode = "login" | "waitlist" | "onboarding";

type Props = {
  mode: LoginPageMode;
  user: User | null;
  onSuccess: () => void;
  onWaitlist: () => void;
  onProfileComplete: () => void;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

export default function LoginPage({
  mode,
  user,
  onSuccess,
  onWaitlist,
  onProfileComplete,
}: Props) {
  const resumeExpanded = mode === "onboarding" && Boolean(user && hasFullName(user));
  const [panelExpanded, setPanelExpanded] = useState(resumeExpanded);
  const [showTestimonials, setShowTestimonials] = useState(!resumeExpanded);
  const [shellReady, setShellReady] = useState(resumeExpanded);
  const transitioning = useRef(false);

  useEffect(() => {
    if (mode !== "onboarding") {
      setPanelExpanded(false);
      setShowTestimonials(true);
      setShellReady(false);
      transitioning.current = false;
      return;
    }

    if (user && hasFullName(user)) {
      setPanelExpanded(true);
      setShowTestimonials(false);
      setShellReady(true);
    }
  }, [mode, user]);

  async function handleNameCaptured() {
    if (transitioning.current || shellReady) return;
    transitioning.current = true;

    setPanelExpanded(true);
    await sleep(EXPAND_MS);

    setShowTestimonials(false);
    await sleep(TESTIMONIAL_FADE_MS);

    setShellReady(true);
    transitioning.current = false;
  }

  function handleBackToName() {
    transitioning.current = false;
    setShellReady(false);
    setShowTestimonials(true);
    setPanelExpanded(false);
  }

  return (
    <div className="h-full overflow-hidden bg-background font-sans">
      <motion.div
        className="grid h-full overflow-hidden"
        initial={false}
        animate={{
          gridTemplateColumns: panelExpanded ? PANEL_EXPANDED : PANEL_DEFAULT,
        }}
        transition={{ duration: EXPAND_MS / 1000, ease: "easeInOut" }}
      >
        <div className="min-w-0 overflow-hidden">
          <AnimatedGradientPanel showTestimonials={showTestimonials} />
        </div>

        <div className="auth-surface relative flex h-full min-w-0 flex-col bg-background">
          {mode !== "waitlist" ? (
            <>
              <WindowControls className="absolute right-4 top-[5px] z-50" />
              <div className="app-drag-region absolute left-0 right-[5.5rem] top-0 z-40 h-9" aria-hidden />
            </>
          ) : null}

          <AnimatePresence mode="wait">
            {mode === "waitlist" ? (
              <motion.div
                key="waitlist"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.5, ease: EASE }}
                className="flex h-full flex-col"
              >
                <WaitlistView />
              </motion.div>
            ) : mode === "onboarding" && user ? (
              <motion.div
                key="onboarding"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.4, ease: EASE }}
                className="flex h-full flex-col"
              >
                <OnboardingFlow
                  user={user}
                  shellReady={shellReady}
                  onNameCaptured={() => void handleNameCaptured()}
                  onBackToName={handleBackToName}
                  onComplete={onProfileComplete}
                />
              </motion.div>
            ) : (
              <motion.div
                key="login"
                initial={{ opacity: 0, x: 16 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, y: -8 }}
                transition={{ duration: 0.45, ease: EASE }}
                className="flex h-full flex-col"
              >
                <LoginForm onSuccess={onSuccess} onWaitlist={onWaitlist} />
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </div>
  );
}
