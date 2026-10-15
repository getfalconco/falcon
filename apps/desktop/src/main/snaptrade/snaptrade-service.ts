import { app, safeStorage } from "electron";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  Snaptrade,
  SnaptradeAuth,
  type CommercialApiKeyAuth,
} from "snaptrade-typescript-sdk";
import type {
  BrokerageAccount,
  BrokerageNetWorth,
  SnaptradeBrokerage,
} from "../../shared/snaptrade";
import { ensureBrokerLinksSchema } from "../db/ensure-broker-links-schema";
import { loadDesktopEnv } from "../load-desktop-env";
import { resolveDataRoot } from "../data-root";
import { createLocalSnaptradeStore, snaptradeAccountKey, type StoredUser } from "./local-secret-store";
import { isSealed, openSecret, parseSecretKey, sealSecret } from "./secret-box";

type SnaptradeClient = Snaptrade<CommercialApiKeyAuth>;

const SUPABASE_HEADERS = {
  "User-Agent": "MeridianDesktop/1.0",
  "Content-Type": "application/json",
};

/**
 * SnapTrade credentials live only in the main-process environment
 * (SNAPTRADE_CLIENT_ID + SNAPTRADE_CONSUMER_KEY). They must never reach the
 * renderer — the renderer only ever receives the normalized brokerage list.
 */
function getConfig(): { clientId: string; consumerKey: string } | null {
  const clientId = process.env.SNAPTRADE_CLIENT_ID?.trim();
  const consumerKey = process.env.SNAPTRADE_CONSUMER_KEY?.trim();
  if (!clientId || !consumerKey) return null;
  return { clientId, consumerKey };
}

let cached: SnaptradeClient | null = null;

function getClient(): SnaptradeClient | null {
  if (cached) return cached;
  const cfg = getConfig();
  if (!cfg) return null;
  cached = new Snaptrade({
    auth: SnaptradeAuth.commercialApiKey({
      clientId: cfg.clientId,
      consumerKey: cfg.consumerKey,
    }),
  });
  return cached;
}

export function isSnaptradeConfigured(): boolean {
  return getConfig() !== null;
}

