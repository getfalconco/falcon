import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Plus, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DROPDOWN_FADE } from "@/lib/dropdown-motion";

export type ModuleChoice = {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Already on the canvas: choosing it again opens a second copy beside the first. */
  onCanvas: boolean;
};

const ITEM_CLASS =
  "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-normal text-[#1d1b1b] transition-colors duration-150 hover:bg-[#1d1b1b]/[0.07]";

/**
 * The way a module gets onto the dashboard: a card that was removed from its
 * menu, or a second copy of one that is there. Before this the only way back
 * for a removed card was the next launch, which re-appends any default card
 * the saved order lacks.
 *
 * Dressed as the dashboard's primary action (the View Calendar button's dark
 * glass) in the account pill's shape, so it reads as the one thing to press in
 * the bar and still belongs with the pill across the search bar from it. The
 * menu is the pill's menu, in the same light glass. Below 980px the label goes
 * and the plus stays: the button stands off the search bar's right end, and
 * narrower than that the labelled button would run into the sign-out and
 * window controls at the bar's right end (the window can shrink to 720px).
 */
export default function AddModuleButton({
  modules,
  onAdd,
  className,
  style,
}: {
  modules: readonly ModuleChoice[];
  onAdd: (id: string) => void;
  className?: string;
  style?: CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div ref={ref} className={cn("relative", className)} style={style}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="Add module"
        onClick={() => setOpen((v) => !v)}
        className="glass-cta app-no-drag flex h-9 items-center gap-1.5 rounded-full pl-3 pr-3.5 text-[13px] font-medium max-[980px]:px-2.5"
      >
        <Plus className="h-3.5 w-3.5 shrink-0" strokeWidth={2.25} aria-hidden />
        <span className="max-[980px]:sr-only">Add Module</span>
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            aria-label="Add module"
            {...DROPDOWN_FADE}
            className="app-no-drag absolute right-0 top-full mt-2 w-56 rounded-2xl border border-white/60 bg-white/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
          >
            <div className="px-3 pb-1.5 pt-2 font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">MODULES</div>
            {modules.map(({ id, label, icon: Icon, onCanvas }) => (
              <button
                key={id}
                role="menuitem"
                type="button"
                onClick={() => {
                  setOpen(false);
                  onAdd(id);
                }}
                className={ITEM_CLASS}
              >
                <Icon className="h-[15px] w-[15px] shrink-0 text-[#4b5563]" strokeWidth={1.75} aria-hidden />
                {label}
                {onCanvas ? <span className="ml-auto shrink-0 text-[11.5px] text-[#9CA3AF]">Add a copy</span> : null}
              </button>
            ))}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
