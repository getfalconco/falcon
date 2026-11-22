"use client";

import { FUNNEL_TEST_MODE } from "@/lib/funnel-test-mode";
import { TICKER_PATTERN } from "@/lib/onboarding";

/**
 * Workspace tabs and panel layout. Saved in this browser per user id (moves to
 * the account later); in funnel test mode it lives only as long as the page.
 */

export type TabKind = "dashboard" | "graph" | "ticker" | "sighting" | "strategy";

export type Tab =
  | { id: string; kind: "dashboard" }
  | { id: string; kind: "graph" }
  | { id: string; kind: "ticker"; ticker: string }
  | { id: string; kind: "sighting"; cardId: string; title?: string }
  | { id: string; kind: "strategy"; strategyId: string };

/**
 * Split view: a second pane next to the view in focus. `other` is a tab id,
 * "sightings" or "help" (a split saved with the old "focus" list view is
 * dropped on read); `side` is where that pane sits; `ratio` is
 * the left pane's share of the width.
 */
export type SplitState = { other: string; side: "left" | "right"; ratio: number };

export type WorkspaceLayout = {
  tabs: Tab[];
  activeId: string;
  sidebarOpen: boolean;
  /** Missing in layouts saved before split view; null when there is one pane. */
  split?: SplitState | null;
};

export const SPLIT_SECTIONS = ["sightings", "help", "news"] as const;
export const MIN_SPLIT_RATIO = 0.2;
export const MAX_SPLIT_RATIO = 0.8;

function parseSplit(raw: unknown, tabs: Tab[]): SplitState | null {
  if (!raw || typeof raw !== "object") return null;
  const s = raw as Record<string, unknown>;
  const other = typeof s.other === "string" ? s.other : "";
  const known = (SPLIT_SECTIONS as readonly string[]).includes(other) || other === "dashboard" || other === "graph" || tabs.some((t) => t.id === other);
  if (!known) return null;
  const ratio = typeof s.ratio === "number" && Number.isFinite(s.ratio) ? Math.min(MAX_SPLIT_RATIO, Math.max(MIN_SPLIT_RATIO, s.ratio)) : 0.5;
  return { other, side: s.side === "left" ? "left" : "right", ratio };
}

export const MAX_TABS = 24;

export function tabId(tab: { kind: TabKind; ticker?: string; cardId?: string; strategyId?: string }): string {
  if (tab.kind === "ticker") return `ticker:${tab.ticker}`;
  if (tab.kind === "sighting") return `sighting:${tab.cardId}`;
  if (tab.kind === "strategy") return `strategy:${tab.strategyId}`;
  return tab.kind;
}

export const DASHBOARD_TAB: Tab = { id: "dashboard", kind: "dashboard" };

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  tabs: [DASHBOARD_TAB],
  activeId: DASHBOARD_TAB.id,
  sidebarOpen: true,
  split: null,
};

/** Keyed by storage scope (lib/workspace/workspaces.ts): `<prefix>:<userId>` for main, `<prefix>:<userId>:<workspaceId>` otherwise. */
export const LAYOUT_KEY_PREFIX = "falcon.workspace.v1";
const KEY_PREFIX = LAYOUT_KEY_PREFIX;
let memory: { userId: string; layout: WorkspaceLayout } | null = null;

function parseTab(raw: unknown): Tab | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  switch (t.kind) {
    case "dashboard":
    case "graph":
      return { id: t.kind, kind: t.kind };
    case "strategy":
      // One tab per saved strategy (lib/workspace/strategies.ts).
      return typeof t.strategyId === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(t.strategyId)
        ? { id: tabId({ kind: "strategy", strategyId: t.strategyId }), kind: "strategy", strategyId: t.strategyId }
        : null;
    case "ticker":
      return typeof t.ticker === "string" && TICKER_PATTERN.test(t.ticker)
        ? { id: tabId({ kind: "ticker", ticker: t.ticker }), kind: "ticker", ticker: t.ticker }
        : null;
    case "sighting":
      return typeof t.cardId === "string" && t.cardId.length > 0 && t.cardId.length < 200
        ? {
            id: tabId({ kind: "sighting", cardId: t.cardId }),
            kind: "sighting",
            cardId: t.cardId,
            title: typeof t.title === "string" ? t.title.slice(0, 60) : undefined,
          }
        : null;
    default:
      return null;
  }
}

export function readLayout(userId: string): WorkspaceLayout {
  if (memory?.userId === userId) return memory.layout;
  if (FUNNEL_TEST_MODE || typeof window === "undefined") return DEFAULT_LAYOUT;
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}:${userId}`);
    if (!raw) return DEFAULT_LAYOUT;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const seen = new Set<string>();
    const tabs = (Array.isArray(parsed.tabs) ? parsed.tabs : [])
      .map(parseTab)
      .filter((t): t is Tab => t !== null && !seen.has(t.id) && Boolean(seen.add(t.id)))
      .slice(0, MAX_TABS);
    const activeId = typeof parsed.activeId === "string" && tabs.some((t) => t.id === parsed.activeId) ? parsed.activeId : tabs[0]?.id;
    return {
      tabs,
      activeId: activeId ?? "",
      sidebarOpen: parsed.sidebarOpen !== false,
      split: parseSplit(parsed.split, tabs),
    };
  } catch {
    return DEFAULT_LAYOUT;
  }
}

export function writeLayout(userId: string, layout: WorkspaceLayout): void {
  memory = { userId, layout };
  if (FUNNEL_TEST_MODE || typeof window === "undefined") return;
  try {
    localStorage.setItem(`${KEY_PREFIX}:${userId}`, JSON.stringify(layout));
  } catch {
    // Storage full or blocked: the layout just resets next visit.
  }
}
