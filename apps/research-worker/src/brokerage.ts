/**
 * SnapTrade brokerage connect / status for mobile.
 *
 * Secrets (SNAPTRADE_CLIENT_ID, SNAPTRADE_CONSUMER_KEY, userSecret) stay in
 * this process. The renderer-readable snapshot is public.broker_links;
 * userSecret lives in public.snaptrade_secrets (service_role only).
 */

import {
  Snaptrade,
  SnaptradeAuth,
  type CommercialApiKeyAuth,
} from "snaptrade-typescript-sdk";

type SnaptradeClient = Snaptrade<CommercialApiKeyAuth>;

export type SnaptradeBrokerage = {
  id: string;
  name: string;
  slug: string;
  logoUrl: string | null;
  url: string | null;
};

export type BrokerageAccount = {
  id: string;
  name: string;
  institution: string;
  totalValue: number | null;
  authorizationId?: string | null;
};

export type BrokerageNetWorth = {
  connected: boolean;
  total: number;
  accounts: BrokerageAccount[];
};

type StoredUser = { userId: string; userSecret: string };

function snaptradeConfig(): { clientId: string; consumerKey: string } | null {
  const clientId = process.env.SNAPTRADE_CLIENT_ID?.trim();
  const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY?.trim();
  if (!clientId || !consumerKey) return null;
  return { clientId, consumerKey };
}

export function isSnaptradeConfigured(): boolean {
  return snaptradeConfig() !== null;
}

let cached: SnaptradeClient | null = null;

function getClient(): SnaptradeClient | null {
  if (cached) return cached;
  const cfg = snaptradeConfig();
  if (!cfg) return null;
  cached = new Snaptrade({
    auth: SnaptradeAuth.commercialApiKey({
      clientId: cfg.clientId,
      consumerKey: cfg.consumerKey,
    }),
  });
  return cached;
}

