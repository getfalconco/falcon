import { NextResponse } from "next/server";
import {
  BROKER_APP_RETURN,
  brokerTicket,
  exchangeBrokerCode,
  readBrokerState,
} from "@/lib/portfolio-server";
import { isAllowedReturnOrigin, writeBrokerCookie } from "../session";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/** The only value SnapTrade sends as `iss` on its authorization responses. */
const SNAPTRADE_ISSUER = "https://api.snaptrade.com";

/**
 * The SnapTrade OAuth app's registered redirect URI (exactly
 * https://app.getfalcon.co/api/portfolio/broker/done). It checks `state`,
 * swaps the code for a token server-side, seals the token into a ticket for
 * the member who started the flow, and hands that ticket back:
 *   - iPhone app: redirect to falcon://broker?ticket=... (or ?error=...)
 *   - web: post it to the opener window on the origin named in `state`, and
 *     keep it in an httpOnly cookie for callers on this host.
 */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const flow = readBrokerState(params.get("state"));
  if (!flow) return page({ ok: false });

  const appReturn = flow.returnTo === "app";
  const target = appReturn || !isAllowedReturnOrigin(flow.returnTo) ? null : flow.returnTo;
  const fail = (reason: string) =>
    appReturn
      ? redirectToApp({ error: reason })
      : page({ ok: false, origin: target });

  const iss = params.get("iss");
  if (iss && iss !== SNAPTRADE_ISSUER) return fail("invalid_issuer");
  const oauthError = params.get("error");
  if (oauthError) return fail(/denied/i.test(oauthError) ? "access_denied" : "authorization_failed");
  const code = params.get("code");
  if (!code) return fail("authorization_failed");

  let exchange: Awaited<ReturnType<typeof exchangeBrokerCode>>;
  try {
    exchange = await exchangeBrokerCode(code, flow.verifier);
  } catch (error) {
    console.error("[portfolio broker done] token request failed", error instanceof Error ? error.name : "");
    return fail("token_exchange_failed");
  }
  if (!exchange.ok) {
    console.error("[portfolio broker done] token exchange", exchange.status, exchange.error);
    return fail("token_exchange_failed");
  }

  const ticket = brokerTicket(flow.userId, exchange);
  if (appReturn) return redirectToApp({ ticket });
  const response = page({ ok: true, origin: target, ticket });
  writeBrokerCookie(response, request, ticket);
  return response;
}

function redirectToApp(query: Record<string, string>) {
  const url = `${BROKER_APP_RETURN}?${new URLSearchParams(query).toString()}`;
  return new NextResponse(null, { status: 302, headers: { ...NO_STORE, Location: url } });
}

/**
 * A small page that tells the welcome flow (its opener) and closes. The
 * ticket is only ever posted to the origin that `state` named; a failure,
 * which carries nothing, goes to any opener.
 */
function page({ ok, origin, ticket }: { ok: boolean; origin?: string | null; ticket?: string }) {
  const message = JSON.stringify({ type: "falcon:broker", ok, ...(ticket ? { ticket } : {}) }).replace(/</g, "\\u003c");
  const targetOrigin = JSON.stringify(ticket ? (origin ?? "") : (origin ?? "*")).replace(/</g, "\\u003c");
  const html = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><title>Falcon</title>
<style>body{margin:0;display:flex;min-height:100vh;align-items:center;justify-content:center;background:#fdfdfd;color:#1d1b1b;font:14px/1.5 system-ui,sans-serif}</style>
</head>
<body>
<p>${ok ? "You can close this window and go back to Falcon." : "That didn't work. Close this window and try again in Falcon."}</p>
<script>
(function () {
  var target = ${targetOrigin};
  try {
    if (window.opener && target) window.opener.postMessage(${message}, target);
  } catch (e) {}
  if (window.history && window.history.replaceState) window.history.replaceState(null, "", window.location.pathname);
  setTimeout(function () { window.close(); }, 150);
})();
</script>
</body>
</html>`;
  return new NextResponse(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", ...NO_STORE },
  });
}
