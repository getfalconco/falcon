import { NextResponse } from "next/server";
import { clientIp, rateLimit, tooManyRequests } from "@/lib/rate-limit";
import { bearerToken, userFromAccessToken } from "@/lib/waitlist-membership";
import { MAX_STOCKS, TICKER_PATTERN } from "@/lib/onboarding";
import { cleanImport, quoteSymbol, valuePortfolio, type PortfolioAccount, type PortfolioPosition, type Quote } from "@/lib/portfolio-holdings";
import { StoreError, benchmarkFor, clearPortfolio, quotesFor, readPortfolio, saveImport } from "@/lib/portfolio-store";

export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };
const MAX_BODY_CHARS = 512 * 1024;

/**
 * The signed-in member's stored portfolio with sizes
 * (lib/portfolio-store.ts; tables from supabase/migrations/20261123_portfolio_holdings.sql).
 * Who is asking comes only from the Supabase access token (Authorization:
 * Bearer); every read and write is filtered by that member's id.
 *
 *   GET    /api/portfolio/holdings[?tickers=A,B][&sizes=0]
 *            -> 200 { available, accounts, positions (valued with live prices), totals,
 *                     weightCurrency, quotes: { TICKER: Quote } for `tickers`,
 *                     benchmark: { symbol: "SPY", from, changePct } | null, at }
 *            `sizes=0` skips the stored rows (another workspace's ticker list).
 *            `market`: every quote by quote symbol, with market cap and volume.
 *            Under `next dev` without a token (the preview) only quotes come back,
 *            or the dev fixture with `fixture=1`, or the ⌘P test portfolio with
 *            `fixture=random&seed=N`.
 *   POST   /api/portfolio/holdings { source, accounts, positions }
 *            -> 200 { available, accounts, positions, tickers } (validated; tickers added to the list)
 *   DELETE /api/portfolio/holdings -> 200 { available } ("Clear portfolio")
 *
 *   `available: false` while the tables are missing: nothing is saved.
 *   401 not signed in, 400 bad body, 413 too large, 429 rate limited, 502 database failed.
 */

async function member(request: Request) {
  return userFromAccessToken(bearerToken(request)).catch(() => null);
}

function tickersParam(url: URL): string[] {
  const raw = url.searchParams.get("tickers") ?? "";
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((t) => t.trim().toUpperCase())
        .filter((t) => TICKER_PATTERN.test(t)),
    ),
  ).slice(0, MAX_STOCKS);
}

/** Quotes for the ticker list, keyed by the ticker as the app writes it (BRK.B). */
function byTicker(tickers: readonly string[], quotes: Record<string, Quote>): Record<string, Quote> {
  const out: Record<string, Quote> = {};
  for (const t of tickers) {
    const s = quoteSymbol({ kind: "stock", symbol: t, ticker: t, currency: null });
    if (s && quotes[s]) out[t] = quotes[s];
  }
  return out;
}

async function valued(accounts: PortfolioAccount[], positions: PortfolioPosition[], tickers: string[], available: boolean) {
  const [quotes, benchmark] = await Promise.all([
    quotesFor(positions, tickers),
    accounts.length || positions.length ? benchmarkFor(accounts, positions).catch(() => null) : Promise.resolve(null),
  ]);
  const v = valuePortfolio(positions, quotes, accounts);
  return {
    available,
    accounts,
    positions: v.positions,
    totals: v.totals,
    weightCurrency: v.weightCurrency,
    quotes: byTicker(tickers, quotes),
    // Every quote by its quote symbol (BRK-B, BTC-USD, an OCC symbol), with market cap and volume, for the Dashboard's table.
    market: quotes,
    benchmark,
    at: Date.now(),
  };
}

