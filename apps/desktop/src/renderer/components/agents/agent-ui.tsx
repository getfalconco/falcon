import { useEffect, useState, type ReactNode } from "react";
import { useLanguage } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { AgentStatus } from "../../../shared/agent-types";
import { STATUS_DOT, sayCount, statusLabel } from "./agent-format";
import { useHomeTabActivity, useOnHomeTabShown } from "@/lib/home-tab-activity";

/**
 * The small pieces every agent screen shares, written in the dashboard's own
 * vocabulary (the card glass, the settings panes' buttons and fields), so the
 * dark theme's translation in globals.css covers them without new rules.
 */

/** A glass card, as the dashboard cards are drawn. */
export const SURFACE =
  "rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150";

/** The settings panes' secondary button. */
export const BUTTON =
  "app-no-drag btn-quiet inline-flex items-center gap-1.5 rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[12.5px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:pointer-events-none disabled:opacity-50";

/** The settings panes' text field. */
export const FIELD =
  "app-no-drag w-full rounded-xl border border-white/60 bg-white/55 px-3 text-[13px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] outline-none ring-1 ring-black/[0.04] transition-colors placeholder:text-[#9CA3AF] focus:bg-white/75 disabled:opacity-60";

/** The masthead label every card carries. */
export const LABEL = "select-none font-sans text-[11px] font-medium tracking-[0.04em] text-[#9CA3AF]";

export const SKELETON = "animate-pulse rounded bg-black/[0.06] motion-reduce:animate-none";

export function StatusDot({ status, className }: { status: AgentStatus; className?: string }) {
  const lang = useLanguage();
  return (
    <span
      aria-label={statusLabel(status, lang)}
      role="img"
      className={cn("inline-block h-[7px] w-[7px] shrink-0 rounded-full", STATUS_DOT[status], className)}
    />
  );
}

export function TickerChip({ ticker, className }: { ticker: string; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-md bg-black/[0.05] px-1.5 font-['Geist_Mono'] text-[10.5px] font-medium tracking-[0.02em] text-[#4b5563]",
        className,
      )}
    >
      {ticker}
    </span>
  );
}

/** The unread count: the one solid ink mark on a row. */
export function UnreadBadge({ count, className }: { count: number; className?: string }) {
  const lang = useLanguage();
  if (count <= 0) return null;
  return (
    <span
      aria-label={sayCount(lang, "agents.unreadCount", count)}
      className={cn(
        "inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-[#1d1b1b] px-1.5 text-[10.5px] font-medium tabular-nums text-white",
        className,
      )}
    >
      {count}
    </span>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-[18px] items-center rounded-[5px] border border-black/[0.1] bg-white/60 px-1 font-sans text-[10.5px] font-medium text-[#6b7280]">
      {children}
    </kbd>
  );
}

/**
 * The wall clock, re-read every `periodMs`, for countdowns and "5 min ago";
 * not while the home page keeps the tab behind another (read again on return).
 */
export function useNow(periodMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now());
  const activity = useHomeTabActivity();
  useOnHomeTabShown(() => setNow(Date.now()));
  useEffect(() => {
    const id = setInterval(() => {
      if (activity.isActive()) setNow(Date.now());
    }, periodMs);
    const onVisible = () => {
      if (!document.hidden && activity.isActive()) setNow(Date.now());
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [periodMs, activity]);
  return now;
}

/** Opens a source link outside the app. Only http(s) is ever handed over. */
export function openLink(url: string | undefined): void {
  if (!url || !/^https?:\/\//i.test(url)) return;
  const bridge = window.meridian;
  if (bridge?.openExternal) void bridge.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}
