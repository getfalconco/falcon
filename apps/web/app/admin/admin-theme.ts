import { cn } from "@/lib/utils";

/** Falcon marketing-site palette for the admin dashboard. */
export const ADMIN_BG = "bg-[#fdfdfd]";
export const ADMIN_TEXT = "text-[#111111]";
export const ADMIN_MUTED = "text-[#6b7280]";

export const ADMIN_SERIF = "var(--font-libre-baskerville), Georgia, serif";
export const ADMIN_SANS = "var(--font-geist-sans), sans-serif";
export const ADMIN_MONO = "var(--font-geist-mono), monospace";

export const ADMIN_CARD =
  "rounded-2xl border border-black/10 bg-white shadow-[0_24px_60px_-20px_rgba(0,0,0,0.08)]";

export const ADMIN_CARD_SOFT =
  "rounded-xl border border-black/[0.06] bg-[#fbfbf9]";

export const ADMIN_INPUT =
  "rounded-lg border border-black/10 bg-[#fbfbf9] px-3 py-2 text-[13px] text-[#1d1b1b] outline-none placeholder:text-[#9a9a9a] focus:border-black/30";

export const ADMIN_TEXTAREA = `${ADMIN_INPUT} min-h-[96px] resize-y`;

export const ADMIN_SELECT = ADMIN_INPUT;

export const ADMIN_BTN_PRIMARY =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg bg-[#1c1917] px-3.5 text-[12.5px] font-medium text-[#e7e7e7] transition hover:bg-black disabled:cursor-not-allowed disabled:opacity-40";

export const ADMIN_BTN_SECONDARY =
  "inline-flex h-9 items-center justify-center gap-2 rounded-lg border border-black/10 bg-white px-3.5 text-[12.5px] font-medium text-[#1d1b1b] transition hover:bg-black/[0.03] disabled:cursor-not-allowed disabled:opacity-40";

export const ADMIN_BTN_GHOST =
  "inline-flex h-8 items-center rounded-lg border border-black/10 px-2.5 text-[12px] text-[#6b7280] transition hover:bg-black/[0.03] hover:text-[#1d1b1b]";

export const ADMIN_MICRO_LABEL =
  "text-[11px] font-medium uppercase tracking-[0.08em] text-[#9a9a9a]";

export const ADMIN_PAGE_EYEBROW = ADMIN_MICRO_LABEL;

export const ADMIN_PAGE_TITLE =
  "text-[28px] leading-[34px] text-[#1d1b1b] sm:text-[32px] sm:leading-[38px]";

export const ADMIN_PAGE_DESC = "mt-1.5 max-w-2xl text-[13px] leading-relaxed text-[#6b7280]";

export const ADMIN_TABLE = "w-full min-w-[720px] text-left text-[12.5px]";

export const ADMIN_TABLE_HEAD =
  "border-b border-black/[0.08] text-[11px] uppercase tracking-[0.04em] text-[#9a9a9a]";

export const ADMIN_TABLE_ROW = "border-b border-black/[0.05] text-[#4b4b48]";

export const ADMIN_TAB_LIST =
  "inline-flex flex-wrap gap-1 rounded-xl border border-black/10 bg-white/70 p-1";

export const ADMIN_TAB_ACTIVE =
  "rounded-lg bg-[#1c1917] px-3.5 py-1.5 text-[12.5px] text-white shadow-sm";

export const ADMIN_TAB_IDLE =
  "rounded-lg px-3.5 py-1.5 text-[12.5px] text-[#6b7280] transition hover:bg-black/[0.04] hover:text-[#1d1b1b]";

export const ADMIN_SHELL = "mx-auto w-full max-w-[1200px] px-4 py-6 sm:px-6 md:px-8";

/** Back-compat aliases used by overview components. */
export const CARD = ADMIN_CARD;
export const MICRO_LABEL = ADMIN_MICRO_LABEL;

export type StatusBadgeVariant = "success" | "warning" | "danger" | "neutral" | "info";

const STATUS_BADGE: Record<StatusBadgeVariant, string> = {
  success: "bg-emerald-50 text-emerald-800 border-emerald-200/80",
  warning: "bg-amber-50 text-amber-800 border-amber-200/80",
  danger: "bg-red-50 text-red-800 border-red-200/80",
  neutral: "bg-[#f3f3f0] text-[#6b7280] border-black/10",
  info: "bg-sky-50 text-sky-800 border-sky-200/80",
};

export function statusBadge(variant: StatusBadgeVariant, className?: string): string {
  return cn(
    "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.04em]",
    STATUS_BADGE[variant],
    className,
  );
}

export function formatNumber(n: number): string {
  return new Intl.NumberFormat("en-US").format(n);
}

/** Compact, static relative time (rendered server-side). */
export function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "—";
  const diff = Date.now() - then;
  const min = Math.round(diff / 60000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 7) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 5) return `${wk}w ago`;
  return new Date(then).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
