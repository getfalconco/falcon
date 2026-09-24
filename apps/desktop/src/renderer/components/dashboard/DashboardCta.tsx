import type { ReactNode } from "react";
import { dashboardCtasEnabled } from "@/lib/dashboard-config";
import { cn } from "@/lib/utils";

/**
 * A dashboard CTA — the buttons that leave a card for a detail view. Every one
 * of them reads the same switch, so closing or reopening those doors is one
 * line in `dashboard-config`, not an edit per card.
 *
 * Switched off, the button keeps its place in the layout and goes quiet:
 * dimmed, inert, and out of the tab order. `pointer-events-none` is what does
 * the work — it kills the card's own hover styling without each caller having
 * to know which classes to drop.
 *
 * How "off" looks is the caller's call. A solid button reads as disabled at
 * half opacity; a glass one does not — it is already translucent, so the same
 * 50% barely registers and the button still looks live. Those callers pass a
 * recessed treatment instead.
 */
export default function DashboardCta({
  onClick,
  className,
  children,
  ariaLabel,
  title,
  disabled = false,
  disabledClassName = "opacity-50",
}: {
  onClick?: () => void;
  className?: string;
  children: ReactNode;
  ariaLabel?: string;
  title?: string;
  /**
   * Off for a reason of the caller's own (the view it leads to is not built
   * yet), which the dashboard switch cannot turn back on. Looks the same as
   * the switch being off.
   */
  disabled?: boolean;
  /** What the switched-off button looks like. Half opacity by default. */
  disabledClassName?: string;
}) {
  const enabled = dashboardCtasEnabled() && !disabled;
  return (
    <button
      type="button"
      onClick={enabled ? onClick : undefined}
      disabled={!enabled}
      aria-label={ariaLabel}
      title={enabled ? title : undefined}
      className={cn(
        "app-no-drag",
        className,
        !enabled && "pointer-events-none cursor-default",
        !enabled && disabledClassName,
      )}
    >
      {children}
    </button>
  );
}
