import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Copy, MoreVertical, X } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The balance card's masthead: the same small label and three-dot menu every
 * other card carries, in the same place, with the same two verbs — so the
 * card reads as one of the set rather than a different kind of surface.
 */
export default function ChartCardHeader({
  onDuplicate,
  onRemove,
  className,
}: {
  onDuplicate?: () => void;
  onRemove?: () => void;
  className?: string;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  return (
    <div className={cn("flex shrink-0 items-center justify-between", className)}>
      <span className="select-none font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">
        PORTFOLIO VALUE
      </span>
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
              initial={{ opacity: 0, scale: 0.92, y: -6 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, y: -4 }}
              transition={{ type: "spring", stiffness: 480, damping: 34 }}
              style={{ transformOrigin: "top right" }}
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
  );
}
