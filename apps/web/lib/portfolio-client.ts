import type { PickedStock } from "./onboarding";
import { cleanImport, type Benchmark, type CurrencyTotal, type PortfolioAccount, type PortfolioImport, type Quote, type ValuedPosition } from "./portfolio-holdings";

/**
 * Browser side of the portfolio imports (/api/portfolio/*): which sources this
 * deployment offers, reading a screenshot and the SnapTrade popup. Shared by
 * the welcome flow's portfolio step and the Dashboard's "Start with what you
 * own" card. Every function throws an Error whose message can be shown as is.
 */

export type PortfolioSources = { screenshot: boolean; broker: boolean };

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Long edge of the image we send: plenty for reading a holdings list. */
const MAX_IMAGE_EDGE = 2400;
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif";

const NO_SOURCES: PortfolioSources = { screenshot: false, broker: false };

/** GET /api/portfolio/status; both false on any error. */
export function fetchPortfolioSources(): Promise<PortfolioSources> {
  return fetch("/api/portfolio/status", { cache: "no-store" })
    .then((r) => (r.ok ? (r.json() as Promise<PortfolioSources>) : NO_SOURCES))
    .catch(() => NO_SOURCES);
}

export function isHeic(file: File) {
  return /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/**
 * A JPEG no larger than MAX_IMAGE_EDGE on its long side, decoded by the
 * browser (which also turns HEIC into JPEG where the browser can read it).
 */
export async function prepareImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("no blob");
    return blob;
  } catch {
    if (isHeic(file)) {
      throw new Error("This browser can't open HEIC files. Take a PNG screenshot or save the image as JPG.");
    }
    if (["image/png", "image/jpeg", "image/webp"].includes(file.type)) return file;
    throw new Error("Use a PNG, JPG, WEBP or HEIC image.");
  }
}

type ImportBody = { holdings?: PickedStock[]; import?: unknown; error?: string; url?: string };

export async function readJson(res: Response): Promise<ImportBody> {
  try {
    return (await res.json()) as ImportBody;
  } catch {
    return {};
  }
}

/** What an import route gave back: `holdings` (one row per ticker) and, from routes that send it, the full import. */
export type ImportResponse = { holdings: PickedStock[] | undefined; import: PortfolioImport | undefined };

function importResponse(body: ImportBody): ImportResponse {
  const checked = body.import === undefined ? null : cleanImport(body.import);
  return { holdings: body.holdings, import: checked?.ok ? checked.value : undefined };
}

/** POST /api/portfolio/screenshot with the shrunk image; what Falcon read from it. */
export async function readScreenshotHoldings(file: File, headers: HeadersInit, signal?: AbortSignal): Promise<ImportResponse> {
  const form = new FormData();
  form.append("image", await prepareImage(file), "portfolio.jpg");
  const res = await fetch("/api/portfolio/screenshot", { method: "POST", headers, body: form, signal });
  const body = await readJson(res);
  if (!res.ok) throw new Error(body.error ?? "We couldn't read that screenshot. Try a CSV instead.");
  return importResponse(body);
}

export type BrokerImportOptions = {
  /** Called once the window came back (or closed) and the holdings are being read. */
  onReading?: () => void;
  /**
   * Aborting stops the import: the message listener and the window watch go,
   * any request in flight is cancelled, and the call rejects with an
   * AbortError (the caller closes the window).
   */
  signal?: AbortSignal;
};

function aborted(): DOMException {
  return new DOMException("The broker import was cancelled.", "AbortError");
}

/**
 * The read-only SnapTrade import in `popup` (opened by the caller inside the
 * click, so pop-up blockers allow it): start, wait for the done page's message
 * or the window closing, then read the holdings (the route revokes the grant,
 * so nothing stays linked). Null when the window was closed before finishing.
 */
