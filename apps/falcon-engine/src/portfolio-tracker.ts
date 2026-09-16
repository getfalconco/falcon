/**
 * 24/7 portfolio tracker.
 *
 * Every tick: read every synced paper portfolio from Supabase, price the held
 * symbols via Finnhub, and append one net-worth snapshot per user. This is
 * what keeps the desktop's portfolio chart moving while the app is closed.
 *
 * Mirrors the engine-health pattern: service-role REST, best-effort (never
 * throws into the run loop), no-op when Supabase isn't configured.
 */

type PortfolioRow = {
  user_id: string;
  cash: number;
  positions: Record<string, { symbol?: string; shares?: number; costUsd?: number }>;
};

const SUPABASE_HEADERS = {
  "User-Agent": "MeridianWorker/1.0",
  "Content-Type": "application/json",
};

function supabaseConfig(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

async function fetchPortfolios(config: {
  url: string;
  serviceKey: string;
}): Promise<PortfolioRow[]> {
  const res = await fetch(
    `${config.url}/rest/v1/paper_portfolios?select=user_id,cash,positions`,
    {
      headers: {
        ...SUPABASE_HEADERS,
        apikey: config.serviceKey,
        Authorization: `Bearer ${config.serviceKey}`,
      },
    },
  );
  if (!res.ok) {
    throw new Error(`paper_portfolios read failed: ${res.status}`);
  }
  const rows = (await res.json()) as PortfolioRow[];
  return Array.isArray(rows) ? rows : [];
}

const YAHOO_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
};

/**
 * Extended-hours price from Yahoo: pre-market and after-hours prints are what
 * actually move a book outside 09:30–16:00, and Finnhub's free /quote only
 * ever reports the regular session.
 *
 * The session is derived from Yahoo's trading-period windows, matching the
 * desktop's live quote exactly. That agreement matters: if the worker prices
 * the book off a different print than the app trades at, the difference shows
 * up as phantom P&L — a $4k position valued at Friday's after-hours print
 * instead of its close reads as +$12.30 of gain on a closed market.
 */
async function fetchPriceExtended(symbol: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(
        symbol,
      )}?range=1d&interval=1m&includePrePost=true`,
      { headers: YAHOO_HEADERS },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      chart?: {
        result?: Array<{
          meta?: {
            preMarketPrice?: number;
            postMarketPrice?: number;
            regularMarketPrice?: number;
            currentTradingPeriod?: Record<string, { start?: number; end?: number }>;
          };
          indicators?: { quote?: Array<{ close?: Array<number | null> }> };
        }>;
      };
    };
    const result = data.chart?.result?.[0];
    if (!result) return null;
    const meta = result.meta ?? {};
    const ok = (v: unknown): v is number =>
      typeof v === "number" && Number.isFinite(v) && v > 0;

    // Resolve the session from the trading-period windows, exactly the way the
    // desktop's live quote does — Yahoo omits marketState on this endpoint, and
    // guessing from the candle series instead would price the book off a
    // different print than the app trades at (phantom P&L on a closed market).
    const nowSec = Math.floor(Date.now() / 1000);
    const within = (w?: { start?: number; end?: number }) =>
      w != null && ok(w.start) && ok(w.end) && nowSec >= w.start && nowSec < w.end;
    const periods = meta.currentTradingPeriod ?? {};

    const lastPrint = (): number | null => {
      const closes = result.indicators?.quote?.[0]?.close ?? [];
      for (let i = closes.length - 1; i >= 0; i--) {
        if (ok(closes[i])) return closes[i] as number;
      }
      return null;
    };

    if (within(periods.pre)) return meta.preMarketPrice ?? lastPrint() ?? null;
    if (within(periods.post)) return meta.postMarketPrice ?? lastPrint() ?? null;
    // Regular session: regularMarketPrice is the freshest field Yahoo sends.
    if (within(periods.regular) && ok(meta.regularMarketPrice)) {
      return meta.regularMarketPrice;
    }
    // Closed: the last extended-hours print is the newest real trade.
    return lastPrint() ?? (ok(meta.regularMarketPrice) ? meta.regularMarketPrice : null);
  } catch {
    return null;
  }
}

/** Finnhub current price — regular session only; the fallback source. */
async function fetchPriceFinnhub(symbol: string, token: string): Promise<number | null> {
  try {
    const res = await fetch(
      `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${token}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { c?: number };
    return typeof data.c === "number" && Number.isFinite(data.c) && data.c > 0
      ? data.c
      : null;
  } catch {
    return null;
  }
}

