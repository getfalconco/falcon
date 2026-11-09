/**
 * Server-only SEC EDGAR helpers for the welcome flow: ticker search (from the
 * SEC's public company_tickers.json) and recent filings for a set of tickers
 * (data.sec.gov submissions). Both are free public sources. Requests carry
 * Falcon's own descriptive User-Agent as SEC asks; nothing about the member
 * is ever sent. Results are cached in memory per server instance.
 */

const SEC_UA = process.env.SEC_EDGAR_USER_AGENT?.trim() || "Falcon Website research@getfalcon.co";
const TIMEOUT_MS = 6000;
const TICKERS_TTL_MS = 24 * 60 * 60 * 1000;
const FILINGS_TTL_MS = 10 * 60 * 1000;
const MAX_FILING_TICKERS = 30;

export type TickerEntry = { ticker: string; name: string; cik: string };

async function secJson<T>(url: string): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": SEC_UA, Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`SEC ${res.status} for ${url}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

type TickerIndex = { at: number; list: TickerEntry[]; byTicker: Map<string, TickerEntry> };

let tickers: TickerIndex | null = null;
let tickersLoading: Promise<TickerIndex> | null = null;

/** Tidies SEC's all-caps names ("MICROSOFT CORP" to "Microsoft Corp"). */
function displayName(title: string): string {
  const clean = title.replace(/\s*\/[A-Za-z]{2,3}\/?$/, "").trim();
  if (clean !== clean.toUpperCase()) return clean;
  return clean
    .toLowerCase()
    .replace(/\b([a-z])/g, (c) => c.toUpperCase())
    .replace(/\b(Llc|Plc|Nv|Sa|Ag|Se|Lp|Etf|Ii|Iii)\b/g, (w) => w.toUpperCase());
}

async function loadTickers(): Promise<TickerIndex> {
  if (tickers && Date.now() - tickers.at < TICKERS_TTL_MS) return tickers;
  if (!tickersLoading) {
    tickersLoading = (async () => {
      const raw = await secJson<Record<string, { cik_str: number; ticker: string; title: string }>>(
        "https://www.sec.gov/files/company_tickers.json",
      );
      const list: TickerEntry[] = [];
      const byTicker = new Map<string, TickerEntry>();
      // The file is ordered by market value, so earlier rows rank higher.
      for (const row of Object.values(raw)) {
        const ticker = String(row.ticker).toUpperCase().replace(/-/g, ".");
        if (byTicker.has(ticker)) continue;
        const entry = { ticker, name: displayName(row.title), cik: String(row.cik_str).padStart(10, "0") };
        list.push(entry);
        byTicker.set(ticker, entry);
      }
      const index: TickerIndex = { at: Date.now(), list, byTicker };
      tickers = index;
      return index;
    })().finally(() => {
      tickersLoading = null;
    });
  }
  return tickersLoading;
}

/**
 * Up to `limit` matches: the exact ticker first, then tickers or company
 * names that start with the query, then names containing it as a word. Ties
 * keep SEC's order (by market value), so "app" lists Apple near the top.
 */
export async function searchTickers(query: string, limit = 8): Promise<{ ticker: string; name: string }[]> {
  const q = query.trim().toUpperCase();
  if (!q) return [];
  const { list } = await loadTickers();
  const scored: { entry: TickerEntry; tier: number; rank: number }[] = [];
  list.forEach((entry, rank) => {
    const name = entry.name.toUpperCase();
    let tier = -1;
    if (entry.ticker === q) tier = 0;
    else if (entry.ticker.startsWith(q) || (q.length >= 2 && name.startsWith(q))) tier = 1;
    else if (q.length >= 3 && name.includes(` ${q}`)) tier = 2;
    if (tier >= 0) scored.push({ entry, tier, rank });
  });
  return scored
    .sort((a, b) => a.tier - b.tier || a.rank - b.rank)
    .slice(0, limit)
    .map(({ entry }) => ({ ticker: entry.ticker, name: entry.name }));
}