export async function importBrokerHoldings(
  popup: Window,
  headers: HeadersInit,
  { onReading, signal }: BrokerImportOptions = {},
): Promise<ImportResponse | null> {
  if (signal?.aborted) throw aborted();
  const res = await fetch("/api/portfolio/broker/start", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ returnTo: window.location.origin }),
    signal,
  });
  const body = await readJson(res);
  if (!res.ok || !body.url) throw new Error(body.error ?? "We couldn't reach the broker service.");
  if (signal?.aborted) throw aborted();
  popup.location.href = body.url;

  // Done when SnapTrade sends the member back (the done page posts a message) or the window closes.
  const result = await new Promise<{ ok: boolean; ticket?: string } | null>((resolve, reject) => {
    const stop = () => {
      window.removeEventListener("message", onMessage);
      signal?.removeEventListener("abort", onAbort);
      clearInterval(watch);
    };
    const finish = (value: { ok: boolean; ticket?: string } | null) => {
      stop();
      resolve(value);
    };
    const onAbort = () => {
      stop();
      reject(aborted());
    };
    const onMessage = (event: MessageEvent) => {
      const data = event.data as { type?: string; ok?: unknown; ticket?: unknown } | null;
      if (event.source !== popup || data?.type !== "falcon:broker") return;
      finish({ ok: data.ok === true, ticket: typeof data.ticket === "string" ? data.ticket : undefined });
    };
    const watch = setInterval(() => {
      if (popup.closed) finish(null);
    }, 500);
    window.addEventListener("message", onMessage);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  if (result && !result.ok) throw new Error("The broker connection didn't go through. Try again or use a CSV.");
  onReading?.();

  // Without a message the ticket may still be in this host's cookie; the route also revokes the grant.
  const holdingsRes = await fetch("/api/portfolio/broker/holdings", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: result?.ticket }),
    signal,
  });
  const holdingsBody = await readJson(holdingsRes);
  if (!result && holdingsRes.status === 409) return null; // Closed before finishing.
  if (!holdingsRes.ok) throw new Error(holdingsBody.error ?? "We couldn't read your broker holdings.");
  return importResponse(holdingsBody);
}

/** Opens the named broker window inside a click; null when the browser blocked it. */
export function openBrokerWindow(): Window | null {
  return window.open("", "falcon-broker", "width=520,height=760");
}

/* ------------------------------------------------------------------ stored holdings (/api/portfolio/holdings) */

/**
 * The stored portfolio with live prices. `available: false` while sizes
 * cannot be stored yet (tables missing) or for a list without sizes; the
 * quotes for `tickers` come back either way. Amounts live in memory only:
 * nothing here writes to this browser's storage.
 */
export type HoldingsData = {
  available: boolean;
  accounts: PortfolioAccount[];
  positions: ValuedPosition[];
  totals: CurrencyTotal[];
  weightCurrency: string | null;
  /** Live (or last close) quotes for the ticker list, keyed by ticker. */
  quotes: Record<string, Quote>;
  /** Every quote (positions and list) by quote symbol (BRK-B, BTC-USD, an OCC symbol), with market cap and volume when the source gives them. */
  market: Record<string, Quote>;
  /** SPY over the same time as the portfolio, when it is at least a day old. */
  benchmark: Benchmark | null;
  at: number;
};

export type HoldingsQuery = {
  tickers?: readonly string[];
  sizes?: boolean;
  /** Development only: true for the `&sizes=1` fixture, a number for the ⌘P test portfolio with that seed. */
  fixture?: boolean | number;
  signal?: AbortSignal;
};

/** GET /api/portfolio/holdings; throws with a message to show on failure. */
export async function fetchHoldings(headers: HeadersInit, { tickers = [], sizes = true, fixture = false, signal }: HoldingsQuery = {}): Promise<HoldingsData> {
  const q = new URLSearchParams();
  if (tickers.length) q.set("tickers", tickers.join(","));
  if (!sizes) q.set("sizes", "0");
  if (typeof fixture === "number") {
    q.set("fixture", "random");
    q.set("seed", String(fixture));
  } else if (fixture) q.set("fixture", "1");
  const res = await fetch(`/api/portfolio/holdings${q.size ? `?${q}` : ""}`, { headers, cache: "no-store", signal });
  const body = (await res.json().catch(() => ({}))) as Partial<HoldingsData> & { error?: string };
  if (!res.ok) throw new Error(body.error ?? "Your portfolio couldn't be loaded.");
  return {
    available: body.available === true,
    accounts: body.accounts ?? [],
    positions: body.positions ?? [],
    totals: body.totals ?? [],
    weightCurrency: body.weightCurrency ?? null,
    quotes: body.quotes ?? {},
    market: body.market ?? {},
    benchmark: body.benchmark ?? null,
    at: body.at ?? Date.now(),
  };
}

