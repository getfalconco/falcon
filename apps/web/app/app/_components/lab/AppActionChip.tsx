"use client";

import { ArrowUpRight, Filter, LayoutDashboard, Network, PanelTop } from "lucide-react";
import { actionLabel, type AppAction } from "@/lib/desk/app-actions";
import { runAppAction } from "./app-bridge";

/**
 * An app action Falcon AI took, in its reply: "Showed NVDA in the Graph".
 * It ran once when it streamed (lab/sessions.ts); a click runs it again.
 */
export function AppActionChip({ action }: { action: AppAction }) {
  const Icon = action.type === "show_in_graph" ? Network : action.type === "set_graph_filters" ? Filter : action.type === "open_dashboard" ? LayoutDashboard : PanelTop;
  const label = actionLabel(action);
  return (
    <button
      type="button"
      onClick={() => runAppAction(action)}
      title="Show it again"
      aria-label={`${label}. Show it again`}
      className="group inline-flex max-w-full items-center gap-1.5 self-start rounded-full border border-line/10 bg-line/[0.03] py-1 pl-2.5 pr-2 text-fs-12.5 text-fore-3 outline-none transition-colors hover:bg-surface-hover hover:text-fore focus-visible:ring-2 focus-visible:ring-line/20"
    >
      <Icon width={13} height={13} strokeWidth={1.8} aria-hidden className="shrink-0" />
      <span className="truncate">{label}</span>
      <ArrowUpRight width={12} height={12} strokeWidth={1.8} aria-hidden className="shrink-0 opacity-50 transition-opacity group-hover:opacity-100" />
    </button>
  );
}
