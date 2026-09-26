import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Globe,
  Info,
  Layers,
  LifeBuoy,
  LogOut,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { DROPDOWN_FADE } from "@/lib/dropdown-motion";

/**
 * Who is signed in, and on what plan — the glass pill beside the search bar.
 * There are no plans yet, so everyone reads "Pro". The avatar is a small
 * generated graphic rather than a photo: two hues picked from the name, so
 * the same person always gets the same mark and nobody gets a grey circle.
 *
 * The pill opens the account menu: whose account this is, then the places an
 * account leads to. Most of those places are not built yet; their rows are
 * here so the menu has its final shape, and each reports itself through
 * `onSelect` so a screen can be wired to it without touching the menu.
 */

/** The rows between the address and Sign out, in order. */
export type AccountMenuKey = "settings" | "language" | "help" | "plans" | "changelog" | "learn";

const ITEMS: ReadonlyArray<{
  key: AccountMenuKey;
  label: string;
  icon: LucideIcon;
  dividerAfter?: boolean;
  /** The row leads somewhere further, so it ends in an arrow. */
  arrow?: boolean;
}> = [
  { key: "settings", label: "Settings", icon: Settings },
  { key: "language", label: "Language", icon: Globe, dividerAfter: true },
  { key: "help", label: "Get Help", icon: LifeBuoy },
  { key: "plans", label: "View All Plans", icon: Layers },
  { key: "changelog", label: "View Changelog", icon: FileText },
  { key: "learn", label: "Learn more", icon: Info, arrow: true },
];

const ITEM_CLASS =
  "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-normal text-[#1d1b1b] transition-colors duration-150 hover:bg-[#1d1b1b]/[0.07]";
const DIVIDER = <div aria-hidden className="mx-2 my-1 h-px bg-black/[0.06]" />;

function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function Avatar({ name }: { name: string }) {
  const { a, b, angle, bars } = useMemo(() => {
    const h = hashOf(name || "falcon");
    const hue = h % 360;
    return {
      a: `hsl(${hue} 55% 46%)`,
      b: `hsl(${(hue + 48) % 360} 60% 62%)`,
      angle: (h >> 8) % 360,
      // Three little bars, like a chart seen from far away.
      bars: [0, 1, 2].map((i) => 4 + ((h >> (12 + i * 4)) % 7)),
    };
  }, [name]);

  return (
    <span
      aria-hidden
      className="relative flex h-5 w-5 shrink-0 items-end justify-center gap-[2px] overflow-hidden rounded-full pb-[4px]"
      style={{ background: `linear-gradient(${angle}deg, ${a}, ${b})` }}
    >
      {bars.map((height, i) => (
        <span key={i} className="w-[2.5px] rounded-[1px] bg-white/85" style={{ height }} />
      ))}
    </span>
  );
}

export default function ProfilePill({
  name,
  email,
  plan = "Pro",
  onSignOut,
  onSelect,
  className,
  style,
}: {
  name: string;
  /** The address the account is signed in with; heads the menu. */
  email?: string;
  plan?: string;
  onSignOut?: () => void;
  /** A row other than Sign out was chosen. */
  onSelect?: (key: AccountMenuKey) => void;
  className?: string;
  style?: React.CSSProperties;
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
      {/* The search pill's own glass: same height, border, highlight, ring and blur. */}
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="app-no-drag flex h-9 max-w-[200px] items-center gap-2 rounded-full border border-white/60 bg-white/55 pl-2 pr-3 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl transition-colors hover:bg-white/70"
      >
        <Avatar name={name} />
        <span className="min-w-0 truncate text-[13px] font-normal text-[#1d1b1b]">{name}</span>
        <span className="shrink-0 text-[13px] font-normal text-[#9CA3AF]">· {plan}</span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 text-[#6b7280] transition-transform", open && "rotate-180")}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            aria-label="Account"
            {...DROPDOWN_FADE}
            className="app-no-drag absolute left-0 top-full mt-2 w-60 rounded-2xl border border-white/60 bg-white/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
          >
            {email ? (
              <div
                data-selectable
                title={email}
                className="truncate px-3 pb-1.5 pt-2 text-[12.5px] font-normal text-[rgb(161,161,161)]"
              >
                {email}
              </div>
            ) : null}
            {ITEMS.map(({ key, label, icon: Icon, dividerAfter, arrow }) => (
              <div key={key}>
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    onSelect?.(key);
                  }}
                  className={ITEM_CLASS}
                >
                  <Icon className="h-[15px] w-[15px] text-[#4b5563]" strokeWidth={1.75} aria-hidden />
                  {label}
                  {arrow ? (
                    <ChevronRight
                      className="ml-auto h-3.5 w-3.5 shrink-0 text-[#9CA3AF]"
                      strokeWidth={1.75}
                      aria-hidden
                    />
                  ) : null}
                </button>
                {dividerAfter ? DIVIDER : null}
              </div>
            ))}
            {DIVIDER}
            <button
              role="menuitem"
              type="button"
              onClick={() => {
                setOpen(false);
                onSignOut?.();
              }}
              className={ITEM_CLASS}
            >
              <LogOut className="h-[15px] w-[15px] text-[#4b5563]" strokeWidth={1.75} aria-hidden />
              Sign out
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
