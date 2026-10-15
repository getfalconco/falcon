import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * Small pieces the Privacy, Billing and Usage panes share, drawn in the same
 * glass and palette as AccountPane so the dark-mode translation in
 * globals.css covers them.
 */

export const BUTTON =
  "app-no-drag btn-quiet rounded-lg border border-white/60 bg-white/55 px-3 py-1.5 text-[13px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75 disabled:pointer-events-none disabled:opacity-60";

export const DANGER_BUTTON =
  "app-no-drag rounded-lg bg-[#DC2626] px-3 py-1.5 text-[13px] font-medium text-white transition-colors hover:bg-[#B91C1C] disabled:opacity-60";

/** A counted figure at the right of a row. */
export function Value({ children, muted = false }: { children: ReactNode; muted?: boolean }) {
  return (
    <span className={cn("font-['Geist_Mono'] text-[12.5px] tabular-nums", muted ? "text-[#9CA3AF]" : "text-[#4b5563]")}>
      {children}
    </span>
  );
}

/** A row whose content needs the pane's width rather than a control's. */
export function StackedRow({
  label,
  description,
  children,
  last = false,
}: {
  label: string;
  description?: ReactNode;
  children?: ReactNode;
  last?: boolean;
}) {
  return (
    <div className={cn("py-4", last ? "" : "border-b border-black/[0.06]")}>
      <div className="text-[13.5px] font-normal text-[#1d1b1b]">{label}</div>
      {description ? <p className="mt-1 text-[12.5px] font-normal leading-snug text-[#6b7280]">{description}</p> : null}
      {children}
    </div>
  );
}

/** One line of status beside a control: grey while it is fine, red when it is not. */
export function StatusLine({ text, error = false }: { text: string; error?: boolean }) {
  return (
    <span role="status" className={cn("text-[12px] font-normal", error ? "text-[#DC2626]" : "text-[#9CA3AF]")}>
      {text}
    </span>
  );
}

/** "1,234" for a count. */
export function formatCount(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

/** "1.2M" / "34.5K" / "812" for a token total. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  return formatCount(n);
}
