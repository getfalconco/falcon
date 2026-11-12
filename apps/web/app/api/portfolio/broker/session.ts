import type { NextResponse } from "next/server";

/**
 * The sealed broker ticket (see lib/portfolio-server.ts) for a member on the
 * app host, kept in an httpOnly cookie scoped to these routes for 15 minutes.
 * It backs up the ticket the done page posts to the opener window.
 */
const COOKIE = "falcon_broker";
const PATH = "/api/portfolio/broker";

export function readBrokerCookie(request: Request): string | null {
  const raw = request.headers
    .get("cookie")
    ?.split(";")
    .map((c) => c.trim())
    .find((c) => c.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1);
  return raw ? decodeURIComponent(raw) : null;
}

export function writeBrokerCookie(response: NextResponse, request: Request, ticket: string | null) {
  response.cookies.set(COOKIE, ticket ?? "", {
    httpOnly: true,
    secure: new URL(request.url).protocol === "https:",
    sameSite: "lax",
    path: PATH,
    maxAge: ticket ? 15 * 60 : 0,
  });
}

/** Origins the done page may post a ticket to: Falcon's own hosts and local dev servers. */
export function isAllowedReturnOrigin(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.origin !== value) return false;
  const host = url.hostname;
  if (url.protocol === "https:" && (host === "getfalcon.co" || host.endsWith(".getfalcon.co"))) return true;
  const local = host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]";
  return local && (url.protocol === "http:" || url.protocol === "https:");
}
