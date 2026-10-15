import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import {
  CreditCard,
  Cpu,
  Keyboard,
  Monitor,
  Search,
  Shield,
  SlidersHorizontal,
  Terminal,
  User,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { foldForSearch } from "@/lib/i18n/languages";
import { useT, type MessageKey } from "@/lib/i18n";
import type { User as AuthUser } from "@supabase/supabase-js";
import AccountPane, { type AccountActions } from "./AccountPane";
import GeneralPane, { type GeneralAnchor } from "./GeneralPane";
import PrivacyPane, { type PrivacyTab } from "./PrivacyPane";
import BillingPane from "./BillingPane";
import UsagePane from "./UsagePane";
import SystemPane from "./SystemPane";
import DeveloperPane from "./DeveloperPane";
import EnginesPane from "./EnginesPane";
import ShortcutsPane from "./ShortcutsPane";

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

/**
 * Every place Settings can open on. Most are rows in the rail; "appearance"
 * and "notifications" are sections of the General pane now (see FOLDED), kept
 * here so a link to either still lands on them.
 */
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
 * Places that no longer have a row: each is a section of another pane, which
 * opens scrolled to it. The search still finds them by these names (English
 * and the reader's language), and lights the row of the pane that holds them.
 */
const FOLDED: ReadonlyArray<{
  key: SettingsSection & GeneralAnchor;
  into: SettingsSection;
  names: ReadonlyArray<readonly [english: string, key: MessageKey]>;
}> = [
  {
    key: "appearance",
    into: "general",
    names: [
      ["Appearance", "settings.section.appearance"],
      ["Theme", "settings.appearance.theme"],
      ["Interface size", "settings.appearance.size"],
      ["Motion", "settings.appearance.motion"],
    ],
  },
  { key: "notifications", into: "general", names: [["Notifications", "settings.section.notifications"]] },
];

/** The rail row a place is shown under. */
const rowOf = (section: SettingsSection): SettingsSection =>
  FOLDED.find((f) => f.key === section)?.into ?? section;

/**
 * The rail's three groups: what the account is, what this machine does with
 * it, and what the reader has made their own. `heading` and `label` are the
 * English names; the rail shows the translation (`headingKey`, and
 * `settings.section.<key>` for a row) and searches both.
 */
const GROUPS: ReadonlyArray<{ heading: string; headingKey: MessageKey; items: readonly Item[] }> = [
  {
    heading: "Settings",
    headingKey: "settings.group.settings",
    items: [
      { key: "general", label: "General", icon: SlidersHorizontal },
      { key: "account", label: "Account", icon: User },
      { key: "privacy", label: "Privacy", icon: Shield },
      { key: "billing", label: "Billing", icon: CreditCard },
      // Usage is hidden from the rail for now; its pane is kept for when it returns.
    ],
  },
  {
    heading: "Desktop app",
    headingKey: "settings.group.desktop",
    items: [
      { key: "system", label: "System", icon: Monitor },
      { key: "developer", label: "Developer", icon: Terminal },
    ],
  },
  {
    heading: "Customize",
    headingKey: "settings.group.customize",
    items: [
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
  user = null,
  accountActions,
  onOpenTab,
}: {
  open: boolean;
  onClose: () => void;
  /** The signed-in user, for the Account pane. */
  user?: AuthUser | null;
  /** Stand-ins for the Account pane's writes, for a harness with no session. */
  accountActions?: AccountActions;
  /** The row that is lit. Left out, the panel keeps its own. */
  section?: SettingsSection;
  onSection?: (section: SettingsSection) => void;
  /**
   * Brings a home tab to the front (Privacy's Agents and Calendar rows). The
   * host closes the panel as it does so. Left out, those rows are too.
   */
  onOpenTab?: (tab: PrivacyTab) => void;
}) {
  const [own, setOwn] = useState<SettingsSection>("general");
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const current = section ?? own;
  const t = useT();

  const choose = (key: SettingsSection) => {
    setOwn(key);
    onSection?.(key);
  };

  // What the search leaves standing. A group whose rows have all gone takes
  // its heading with it, so the rail never shows a title over nothing.
  // A row also stands when the query names a section folded into its pane;
  // then picking it opens the pane on that section (`target`).
  const shown = useMemo(() => {
    const q = foldForSearch(query);
    if (!q) return GROUPS.map((g) => ({ ...g, items: g.items.map((i) => ({ ...i, target: i.key })) }));
    const hit = (english: string, key: MessageKey) =>
      foldForSearch(english).includes(q) || foldForSearch(t(key)).includes(q);
    return GROUPS.map((g) => ({
      ...g,
      items: g.items.flatMap((i) => {
        if (hit(i.label, `settings.section.${i.key}`)) return [{ ...i, target: i.key }];
        const folded = FOLDED.find((f) => f.into === i.key && f.names.some(([en, key]) => hit(en, key)));
        return folded ? [{ ...i, target: folded.key }] : [];
      }),
    })).filter((g) => g.items.length > 0);
  }, [query, t]);

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
            aria-label={t("settings.label")}
            className="app-no-drag relative flex h-[min(680px,82vh)] w-[min(1120px,90vw)] overflow-hidden rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
            {...PANEL_FADE}
          >
            {/* The rail. A shade deeper than the panel it sits in, so the
                list reads as a place of its own rather than a column. */}
            <nav
              aria-label={t("settings.sectionsLabel")}
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
                  placeholder={t("settings.search")}
                  aria-label={t("settings.searchLabel")}
                  className="app-no-drag h-9 w-full rounded-xl border border-white/60 bg-white/55 pl-9 pr-3 text-[13px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] transition-colors placeholder:text-[#9CA3AF] focus:bg-white/75 [&::-webkit-search-cancel-button]:hidden"
                />
              </div>

              {shown.map((group) => (
                <div key={group.heading}>
                  <div className={GROUP_LABEL}>{t(group.headingKey)}</div>
                  {group.items.map(({ key, target, icon: Icon }) => {
                    const on = key === rowOf(current);
                    return (
                      <button
                        key={key}
                        type="button"
                        aria-current={on ? "page" : undefined}
                        onClick={() => choose(target)}
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
                        <span className="truncate">{t(`settings.section.${key}`)}</span>
                      </button>
                    );
                  })}
                </div>
              ))}

              {shown.length === 0 ? (
                <div className="px-3 pt-4 text-[12.5px] font-normal text-[#9CA3AF]">{t("settings.searchEmpty")}</div>
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
                {rowOf(current) === "general" ? (
                  <GeneralPane
                    anchor={FOLDED.find((f) => f.key === current && f.into === "general")?.key}
                  />
                ) : null}
                {current === "account" ? <AccountPane user={user} actions={accountActions} /> : null}
                {current === "privacy" ? (
                  <PrivacyPane user={user} onAccount={() => choose("account")} onOpenTab={onOpenTab} />
                ) : null}
                {current === "billing" ? <BillingPane user={user} /> : null}
                {current === "usage" ? <UsagePane user={user} /> : null}
                {current === "system" ? <SystemPane /> : null}
                {current === "developer" ? <DeveloperPane /> : null}
                {current === "engines" ? <EnginesPane /> : null}
                {current === "shortcuts" ? <ShortcutsPane /> : null}
              </div>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("settings.close")}
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