/* ------------------------------------------------------------------ */

type Submissions = {
  filings?: {
    recent?: {
      form: string[];
      acceptanceDateTime: string[];
      primaryDocDescription?: string[];
    };
  };
};

export type RecentFiling = { ticker: string; form: string; label: string; filedAt: string };

const FORM_LABELS: Record<string, string> = {
  "8-K": "Current report",
  "10-Q": "Quarterly report",
  "10-K": "Annual report",
  "6-K": "Foreign issuer report",
  "20-F": "Annual report",
  "4": "Insider transaction",
  "3": "New insider",
  "144": "Planned insider sale",
  "SC 13G": "Ownership stake",
  "SC 13G/A": "Ownership stake update",
  "SC 13D": "Activist stake",
  "SC 13D/A": "Activist stake update",
  "DEF 14A": "Proxy statement",
  "S-1": "Registration",
  "S-3": "Shelf registration",
};

const ROUTINE_FORMS = new Set(["424B2", "424B3", "424B5", "424B7", "FWP", "13F-HR", "13F-NT"]);

const filingsCache = new Map<string, { at: number; filings: { form: string; filedAt: string; label: string }[] }>();

async function filingsForCik(cik: string) {
  const hit = filingsCache.get(cik);
  if (hit && Date.now() - hit.at < FILINGS_TTL_MS) return hit.filings;
  const data = await secJson<Submissions>(`https://data.sec.gov/submissions/CIK${cik}.json`);
  const recent = data.filings?.recent;
  const filings: { form: string; filedAt: string; label: string }[] = [];
  if (recent) {
    // Newest first; a couple of days back is all the welcome result needs.
    const cutoff = Date.now() - 3 * 24 * 60 * 60 * 1000;
    for (let i = 0; i < recent.form.length; i++) {
      const at = Date.parse(recent.acceptanceDateTime[i]);
      if (!Number.isFinite(at) || at < cutoff) break;
      const form = recent.form[i];
      // Banks file dozens of structured note prospectuses a day; they are not
      // news about the company, so they don't count as events.
      if (ROUTINE_FORMS.has(form)) continue;
      filings.push({
        form,
        filedAt: new Date(at).toISOString(),
        label: FORM_LABELS[form] ?? recent.primaryDocDescription?.[i]?.trim() ?? form,
      });
    }
  }
  filingsCache.set(cik, { at: Date.now(), filings });
  return filings;
}

/**
 * Real SEC filings accepted in the last 24 hours for the given tickers.
 * Unknown tickers are skipped. Throws only when SEC can't be reached at all.
 */
export async function recentFilings(input: string[]): Promise<RecentFiling[]> {
  const { byTicker } = await loadTickers();
  const entries = Array.from(new Set(input.map((t) => t.trim().toUpperCase())))
    .map((t) => byTicker.get(t))
    .filter((e): e is TickerEntry => Boolean(e))
    .slice(0, MAX_FILING_TICKERS);

  const since = Date.now() - 24 * 60 * 60 * 1000;
  const out: RecentFiling[] = [];
  let failures = 0;

  // Four at a time keeps well under SEC's 10 requests per second.
  for (let i = 0; i < entries.length; i += 4) {
    const batch = entries.slice(i, i + 4);
    const results = await Promise.allSettled(batch.map((e) => filingsForCik(e.cik)));
    results.forEach((result, j) => {
      if (result.status !== "fulfilled") {
        failures++;
        return;
      }
      for (const f of result.value) {
        if (Date.parse(f.filedAt) >= since) out.push({ ticker: batch[j].ticker, ...f });
      }
    });
  }

  if (entries.length > 0 && failures === entries.length) throw new Error("SEC unreachable");
  return out.sort((a, b) => b.filedAt.localeCompare(a.filedAt));
}