function supabaseConfig(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

function headers(serviceKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

async function loadCloudUser(supabaseUserId: string): Promise<StoredUser | null> {
  const c = supabaseConfig();
  if (!c) return null;
  try {
    const res = await fetch(
      `${c.url}/rest/v1/snaptrade_secrets?user_id=eq.${encodeURIComponent(supabaseUserId)}&select=snaptrade_user_id,user_secret`,
      { headers: headers(c.serviceKey) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{ snaptrade_user_id?: string; user_secret?: string }>;
    const row = rows[0];
    if (!row?.snaptrade_user_id || !row.user_secret) return null;
    return { userId: row.snaptrade_user_id, userSecret: row.user_secret };
  } catch {
    return null;
  }
}

async function saveCloudUser(supabaseUserId: string, user: StoredUser): Promise<void> {
  const c = supabaseConfig();
  if (!c) return;
  const res = await fetch(`${c.url}/rest/v1/snaptrade_secrets?on_conflict=user_id`, {
    method: "POST",
    headers: { ...headers(c.serviceKey), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      user_id: supabaseUserId,
      snaptrade_user_id: user.userId,
      user_secret: user.userSecret,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    console.warn("[brokerage] save secrets failed:", res.status, (await res.text()).slice(0, 200));
  }
}

async function persistBrokerLinks(
  supabaseUserId: string,
  networth: BrokerageNetWorth,
  snaptradeUserId: string,
): Promise<void> {
  const c = supabaseConfig();
  if (!c) return;
  const res = await fetch(`${c.url}/rest/v1/broker_links?on_conflict=user_id`, {
    method: "POST",
    headers: { ...headers(c.serviceKey), Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify({
      user_id: supabaseUserId,
      snaptrade_user_id: snaptradeUserId,
      connected: networth.connected,
      total: networth.total,
      accounts: networth.accounts,
      updated_at: new Date().toISOString(),
    }),
  });
  if (!res.ok) {
    console.warn("[brokerage] persist broker_links failed:", res.status, (await res.text()).slice(0, 200));
  }
}

async function loadBrokerLinkSnapshot(supabaseUserId: string): Promise<BrokerageNetWorth | null> {
  const c = supabaseConfig();
  if (!c) return null;
  try {
    const res = await fetch(
      `${c.url}/rest/v1/broker_links?user_id=eq.${encodeURIComponent(supabaseUserId)}&select=connected,total,accounts`,
      { headers: headers(c.serviceKey) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as Array<{
      connected?: boolean;
      total?: number | string;
      accounts?: unknown;
    }>;
    const row = rows[0];
    if (!row) return null;
    const total = Number(row.total);
    const accounts = Array.isArray(row.accounts) ? (row.accounts as BrokerageAccount[]) : [];
    return {
      connected: Boolean(row.connected) || accounts.length > 0,
      total: Number.isFinite(total) ? total : 0,
      accounts,
    };
  } catch {
    return null;
  }
}

function accountsFromSnaptrade(raw: Array<Record<string, unknown>>): BrokerageAccount[] {
  return raw.map((a) => {
    const balance = a.balance as
      | { total?: { amount?: number | null } | null }
      | undefined;
    const amount = balance?.total?.amount;
    const auth = a.brokerage_authorization;
    let authorizationId: string | null = null;
    if (typeof auth === "string" && auth.trim()) authorizationId = auth;
    else if (auth && typeof auth === "object" && "id" in auth) {
      const id = (auth as { id?: unknown }).id;
      if (typeof id === "string" && id.trim()) authorizationId = id;
    }
    return {
      id: String(a.id ?? ""),
      name: String(a.name ?? a.number ?? "Account"),
      institution: String(a.institution_name ?? ""),
      totalValue: typeof amount === "number" && Number.isFinite(amount) ? amount : null,
      authorizationId,
    };
  });
}

async function ensureUser(client: SnaptradeClient, supabaseUserId: string): Promise<StoredUser> {
  const existing = await loadCloudUser(supabaseUserId);
  if (existing) return existing;

  const userId = `falcon-${supabaseUserId}`;
  const res = await client.authentication.registerSnapTradeUser({ userId });
  const userSecret = (res.data as { userSecret?: string }).userSecret;
  if (!userSecret) {
    throw new Error("SnapTrade did not return a userSecret on registration.");
  }
  const stored: StoredUser = { userId, userSecret };
  await saveCloudUser(supabaseUserId, stored);
  return stored;
}

export async function listBrokerages(): Promise<SnaptradeBrokerage[]> {
  const client = getClient();
  if (!client) throw new Error("SnapTrade is not configured.");

  const res = await client.referenceData.listAllBrokerages();
  const raw = (Array.isArray(res.data) ? res.data : []) as Array<Record<string, unknown>>;

  return raw
    .map((b): SnaptradeBrokerage => {
      const name = String(b.display_name ?? b.name ?? b.slug ?? "").trim();
      return {
        id: String(b.id ?? b.slug ?? name),
        name,
        slug: String(b.slug ?? ""),
        logoUrl:
          (b.aws_s3_square_logo_url as string | undefined) ??
          (b.aws_s3_logo_url as string | undefined) ??
          null,
        url: (b.url as string | undefined) ?? null,
      };
    })
    .filter((b) => b.name.length > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function getConnectionUrl(
  supabaseUserId: string,
  broker?: string,
  customRedirect?: string,
): Promise<string> {
  const client = getClient();
  if (!client) throw new Error("SnapTrade is not configured.");

  const user = await ensureUser(client, supabaseUserId);
  const res = await client.authentication.loginSnapTradeUser({
    userId: user.userId,
    userSecret: user.userSecret,
    broker,
    immediateRedirect: false,
    connectionType: "read",
    ...(customRedirect ? { customRedirect } : {}),
  });

  const data = res.data as { redirectURI?: string } | undefined;
  const url = data?.redirectURI;
  if (!url) throw new Error("SnapTrade did not return a connection URL.");
  return url;
}

export async function getBrokerageNetWorth(supabaseUserId: string): Promise<BrokerageNetWorth> {
  const client = getClient();
  if (!client) {
    return (await loadBrokerLinkSnapshot(supabaseUserId)) ?? { connected: false, total: 0, accounts: [] };
  }

  const user = await ensureUser(client, supabaseUserId);
  const res = await client.accountInformation.listUserAccounts({
    userId: user.userId,
    userSecret: user.userSecret,
  });
  const raw = (Array.isArray(res.data) ? res.data : []) as Array<Record<string, unknown>>;
  const accounts = accountsFromSnaptrade(raw);
  const total = accounts.reduce((sum, a) => sum + (a.totalValue ?? 0), 0);
  const networth: BrokerageNetWorth = { connected: accounts.length > 0, total, accounts };
  await persistBrokerLinks(supabaseUserId, networth, user.userId);
  return networth;
}

export async function disconnectBrokerage(
  supabaseUserId: string,
  authorizationId: string,
): Promise<BrokerageNetWorth> {
  const client = getClient();
  if (!client) throw new Error("SnapTrade is not configured.");

  const user = await ensureUser(client, supabaseUserId);
  await client.connections.removeBrokerageAuthorization({
    authorizationId,
    userId: user.userId,
    userSecret: user.userSecret,
  });
  return getBrokerageNetWorth(supabaseUserId);
}
