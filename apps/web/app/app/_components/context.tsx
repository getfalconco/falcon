"use client";

import { createContext, useContext } from "react";
import type { SightingsFeed } from "@falcon/ripple";
import type { FeedStatus } from "@/lib/workspace/sightings";
import type { FocusItem } from "@/lib/workspace/focus";
import type { TabKind } from "@/lib/workspace/layout";
import type { createStrategy, SavedStrategy } from "@/lib/workspace/strategies";

export type WorkspaceApi = {
  feed: SightingsFeed | null;
  feedStatus: FeedStatus;
  sample: boolean;
  loadedAt: number | null;
  refreshFeed: () => void;
  focus: FocusItem[];
  focusSet: Set<string>;
  /** Opens (or focuses) the tab for a ticker. */
  openTicker: (ticker: string) => void;
  /** Opens (or focuses) the tab for a Sightings card. */
  openSighting: (cardId: string) => void;
  /** Dashboard and Graph focus their tab; Strategy starts a new strategy. */
  openTab: (kind: Exclude<TabKind, "ticker" | "sighting">) => void;
  /** Storage key for this viewer's saved strategies. */
  userId: string;
  strategies: SavedStrategy[];
  openStrategy: (strategyId: string) => void;
  newStrategy: (init?: Parameters<typeof createStrategy>[1]) => void;
  /** Deletes a saved strategy and closes its tab. */
  deleteStrategy: (strategyId: string) => void;
  /** Opens a Strategy tab that tests past events like this card's, and runs it. */
  backtestSighting: (cardId: string) => void;
  addFocus: (item: FocusItem) => void;
  removeFocus: (ticker: string) => void;
};

export const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function useWorkspace(): WorkspaceApi {
  const api = useContext(WorkspaceContext);
  if (!api) throw new Error("useWorkspace outside the Workspace");
  return api;
}
