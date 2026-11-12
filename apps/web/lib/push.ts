/**
 * Web push for the morning alert. PREPARED, NOT ENABLED.
 *
 * Nothing calls this yet and the flag is off, so no browser is ever asked for
 * notification permission. The service worker (`lib/sw-source.ts`) already
 * shows a pushed `{ title, body, url, tag }` payload and opens `url` on tap.
 *
 * To switch it on:
 * 1. Generate a VAPID key pair once, outside the repo:
 *      npx web-push generate-vapid-keys
 *    Never commit the keys and never generate them in CI.
 * 2. Netlify env (and apps/web/.env.local for local tests):
 *      NEXT_PUBLIC_PUSH_ENABLED=1
 *      NEXT_PUBLIC_VAPID_PUBLIC_KEY=<public key>   (browser, used below)
 *      VAPID_PRIVATE_KEY=<private key>             (server only, signs sends)
 *      VAPID_SUBJECT=mailto:<contact address>      (server only)
 * 3. Add `POST /api/push/subscribe` (save the subscription JSON for the signed-in
 *    user, e.g. a `push_subscriptions` table keyed by endpoint) and a matching
 *    DELETE, plus the morning job that sends with the `web-push` package and
 *    deletes subscriptions that come back 404/410.
 * 4. Call `subscribeToMorningAlert()` from a button the user taps (browsers and
 *    iOS require a user gesture for the permission prompt).
 *
 * iOS only delivers web push to the installed app (Add to Home Screen, iOS 16.4+);
 * in a Safari tab `pushSupported()` is false.
 */

export const PUSH_ENABLED = process.env.NEXT_PUBLIC_PUSH_ENABLED === "1";
const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY ?? "";
const SUBSCRIBE_ENDPOINT = "/api/push/subscribe";

export type PushResult =
  | { ok: true; subscription: PushSubscriptionJSON }
  | { ok: false; reason: "disabled" | "unsupported" | "denied" | "error"; message?: string };

/** True when this browser can receive web push (on iOS: only the installed app). */
export function pushSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    "serviceWorker" in navigator &&
    "PushManager" in window &&
    "Notification" in window
  );
}

function urlBase64ToBytes(base64: string): Uint8Array<ArrayBuffer> {
  const padded = (base64 + "=".repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(padded);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** The current subscription, if this device already opted in. */
export async function currentPushSubscription(): Promise<PushSubscription | null> {
  if (!PUSH_ENABLED || !pushSupported()) return null;
  const reg = await navigator.serviceWorker.getRegistration();
  return (await reg?.pushManager.getSubscription()) ?? null;
}

/**
 * Ask for permission, subscribe this device and hand the subscription to the
 * server. Call from a tap handler. `accessToken` is the Supabase session token.
 */
export async function subscribeToMorningAlert(accessToken: string): Promise<PushResult> {
  if (!PUSH_ENABLED || !VAPID_PUBLIC_KEY) return { ok: false, reason: "disabled" };
  if (!pushSupported()) return { ok: false, reason: "unsupported" };
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, reason: "denied" };
    const reg = await navigator.serviceWorker.ready;
    const subscription =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToBytes(VAPID_PUBLIC_KEY),
      }));
    const json = subscription.toJSON();
    const res = await fetch(SUBSCRIBE_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ subscription: json, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
    if (!res.ok) return { ok: false, reason: "error", message: `Subscribe failed (${res.status})` };
    return { ok: true, subscription: json };
  } catch (err) {
    return { ok: false, reason: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Turn the morning alert off on this device. */
export async function unsubscribeFromMorningAlert(accessToken: string): Promise<boolean> {
  const subscription = await currentPushSubscription();
  if (!subscription) return true;
  try {
    await fetch(SUBSCRIBE_ENDPOINT, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
    return await subscription.unsubscribe();
  } catch {
    return false;
  }
}
