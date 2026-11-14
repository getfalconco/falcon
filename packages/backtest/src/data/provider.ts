/**
 * The market data provider behind every v2 run (design 5.1).
 *
 *   MARKET_DATA_PROVIDER  "yahoo" (default today) | "vendor" (licensed, M2: not built yet)
 *   FALCON_STAGE          "dev" | "beta" | "production"; unset counts as beta
 *
 * Yahoo is a dev and invite-beta source only: its terms do not allow
 * commercial use, so with FALCON_STAGE=production no Yahoo call is reachable
 * and runs answer that licensed data is not connected yet. Results from Yahoo
 * carry "Beta data source, not reproducible".
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { JsonCache, defaultCacheDir } from "./cache";
import { FredRateSource, type RateSource } from "./fred";
import type { EarningsSource, PriceSource, RippleEventRaw } from "./types";
export type { RippleEventRaw } from "./types";
import { YahooEarningsSource, YahooPriceSource } from "./yahoo";

export interface RippleEventSource {
  readonly name: string;
  events(query: { tickers: string[]; from: string; to: string }, signal?: AbortSignal): Promise<RippleEventRaw[]>;
}

export type MarketDataProvider = {
  name: string;
  prices: PriceSource;
  earnings: EarningsSource | null;
  ripple: RippleEventSource | null;
  rates: RateSource | null;
  /** Shown on every result: "Beta data source, not reproducible". */
  beta: boolean;
};

const RIPPLE_FILES = [
  "packages/engine/data/ripple-hits-pit.ndjson",
  "packages/engine/data/ripple-hits-pit.ndjson.gz",
];

function findUp(rel: string, cwd: string): string | null {
  for (const dir of [cwd, path.join(cwd, ".."), path.join(cwd, "..", ".."), path.join(cwd, "..", "..", "..")]) {
    const p = path.join(dir, rel);
    if (fs.existsSync(p)) return p;
  }
  return null;
}

/**
 * Reads point-in-time Sighting hits from a local NDJSON file (one
 * RippleEventRaw per line, optionally gzipped): FALCON_RIPPLE_EVENTS_FILE, or
 * packages/engine/data/ripple-hits-pit.ndjson(.gz). Null when no file exists.
 */
export function fileRippleSource(cwd = process.cwd()): RippleEventSource | null {
  const fromEnv = process.env.FALCON_RIPPLE_EVENTS_FILE?.trim();
  const file = fromEnv && fs.existsSync(fromEnv) ? fromEnv : RIPPLE_FILES.map((f) => findUp(f, cwd)).find(Boolean) ?? null;
  if (!file) return null;
  let rows: RippleEventRaw[] | null = null;
  const load = () => {
    if (rows) return rows;
    const buf = fs.readFileSync(file);
    const text = file.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf8") : buf.toString("utf8");
    rows = text
      .split("\n")
      .filter((l) => l.trim())
      .flatMap((l) => {
        try {
          const r = JSON.parse(l) as RippleEventRaw;
          return typeof r.ticker === "string" && typeof r.known_at === "string" ? [r] : [];
        } catch {
          return [];
        }
      });
    return rows;
  };
  return {
    name: `Falcon Sightings history (${path.basename(file)})`,
    async events({ tickers, from, to }) {
      const set = new Set(tickers);
      return load().filter((r) => set.has(r.ticker) && r.known_at.slice(0, 10) >= from && r.known_at.slice(0, 10) <= to);
    },
  };
}

let memo: { key: string; provider: MarketDataProvider } | null = null;

export type ProviderResult = { ok: true; provider: MarketDataProvider } | { ok: false; error: string };

export function providerFromEnv(env: Record<string, string | undefined> = process.env, cacheDir = defaultCacheDir()): ProviderResult {
  const which = (env.MARKET_DATA_PROVIDER ?? "yahoo").trim().toLowerCase();
  const stage = (env.FALCON_STAGE ?? "beta").trim().toLowerCase();
  if (which === "vendor") return { ok: false, error: "The licensed market data source is not connected yet." };
  if (which !== "yahoo") return { ok: false, error: `Unknown MARKET_DATA_PROVIDER "${which}".` };
  if (stage === "production") {
    return { ok: false, error: "Backtests are in invite beta: the licensed market data source is not connected yet." };
  }
  const key = `${which}|${cacheDir}`;
  if (memo?.key === key) return { ok: true, provider: memo.provider };
  const cache = new JsonCache(cacheDir);
  const provider: MarketDataProvider = {
    name: "Yahoo Finance (beta data source)",
    prices: new YahooPriceSource(cache),
    earnings: new YahooEarningsSource(cache),
    ripple: fileRippleSource(),
    rates: new FredRateSource(cache),
    beta: true,
  };
  memo = { key, provider };
  return { ok: true, provider };
}
