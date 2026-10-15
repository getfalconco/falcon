/**
 * ENGINE RISK DATA: the account-deletion step for the engine.
 *
 * The risk engine (apps/falcon-engine, @meridian/research/risk) keeps each
 * account's paper-account copy and the risk readings computed from it on the
 * engine's own volume. Account deletion removes them through the engine's
 * `POST /service/delete-user-data` `{ userId }`, authenticated with the
 * shared FALCON_ENGINE_SERVICE_TOKEN (set the same 32+ character value on the
 * engine and on this worker). The service credential, not the reader's
 * token, because the retry queue runs after the account, and its token, are
 * gone.
 *
 * A non-2xx answer throws, so account-deletion.ts queues the step and the
 * retry loop tries again. Without FALCON_ENGINE_URL or the token there is no
 * way to reach the engine: this returns null and deletion reports the engine
 * item as "unavailable" instead of claiming it was removed (the desktop also
 * erases it with the reader's own session before deleting, see
 * apps/desktop/src/main/account/account-deletion.ts).
 */

export type EngineCleanupEnv = { url: string | undefined; token: string | undefined };

export function engineRiskDeleter(
  env: EngineCleanupEnv = { url: process.env.FALCON_ENGINE_URL, token: process.env.FALCON_ENGINE_SERVICE_TOKEN },
  doFetch: typeof fetch = fetch,
): ((userId: string) => Promise<void>) | null {
  const base = env.url?.trim().replace(/\/+$/, "") ?? "";
  const token = env.token?.trim() ?? "";
  if (!base || token.length < 32) return null;
  return async (userId: string) => {
    const res = await doFetch(`${base}/service/delete-user-data`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ userId }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`engine delete-user-data answered ${res.status}`);
  };
}
