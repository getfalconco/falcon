"use client";

import { createContext, useContext } from "react";
import type { SightingsFeed } from "@falcon/ripple";
import type { FeedStatus } from "@/lib/workspace/sightings";
import type { FocusItem } from "@/lib/workspace/focus";
import type { TabKind } from "@/lib/workspace/layout";

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
  openTab: (kind: Exclude<TabKind, "ticker" | "sighting">) => void;
  addFocus: (item: FocusItem) => void;
  removeFocus: (ticker: string) => void;
};

export const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function useWorkspace(): WorkspaceApi {
  const api = useContext(WorkspaceContext);
  if (!api) throw new Error("useWorkspace outside the Workspace");
  return api;
}