/** POST /api/portfolio/holdings: saves an import. `available: false` when sizes cannot be stored yet. */
export async function saveHoldings(headers: HeadersInit, imp: PortfolioImport): Promise<{ available: boolean }> {
  const res = await fetch("/api/portfolio/holdings", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(imp),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { available?: boolean; error?: string };
  if (!res.ok) throw new Error(body.error ?? "Your portfolio couldn't be saved.");
  return { available: body.available === true };
}

/** DELETE /api/portfolio/holdings ("Clear portfolio"). */
export async function clearHoldings(headers: HeadersInit): Promise<{ available: boolean }> {
  const res = await fetch("/api/portfolio/holdings", { method: "DELETE", headers, cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as { available?: boolean; error?: string };
  if (!res.ok) throw new Error(body.error ?? "Your portfolio couldn't be cleared.");
  return { available: body.available === true };
}

/* ------------------------------------------------------------------ paper account (/api/portfolio/paper) */

/** POST /api/portfolio/paper: the account as the server built it; `available: false` when it could not be stored yet. */
export async function createPaperAccount(headers: HeadersInit, balance: number, name: string | null): Promise<{ available: boolean; account: PortfolioAccount | null }> {
  const res = await fetch("/api/portfolio/paper", {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ balance, name }),
    cache: "no-store",
  });
  const body = (await res.json().catch(() => ({}))) as { available?: boolean; account?: PortfolioAccount; error?: string };
  if (!res.ok) throw new Error(body.error ?? "Your paper account couldn't be created.");
  return { available: body.available === true, account: body.account ?? null };
}

/** DELETE /api/portfolio/paper ("Clear paper portfolio"). */
export async function deletePaperAccount(headers: HeadersInit): Promise<{ available: boolean }> {
  const res = await fetch("/api/portfolio/paper", { method: "DELETE", headers, cache: "no-store" });
  const body = (await res.json().catch(() => ({}))) as { available?: boolean; error?: string };
  if (!res.ok) throw new Error(body.error ?? "Your paper account couldn't be removed.");
  return { available: body.available === true };
}

/** GET /api/portfolio/spark: the "Last 7 Days" lines by quote symbol, fetched on Falcon's server. Never throws: {} on failure. */
export async function fetchSpark(symbols: readonly string[], signal?: AbortSignal): Promise<Record<string, number[]>> {
  if (!symbols.length) return {};
  try {
    const res = await fetch(`/api/portfolio/spark?symbols=${symbols.map(encodeURIComponent).join(",")}`, { signal });
    if (!res.ok) return {};
    const body = (await res.json().catch(() => ({}))) as { spark?: Record<string, unknown> };
    const out: Record<string, number[]> = {};
    for (const [k, v] of Object.entries(body.spark ?? {})) {
      if (Array.isArray(v) && v.every((n) => typeof n === "number" && Number.isFinite(n))) out[k] = v as number[];
    }
    return out;
  } catch {
    return {};
  }
}

/** GET /api/portfolio/history: closes per quote symbol for the Equity card, fetched on Falcon's server. Never throws: {} on failure. */
export async function fetchHistory(symbols: readonly string[], range: string, signal?: AbortSignal): Promise<Record<string, { t: number[]; c: number[]; prev?: number }>> {
  if (!symbols.length) return {};
  try {
    const res = await fetch(`/api/portfolio/history?range=${encodeURIComponent(range)}&symbols=${symbols.map(encodeURIComponent).join(",")}`, { signal });
    if (!res.ok) return {};
    const body = (await res.json().catch(() => ({}))) as { series?: Record<string, unknown> };
    const out: Record<string, { t: number[]; c: number[]; prev?: number }> = {};
    for (const [k, v] of Object.entries(body.series ?? {})) {
      const s = v as { t?: unknown; c?: unknown; prev?: unknown };
      if (!(Array.isArray(s.t) && Array.isArray(s.c) && s.t.length === s.c.length && s.t.every((n) => typeof n === "number") && s.c.every((n) => typeof n === "number"))) continue;
      out[k] = { t: s.t as number[], c: s.c as number[], ...(typeof s.prev === "number" && Number.isFinite(s.prev) ? { prev: s.prev } : {}) };
    }
    return out;
  } catch {
    return {};
  }
}

export type EquityAnswer = { points: { t: number; v: number; spy: number | null; pre?: boolean }[]; firstAt: number | null; from: number; at: number };

/**
 * GET /api/portfolio/equity: the Equity chart's points from the member's
 * holdings history, computed on Falcon's server (quantities stay there).
 * `fixture`: development only, as for fetchHoldings. Null on failure.
 */
export async function fetchEquity(headers: HeadersInit, { range, currency, fixture = false, signal }: { range: string; currency: string; fixture?: boolean | number; signal?: AbortSignal }): Promise<EquityAnswer | null> {
  const q = new URLSearchParams({ range, currency });
  if (typeof fixture === "number") {
    q.set("fixture", "random");
    q.set("seed", String(fixture));
  } else if (fixture) q.set("fixture", "1");
  try {
    const res = await fetch(`/api/portfolio/equity?${q}`, { headers, cache: "no-store", signal });
    if (!res.ok) return null;
    const body = (await res.json().catch(() => null)) as Partial<EquityAnswer> | null;
    if (!body || !Array.isArray(body.points)) return null;
    const points = body.points.filter((p) => p && typeof p.t === "number" && typeof p.v === "number" && Number.isFinite(p.v)).map((p) => ({ t: p.t, v: p.v, spy: typeof p.spy === "number" ? p.spy : null, ...(p.pre === true ? { pre: true } : {}) }));
    return { points, firstAt: typeof body.firstAt === "number" ? body.firstAt : null, from: typeof body.from === "number" ? body.from : Date.now(), at: typeof body.at === "number" ? body.at : Date.now() };
  } catch {
    return null;
  }
}
