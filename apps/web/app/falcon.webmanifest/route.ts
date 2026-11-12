import { isAppHost } from "@/lib/app-host";
import { webManifest } from "@/lib/pwa";

/** The install manifest exists only on the app host; getfalcon.co gets a 404. */
export function GET(request: Request) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  if (!isAppHost(host)) return new Response("Not found", { status: 404 });
  return new Response(JSON.stringify(webManifest()), {
    headers: {
      "Content-Type": "application/manifest+json; charset=utf-8",
      "Cache-Control": "no-cache",
    },
  });
}
