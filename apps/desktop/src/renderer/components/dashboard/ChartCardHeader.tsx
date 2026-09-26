import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, Copy, MoreVertical, SlidersHorizontal, X } from "lucide-react";
import { TIMEFRAMES, type Timeframe } from "@/components/dashboard/TimeframeControls";
import { cn } from "@/lib/utils";
import { DROPDOWN_FADE } from "@/lib/dropdown-motion";

/**
 * A card's masthead: the same small label and three-dot menu every other card
 * carries, in the same place, with the same two verbs — so the card reads as
 * one of the set rather than a different kind of surface. Written for the
 * balance card, whose label is still the default; a second card passes its own.
 * A card with a control of its own beside the dots (the Risk Score card's
 * settings glyph) hands it in as `actions`, so the dots stay where they are
 * on every card.
 */
export default function ChartCardHeader({
  label = "PORTFOLIO VALUE",
  meta,
  actions,
  timeframe,
  onTimeframe,
  onDuplicate,
  onRemove,
  className,
}: {
  label?: string;
  /** Sits beside the label, on its baseline: a date, a count. The caller styles it. */
  meta?: ReactNode;
  /** The card's own controls, drawn left of the settings glyph and the dots, in the same row and gap. */
  actions?: ReactNode;
  /** With both given, the settings glyph appears and its panel picks the chart's window. */
  timeframe?: Timeframe;
  onTimeframe?: (tf: Timeframe) => void;
  onDuplicate?: () => void;
  onRemove?: () => void;
  className?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const settingsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen && !settingsOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
      if (!settingsRef.current?.contains(e.target as Node)) setSettingsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      setSettingsOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, settingsOpen]);

  const labelEl = (
    <span className="select-none font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">
      {label}
    </span>
  );

  return (
    <div className={cn("flex shrink-0 items-center justify-between", className)}>
      {/* The wrapper exists only when there is something to put beside the
          label, so a card that passes no meta keeps the exact markup it had. */}
      {meta == null ? labelEl : <div className="flex min-w-0 items-baseline gap-3">{labelEl}{meta}</div>}
      <div className="flex items-center gap-3">
      {actions}
      {/* Settings — the same switch glyph and glass panel the Positions card
          has. Here it holds the one choice the card offers: the window the
          chart draws. */}
      {timeframe && onTimeframe ? (
        <div ref={settingsRef} data-no-lift className="relative flex">
          <button
            type="button"
            aria-label="Chart settings"
            aria-haspopup="dialog"
            aria-expanded={settingsOpen}
            onClick={() => setSettingsOpen((v) => !v)}
            className={cn(
              "app-no-drag transition-colors hover:text-[#1d1b1b]",
              settingsOpen ? "text-[#1d1b1b]" : "text-[#4b5563]",
            )}
          >
            <SlidersHorizontal className="h-4 w-4" strokeWidth={1.75} aria-hidden />
          </button>
          <AnimatePresence>
            {settingsOpen ? (
              <motion.div
                role="dialog"
                aria-label="Chart settings"
                {...DROPDOWN_FADE}
                className="app-no-drag absolute right-0 top-full z-50 mt-2 w-48 rounded-2xl border border-white/60 bg-white/70 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
              >
                <div className="px-1 pb-1.5">
                  <span className="select-none font-sans text-[11px] font-normal tracking-[0.08em] text-[#9CA3AF]">
                    TIMEFRAME
                  </span>
                </div>
                <div role="radiogroup" aria-label="Timeframe">
                  {TIMEFRAMES.map((tf) => {
                    const active = tf === timeframe;
                    return (
                      <button
                        key={tf}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => {
                          onTimeframe(tf);
                          setSettingsOpen(false);
                        }}
                        className="flex w-full items-center justify-between rounded-lg px-2 py-1.5 text-left text-[12.5px] font-normal text-[#1d1b1b] transition-colors hover:bg-[#1d1b1b]/[0.06]"
                      >
                        {tf}
                        <span
                          aria-hidden
                          className={cn(
                            // The same box the Positions column list ticks: a rounded square,
                            // not a radio dot, so the two panels read as one kind of control.
                            "flex h-[15px] w-[15px] shrink-0 items-center justify-center rounded-[4px] border transition-colors",
                            active ? "border-[#1d1b1b] bg-[#1d1b1b] text-white" : "border-black/20 bg-white/60",
                          )}
                        >
                          {active ? <Check className="h-[10px] w-[10px]" strokeWidth={3} /> : null}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      ) : null}
      {/* Same pulled-in dots as the Positions card: the glyph is a 3px mark
          centred in a 16px box, so without the -mr the empty half of the box
          reads as extra padding against the card's edge. */}
      <div ref={menuRef} data-no-lift className="relative flex -mr-[10px]">
        <button
          type="button"
          aria-label="Card menu"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
          className={cn(
            "app-no-drag transition-colors hover:text-[#1d1b1b]",
            menuOpen ? "text-[#1d1b1b]" : "text-[#4b5563]",
          )}
        >
          <MoreVertical className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </button>
        <AnimatePresence>
          {menuOpen ? (
            <motion.div
              role="menu"
              aria-label="Card actions"
              {...DROPDOWN_FADE}
              className="app-no-drag absolute right-0 top-full z-50 mt-2 w-48 rounded-2xl border border-white/60 bg-white/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            >
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onDuplicate?.();
                }}
                className="group/mi flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-normal text-[#1d1b1b] transition-all duration-150 hover:translate-x-0.5 hover:bg-[#1d1b1b]/[0.07] active:scale-[0.97]"
              >
                <Copy
                  className="h-[15px] w-[15px] text-[#4b5563] transition-colors duration-150 group-hover/mi:text-[#1d1b1b]"
                  strokeWidth={1.75}
                  aria-hidden
                />
                Duplicate
              </button>
              <div aria-hidden className="mx-2 my-1 h-px bg-black/[0.06]" />
              <button
                role="menuitem"
                type="button"
                onClick={() => {
                  setMenuOpen(false);
                  onRemove?.();
                }}
                className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-normal text-[#DC2626] transition-all duration-150 hover:translate-x-0.5 hover:bg-[#DC2626]/[0.10] active:scale-[0.97]"
              >
                <X className="h-[15px] w-[15px]" strokeWidth={2} aria-hidden />
                Delete module
              </button>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
      </div>
    </div>
  );
}
