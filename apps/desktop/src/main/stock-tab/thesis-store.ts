import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import {
  THESIS_MAX_PER_USER,
  readStoredThesis,
  thesisText,
  thesisTicker,
  type StockThesis,
  type StockThesisResult,
} from "../../shared/stock-thesis";

/**
 * The Stock tab's theses, one file per account: `<data root>/theses/<user
 * key>.json`, holding `{ schema_version, theses: { TICKER: { text,
 * updated_at } } }`. The user key is the account id from the session bridge;
 * with no one signed in there is nothing to read or write, so two accounts on
 * one machine never share a file and nothing lands in a pool no one owns.
 *
 * Every write is validated (shared/stock-thesis.ts) and written atomically;
 * a row that does not read back is dropped on its own, never the file.
 *
 * Electron-free: the root, the user key and the clock are injected.
 */

const SCHEMA_VERSION = 1;
const USER_KEY = /^[a-z0-9-]{1,64}$/;

type ThesisFile = { schema_version: number; theses: Record<string, unknown> };

export type ThesisStoreDeps = {
  root: string;
  /** The signed-in account's key, or "anon" / "local" / "" when no one is signed in. */
  userKey: () => string;
  now?: () => Date;
};

export function thesesDir(root: string): string {
  return path.join(root, "theses");
}

/** The account's file, or null for a key that is not a signed-in account. */
export function thesisFile(root: string, userKey: string): string | null {
  const key = userKey.trim().toLowerCase();
  if (!USER_KEY.test(key) || key === "anon" || key === "local") return null;
  return path.join(thesesDir(root), `${key}.json`);
}

function readFile(file: string): ThesisFile {
  const data = readJson<ThesisFile>(file);
  if (!data || data.schema_version !== SCHEMA_VERSION || !data.theses || typeof data.theses !== "object" || Array.isArray(data.theses)) {
    return { schema_version: SCHEMA_VERSION, theses: {} };
  }
  return data;
}

/** Every thesis the account keeps, each re-validated, by ticker. */
export function readTheses(root: string, userKey: string): StockThesis[] {
  const file = thesisFile(root, userKey);
  if (!file) return [];
  const data = readFile(file);
  const out: StockThesis[] = [];
  for (const [ticker, row] of Object.entries(data.theses)) {
    const thesis = readStoredThesis(ticker, row);
    if (thesis) out.push(thesis);
  }
  return out.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** Removes the account's file (account deletion). A file already gone is not an error. */
export function removeTheses(root: string, userKey: string): void {
  const file = thesisFile(root, userKey);
  if (!file) throw new Error("Not an account id");
  try {
    fs.unlinkSync(file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

export function createThesisStore(deps: ThesisStoreDeps) {
  const now = deps.now ?? (() => new Date());

  return {
    get(rawTicker: unknown): StockThesisResult {
      const ticker = thesisTicker(rawTicker);
      if (!ticker) return { ok: false, error: "invalid_ticker" };
      const file = thesisFile(deps.root, deps.userKey());
      if (!file) return { ok: false, error: "signed_out" };
      return { ok: true, thesis: readStoredThesis(ticker, readFile(file).theses[ticker]) };
    },

    set(rawTicker: unknown, rawText: unknown): StockThesisResult {
      const ticker = thesisTicker(rawTicker);
      if (!ticker) return { ok: false, error: "invalid_ticker" };
      const text = thesisText(rawText);
      if (text === null) return { ok: false, error: "too_long" };
      const file = thesisFile(deps.root, deps.userKey());
      if (!file) return { ok: false, error: "signed_out" };
      const data = readFile(file);
      // Rows that no longer read back go with this write.
      const kept: Record<string, StockThesis> = {};
      for (const [t, row] of Object.entries(data.theses)) {
        const thesis = readStoredThesis(t, row);
        if (thesis) kept[thesis.ticker] = thesis;
      }
      if (!text) {
        if (!(ticker in kept) && !(ticker in data.theses)) return { ok: true, thesis: null };
        delete kept[ticker];
        writeJsonAtomic(file, { schema_version: SCHEMA_VERSION, theses: strip(kept) });
        return { ok: true, thesis: null };
      }
      if (!(ticker in kept) && Object.keys(kept).length >= THESIS_MAX_PER_USER) return { ok: false, error: "full" };
      const thesis: StockThesis = { ticker, text, updated_at: now().toISOString() };
      kept[ticker] = thesis;
      writeJsonAtomic(file, { schema_version: SCHEMA_VERSION, theses: strip(kept) });
      return { ok: true, thesis };
    },
  };
}

/** The ticker is the row's key; the file does not repeat it. */
function strip(rows: Record<string, StockThesis>): Record<string, { text: string; updated_at: string }> {
  const out: Record<string, { text: string; updated_at: string }> = {};
  for (const [t, r] of Object.entries(rows)) out[t] = { text: r.text, updated_at: r.updated_at };
  return out;
}

export type ThesisStore = ReturnType<typeof createThesisStore>;
