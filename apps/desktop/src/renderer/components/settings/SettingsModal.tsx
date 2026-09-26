import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  Activity,
  Bell,
  CreditCard,
  Cpu,
  Keyboard,
  Monitor,
  Palette,
  Search,
  Shield,
  SlidersHorizontal,
  Terminal,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import GeneralPane from "./GeneralPane";

/**
 * Settings, opened from the account pill.
 *
 * Only the rail is built. It is the part that decides what settings are —
 * the list of places, in the order a reader meets them — so it is worth
 * settling before any of the panes exist. Every row carries its own name and
 * reports itself through `onSection`, so a pane can be hung on a row later
 * without the rail changing.
 *
 * The right side is deliberately empty until then.
 */

/** Every place the rail leads. A pane is hung on one of these later. */
export type SettingsSection =
  | "general"
  | "account"
  | "privacy"
  | "billing"
  | "usage"
  | "system"
  | "notifications"
  | "developer"
  | "appearance"
  | "engines"
  | "shortcuts";

type Item = { key: SettingsSection; label: string; icon: LucideIcon };

/**
 * The rail's three groups: what the account is, what this machine does with
 * it, and what the reader has made their own.
 */
const GROUPS: ReadonlyArray<{ heading: string; items: readonly Item[] }> = [
  {
    heading: "Settings",
    items: [
      { key: "general", label: "General", icon: SlidersHorizontal },
      { key: "account", label: "Account", icon: User },
      { key: "privacy", label: "Privacy", icon: Shield },
      { key: "billing", label: "Billing", icon: CreditCard },
      { key: "usage", label: "Usage", icon: Activity },
    ],
  },
  {
    heading: "Desktop app",
    items: [
      { key: "system", label: "System", icon: Monitor },
      { key: "notifications", label: "Notifications", icon: Bell },
      { key: "developer", label: "Developer", icon: Terminal },
    ],
  },
  {
    heading: "Customize",
    items: [
      { key: "appearance", label: "Appearance", icon: Palette },
      { key: "engines", label: "Engines", icon: Cpu },
      { key: "shortcuts", label: "Shortcuts", icon: Keyboard },
    ],
  },
];

/**
 * The panel arrives by fading, at the size it will keep. A settings window is
 * furniture, not an event: growing it into place would draw the eye to the
 * frame when what the reader came for is the list inside it.
 */
const PANEL_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: [0.33, 1, 0.68, 1] },
} as const;

/** The rail's group headings, set like every other masthead in the app. */
const GROUP_LABEL =
  "select-none px-3 pb-1.5 pt-4 font-sans text-[10.5px] font-medium tracking-[0.08em] text-[#9CA3AF]";

const ROW =
  "app-no-drag flex w-full items-center gap-2.5 rounded-xl px-3 py-[7px] text-left text-[13px] font-normal transition-colors duration-150";

export default function SettingsModal({
  open,
  onClose,
  section,
  onSection,
}: {
  open: boolean;
  onClose: () => void;
  /** The row that is lit. Left out, the panel keeps its own. */
  section?: SettingsSection;
  onSection?: (section: SettingsSection) => void;
}) {
  const [own, setOwn] = useState<SettingsSection>("general");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const current = section ?? own;

  const choose = (key: SettingsSection) => {
    setOwn(key);
    onSection?.(key);
  };

  // What the search leaves standing. A group whose rows have all gone takes
  // its heading with it, so the rail never shows a title over nothing.
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return GROUPS;
    return GROUPS.map((g) => ({
      ...g,
      items: g.items.filter((i) => i.label.toLowerCase().includes(q)),
    })).filter((g) => g.items.length > 0);
  }, [query]);

  // Esc closes. The page behind never scrolls under the panel, and the
  // search takes the caret on arrival so a reader can type straight away.
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
    const focus = window.setTimeout(() => searchRef.current?.focus(), 180);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
      window.clearTimeout(focus);
    };
  }, [open, onClose]);

  // A fresh open starts from a clean search rather than the last one's.
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div key="settings" className="fixed inset-0 z-[90] flex items-center justify-center">
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
            aria-label="Settings"
            className="app-no-drag relative flex h-[min(680px,82vh)] w-[min(1120px,90vw)] overflow-hidden rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            {...PANEL_FADE}
          >
            {/* The rail. A shade deeper than the panel it sits in, so the
                list reads as a place of its own rather than a column. */}
            <nav
              aria-label="Settings sections"
              className="scrollbar-meridian flex w-[220px] shrink-0 flex-col overflow-y-auto border-r border-black/[0.06] bg-black/[0.022] p-3"
            >
              <div className="relative shrink-0">
                <Search
                  className="pointer-events-none absolute left-3 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-[#9CA3AF]"
                  strokeWidth={1.75}
                  aria-hidden
                />
                <input
                  ref={searchRef}
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search"
                  aria-label="Search settings"
                  className="app-no-drag h-9 w-full rounded-xl border border-white/60 bg-white/55 pl-9 pr-3 text-[13px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] transition-colors placeholder:text-[#9CA3AF] focus:bg-white/75 [&::-webkit-search-cancel-button]:hidden"
                />
              </div>

              {shown.map((group) => (
                <div key={group.heading}>
                  <div className={GROUP_LABEL}>{group.heading}</div>
                  {group.items.map(({ key, label, icon: Icon }) => {
                    const on = key === current;
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-current={on ? "page" : undefined}
                        onClick={() => choose(key)}
                        className={cn(
                          ROW,
                          on
                            ? "bg-white/75 text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] ring-1 ring-black/[0.06]"
                            : "text-[#1d1b1b]/90 hover:bg-[#1d1b1b]/[0.06]",
                        )}
                      >
                        <Icon
                          className={cn("h-[15px] w-[15px] shrink-0", on ? "text-[#1d1b1b]" : "text-[#6b7280]")}
                          strokeWidth={1.75}
                          aria-hidden
                        />
                        <span className="truncate">{label}</span>
                      </button>
                    );
                  })}
                </div>
              ))}

              {shown.length === 0 ? (
                <div className="px-3 pt-4 text-[12.5px] font-normal text-[#9CA3AF]">Nothing by that name.</div>
              ) : null}
            </nav>

            {/* The panes. General is the one that exists; the other rows lead
                to an empty page until each is written. The strip along the
                top still drags the window, since the panel covers the app's
                own. It covers the pane's top padding only, and the close
                button sits above it. */}
            <div className="relative min-w-0 flex-1">
              <div className="app-drag-region absolute inset-x-0 top-0 h-14" aria-hidden />
              <div className="scrollbar-meridian h-full overflow-y-auto px-8 pb-8 pt-14">
                {current === "general" ? <GeneralPane /> : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label="Close settings"
                className="app-no-drag absolute right-4 top-4 rounded-lg p-1.5 text-[#6b7280] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
              >
                <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
