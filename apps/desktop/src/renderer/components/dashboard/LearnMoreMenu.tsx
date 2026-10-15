import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, useIsPresent } from "framer-motion";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import { DROPDOWN_FADE } from "@/lib/dropdown-motion";
import { formatKeys } from "@/lib/shortcuts";
import { useBinding } from "@/lib/use-shortcuts";
import { useT, type MessageKey } from "@/lib/i18n";
import { LEGAL_URLS, SITE } from "@/lib/legal-links";

/**
 * "Learn more" in the account menu, and the flyout it opens beside the menu:
 * the website's about and legal pages, then the keyboard shortcuts.
 *
 * It opens on hover, the way the account menus in ChatGPT and Claude do, with
 * a short delay each way: a pointer sweeping past the row does not flash it
 * open, and a pointer cutting diagonally from the row to the flyout — across
 * a corner of the menu or the gap between the two — does not close it. It
 * also opens on click, and from the keyboard with ArrowRight, Enter or Space,
 * which put the caret on its first row; ArrowLeft or Escape come back.
 *
 * The links are fixed addresses on getfalcon.co, opened in the reader's own
 * browser by the main process. Nothing here takes a URL from data. The
 * shortcut hint is the "open-shortcuts" binding from `lib/shortcuts`, so it
 * reads Ctrl+/ (⌘/ on a Mac) until the reader moves it.
 */

/**
 * The flyout's web rows. The usage policy is the "Acceptable use" section of
 * the terms, so that row opens the terms at its anchor (the site also answers
 * /usage-policy with a redirect there). These are the same addresses the
 * Privacy pane and the sign-in screen open: lib/legal-links.
 */
const LINKS: ReadonlyArray<{
  /** The row's words, by i18n key (lib/i18n/messages). */
  labelKey: MessageKey;
  url: string;
  dividerAfter?: boolean;
}> = [
  { labelKey: "menu.learn.about", url: `${SITE}/about`, dividerAfter: true },
  { labelKey: "menu.learn.usagePolicy", url: LEGAL_URLS.usagePolicy },
  { labelKey: "menu.learn.privacyPolicy", url: LEGAL_URLS.privacy },
  { labelKey: "menu.learn.terms", url: LEGAL_URLS.terms, dividerAfter: true },
];

/** Hover intent: how long the pointer rests on the row before it opens… */
const OPEN_DELAY_MS = 90;
/** …and how long it may be away from both row and flyout before it closes. */
const CLOSE_DELAY_MS = 260;

/** The flyout's width, and its gap from the menu's edge. */
const FLYOUT_WIDTH = 224;
const GAP = 4;
/** The account menu's padding (`p-1.5`) and border, which the row sits inside. */
const MENU_PAD = 7;

