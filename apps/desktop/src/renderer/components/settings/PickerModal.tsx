import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Search, X } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/**
 * A searchable list in the language picker's glass: one column of options,
 * each a name over a quiet second line. Picking one applies it and closes the
 * panel. Esc closes this panel and nothing under it; the arrows walk the list
 * and Enter picks. Used by Settings, General for the region and the time zone.
 */

export type PickerOption = { id: string; title: string; subtitle?: string; search: string };

const PANEL_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: [0.33, 1, 0.68, 1] },
} as const;

function fold(text: string): string {
  return text.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").toLowerCase();
}

export default function PickerModal({
  open,
  title,
  searchLabel,
  options,
  current,
  onPick,
  onClose,
}: {
  open: boolean;
  title: string;
  searchLabel: string;
  options: PickerOption[];
  current: string;
  onPick: (id: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const idBase = useMemo(() => `picker-${Math.random().toString(36).slice(2, 8)}`, []);

  const shown = useMemo(() => {
    const q = fold(query.trim());
    return q ? options.filter((o) => fold(o.search).includes(q)) : options;
  }, [options, query]);

  useEffect(() => {
    if (!open) return;
    const at = query.trim() ? 0 : shown.findIndex((o) => o.id === current);
    setActive(Math.max(0, at));
  }, [open, query, shown, current]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const focus = window.setTimeout(() => searchRef.current?.focus(), 180);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.clearTimeout(focus);
    };
  }, [open, onClose]);

  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const pick = (id: string) => {
    onPick(id);
    onClose();
  };

  const onSearchKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    const last = shown.length - 1;
    if (last < 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(last, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const chosen = shown[active];
      if (chosen) pick(chosen.id);
    }
  };

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div key="picker" className="fixed inset-0 z-[100] flex items-center justify-center">
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
            aria-labelledby={`${idBase}-title`}
            className="app-no-drag relative flex max-h-[min(560px,82vh)] w-[min(460px,90vw)] flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            {...PANEL_FADE}
          >
            <div className="flex shrink-0 items-center justify-between px-6 pb-4 pt-5">
              <h2 id={`${idBase}-title`} className="text-[17px] font-medium text-content-primary">
                {title}
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
              <Search className="pointer-events-none absolute left-9 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-content-tertiary" strokeWidth={1.75} aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={onSearchKey}
                placeholder={searchLabel}
                aria-label={searchLabel}
                aria-controls={`${idBase}-list`}
                aria-activedescendant={shown[active] ? `${idBase}-${active}` : undefined}
                className="app-no-drag h-10 w-full rounded-xl border border-white/60 bg-white/55 pl-9 pr-3 text-[13.5px] font-normal text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] transition-colors placeholder:text-content-tertiary focus:bg-white/75 [&::-webkit-search-cancel-button]:hidden"
              />
            </div>

            <div className="scrollbar-meridian mt-4 min-h-0 flex-1 overflow-y-auto px-4 pb-5">
              {shown.length > 0 ? (
                <div ref={listRef} id={`${idBase}-list`} role="listbox" aria-label={title} className="flex flex-col gap-0.5">
                  {shown.map((o, i) => {
                    const on = o.id === current;
                    return (
                      <button
                        key={o.id}
                        id={`${idBase}-${i}`}
                        data-index={i}
                        type="button"
                        role="option"
                        aria-selected={on}
                        tabIndex={-1}
                        onClick={() => pick(o.id)}
                        onMouseMove={() => setActive(i)}
                        className={cn(
                          "app-no-drag flex min-w-0 flex-col items-start rounded-xl px-3.5 py-2 text-left transition-colors duration-150",
                          on ? "bg-white/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] ring-1 ring-black/[0.06]" : i === active ? "bg-black/[0.06]" : "hover:bg-black/[0.06]",
                        )}
                      >
                        <span className="w-full truncate text-[13.5px] font-medium text-content-primary">
                          {o.title}
                          {on ? <span className="sr-only">, {t("settings.general.pickerCurrent")}</span> : null}
                        </span>
                        {o.subtitle ? <span className="mt-0.5 w-full truncate text-[12px] font-normal text-content-secondary">{o.subtitle}</span> : null}
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="px-2 py-10 text-center text-[13px] font-normal text-content-tertiary">{t("settings.general.pickerEmpty", { query: query.trim() })}</div>
              )}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
