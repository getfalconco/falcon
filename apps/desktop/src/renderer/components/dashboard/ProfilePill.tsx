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
import { useProfilePhoto } from "@/lib/profile-photo";
import { useT, type MessageKey } from "@/lib/i18n";
import { useChangelogUnseen } from "@/lib/changelog";
import { currentPlanLabel } from "@/components/plans/plan-names";
import { currentPlanFromAppMetadata } from "../../../shared/plans";
import LearnMoreMenu from "./LearnMoreMenu";

/**
 * Who is signed in, and on what plan — the glass pill beside the search bar.
 * The plan is the account's own (shared/plans currentPlanFromAppMetadata):
 * Early Access for members, the role's name for staff. The avatar is the photo
 * the reader set in Settings → Account when there is one; otherwise a small
 * generated graphic: two hues picked from the name, so the same person always
 * gets the same mark and nobody gets a grey circle.
 *
 * The pill opens the account menu: whose account this is, then the places an
 * account leads to. Most of those places are not built yet; their rows are
 * here so the menu has its final shape, and each reports itself through
 * `onSelect` so a screen can be wired to it without touching the menu.
 */

/**
 * The rows between the address and Sign out, in order — and "shortcuts",
 * which sits in the "Learn more" flyout rather than the menu itself.
 */
export type AccountMenuKey = "settings" | "language" | "help" | "plans" | "changelog" | "learn" | "shortcuts";

const ITEMS: ReadonlyArray<{
  key: AccountMenuKey;
  /** The row's words, by i18n key (lib/i18n/messages). */
  labelKey: MessageKey;
  icon: LucideIcon;
  dividerAfter?: boolean;
  /** The row leads somewhere further, so it ends in an arrow. */
  arrow?: boolean;
}> = [
  { key: "settings", labelKey: "menu.settings", icon: Settings },
  { key: "language", labelKey: "menu.language", icon: Globe, dividerAfter: true },
  { key: "help", labelKey: "menu.help", icon: LifeBuoy },
  { key: "plans", labelKey: "menu.plans", icon: Layers },
  { key: "changelog", labelKey: "menu.changelog", icon: FileText },
  { key: "learn", labelKey: "menu.learn", icon: Info, arrow: true },
];

const ITEM_CLASS =
  "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-normal text-content-primary transition-colors duration-150 hover:bg-ink/[0.07]";
const DIVIDER = <div aria-hidden className="mx-2 my-1 h-px bg-black/[0.06]" />;

function hashOf(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * The generated mark: two hues and three bars from the name. Drawn at the
 * pill's 20px by default; the account pane shows the same mark larger, with
 * the bars scaled to it, so the two never disagree about who this is.
 */
export function Avatar({
  name,
  size = 20,
  photo,
}: {
  name: string;
  size?: number;
  /** The reader's own photo, as a data URL; drawn in place of the mark when set. */
  photo?: string | null;
}) {
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
  const k = size / 20;

  if (photo) {
    return (
      <img
        aria-hidden
        alt=""
        src={photo}
        draggable={false}
        className="shrink-0 rounded-full object-cover ring-1 ring-black/[0.06]"
        style={{ width: size, height: size }}
      />
    );
  }

  return (
    <span
      aria-hidden
      className="relative flex shrink-0 items-end justify-center overflow-hidden rounded-full"
      style={{
        width: size,
        height: size,
        gap: 2 * k,
        paddingBottom: 4 * k,
        background: `linear-gradient(${angle}deg, ${a}, ${b})`,
      }}
    >
      {bars.map((height, i) => (
        <span key={i} className="rounded-sm bg-white/85" style={{ width: 2.5 * k, height: height * k }} />
      ))}
    </span>
  );
}

export default function ProfilePill({
  name,
  userId,
  email,
  appMetadata,
  plan,
  onSignOut,
  onSelect,
  className,
  style,
}: {
  name: string;
  /** The signed-in account's id, whose profile photo the pill shows. */
  userId?: string | null;
  /** The address the account is signed in with; heads the menu. */
  email?: string;
  /** The account's `app_metadata`, which says what plan it is on. */
  appMetadata?: Record<string, unknown> | null;
  /** Overrides the plan read from `appMetadata` (preview harness). */
  plan?: string;
  onSignOut?: () => void;
  /** A row other than Sign out was chosen. */
  onSelect?: (key: AccountMenuKey) => void;
  className?: string;
  style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const photo = useProfilePhoto(userId);
  const t = useT();
  const planText = plan ?? currentPlanLabel(currentPlanFromAppMetadata(appMetadata), t);
  /** A release the reader has not opened What's new for yet: a dot on its row. */
  const changelogUnseen = useChangelogUnseen();
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
        className="app-no-drag flex h-9 max-w-[240px] items-center gap-2 rounded-full border border-white/60 bg-white/55 pl-2 pr-3 text-left shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl transition-colors hover:bg-white/70"
      >
        <Avatar name={name} photo={photo} />
        <span className="min-w-0 truncate text-[13px] font-normal text-content-primary">{name}</span>
        <span title={planText} className="max-w-[96px] shrink-0 truncate text-[13px] font-normal text-content-tertiary">
          · {planText}
        </span>
        <ChevronDown
          className={cn("h-3.5 w-3.5 shrink-0 text-content-secondary transition-transform", open && "rotate-180")}
          strokeWidth={1.75}
          aria-hidden
        />
      </button>

      <AnimatePresence>
        {open ? (
          <motion.div
            role="menu"
            aria-label={t("menu.label")}
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
            {ITEMS.map(({ key, labelKey, icon: Icon, dividerAfter, arrow }) => (
              <div key={key}>
                {/* "Learn more" opens its own flyout on hover; see LearnMoreMenu. */}
                {key === "learn" ? (
                  <LearnMoreMenu
                    label={t(labelKey)}
                    icon={Icon}
                    rowClassName={ITEM_CLASS}
                    onDone={() => setOpen(false)}
                    onShortcuts={() => onSelect?.("shortcuts")}
                  />
                ) : (
                  <button
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onSelect?.(key);
                    }}
                    className={ITEM_CLASS}
                  >
                    <Icon className="h-[15px] w-[15px] text-content-body" strokeWidth={1.75} aria-hidden />
                    {t(labelKey)}
                    {key === "changelog" && changelogUnseen ? (
                      <span
                        aria-label={t("menu.new")}
                        className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-tint"
                      />
                    ) : null}
                    {arrow ? (
                      <ChevronRight
                        className="ml-auto h-3.5 w-3.5 shrink-0 text-content-tertiary"
                        strokeWidth={1.75}
                        aria-hidden
                      />
                    ) : null}
                  </button>
                )}
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
              <LogOut className="h-[15px] w-[15px] text-content-body" strokeWidth={1.75} aria-hidden />
              {t("menu.signOut")}
            </button>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
