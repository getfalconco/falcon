import { MAX_STOCKS, TICKER_PATTERN, type PickedStock } from "./onboarding";

/**
 * Broker CSV parsing for the portfolio step, the same rules as the website's
 * apps/web/lib/portfolio.ts (read on the phone; the file never leaves it).
 */

/** Rows brokers put in the symbol column that are not holdings. */
const NOT_A_HOLDING = new Set(["CASH", "TOTAL", "TOTALS", "SUBTOTAL", "PENDING", "ACCOUNT", "MONEY", "SWEEP", "USD", "CORE"]);

type RawHolding = { ticker: string; name?: string | null; shares?: number | null; value?: number | null };

/** "brk-b" or "$BRK.B" to "BRK.B"; null when it isn't a ticker. */
export function cleanTicker(raw: string): string | null {
  // Brokers mark money market sweeps with "**" (Fidelity's SPAXX**).
  if (/\*\*\s*$/.test(raw)) return null;
  const ticker = raw.trim().toUpperCase().replace(/^\$/, "").replace(/\*+$/, "").replace(/-/g, ".").replace(/\s+/g, "");
  if (!TICKER_PATTERN.test(ticker) || NOT_A_HOLDING.has(ticker)) return null;
  return ticker;
}

function positive(n: number | null | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Valid tickers only, one row per ticker (shares and value added up), at most MAX_STOCKS. */
function normalizeHoldings(rows: RawHolding[]): PickedStock[] {
  const byTicker = new Map<string, PickedStock>();
  for (const row of rows) {
    const ticker = cleanTicker(row.ticker ?? "");
    if (!ticker || /money market|cash sweep/i.test(row.name ?? "")) continue;
    const shares = positive(row.shares);
    const value = positive(row.value);
    const seen = byTicker.get(ticker);
    if (seen) {
      if (shares !== undefined) seen.shares = (seen.shares ?? 0) + shares;
      if (value !== undefined) seen.value = (seen.value ?? 0) + value;
      continue;
    }
    if (byTicker.size >= MAX_STOCKS) break;
    byTicker.set(ticker, { ticker, name: (row.name ?? "").trim().slice(0, 120), shares, value });
  }
  return Array.from(byTicker.values());
}

const SYMBOL_HEADERS = ["symbol", "ticker", "ticker symbol", "security symbol", "instrument", "code", "stock"];
const SHARES_HEADERS = ["quantity", "shares", "qty", "units", "quantity held", "share count"];
const VALUE_HEADERS = ["market value", "current value", "marketvalue", "market val", "value", "total value", "position value", "mkt val"];
const NAME_HEADERS = ["description", "name", "security name", "company", "security description", "instrument name"];

function splitRow(line: string, delimiter: string): string[] {
  const cells: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      cells.push(cell);
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells.map((c) => c.trim());
}

function headerKey(cell: string): string {
  return cell.toLowerCase().replace(/[^a-z ]/g, " ").replace(/\s+/g, " ").trim();
}

function findColumn(headers: string[], names: string[]): number {
  for (const name of names) {
    const exact = headers.indexOf(name);
    if (exact !== -1) return exact;
  }
  for (const name of names) {
    const loose = headers.findIndex((h) => h.startsWith(`${name} `) || h.endsWith(` ${name}`));
    if (loose !== -1) return loose;
  }
  return -1;
}

/** "$1,234.50", "(12)", "1.234,50" (with ";" files) to a number. */
function parseNumber(raw: string | undefined, europeanDecimals: boolean): number | null {
  if (!raw) return null;
  let s = raw.replace(/[$€£\s]/g, "");
  const negative = /^\(.*\)$/.test(s) || s.startsWith("-");
  s = s.replace(/[()+-]/g, "");
  if (europeanDecimals || (/,\d{1,2}$/.test(s) && !s.includes("."))) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else {
    s = s.replace(/,/g, "");
  }
  const n = Number.parseFloat(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

export type CsvResult = { ok: true; holdings: PickedStock[] } | { ok: false; error: string };

/** Holdings from a broker's CSV export ("," ";" and tab all work). */
export function parseHoldingsCsv(text: string): CsvResult {
  const lines = text.replace(/^﻿/, "").split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length < 2) return { ok: false, error: "That file looks empty." };

  const sample = lines.slice(0, 15).join("\n");
  const delimiter = [",", ";", "\t"]
    .map((d) => ({ d, n: sample.split(d).length }))
    .sort((a, b) => b.n - a.n)[0].d;

  let headerAt = -1;
  let columns = { symbol: -1, shares: -1, value: -1, name: -1 };
  for (let i = 0; i < Math.min(lines.length, 15); i++) {
    const headers = splitRow(lines[i], delimiter).map(headerKey);
    const symbol = findColumn(headers, SYMBOL_HEADERS);
    if (symbol === -1) continue;
    headerAt = i;
    columns = {
      symbol,
      shares: findColumn(headers, SHARES_HEADERS),
      value: findColumn(headers, VALUE_HEADERS),
      name: findColumn(headers, NAME_HEADERS),
    };
    break;
  }
  if (headerAt === -1) {
    return { ok: false, error: "We couldn't find a Symbol or Ticker column in that file." };
  }

  const european = delimiter === ";";
  const rows: RawHolding[] = lines.slice(headerAt + 1).map((line) => {
    const cells = splitRow(line, delimiter);
    return {
      ticker: cells[columns.symbol] ?? "",
      name: columns.name === -1 ? null : cells[columns.name],
      shares: columns.shares === -1 ? null : parseNumber(cells[columns.shares], european),
      value: columns.value === -1 ? null : parseNumber(cells[columns.value], european),
    };
  });
  const holdings = normalizeHoldings(rows);
  if (holdings.length === 0) return { ok: false, error: "We couldn't find any stock holdings in that file." };
  return { ok: true, holdings };
}