function supabaseConfig(): { url: string; serviceKey: string } | null {
  loadDesktopEnv(true);
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

function supabaseAuthHeaders(serviceKey: string): Record<string, string> {
  return {
    ...SUPABASE_HEADERS,
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

function isMissingTableError(status: number, body: string): boolean {
  if (status === 404) return true;
  return /PGRST205|42P01|broker_links|snaptrade_secrets|schema cache/i.test(body);
}

async function resolveUserId(accessToken: string): Promise<string> {
  loadDesktopEnv(true);
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const anonKey = process.env.VITE_SUPABASE_ANON_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error("Supabase is not configured.");
  }

  const res = await fetch(`${url}/auth/v1/user`, {
    headers: {
      apikey: anonKey,
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!res.ok) {
    throw new Error("Session expired. Sign in again.");
  }

  const data = (await res.json()) as { id?: string };
  if (!data.id) {
    throw new Error("Could not verify your account.");
  }
  return data.id;
}

/** Fetch every brokerage SnapTrade supports, normalized + sorted by name. */
export async function listBrokerages(): Promise<SnaptradeBrokerage[]> {
  const client = getClient();
  if (!client) {
    throw new Error(
      "SnapTrade is not configured. Set SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY in apps/desktop/.env.local",
    );
  }

  const res = await client.referenceData.listAllBrokerages();
  const raw = (Array.isArray(res.data) ? res.data : []) as Array<
    Record<string, unknown>
  >;

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

/* ------------------------------------------------------------------ */
/* Connection flow                                                     */
/* ------------------------------------------------------------------ */

/**
 * This machine's copy of an account's SnapTrade identity: one encrypted file
 * per account under the data root (see local-secret-store.ts). The old
 * per-machine plaintext `<userData>/snaptrade-user.json` is migrated into it
 * on first use and deleted.
 */
const localStore = createLocalSnaptradeStore({
  root: () => resolveDataRoot(),
  legacyFile: () => path.join(app.getPath("userData"), "snaptrade-user.json"),
  safeStorage,
});

function loadStoredUser(supabaseUserId?: string): StoredUser | null {
  return localStore.read(snaptradeAccountKey(supabaseUserId));
}

function saveStoredUser(user: StoredUser, supabaseUserId?: string): void {
  localStore.write(snaptradeAccountKey(supabaseUserId), user);
}

/** The SnapTrade identity this machine holds for an account, if any (account deletion). */
export function localSnaptradeIdentity(supabaseUserId: string): StoredUser | null {
  return loadStoredUser(supabaseUserId);
}

/** Removes this machine's copy of an account's SnapTrade identity. Throws when the file cannot be removed. */
export function forgetLocalSnaptradeIdentity(supabaseUserId: string): void {
  localStore.remove(snaptradeAccountKey(supabaseUserId));
}

/**
 * Account deletion in direct mode: removes the SnapTrade user and every
 * brokerage connection under it. "absent" when SnapTrade no longer has it
 * (the server side of the deletion may have removed it first).
 */
export async function deleteSnaptradeUser(snaptradeUserId: string): Promise<"deleted" | "absent"> {
  const client = getClient();
  if (!client) throw new Error("SnapTrade is not configured.");
  try {
    await client.authentication.deleteSnapTradeUser({ userId: snaptradeUserId });
    return "deleted";
  } catch (err) {
    if ((err as { status?: number }).status === 404) return "absent";
    throw err;
  }
}

/**
 * The key that seals the user secret in snaptrade_secrets (secret-box.ts).
 * Same SNAPTRADE_SECRET_KEY as the research-worker; without it rows are read
 * and written in plaintext, and a sealed row cannot be opened.
 */
let warnedPlaintext = false;
function secretKey(): Buffer | null {
  loadDesktopEnv(true);
  const key = parseSecretKey(process.env.SNAPTRADE_SECRET_KEY);
  if (!key && !warnedPlaintext) {
    warnedPlaintext = true;
    console.warn("[snaptrade] SNAPTRADE_SECRET_KEY not set: cloud SnapTrade secrets are read and written in plaintext.");
  }
  return key;
}

async function loadCloudUser(supabaseUserId: string): Promise<StoredUser | null> {
  const config = supabaseConfig();
  if (!config) return null;
  await ensureBrokerLinksSchema();

  try {
    const res = await fetch(
      `${config.url}/rest/v1/snaptrade_secrets?user_id=eq.${encodeURIComponent(supabaseUserId)}&select=snaptrade_user_id,user_secret`,
      { headers: supabaseAuthHeaders(config.serviceKey) },
    );
    const body = await res.text();
    if (!res.ok) {
      if (!isMissingTableError(res.status, body)) {
        console.warn("[snaptrade] load secrets failed:", res.status, body.slice(0, 200));
      }
      return null;
    }
    const rows = JSON.parse(body) as Array<{ snaptrade_user_id?: string; user_secret?: string }>;
    const row = rows[0];
    if (!row?.snaptrade_user_id || !row.user_secret) return null;
    const key = secretKey();
    if (isSealed(row.user_secret)) {
      if (!key) {
        throw new Error("SnapTrade secret is encrypted but SNAPTRADE_SECRET_KEY is not set in apps/desktop/.env.local.");
      }
      return { userId: row.snaptrade_user_id, userSecret: openSecret(row.user_secret, key, supabaseUserId) };
    }
    const user = { userId: row.snaptrade_user_id, userSecret: row.user_secret };
    // A row from before encryption: seal it now (lazy re-encryption).
    if (key) await saveCloudUser(supabaseUserId, user);
    return user;
  } catch (err) {
    if (err instanceof Error && /SNAPTRADE_SECRET_KEY/.test(err.message)) throw err;
    console.warn("[snaptrade] load secrets failed:", err instanceof Error ? err.message : err);
    return null;
  }
}

async function saveCloudUser(supabaseUserId: string, user: StoredUser): Promise<void> {
  const config = supabaseConfig();
  if (!config) return;
  await ensureBrokerLinksSchema();

  try {
    const res = await fetch(
      `${config.url}/rest/v1/snaptrade_secrets?on_conflict=user_id`,
      {
        method: "POST",
        headers: {
          ...supabaseAuthHeaders(config.serviceKey),
          Prefer: "resolution=merge-duplicates",
        },
        body: JSON.stringify({
          user_id: supabaseUserId,
          snaptrade_user_id: user.userId,
          user_secret: (() => {
            const key = secretKey();
            return key ? sealSecret(user.userSecret, key, supabaseUserId) : user.userSecret;
          })(),
          updated_at: new Date().toISOString(),
        }),
      },
    );
    if (!res.ok) {
      const body = await res.text();
      console.warn("[snaptrade] save secrets failed:", res.status, body.slice(0, 200));
    }
  } catch (err) {
    console.warn("[snaptrade] save secrets failed:", err instanceof Error ? err.message : err);
  }
}

export function accountsFromSnaptrade(raw: Array<Record<string, unknown>>): BrokerageAccount[] {
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

async function persistBrokerLinks(
  supabaseUserId: string,
  networth: BrokerageNetWorth,
  snaptradeUserId: string,
): Promise<void> {
  const config = supabaseConfig();
  if (!config) return;
  await ensureBrokerLinksSchema();

  try {
    const res = await fetch(`${config.url}/rest/v1/broker_links?on_conflict=user_id`, {
      method: "POST",
      headers: {
        ...supabaseAuthHeaders(config.serviceKey),
        Prefer: "resolution=merge-duplicates",
      },
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
      const body = await res.text();
      console.warn("[snaptrade] persist broker_links failed:", res.status, body.slice(0, 200));
    }
  } catch (err) {
    console.warn("[snaptrade] persist broker_links failed:", err instanceof Error ? err.message : err);
  }
}

async function loadBrokerLinkSnapshot(supabaseUserId: string): Promise<BrokerageNetWorth | null> {
  const config = supabaseConfig();
  if (!config) return null;

  try {
    const res = await fetch(
      `${config.url}/rest/v1/broker_links?user_id=eq.${encodeURIComponent(supabaseUserId)}&select=connected,total,accounts`,
      { headers: supabaseAuthHeaders(config.serviceKey) },
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
      connected: Boolean(row.connected),
      total: Number.isFinite(total) ? total : 0,
      accounts,
    };
  } catch {
    return null;
  }
}

/** Get (or lazily register) this Falcon user's SnapTrade identity. */
async function ensureUser(
  client: SnaptradeClient,
  supabaseUserId?: string,
): Promise<StoredUser> {
  if (supabaseUserId) {
    const cloud = await loadCloudUser(supabaseUserId);
    if (cloud) {
      saveStoredUser(cloud, supabaseUserId);
      return cloud;
    }
    const local = loadStoredUser(supabaseUserId);
    if (local) {
      await saveCloudUser(supabaseUserId, local);
      return local;
    }
  } else {
    const existing = loadStoredUser();
    if (existing) return existing;
  }

  const userId = supabaseUserId ? `falcon-${supabaseUserId}` : `falcon-${randomUUID()}`;
  const res = await client.authentication.registerSnapTradeUser({ userId });
  const userSecret = (res.data as { userSecret?: string }).userSecret;
  if (!userSecret) {
    throw new Error("SnapTrade did not return a userSecret on registration.");
  }
  const stored: StoredUser = { userId, userSecret };
  saveStoredUser(stored, supabaseUserId);
  if (supabaseUserId) await saveCloudUser(supabaseUserId, stored);
  return stored;
}

/**
 * Returns a SnapTrade Connection Portal URL. Opening it lets the user authorize
 * a brokerage (read-only) so their holdings sync back. `broker` is a slug.
 */
export async function getConnectionUrl(
  broker?: string,
  accessToken?: string,
): Promise<string> {
  const client = getClient();
  if (!client) {
    throw new Error(
      "SnapTrade is not configured. Set SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY in apps/desktop/.env.local",
    );
  }

  const supabaseUserId = accessToken ? await resolveUserId(accessToken) : undefined;
  const user = await ensureUser(client, supabaseUserId);
  const res = await client.authentication.loginSnapTradeUser({
    userId: user.userId,
    userSecret: user.userSecret,
    broker,
    immediateRedirect: false,
    connectionType: "read",
  });

  const data = res.data as { redirectURI?: string } | undefined;
  const url = data?.redirectURI;
  if (!url) {
    throw new Error("SnapTrade did not return a connection URL.");
  }
  return url;
}

/**
 * Combined value of every connected brokerage account. Returns
 * `connected: false` (total 0) when SnapTrade isn't configured or the user
 * has never been registered — the dashboard then shows paper balance only.
 *
 * When a Supabase session is present, SnapTrade identity is stored per user
 * (not per install) so mobile and desktop share the same connections.
 */
export async function getBrokerageNetWorth(accessToken?: string): Promise<BrokerageNetWorth> {
  const supabaseUserId = accessToken
    ? await resolveUserId(accessToken).catch(() => undefined)
    : undefined;

  const client = getClient();
  let user: StoredUser | null = null;
  if (client) {
    try {
      user = await ensureUser(client, supabaseUserId);
    } catch (err) {
      console.warn("[snaptrade] ensureUser:", err instanceof Error ? err.message : err);
    }
  } else if (supabaseUserId) {
    user = await loadCloudUser(supabaseUserId);
  } else {
    user = loadStoredUser();
  }

  if (!client || !user) {
    if (supabaseUserId) {
      const snapshot = await loadBrokerLinkSnapshot(supabaseUserId);
      if (snapshot) return snapshot;
    }
    return { connected: false, total: 0, accounts: [] };
  }

  const res = await client.accountInformation.listUserAccounts({
    userId: user.userId,
    userSecret: user.userSecret,
  });

  const raw = (Array.isArray(res.data) ? res.data : []) as Array<Record<string, unknown>>;
  const accounts = accountsFromSnaptrade(raw);
  const total = accounts.reduce((sum, a) => sum + (a.totalValue ?? 0), 0);
  const networth: BrokerageNetWorth = { connected: accounts.length > 0, total, accounts };

  if (supabaseUserId) {
    void persistBrokerLinks(supabaseUserId, networth, user.userId);
  }

  return networth;
}
