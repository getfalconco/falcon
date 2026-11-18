"use client";

import { createContext, useContext } from "react";
import type { SightingsFeed } from "@falcon/ripple";
import type { FeedStatus } from "@/lib/workspace/sightings";
import type { PortfolioItem } from "@/lib/workspace/focus";
import type { HoldingsState } from "@/lib/workspace/holdings";
import type { PortfolioAccount, PortfolioImport } from "@/lib/portfolio-holdings";
import type { TabKind } from "@/lib/workspace/layout";
import type { SavedStrategy } from "@/lib/workspace/strategies";

export type WorkspaceApi = {
  feed: SightingsFeed | null;
  feedStatus: FeedStatus;
  sample: boolean;
  loadedAt: number | null;
  refreshFeed: () => void;
  /** The member's portfolio: tickers from holdings imports and the demo (lib/workspace/focus.ts). */
  portfolio: PortfolioItem[];
  portfolioSet: Set<string>;
  /** False until the portfolio has come from memory, this browser or the account. */
  portfolioLoaded: boolean;
  /** Opens (or focuses) the tab for a ticker. */
  openTicker: (ticker: string) => void;
  /** Opens (or focuses) the tab for a Sightings card. */
  openSighting: (cardId: string) => void;
  /** Dashboard and Graph focus their tab; Strategy starts a new strategy. */
  openTab: (kind: Exclude<TabKind, "ticker" | "sighting">) => void;
  /** Opens the Sightings list view. */
  openSightings: () => void;
  /** Storage key for this viewer's saved strategies. */
  userId: string;
  strategies: SavedStrategy[];
  openStrategy: (strategyId: string) => void;
  /** Closes an open tab (ticker, sighting, strategy) by its id. */
  closeTab: (id: string) => void;
  /** Deletes a saved strategy and closes its tab. */
  deleteStrategy: (strategyId: string) => void;
  /** Replaces the whole portfolio (imports, the demo, Clear demo, Clear portfolio); saved to this browser and the account. */
  setPortfolio: (items: PortfolioItem[]) => void;
  /** The member's Supabase access token for the server routes; null in the preview or when signed out. */
  getToken: () => Promise<string | null>;
  /** Sizes and live prices (lib/workspace/holdings.ts): stored rows for the signed-in main workspace, quotes only elsewhere. In memory only. */
  holdings: HoldingsState;
  /** Saves an import's positions and balances (signed-in main workspace only); `stored` false when sizes cannot be kept. Throws with a message. */
  saveImport: (imp: PortfolioImport) => Promise<{ stored: boolean }>;
  /** Removes every stored account and position ("Clear portfolio"). Never throws. */
  clearHoldings: () => Promise<void>;
  /** Re-reads sizes and prices now. */
  refreshHoldings: () => void;
  /** Creates the paper account with a USD cash balance (stored when it can be, else in memory). Throws with a message. */
  createPaper: (balance: number, name: string | null) => Promise<PortfolioAccount>;
  /** Removes the paper account. Never throws. */
  clearPaper: () => Promise<void>;
  /** Opens Settings, on a section when given ("portfolio": the full positions list). */
  openSettings: (section?: "portfolio") => void;
};

export const WorkspaceContext = createContext<WorkspaceApi | null>(null);

export function useWorkspace(): WorkspaceApi {
  const api = useContext(WorkspaceContext);
  if (!api) throw new Error("useWorkspace outside the Workspace");
  return api;
}
