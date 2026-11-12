import { isAppHost } from "@/lib/app-host";
import { SERVICE_WORKER_SOURCE } from "@/lib/sw-source";

/**
 * The service worker script, served at the root so its scope is the whole app
 * host. Only the app host gets it; `no-cache` makes browsers check for a new
 * version on every load.
 */
export function GET(request: Request) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!isAppHost(host)) return new Response("Not found", { status: 404 });
  return new Response(SERVICE_WORKER_SOURCE, {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-cache",
      "Service-Worker-Allowed": "/",
    },
  });
}
