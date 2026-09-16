/**
 * §2 company metadata table: ticker → official name, aliases, sector,
 * market-cap bucket.
 *
 * Seeded from the Finnhub company profile when a ticker is added, refreshed
 * on the configured interval, persisted as one JSON file. Missing metadata
 * never blocks classification: `tickerContext()` falls back to the symbol and
 * flags `metadata_missing`.
 */

import fs from "node:fs";
import path from "node:path";
import { capBucketOf, type ClassifierConfig } from "./config.js";
import type { CompanyMetadata, TickerContext } from "./types.js";
import { finnhubApiBase } from "../finnhub.js";

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** Finnhub /stock/profile2 — the fields we read. */
export type FinnhubProfile = {
  name?: string;
  ticker?: string;
  finnhubIndustry?: string;
  /** Reported in millions of USD. */
  marketCapitalization?: number;
};

/** Cheap alias derivation: the name minus corporate suffixes, plus the name itself. */
export function deriveAliases(officialName: string): string[] {
  const out = new Set<string>();
  const name = officialName.trim();
  if (!name) return [];
  out.add(name);
  const stripped = name
    .replace(/[,.]?\s+(incorporated|inc|corporation|corp|company|co|plc|ltd|limited|holdings|holding|group|sa|nv|ag|se)\.?$/i, "")
    .replace(/[,.]?\s+(incorporated|inc|corporation|corp|company|co|plc|ltd|limited|holdings|holding|group|sa|nv|ag|se)\.?$/i, "")
    .trim();
  if (stripped && stripped !== name) out.add(stripped);
  return [...out];
}

/** Map a Finnhub profile onto a metadata row (pure). */
export function metadataFromProfile(
  ticker: string,
  profile: FinnhubProfile,
  refreshedAt: string,
  config: Pick<ClassifierConfig, "capBuckets">,
): CompanyMetadata | null {
  const name = profile.name?.trim();
  if (!name) return null;
  const capMillions = profile.marketCapitalization;
  const capUsd =
    typeof capMillions === "number" && Number.isFinite(capMillions) && capMillions > 0
      ? capMillions * 1e6
      : null;
  return {
    ticker: ticker.toUpperCase(),
    official_name: name,
    aliases: deriveAliases(name),
    sector: profile.finnhubIndustry?.trim() || null,
    market_cap_usd: capUsd,
    cap_bucket: capBucketOf(capUsd, config.capBuckets),
    refreshed_at: refreshedAt,
    source: "finnhub",
  };
}

/** §3 request payload per ticker — symbol, official name, sector, cap bucket. */
export function tickerContext(ticker: string, row: CompanyMetadata | null): TickerContext {
  const symbol = ticker.toUpperCase();
  if (!row) {
    return {
      ticker: symbol,
      official_name: null,
      sector: null,
      cap_bucket: null,
      metadata_missing: true,
    };
  }
  return {
    ticker: symbol,
    official_name: row.official_name,
    sector: row.sector,
    cap_bucket: row.cap_bucket,
    metadata_missing: false,
  };
}

export function isStale(row: CompanyMetadata, nowIso: string, refreshMs: number): boolean {
  const age = Date.parse(nowIso) - Date.parse(row.refreshed_at);
  return !Number.isFinite(age) || age >= refreshMs;
}

// ---------------------------------------------------------------------------
// Fetch (injectable)
// ---------------------------------------------------------------------------

export type ProfileFetcher = (ticker: string) => Promise<FinnhubProfile | null>;

const FETCH_TIMEOUT_MS = 10_000;

/** Real Finnhub profile2 fetch; throws on transport errors, null on empty. */
export const fetchFinnhubProfile: ProfileFetcher = async (ticker) => {
  const token = process.env.FINNHUB_API_KEY?.trim();
  if (!token) throw new Error("FINNHUB_API_KEY not configured");
  const url =
    `${finnhubApiBase()}/stock/profile2?symbol=${encodeURIComponent(ticker)}` +
    `&token=${encodeURIComponent(token)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Finnhub HTTP ${res.status}`);
    const data = (await res.json()) as FinnhubProfile;
    return data && typeof data === "object" && data.name ? data : null;
  } finally {
    clearTimeout(timer);
  }
};

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type MetadataFile = { schema_version: 1; rows: Record<string, CompanyMetadata> };

export class CompanyMetadataStore {
  private rows = new Map<string, CompanyMetadata>();
  private loaded = false;

  constructor(
    private readonly file: string,
    private readonly fetcher: ProfileFetcher = fetchFinnhubProfile,
  ) {}

  get filePath(): string {
    return this.file;
  }

  load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, "utf8")) as MetadataFile;
      if (parsed && parsed.rows && typeof parsed.rows === "object") {
        for (const [ticker, row] of Object.entries(parsed.rows)) {
          if (row && typeof row.official_name === "string") this.rows.set(ticker.toUpperCase(), row);
        }
      }
    } catch {
      // First run or corrupt file: start empty. Missing metadata never blocks (§2).
    }
  }

  private save(): void {
    const payload: MetadataFile = { schema_version: 1, rows: Object.fromEntries(this.rows) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 1), "utf8");
    fs.renameSync(tmp, this.file);
  }

  get(ticker: string): CompanyMetadata | null {
    this.load();
    return this.rows.get(ticker.toUpperCase()) ?? null;
  }

  list(): CompanyMetadata[] {
    this.load();
    return [...this.rows.values()].sort((a, b) => a.ticker.localeCompare(b.ticker));
  }

  context(ticker: string): TickerContext {
    return tickerContext(ticker, this.get(ticker));
  }

  /** Manual override (tests, or a ticker the profile source does not know). */
  upsert(row: CompanyMetadata): void {
    this.load();
    this.rows.set(row.ticker.toUpperCase(), row);
    this.save();
  }

  /**
   * Seed or refresh the given tickers. Rows younger than the refresh interval
   * are left alone unless `force`. Fetch failures are recorded and skipped —
   * the table is best-effort; classification proceeds without it.
   */
  async refresh(
    tickers: string[],
    options: { config: ClassifierConfig; now?: string; force?: boolean },
  ): Promise<{ refreshed: string[]; skipped: string[]; failed: Array<{ ticker: string; error: string }> }> {
    this.load();
    const now = options.now ?? new Date().toISOString();
    const refreshed: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ ticker: string; error: string }> = [];
    for (const raw of tickers) {
      const ticker = raw.toUpperCase();
      const existing = this.rows.get(ticker) ?? null;
      if (existing && !options.force && !isStale(existing, now, options.config.metadataRefreshMs)) {
        skipped.push(ticker);
        continue;
      }
      try {
        const profile = await this.fetcher(ticker);
        const row = profile ? metadataFromProfile(ticker, profile, now, options.config) : null;
        if (!row) {
          failed.push({ ticker, error: "no profile" });
          continue;
        }
        this.rows.set(ticker, row);
        refreshed.push(ticker);
      } catch (err) {
        failed.push({ ticker, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (refreshed.length) this.save();
    return { refreshed, skipped, failed };
  }
}