export default function LearnMoreMenu({
  label,
  icon: Icon,
  rowClassName,
  onDone,
  onShortcuts,
}: {
  label: string;
  icon: LucideIcon;
  /** The account menu's own row class, so this row matches its neighbours. */
  rowClassName: string;
  /** A flyout row was chosen; the whole account menu should close. */
  onDone: () => void;
  /** "Keyboard shortcuts" was chosen. */
  onShortcuts?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const t = useT();
  /** The "open keyboard shortcuts" keys, following a rebinding in Settings. */
  const shortcutKeys = useBinding("open-shortcuts");
  /** False while the account menu itself is fading out; the flyout fades with it. */
  const menuPresent = useIsPresent();
  /** Where the flyout stands, in the coordinates of the element it is portalled into. */
  const [pos, setPos] = useState<{
    host: HTMLElement;
    left: number;
    top: number;
  } | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const rowRef = useRef<HTMLButtonElement>(null);
  const flyoutRef = useRef<HTMLDivElement>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  /** The flyout was opened from the keyboard, so its first row takes the caret. */
  const focusFirst = useRef(false);

  const clearTimers = () => {
    if (openTimer.current != null) window.clearTimeout(openTimer.current);
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    openTimer.current = closeTimer.current = null;
  };
  useEffect(() => clearTimers, []);

  /**
   * Open beside the account menu, on whichever side has room.
   *
   * The flyout is not drawn inside the menu: the menu's backdrop blur makes it
   * a backdrop root, and a blurred panel inside it — standing outside its
   * bounds — would blur nothing and read as a bare tint over the dashboard.
   * It goes into the menu's parent (the pill's own box) instead, so it is
   * still inside the pill for the outside-click check, and is placed there
   * from the menu's measured edges.
   */
  const show = (withFocus = false) => {
    clearTimers();
    const menu = wrapRef.current?.closest<HTMLElement>('[role="menu"]');
    const host = menu?.parentElement;
    const row = wrapRef.current;
    if (!menu || !host || !row) return;
    const m = menu.getBoundingClientRect();
    const h = host.getBoundingClientRect();
    const roomRight = window.innerWidth - m.right;
    const right = roomRight >= FLYOUT_WIDTH + GAP + 8 || roomRight >= m.left;
    setPos({
      host,
      left: right ? m.right - h.left + GAP : m.left - h.left - GAP - FLYOUT_WIDTH,
      top: row.getBoundingClientRect().top - h.top - MENU_PAD,
    });
    focusFirst.current = withFocus;
    setOpen(true);
  };

  const hide = (refocusRow = false) => {
    clearTimers();
    setOpen(false);
    if (refocusRow) rowRef.current?.focus();
  };

  /** Pointer back on the row or the flyout: whatever close was pending is off. */
  const onEnter = () => {
    if (closeTimer.current != null) window.clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  /** Pointer off both: a pending open is dropped, an open flyout closes soon. */
  const onLeave = () => {
    if (openTimer.current != null) window.clearTimeout(openTimer.current);
    openTimer.current = null;
    if (open && closeTimer.current == null) {
      closeTimer.current = window.setTimeout(() => hide(), CLOSE_DELAY_MS);
    }
  };

  // Kept inside the window: a flyout that would run off an edge moves back
  // by the overrun (in a window too narrow for either side, over the menu).
  // Measured before the fade has shown anything.
  useLayoutEffect(() => {
    if (!open || !flyoutRef.current) return;
    const r = flyoutRef.current.getBoundingClientRect();
    const dy = Math.min(0, window.innerHeight - 8 - r.bottom);
    const dx = r.left < 8 ? 8 - r.left : Math.min(0, window.innerWidth - 8 - r.right);
    if (dx || dy) setPos((p) => (p ? { ...p, left: p.left + dx, top: p.top + dy } : p));
  }, [open]);

  useEffect(() => {
    if (!open || !focusFirst.current) return;
    focusFirst.current = false;
    flyoutRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
  }, [open]);

  const onFlyoutKey = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(flyoutRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    const move = (to: number) => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown") move(at + 1);
    else if (e.key === "ArrowUp") move(at < 0 ? items.length - 1 : at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else if (e.key === "ArrowLeft" || e.key === "Escape") {
      // Back to the row, and no further: the account menu stays open.
      e.preventDefault();
      e.stopPropagation();
      hide(true);
    }
  };

  return (
    <div ref={wrapRef} onPointerEnter={onEnter} onPointerLeave={onLeave}>
      <button
        ref={rowRef}
        role="menuitem"
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onPointerEnter={() => {
          if (open || openTimer.current != null) return;
          openTimer.current = window.setTimeout(() => show(), OPEN_DELAY_MS);
        }}
        // A click opens and never toggles: the hover has usually opened it
        // already, and a click that then shut it would read as broken.
        onClick={() => (open ? clearTimers() : show())}
        onKeyDown={(e) => {
          if (e.key === "ArrowRight" || e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            if (open) {
              clearTimers();
              flyoutRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
            } else show(true);
          }
        }}
        // Lit while its flyout is open. Not the row's own ink-tint hover class:
        // the dark theme reads a button carrying `bg-[#1d1b1b]…` as a solid
        // ink button and inverts it; black at 6% translates to a light tint.
        className={cn(rowClassName, open && "bg-black/[0.06]")}
      >
        <Icon className="h-[15px] w-[15px] text-[#4b5563]" strokeWidth={1.75} aria-hidden />
        {label}
        <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-[#9CA3AF]" strokeWidth={1.75} aria-hidden />
      </button>

      {pos
        ? createPortal(
            <AnimatePresence>
              {open && menuPresent ? (
                <motion.div
                  ref={flyoutRef}
                  role="menu"
                  aria-label={label}
                  {...DROPDOWN_FADE}
                  onKeyDown={onFlyoutKey}
                  onPointerEnter={onEnter}
                  onPointerLeave={onLeave}
                  style={{ width: FLYOUT_WIDTH, left: pos.left, top: pos.top }}
                  className="app-no-drag absolute rounded-2xl border border-white/60 bg-white/70 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
                >
                  {LINKS.map(({ labelKey, url, dividerAfter }) => (
                    <div key={labelKey}>
                      <button
                        role="menuitem"
                        type="button"
                        onClick={() => {
                          void window.meridian?.openExternal(url);
                          hide();
                          onDone();
                        }}
                        className={rowClassName}
                      >
                        {t(labelKey)}
                      </button>
                      {dividerAfter ? <div aria-hidden className="mx-2 my-1 h-px bg-black/[0.06]" /> : null}
                    </div>
                  ))}
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      hide();
                      onDone();
                      onShortcuts?.();
                    }}
                    className={rowClassName}
                  >
                    {t("menu.learn.shortcuts")}
                    <span className="ml-auto shrink-0 text-[12px] text-[#9CA3AF]">{formatKeys(shortcutKeys)}</span>
                  </button>
                </motion.div>
              ) : null}
            </AnimatePresence>,
            pos.host,
          )
        : null}
    </div>
  );
}
