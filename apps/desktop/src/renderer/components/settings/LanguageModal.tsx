import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Search, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { LANGUAGES, matchesLanguage, useI18n, type LanguageCode } from "@/lib/i18n";

/**
 * "Choose your language": every language Falcon can be read in, as a grid
 * of cells, each with its own name over its English one. Opened from the
 * account pill's Language row and from Settings, General.
 *
 * Picking a cell applies the language at once and closes the panel; the
 * menus behind it have already changed by the time it has faded. The panel
 * is the settings panel's glass, a size smaller, and sits above it, so it can
 * be opened from inside Settings and Esc closes only this one.
 */

const PANEL_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: [0.33, 1, 0.68, 1] },
} as const;

const COLUMNS = 3;

/** A language's name in another language, when the runtime knows it. */
function displayName(code: LanguageCode, inLocale: string): string | null {
  try {
    return new Intl.DisplayNames([inLocale], { type: "language" }).of(code) ?? null;
  } catch {
    return null;
  }
}

export default function LanguageModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { language, locale, t, setLanguage } = useI18n();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  // A reader typing in the language the app is shown in finds the others by
  // the names they know them by ("Almanca", "ドイツ語"), not only by English.
  const shown = useMemo(
    () =>
      LANGUAGES.filter((l) => {
        const local = displayName(l.code, locale);
        return matchesLanguage(l, query, local ? [local] : []);
      }),
    [query, locale],
  );

  // The keyboard's place starts on the current language, or on the first
  // match once the reader is searching.
  useEffect(() => {
    if (!open) return;
    const at = query.trim() ? 0 : shown.findIndex((l) => l.code === language);
    setActive(Math.max(0, at));
  }, [open, query, shown, language]);

  useEffect(() => {
    gridRef.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (code: LanguageCode) => {
    setLanguage(code);
    onClose();
  };

  // Esc closes this panel and nothing under it: the listener runs in the
  // capture phase and stops the key there, before Settings' own listener
  // (or the account menu's) can see it. The page never scrolls under it, and
  // the search takes the caret on arrival.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const focus = window.setTimeout(() => searchRef.current?.focus(), 180);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
      window.clearTimeout(focus);
    };
  }, [open, onClose]);

  // A fresh open starts from a clean search.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  /**
   * Arrows walk the grid; Enter picks. Up and down move a row. Left and
   * right move a cell only while the search is empty, since in a typed
   * query they belong to the caret.
   */
  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = shown.length - 1;
    if (last < 0) return;
    let next: number | null = null;
    if (e.key === "ArrowDown") next = Math.min(last, active + COLUMNS);
    else if (e.key === "ArrowUp") next = Math.max(0, active - COLUMNS);
    else if (e.key === "ArrowRight" && !query) next = Math.min(last, active + 1);
    else if (e.key === "ArrowLeft" && !query) next = Math.max(0, active - 1);
    else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = shown[active];
      if (chosen) pick(chosen.code);
      return;
    }
    if (next !== null) {
      e.preventDefault();
      setActive(next);
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div key="language" className="fixed inset-0 z-[100] flex items-center justify-center">
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
            aria-labelledby="language-modal-title"
            className="app-no-drag relative flex max-h-[min(560px,82vh)] w-[min(720px,90vw)] flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            {...PANEL_FADE}
          >
            <div className="flex shrink-0 items-center justify-between px-6 pb-4 pt-5">
              <h2 id="language-modal-title" className="text-[17px] font-medium text-content-primary">
                {t("language.title")}
              </h2>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("common.close")}
                className="app-no-drag -mr-1.5 rounded-lg p-1.5 text-content-secondary transition-colors hover:bg-black/[0.04] hover:text-content-primary"
              >
                <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </button>
            </div>

            <div className="relative shrink-0 px-6">
              <Search
                className="pointer-events-none absolute left-9 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-content-tertiary"
                strokeWidth={1.75}
                aria-hidden
              />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder={t("language.search")}
                aria-label={t("language.search")}
                aria-controls="language-modal-list"
                aria-activedescendant={shown[active] ? `language-option-${shown[active].code}` : undefined}
                className="app-no-drag h-10 w-full rounded-xl border border-white/60 bg-white/55 pl-9 pr-3 text-[13.5px] font-normal text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] transition-colors placeholder:text-content-tertiary focus:bg-white/75 [&::-webkit-search-cancel-button]:hidden"
              />
            </div>

            <div className="scrollbar-meridian mt-4 min-h-0 flex-1 overflow-y-auto px-4 pb-5">
              {shown.length > 0 ? (
                <div
                  ref={gridRef}
                  id="language-modal-list"
                  role="listbox"
                  aria-label={t("language.title")}
                  className="grid grid-cols-3 gap-1"
                >
                  {shown.map((l, i) => {
                    const on = l.code === language;
                    const lit = i === active;
                    return (
                      <button
                        key={l.code}
                        id={`language-option-${l.code}`}
                        data-index={i}
                        type="button"
                        role="option"
                        aria-selected={on}
                        tabIndex={-1}
                        lang={l.code}
                        onClick={() => pick(l.code)}
                        onMouseMove={() => setActive(i)}
                        // The current language is lit like the rail's current row.
                        // The keyboard's place and the hover are black at 6%, not
                        // the ink tint: the dark theme reads a button carrying
                        // bg-ink as a solid call to action and inverts it.
                        className={cn(
                          "app-no-drag flex min-w-0 flex-col items-start rounded-xl px-3.5 py-2.5 text-left transition-colors duration-150",
                          on
                            ? "bg-white/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] ring-1 ring-black/[0.06]"
                            : lit
                              ? "bg-black/[0.06]"
                              : "hover:bg-black/[0.06]",
                        )}
                      >
                        <span className="flex w-full min-w-0 items-center gap-1.5">
                          <span className="truncate text-[13.5px] font-medium text-content-primary">{l.nativeName}</span>
                          {on ? (
                            <>
                              <Check className="h-3.5 w-3.5 shrink-0 text-content-primary" strokeWidth={2.25} aria-hidden />
                              <span className="sr-only">{t("language.current")}</span>
                            </>
                          ) : null}
                        </span>
                        <span lang="en" className="mt-0.5 w-full truncate text-[12px] font-normal text-content-secondary">
                          {l.englishName}
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="px-2 py-10 text-center text-[13px] font-normal text-content-tertiary">
                  {t("language.empty", { query: query.trim() })}
                </div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