/** Extended-hours price where available, else the regular-session quote. */
async function fetchPrice(symbol: string, token: string): Promise<number | null> {
  return (await fetchPriceExtended(symbol)) ?? (await fetchPriceFinnhub(symbol, token));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Stay well inside Finnhub's free-tier 60 req/min alongside the news poller.
const MAX_SYMBOLS_PER_TICK = 40;
const QUOTE_DELAY_MS = 250;
/**
 * At a 5s cadence the same symbol would be re-quoted every few seconds, which
 * neither Yahoo nor Finnhub thanks you for and which no price actually needs:
 * a quote is reused while it is this fresh, so a tick usually costs nothing
 * and only the snapshot write is per-tick.
 */
const PRICE_TTL_MS = 20_000;
const priceCache = new Map<string, { price: number; at: number }>();

async function pricedSymbol(symbol: string, token: string): Promise<number | null> {
  const hit = priceCache.get(symbol);
  const now = Date.now();
  if (hit && now - hit.at < PRICE_TTL_MS) return hit.price;
  const price = await fetchPrice(symbol, token);
  if (price != null) priceCache.set(symbol, { price, at: now });
  else if (hit) return hit.price; // a failed poll keeps the last good print
  return price;
}

/** One tracking pass. Returns a short summary line for logging. */
export async function runPortfolioTrack(): Promise<string> {
  const config = supabaseConfig();
  if (!config) return "supabase not configured — skipped";
  const finnhubKey = process.env.FINNHUB_API_KEY?.trim();
  if (!finnhubKey) return "FINNHUB_API_KEY missing — skipped";

  const portfolios = await fetchPortfolios(config);
  if (portfolios.length === 0) return "no portfolios";

  // Price each held symbol once, shared across users.
  const symbols = [
    ...new Set(
      portfolios.flatMap((p) =>
        Object.keys(p.positions ?? {}).map((s) => s.toUpperCase()),
      ),
    ),
  ].slice(0, MAX_SYMBOLS_PER_TICK);

  const prices = new Map<string, number>();
  for (const symbol of symbols) {
    const cached = priceCache.get(symbol);
    const fresh = cached != null && Date.now() - cached.at < PRICE_TTL_MS;
    const price = await pricedSymbol(symbol, finnhubKey);
    if (price != null) prices.set(symbol, price);
    // Only a real fetch needs pacing; a cache hit is free.
    if (!fresh) await sleep(QUOTE_DELAY_MS);
  }

  const now = new Date().toISOString();
  const snapshots = portfolios.map((p) => {
    const cash = Number.isFinite(p.cash) ? p.cash : 0;
    const positionsValue = Object.entries(p.positions ?? {}).reduce(
      (sum, [symbol, pos]) => {
        // Shares and cost are signed: negative is a short position, whose
        // market value is a liability. Only a flat position is skipped.
        const shares = Number(pos?.shares);
        if (!Number.isFinite(shares) || Math.abs(shares) <= 1e-9) return sum;
        const price = prices.get(symbol.toUpperCase());
        if (price != null) return sum + shares * price;
        const cost = Number(pos?.costUsd);
        return sum + (Number.isFinite(cost) ? cost : 0);
      },
      0,
    );
    return { user_id: p.user_id, ts: now, value: cash + positionsValue };
  });

  const res = await fetch(`${config.url}/rest/v1/portfolio_snapshots`, {
    method: "POST",
    headers: {
      ...SUPABASE_HEADERS,
      apikey: config.serviceKey,
      Authorization: `Bearer ${config.serviceKey}`,
      Prefer: "return=minimal",
    },
    body: JSON.stringify(snapshots),
  });
  if (!res.ok) {
    throw new Error(
      `snapshot insert failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`,
    );
  }

  return `${snapshots.length} portfolio(s) snapshotted, ${prices.size}/${symbols.length} symbols priced`;
}

/** "fetch failed" hides the real network error in err.cause — surface it. */
function describeError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const c = cause as Error & { code?: string; hostname?: string };
    return `${err.message} (cause: ${c.code ?? c.name}${c.hostname ? ` host=${c.hostname}` : ""} — ${c.message})`;
  }
  return err.message;
}

/** Fire-and-forget loop, independent of the news cycle. */
/**
 * Last tick that actually wrote, and what it wrote. Exposed through the
 * service's /health so a stalled tracker is visible at a glance instead of
 * being discovered days later as a flat line on someone's chart — which is
 * exactly how this went unnoticed for a night.
 */
let lastRun: { at: string; summary: string } | null = null;
let lastError: { at: string; message: string } | null = null;

export function portfolioTrackerHealth(): {
  last_run_at: string | null;
  age_s: number | null;
  last_summary: string | null;
  last_error: string | null;
} {
  const at = lastRun?.at ?? null;
  return {
    last_run_at: at,
    age_s: at ? Math.round((Date.now() - new Date(at).getTime()) / 1000) : null,
    last_summary: lastRun?.summary ?? null,
    last_error: lastError ? `${lastError.at}: ${lastError.message}` : null,
  };
}

export function startPortfolioTracker(): void {
  // 5s, matching the desktop's own recorder: a chart that jumps five minutes
  // at a time between snapshots reads as a step function, not a trajectory.
  // The floor is the same 5s — the price fetch below is what actually paces a
  // tick, and a tick that overruns simply starts the next one late.
  const intervalMs = Math.max(
    5_000,
    Number.parseInt(process.env.PORTFOLIO_TRACK_INTERVAL_MS ?? "5000", 10) || 5_000,
  );

  // Fail loudly on a malformed SUPABASE_URL — the #1 cause of "fetch failed".
  const config = supabaseConfig();
  let targetHost = "not configured";
  if (config) {
    try {
      targetHost = new URL(config.url).host;
    } catch {
      console.error(
        `[portfolio] SUPABASE_URL is not a valid URL: "${config.url.slice(0, 60)}" — ` +
          "it must look like https://<project-ref>.supabase.co (no quotes, no spaces)",
      );
      targetHost = "INVALID";
    }
  }
  console.info(
    `[portfolio] tracker starting — every ${intervalMs}ms, supabase host: ${targetHost}`,
  );

  void (async () => {
    for (;;) {
      try {
        const summary = await runPortfolioTrack();
        lastRun = { at: new Date().toISOString(), summary };
        lastError = null;
        console.info(`[portfolio] ${summary}`);
      } catch (err) {
        lastError = { at: new Date().toISOString(), message: describeError(err) };
        console.warn("[portfolio] tick failed:", describeError(err));
      }
      await sleep(intervalMs);
    }
  })();
}