export async function GET(request: Request) {
  const limit = rateLimit(`portfolio-holdings-get:${clientIp(request)}`, { limit: 60, windowMs: 60_000 });
  if (!limit.ok) return tooManyRequests(limit.retryAfter);
  const url = new URL(request.url);
  const tickers = tickersParam(url);

  if (!bearerToken(request)) {
    if (process.env.NODE_ENV !== "development") return NextResponse.json({ error: "Sign in first." }, { status: 401, headers: NO_STORE });
    // The development preview: no account. Quotes for its tickers, or the dev fixture with sizes.
    // `fixture=random&seed=N` is the ⌘P test portfolio (lib/workspace/test-portfolio.ts), signed in or not: never stored.
    if (url.searchParams.get("fixture") === "random") {
      const seed = Number(url.searchParams.get("seed"));
      if (!Number.isInteger(seed) || seed < 0) return NextResponse.json({ error: "Send a seed." }, { status: 400, headers: NO_STORE });
      const { testPortfolio } = await import("@/lib/test-portfolio-server");
      const test = await testPortfolio(seed);
      return NextResponse.json(await valued(test.accounts, test.positions, [], true), { headers: NO_STORE });
    }
    if (url.searchParams.get("fixture") === "1") {
      const { FIXTURE_ACCOUNTS, FIXTURE_POSITIONS } = await import("@/lib/workspace/fixture-positions");
      return NextResponse.json(await valued(FIXTURE_ACCOUNTS, FIXTURE_POSITIONS, tickers, true), { headers: NO_STORE });
    }
    return NextResponse.json(await valued([], [], tickers, false), { headers: NO_STORE });
  }

  const user = await member(request);
  if (!user) return NextResponse.json({ error: "Sign in again." }, { status: 401, headers: NO_STORE });
  const userLimit = rateLimit(`portfolio-holdings-get-user:${user.id}`, { limit: 30, windowMs: 60_000 });
  if (!userLimit.ok) return tooManyRequests(userLimit.retryAfter);

  try {
    if (url.searchParams.get("sizes") === "0") return NextResponse.json(await valued([], [], tickers, false), { headers: NO_STORE });
    const stored = await readPortfolio(user.id);
    return NextResponse.json(await valued(stored.accounts, stored.positions, tickers, stored.available), { headers: NO_STORE });
  } catch (error) {
    console.error("[api/portfolio/holdings GET]", error instanceof StoreError ? error.code : "unknown");
    return NextResponse.json({ error: "Your portfolio couldn't be loaded." }, { status: 502, headers: NO_STORE });
  }
}

export async function POST(request: Request) {
  const ipLimit = rateLimit(`portfolio-holdings-post:${clientIp(request)}`, { limit: 30, windowMs: 10 * 60_000 });
  if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfter);
  const user = await member(request);
  if (!user) return NextResponse.json({ error: "Sign in again to save your portfolio." }, { status: 401, headers: NO_STORE });
  const userLimit = rateLimit(`portfolio-holdings-post-user:${user.id}`, { limit: 20, windowMs: 10 * 60_000 });
  if (!userLimit.ok) return tooManyRequests(userLimit.retryAfter);

  const raw = await request.text().catch(() => "");
  if (raw.length > MAX_BODY_CHARS) return NextResponse.json({ error: "That import is too large." }, { status: 413, headers: NO_STORE });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "Send a JSON import." }, { status: 400, headers: NO_STORE });
  }
  const checked = cleanImport(body);
  if (!checked.ok) return NextResponse.json({ error: checked.error }, { status: 400, headers: NO_STORE });

  try {
    const saved = await saveImport(user.id, checked.value);
    return NextResponse.json(saved, { headers: NO_STORE });
  } catch (error) {
    console.error("[api/portfolio/holdings POST]", error instanceof StoreError ? error.code : "unknown");
    return NextResponse.json({ error: "Your portfolio couldn't be saved." }, { status: 502, headers: NO_STORE });
  }
}

export async function DELETE(request: Request) {
  const ipLimit = rateLimit(`portfolio-holdings-delete:${clientIp(request)}`, { limit: 20, windowMs: 10 * 60_000 });
  if (!ipLimit.ok) return tooManyRequests(ipLimit.retryAfter);
  const user = await member(request);
  if (!user) return NextResponse.json({ error: "Sign in again." }, { status: 401, headers: NO_STORE });
  try {
    return NextResponse.json(await clearPortfolio(user.id), { headers: NO_STORE });
  } catch (error) {
    console.error("[api/portfolio/holdings DELETE]", error instanceof StoreError ? error.code : "unknown");
    return NextResponse.json({ error: "Your portfolio couldn't be cleared." }, { status: 502, headers: NO_STORE });
  }
}
