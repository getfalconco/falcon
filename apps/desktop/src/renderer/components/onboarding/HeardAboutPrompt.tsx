import { useState } from "react";
import { X } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import { HEARD_ABOUT_SOURCES, shouldAskHeardAbout, type HeardAboutSource } from "../../../shared/onboarding-followup";
import { HEARD_ABOUT_LABEL_KEYS } from "@/lib/onboarding-copy";
import { submitOnboardingSurvey, surveyAnswersFor } from "@/lib/onboarding";
import { markHeardPromptDone, readPreferences } from "@/lib/user-preferences";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Same glass as the update notice, at the scale of a small card. */
const GLASS =
  "rounded-2xl border border-white/60 bg-white/55 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_16px_40px_rgba(0,0,0,0.10)] " +
  "ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150";

/** Kept on this machine too, so the card is gone at once and stays gone if the account write fails. */
function localKey(userId: string): string {
  return `falcon.ui.heardPrompt.${userId}`;
}

function readLocalDone(userId: string): boolean {
  try {
    return localStorage.getItem(localKey(userId)) === "1";
  } catch {
    return false;
  }
}

function writeLocalDone(userId: string): void {
  try {
    localStorage.setItem(localKey(userId), "1");
  } catch {
    /* the account flag still holds */
  }
}

/**
 * "How did you hear about Falcon?", asked once with one tap, a week after
 * setup (shared/onboarding-followup). The answer goes where setup used to put
 * it, the `heard_about` field of the onboarding answers. Answered or
 * dismissed, it is not asked again.
 */
export default function HeardAboutPrompt({ user, className }: { user: User | null | undefined; className?: string }) {
  const t = useT();
  const [done, setDone] = useState(() => (user ? readLocalDone(user.id) : true));
  if (!user || done) return null;
  const prefs = readPreferences(user);
  if (!shouldAskHeardAbout({ completedAt: prefs.onboardingCompletedAt, done: prefs.heardPromptDone, now: Date.now() })) {
    return null;
  }

  function close(answer: HeardAboutSource | null) {
    if (!user) return;
    setDone(true);
    writeLocalDone(user.id);
    if (answer) void submitOnboardingSurvey(surveyAnswersFor(user, answer));
    void markHeardPromptDone().catch((err) => console.warn("[onboarding] could not keep the answer:", err));
  }

  return (
    <section aria-label={t("auth.heard.title")} className={cn("app-no-drag w-[19rem] p-4", GLASS, className)}>
      <div className="flex items-start justify-between gap-3">
        <p className="text-[12.5px] font-medium text-content-primary">{t("auth.heard.title")}</p>
        <button
          type="button"
          onClick={() => close(null)}
          aria-label={t("common.close")}
          className="-mr-1 -mt-1 rounded-md p-1 text-content-secondary transition-colors hover:bg-black/[0.05] hover:text-content-primary"
        >
          <X className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
        </button>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {HEARD_ABOUT_SOURCES.map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => close(id)}
            className="rounded-full border border-black/[0.08] px-2.5 py-1 text-[11.5px] text-content-secondary transition-colors hover:bg-black/[0.05] hover:text-content-primary"
          >
            {t(HEARD_ABOUT_LABEL_KEYS[id])}
          </button>
        ))}
      </div>
    </section>
  );
}
