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
  | { id: string; kind: "strategy" };

export type WorkspaceLayout = {
  tabs: Tab[];
  activeId: string;
  sidebarOpen: boolean;
  contextOpen: boolean;
};

export const MAX_TABS = 24;

export function tabId(tab: { kind: TabKind; ticker?: string; cardId?: string }): string {
  if (tab.kind === "ticker") return `ticker:${tab.ticker}`;
  if (tab.kind === "sighting") return `sighting:${tab.cardId}`;
  return tab.kind;
}

export const DASHBOARD_TAB: Tab = { id: "dashboard", kind: "dashboard" };

export const DEFAULT_LAYOUT: WorkspaceLayout = {
  tabs: [DASHBOARD_TAB],
  activeId: DASHBOARD_TAB.id,
  sidebarOpen: true,
  contextOpen: true,
};

const KEY_PREFIX = "falcon.workspace.v1";
let memory: { userId: string; layout: WorkspaceLayout } | null = null;

function parseTab(raw: unknown): Tab | null {
  if (!raw || typeof raw !== "object") return null;
  const t = raw as Record<string, unknown>;
  switch (t.kind) {
    case "dashboard":
    case "graph":
    case "strategy":
      return { id: t.kind, kind: t.kind };
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
      contextOpen: parsed.contextOpen !== false,
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
