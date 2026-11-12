import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { SITE_URL, isAppHost } from "@/lib/app-host";

/**
 * Paths the app host serves as-is: the login flow (sign in, early access,
 * reset password and email codes all run inside /login), the welcome flow
 * members see right after signing in, the Workspace (/app) it hands over to,
 * invite claims, the admin area the login hands off to, and the API routes
 * they call, plus the offline page the installed app falls back to.
 */
const APP_HOST_PATHS = [/^\/offline$/, /^\/login(\/|$)/, /^\/welcome(\/|$)/, /^\/app(\/|$)/, /^\/early-access(\/|$)/, /^\/invite(\/|$)/, /^\/admin(\/|$)/, /^\/api(\/|$)/];

export function middleware(request: NextRequest) {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const { pathname, search } = request.nextUrl;
  if (!isAppHost(host)) {
    // The Workspace lives on the app host; getfalcon.co/app goes there.
    if (/^\/app(\/|$)/.test(pathname) && /^(www\.)?getfalcon\.co$/i.test((host ?? "").split(":")[0])) {
      return NextResponse.redirect(`https://app.getfalcon.co${pathname}${search}`, 308);
    }
    return NextResponse.next();
  }

  // Static files (fonts, images, icons) are shared by both hosts.
  if (/\.[^/]+$/.test(pathname)) return NextResponse.next();

  let response: NextResponse;

  if (pathname === "/") {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    response = NextResponse.rewrite(url);
  } else if (APP_HOST_PATHS.some((re) => re.test(pathname))) {
    response = NextResponse.next();
  } else {
    // Marketing pages live on the main site.
    return NextResponse.redirect(`${SITE_URL}${pathname}${search}`, 308);
  }

  response.headers.set("X-Robots-Tag", "noindex");
  return response;
}

export const config = {
  // Skip Next internals; static files are let through above.
  matcher: ["/((?!_next/).*)"],
};
