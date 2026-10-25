import { ArrowUpRight, Code } from "lucide-react";
import { replayOnboarding } from "@/lib/onboarding-replay";
import { useT } from "@/lib/i18n";
import { SettingsRow, SettingsSection } from "./SettingsRow";

/**
 * Developer: one card about API access, and the testing door into account
 * setup.
 *
 * Falcon has no public API and no developer portal, so the card says so and
 * points at the site, the one real page there is. The instrument panels
 * (Tracker, Base, Diagnostics) that used to be listed here still open from
 * their own shortcuts; the developer:* IPC handlers stay in main.
 */

const SITE_URL = "https://getfalcon.co";

const BUTTON =
  "app-no-drag btn-quiet rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[13px] font-normal text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:pointer-events-none disabled:opacity-60";

function ApiCard() {
  const t = useT();
  return (
    <section
      aria-labelledby="developer-api-title"
      className="rounded-2xl border border-white/60 bg-white/55 px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04]"
    >
      <div className="flex items-center gap-2">
        <Code className="h-4 w-4 shrink-0 text-content-secondary" strokeWidth={1.75} aria-hidden />
        <h2 id="developer-api-title" className="text-[15px] font-medium text-content-primary">
          {t("developer.api.title")}
        </h2>
      </div>
      <p className="mt-1.5 text-[12.5px] font-normal leading-snug text-content-secondary">{t("developer.api.body")}</p>
      <button
        type="button"
        onClick={() => void window.meridian?.openExternal(SITE_URL)}
        className={`${BUTTON} mt-3 inline-flex items-center gap-1.5`}
      >
        {t("developer.api.button")}
        <ArrowUpRight className="h-3.5 w-3.5 text-content-secondary" strokeWidth={1.75} aria-hidden />
      </button>
    </section>
  );
}

/**
 * The dark theme colour editor opens in a window of its own (main/developer/
 * theme-editor-window.ts). Outside the desktop app (a preview harness) the
 * same page opens in a browser tab, where it edits the same localStorage.
 */
function openThemeEditor() {
  const open = window.meridian?.openThemeEditor;
  if (open) {
    void open().catch(() => {});
    return;
  }
  window.open(new URL("/theme-editor.html", location.origin).href, "_blank");
}

export default function DeveloperPane() {
  const t = useT();
  return (
    <>
      <ApiCard />
      {/* TEMPORARY: goes away with lib/onboarding-replay. */}
      <SettingsSection title={t("developer.testing.title")} className="pt-6">
        <SettingsRow label={t("developer.testing.themeEditor")} description={t("developer.testing.themeEditorDescription")}>
          <button type="button" onClick={openThemeEditor} className={BUTTON}>
            {t("developer.testing.themeEditorButton")}
          </button>
        </SettingsRow>
        <SettingsRow
          label={t("developer.testing.setup")}
          description={t("developer.testing.setupDescription")}
          className="border-b-0"
        >
          <button type="button" onClick={replayOnboarding} className={BUTTON}>
            {t("developer.testing.setupButton")}
          </button>
        </SettingsRow>
      </SettingsSection>
    </>
  );
}
