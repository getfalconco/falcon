/**
 * Brokers: Falcon paper (`paper_portfolios`) + SnapTrade live (`broker_links`).
 *
 * Same rows desktop writes. SnapTrade secrets never live in this client —
 * connect / disconnect / live refresh go through the research-worker.
 */

import {
  connectBrokerage,
  disconnectBrokerage,
  errorFromUnknown,
  isComputeEnabled,
  listBrokerages,
  refreshBrokerageStatus,
  type BrokerageCatalogItem,
  type BrokerageNetWorth,
  type LiveBrokerageAccount,
} from "@/lib/api";
import type { FalconError } from "@/lib/errors";
import { requireSupabase } from "@/lib/supabase";

export type { BrokerageCatalogItem, BrokerageNetWorth, LiveBrokerageAccount };

export type PaperPosition = {
  symbol: string;
  shares: number;
  costUsd: number;
};

export type PaperAccount = {
  cash: number;
  positions: Record<string, PaperPosition>;
};

export type BrokerageBundle = {
  paper: PaperAccount | null;
  live: BrokerageNetWorth;
};

function parsePositions(value: unknown): Record<string, PaperPosition> {
  if (!value || typeof value !== "object") return {};
  const positions: Record<string, PaperPosition> = {};
  for (const [symbol, raw] of Object.entries(value as Record<string, unknown>)) {
    const entry = raw as Partial<PaperPosition> | null;
    const shares = Number(entry?.shares);
    const costUsd = Number(entry?.costUsd);
    if (!Number.isFinite(shares) || Math.abs(shares) <= 1e-9) continue;
    positions[symbol] = {
      symbol,
      shares,
      costUsd: Number.isFinite(costUsd) ? costUsd : 0,
    };
  }
  return positions;
}

function parseLiveAccounts(value: unknown): LiveBrokerageAccount[] {
  if (!Array.isArray(value)) return [];
  const accounts: LiveBrokerageAccount[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const a = row as Record<string, unknown>;
    const totalValue = Number(a.totalValue);
    accounts.push({
      id: String(a.id ?? ""),
      name: String(a.name ?? "Account"),
      institution: String(a.institution ?? ""),
      totalValue: Number.isFinite(totalValue) ? totalValue : null,
      authorizationId: typeof a.authorizationId === "string" ? a.authorizationId : null,
    });
  }
  return accounts;
}

export async function fetchPaperAccount(): Promise<PaperAccount | null> {
  const client = requireSupabase();
  const { data: auth } = await client.auth.getSession();
  if (!auth.session) return null;

  const { data, error } = await client
    .from("paper_portfolios")
    .select("cash,positions")
    .eq("user_id", auth.session.user.id)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;

  const cash = Number(data.cash);
  return {
    cash: Number.isFinite(cash) ? cash : 0,
    positions: parsePositions(data.positions),
  };
}

/** Creates (or resets) the Falcon paper account — same meaning as desktop. */
export async function createPaperAccount(startingCash: number): Promise<PaperAccount> {
  const client = requireSupabase();
  const { data: auth } = await client.auth.getUser();
  if (!auth.user) throw new Error("Sign in to continue.");

  const account: PaperAccount = { cash: Math.max(0, startingCash), positions: {} };
  const { error } = await client.from("paper_portfolios").upsert(
    {
      user_id: auth.user.id,
      cash: account.cash,
      positions: account.positions,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) throw new Error(error.message);
  await client.from("portfolio_snapshots").delete().eq("user_id", auth.user.id);
  return account;
}

export async function fetchLiveBrokerSnapshot(): Promise<BrokerageNetWorth> {
  const client = requireSupabase();
  const { data: auth } = await client.auth.getSession();
  if (!auth.session) return { connected: false, total: 0, accounts: [] };

  const { data, error } = await client
    .from("broker_links")
    .select("connected,total,accounts")
    .eq("user_id", auth.session.user.id)
    .maybeSingle();
  if (error || !data) return { connected: false, total: 0, accounts: [] };

  const total = Number(data.total);
  const accounts = parseLiveAccounts(data.accounts);
  return {
    connected: Boolean(data.connected) || accounts.length > 0,
    total: Number.isFinite(total) ? total : 0,
    accounts,
  };
}

export async function loadBrokers(): Promise<BrokerageBundle> {
  const [paper, live] = await Promise.all([fetchPaperAccount(), fetchLiveBrokerSnapshot()]);
  return { paper, live };
}

export async function loadBrokerCatalog(): Promise<{
  configured: boolean | null;
  brokerages: BrokerageCatalogItem[];
  error?: FalconError;
}> {
  try {
    return await listBrokerages();
  } catch (err) {
    return {
      configured: null,
      brokerages: [],
      error: errorFromUnknown(err),
    };
  }
}

/**
 * Empty live-catalog caption after a successful worker response.
 * Fetch failures (FAL-NET-01 / FAL-JOB-03) must not use this — Connect
 * keeps the live-connect row with a quiet engine hint instead.
 */
export function liveCatalogEmptyCopy(configured: boolean): string {
  return configured
    ? "No brokerages to show."
    : "Live brokers aren't configured on the engine yet.";
}

/**
 * Quiet subtitle on the live-connect fallback row when the catalog
 * couldn't be loaded. Not a page-level banner — Paper still works.
 */
export function liveEngineHint(error: FalconError): string {
  if (error.code === "FAL-NET-01" || error.code === "FAL-JOB-03") {
    return "Engine unreachable — try again";
  }
  return "Connect in the browser";
}

export async function startLiveConnect(broker?: string, redirectUrl?: string): Promise<string> {
  const { url } = await connectBrokerage({ broker, redirectUrl });
  return url;
}

export async function syncLiveBrokerages(): Promise<BrokerageNetWorth> {
  if (!isComputeEnabled()) return fetchLiveBrokerSnapshot();
  try {
    return await refreshBrokerageStatus();
  } catch {
    return fetchLiveBrokerSnapshot();
  }
}

export async function removeLiveBrokerage(authorizationId: string): Promise<BrokerageNetWorth> {
  return disconnectBrokerage(authorizationId);
}

export { isComputeEnabled };
