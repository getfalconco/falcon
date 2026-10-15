/**
 * `public.snaptrade_secrets` over Supabase REST, with the user secret
 * encrypted at the application level (secret-box.ts).
 *
 * - Writes are sealed with SNAPTRADE_SECRET_KEY.
 * - Reads open sealed rows, and re-seal a plaintext row from before this
 *   change on the spot ("lazy re-encryption"), so the table converges to
 *   ciphertext as accounts are used.
 * - Without SNAPTRADE_SECRET_KEY the store keeps working on plaintext, and
 *   says so once in the log. A sealed row read without the key is an error,
 *   not "no row": answering "no row" would make the caller register a second
 *   SnapTrade user for the same account.
 *
 * Electron- and env-free: config, key, fetch and the logger are injected, so
 * the tests drive it against a fake fetch.
 */

import { SecretKeyError, isSealed, openSecret, parseSecretKey, sealSecret } from "./secret-box.js";

export type StoredUser = { userId: string; userSecret: string };

export type SupabaseRestConfig = { url: string; serviceKey: string };

export type SecretsStoreDeps = {
  config: () => SupabaseRestConfig | null;
  /** The 32-byte key, or null when SNAPTRADE_SECRET_KEY is not set. */
  key: () => Buffer | null;
  fetch?: typeof fetch;
  warn?: (message: string) => void;
};

function headers(serviceKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

function isMissingTable(status: number, body: string): boolean {
  return status === 404 || /PGRST205|42P01|schema cache/i.test(body);
}

export function createSnaptradeSecretsStore(deps: SecretsStoreDeps) {
  const doFetch = deps.fetch ?? fetch;
  const warn = deps.warn ?? ((m: string) => console.warn(m));
  let warnedPlaintext = false;
  const warnPlaintextOnce = () => {
    if (warnedPlaintext) return;
    warnedPlaintext = true;
    warn("[snaptrade-secrets] SNAPTRADE_SECRET_KEY is not set: SnapTrade user secrets are stored in plaintext.");
  };

  const rowUrl = (c: SupabaseRestConfig, table: string, userId: string, select?: string) =>
    `${c.url.replace(/\/$/, "")}/rest/v1/${table}?user_id=eq.${encodeURIComponent(userId)}${select ? `&select=${select}` : ""}`;

  async function writeSecret(c: SupabaseRestConfig, supabaseUserId: string, user: StoredUser): Promise<void> {
    const key = deps.key();
    if (!key) warnPlaintextOnce();
    const stored = key ? sealSecret(user.userSecret, key, supabaseUserId) : user.userSecret;
    const res = await doFetch(`${c.url.replace(/\/$/, "")}/rest/v1/snaptrade_secrets?on_conflict=user_id`, {
      method: "POST",
      headers: { ...headers(c.serviceKey), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify({
        user_id: supabaseUserId,
        snaptrade_user_id: user.userId,
        user_secret: stored,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) {
      throw new Error(`save secrets failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
    }
  }

  return {
    /** The account's SnapTrade identity, decrypted; null when it has none. */
    async load(supabaseUserId: string): Promise<StoredUser | null> {
      const c = deps.config();
      if (!c) return null;
      const res = await doFetch(rowUrl(c, "snaptrade_secrets", supabaseUserId, "snaptrade_user_id,user_secret"), {
        headers: headers(c.serviceKey),
      });
      if (!res.ok) return null;
      const rows = (await res.json()) as Array<{ snaptrade_user_id?: string; user_secret?: string }>;
      const row = rows[0];
      if (!row?.snaptrade_user_id || !row.user_secret) return null;

      const key = deps.key();
      if (isSealed(row.user_secret)) {
        if (!key) {
          throw new SecretKeyError("SnapTrade secret is encrypted but SNAPTRADE_SECRET_KEY is not set.");
        }
        return { userId: row.snaptrade_user_id, userSecret: openSecret(row.user_secret, key, supabaseUserId) };
      }

      const user = { userId: row.snaptrade_user_id, userSecret: row.user_secret };
      if (key) {
        // A row from before encryption: seal it now. A failure here leaves the
        // plaintext row in place and is retried on the next read.
        try {
          await writeSecret(c, supabaseUserId, user);
        } catch (err) {
          warn(`[snaptrade-secrets] re-encrypting a plaintext row failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        warnPlaintextOnce();
      }
      return user;
    },

    async save(supabaseUserId: string, user: StoredUser): Promise<void> {
      const c = deps.config();
      if (!c) return;
      await writeSecret(c, supabaseUserId, user);
    },

    /**
     * The SnapTrade user id this account registered, from the secrets row or
     * the broker_links snapshot; null when it never linked a brokerage.
     * Throws when Supabase cannot answer, so account deletion stops rather
     * than forgetting a SnapTrade user it could not see.
     */
    async snaptradeUserIdFor(supabaseUserId: string): Promise<string | null> {
      const c = deps.config();
      if (!c) throw new Error("Supabase is not configured.");
      for (const table of ["snaptrade_secrets", "broker_links"]) {
        const res = await doFetch(rowUrl(c, table, supabaseUserId, "snaptrade_user_id"), { headers: headers(c.serviceKey) });
        const body = await res.text();
        if (!res.ok) {
          if (isMissingTable(res.status, body)) continue;
          throw new Error(`${table} lookup failed: ${res.status}`);
        }
        const rows = JSON.parse(body) as Array<{ snaptrade_user_id?: string | null }>;
        const id = rows[0]?.snaptrade_user_id?.trim();
        if (id) return id;
      }
      return null;
    },

    /** Drops the stored secret and the brokerage snapshot of an account. */
    async remove(supabaseUserId: string): Promise<void> {
      const c = deps.config();
      if (!c) throw new Error("Supabase is not configured.");
      for (const table of ["snaptrade_secrets", "broker_links"]) {
        const res = await doFetch(rowUrl(c, table, supabaseUserId), { method: "DELETE", headers: headers(c.serviceKey) });
        if (!res.ok) {
          const body = await res.text();
          if (isMissingTable(res.status, body)) continue;
          throw new Error(`${table} delete failed: ${res.status}`);
        }
      }
    },
  };
}

export type SnaptradeSecretsStore = ReturnType<typeof createSnaptradeSecretsStore>;

/** The store this process uses, reading Supabase and the key from the environment per call. */
export const snaptradeSecrets: SnaptradeSecretsStore = createSnaptradeSecretsStore({
  config: () => {
    const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    return url && serviceKey ? { url, serviceKey } : null;
  },
  key: (() => {
    let warnedInvalid = false;
    return () => {
      const raw = process.env.SNAPTRADE_SECRET_KEY;
      const key = parseSecretKey(raw);
      if (!key && raw?.trim() && !warnedInvalid) {
        warnedInvalid = true;
        console.error("[snaptrade-secrets] SNAPTRADE_SECRET_KEY is set but is not 32 bytes of hex or base64; ignoring it.");
      }
      return key;
    };
  })(),
});
