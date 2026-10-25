import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { THESIS_MAX_CHARS, thesisText } from "../../../../shared/stock-thesis";
import { useThesis } from "../thesis-store";
import type { StockSectionProps } from "./types";

/**
 * Stock tab, 2: the reader's thesis, in their own words. Saved as they type
 * (a pause of a little under a second, or leaving the field), per account and
 * per ticker by the main process (thesis-store.ts); "Saved" says so quietly
 * and fades. Other sections read the same thesis and see the save at once.
 */

const SAVE_AFTER_MS = 800;
const SAVED_SHOWN_MS = 2200;

type Status = "idle" | "saving" | "saved" | "failed";

export default function ThesisSection({ ticker }: StockSectionProps) {
  const t = useT();
  const id = useId();
  const thesis = useThesis(ticker);
  const [draft, setDraft] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  /** The draft differs from what main holds; the stored text must not overwrite it. */
  const dirty = useRef(false);
  const timer = useRef<number | null>(null);
  const savedTimer = useRef<number | null>(null);
  const latest = useRef({ draft, save: thesis.save, text: thesis.text });
  latest.current = { draft, save: thesis.save, text: thesis.text };

  // The stored text, once read and whenever another surface saves it, unless
  // the reader is mid-edit. A draft that only differs by the spacing main
  // trims (a trailing space mid-sentence) stays as typed.
  useEffect(() => {
    if (thesis.loading || dirty.current) return;
    const stored = thesis.text ?? "";
    setDraft((d) => ((thesisText(d) ?? "") === stored ? d : stored));
  }, [thesis.text, thesis.loading]);

  const flush = useCallback(async () => {
    if (timer.current != null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    const { draft: text, save } = latest.current;
    setStatus("saving");
    try {
      await save(text);
      // Typing that landed during the save keeps the field dirty for the next one.
      if (latest.current.draft === text) dirty.current = false;
      setStatus("saved");
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
      savedTimer.current = window.setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), SAVED_SHOWN_MS);
    } catch {
      setStatus("failed");
    }
  }, []);

  // Whatever is still unsaved goes when the section does (a stock switch, the app closing the tab).
  useEffect(
    () => () => {
      if (savedTimer.current != null) window.clearTimeout(savedTimer.current);
      if (timer.current != null) window.clearTimeout(timer.current);
      if (dirty.current) void latest.current.save(latest.current.draft).catch(() => undefined);
    },
    [],
  );

  const onChange = (value: string) => {
    setDraft(value);
    dirty.current = (thesisText(value) ?? value) !== (latest.current.text ?? "");
    if (status === "failed") setStatus("idle");
    if (timer.current != null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void flush(), SAVE_AFTER_MS);
  };

  const label = t("stocktab.thesis.label", { ticker });
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <textarea
        id={id}
        value={draft}
        disabled={thesis.loading}
        maxLength={THESIS_MAX_CHARS}
        rows={3}
        spellCheck
        placeholder={thesis.loading ? "" : t("stocktab.thesis.placeholder")}
        onChange={(e) => onChange(e.target.value)}
        onBlur={() => void flush()}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "s") {
            e.preventDefault();
            void flush();
          }
        }}
        className={cn(
          "block min-h-[88px] w-full resize-y rounded-2xl border border-white/60 bg-white/40 px-4 py-3 text-[14px] leading-relaxed text-content-primary shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] backdrop-blur-xl transition-colors duration-150 placeholder:text-content-tertiary focus:bg-white/60 focus-visible:ring-2 focus-visible:ring-edge-focus disabled:opacity-60 motion-reduce:transition-none",
        )}
      />
      <div className="mt-1.5 flex h-4 items-center justify-end gap-2 text-[11.5px]" aria-live="polite">
        {status === "saving" ? <span className="text-content-tertiary">{t("stocktab.thesis.saving")}</span> : null}
        {status === "saved" ? <span className="text-content-tertiary">{t("stocktab.thesis.saved")}</span> : null}
        {status === "failed" ? (
          <>
            <span className="text-tone-negative">{t("stocktab.thesis.failed")}</span>
            <button
              type="button"
              onClick={() => {
                dirty.current = true;
                void flush();
              }}
              className="text-content-secondary underline-offset-2 outline-none hover:underline focus-visible:underline"
            >
              {t("stocktab.thesis.retry")}
            </button>
          </>
        ) : null}
      </div>
    </div>
  );
}
