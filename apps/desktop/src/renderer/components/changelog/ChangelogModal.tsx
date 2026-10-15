import { useEffect } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import {
  CHANGELOG,
  CHANGELOG_SECTIONS,
  formatReleaseDate,
  markChangelogSeen,
  type ChangelogRelease,
} from "@/lib/changelog";
import { useI18n } from "@/lib/i18n";

/**
 * "What's new", opened from the account menu's View Changelog: every release
 * newest first, each a date and (where it has one) a version, then what was
 * new, improved and fixed, in plain sentences.
 *
 * Built on the settings panel's pattern (portal, blurred backdrop, the same
 * glass and the same fade, Esc closes) but narrow and tall, since it is read
 * top to bottom like a page rather than navigated. Opening it marks the
 * newest release as seen, which clears the dot on the menu row.
 */

/** The settings panel's arrival: a fade, at the size it keeps. */
const PANEL_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: [0.33, 1, 0.68, 1] },
} as const;

/** NEW / IMPROVED / FIXED, set like the app's other small mastheads. */
const SECTION_LABEL =
  "select-none font-sans text-[10.5px] font-medium uppercase tracking-[0.08em] text-[#9CA3AF]";

function Release({ release }: { release: ChangelogRelease }) {
  const { t, locale } = useI18n();
  return (
    <section className="border-t border-black/[0.06] py-6 first:border-t-0 first:pt-2">
      <header className="flex items-center justify-between gap-3">
        <h3 className="text-[14px] font-semibold text-[#1d1b1b]">{formatReleaseDate(release.date, locale)}</h3>
        {release.version ? (
          <span
            aria-label={t("changelog.version", { version: release.version })}
            className="shrink-0 rounded-md bg-black/[0.05] px-2 py-0.5 font-mono text-[11.5px] text-[#4b5563]"
          >
            {release.version}
          </span>
        ) : null}
      </header>
      {CHANGELOG_SECTIONS.map(({ key, labelKey }) => {
        const lines = release.sections[key];
        if (!lines?.length) return null;
        return (
          <div key={key} className="mt-4">
            <div className={SECTION_LABEL}>{t(labelKey)}</div>
            <ul className="mt-2 list-disc space-y-1.5 pl-[18px] text-[13px] leading-[1.65] text-[#374151]">
              {lines.map((line) => (
                <li key={line} className="pl-0.5">
                  {t(line)}
                </li>
              ))}
            </ul>
          </div>
        );
      })}
    </section>
  );
}

export default function ChangelogModal({
  open,
  onClose,
  releases = CHANGELOG,
}: {
  open: boolean;
  onClose: () => void;
  /** The releases to list; the app's own changelog unless a harness passes others. */
  releases?: readonly ChangelogRelease[];
}) {
  const { t } = useI18n();
  // Opening it is what counts as having seen the newest release.
  useEffect(() => {
    if (open) markChangelogSeen();
  }, [open]);

  // Esc closes, and the page behind never scrolls under the panel.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div key="changelog" className="fixed inset-0 z-[90] flex items-center justify-center">
          {/* Backdrop — the dashboard blurs away behind the panel. */}
          <motion.div
            className="app-no-drag absolute inset-0 bg-black/10"
            style={{ backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.33, 1, 0.68, 1] }}
            onClick={onClose}
          />

          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby="changelog-title"
            className="app-no-drag relative flex h-[min(620px,86vh)] w-[min(520px,90vw)] flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            {...PANEL_FADE}
          >
            <div className="flex shrink-0 items-center justify-between px-7 pb-3 pt-6">
              <h2 id="changelog-title" className="text-[17px] font-semibold text-[#1d1b1b]">
                {t("changelog.title")}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("common.close")}
                className="app-no-drag -mr-2 rounded-lg p-1.5 text-[#6b7280] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
              >
                <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </button>
            </div>
            <div data-selectable className="scrollbar-meridian min-h-0 flex-1 overflow-y-auto px-7 pb-4">
              {releases.map((release) => (
                <Release key={release.date} release={release} />
              ))}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
