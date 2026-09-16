import fs from "node:fs";
import path from "node:path";
import { resolveDataRoot } from "../data-root";

/**
 * The plumbing both Insight write-ups share: a stable key, a JSON file on
 * disk, and the Supabase rows every install reads from. The row shape stays
 * with each service — only the parts that would otherwise be copied twice
 * live here.
 */

/** FNV-1a. Short, stable, and enough to tell two headlines apart. */
export function hash(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * A model sometimes escapes a character twice on the way into JSON, so an
 * em dash arrives as a literal backslash, a "u" and four hex digits, and
 * `JSON.parse` hands all six straight through to the page. Decode whatever
 * survived.
 */
export function decodeEscapes(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    )
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"');
}

export function supabaseConfig(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL ?? process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}

export function authHeaders(serviceKey: string): Record<string, string> {
  return {
    "User-Agent": "MeridianDesktop/1.0",
    "Content-Type": "application/json",
    apikey: serviceKey,
    Authorization: `Bearer ${serviceKey}`,
  };
}

/** One row by key, or null for anything that isn't a clean hit. */
export async function readCloudRow<T>(table: string, key: string): Promise<T | null> {
  const config = supabaseConfig();
  if (!config) return null;
  try {
    const res = await fetch(
      `${config.url}/rest/v1/${table}?cache_key=eq.${encodeURIComponent(key)}&select=*&limit=1`,
      { headers: authHeaders(config.serviceKey) },
    );
    if (!res.ok) return null;
    const rows = (await res.json()) as T[];
    return rows?.[0] ?? null;
  } catch {
    return null;
  }
}

/** Upsert; failures are logged and swallowed — the local copy already stands. */
export async function writeCloudRow(
  table: string,
  row: Record<string, unknown>,
): Promise<void> {
  const config = supabaseConfig();
  if (!config) return;
  try {
    const res = await fetch(`${config.url}/rest/v1/${table}`, {
      method: "POST",
      headers: { ...authHeaders(config.serviceKey), Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(row),
    });
    if (!res.ok) {
      console.warn(
        `[insight] ${table} upsert failed:`,
        res.status,
        (await res.text().catch(() => "")).slice(0, 200),
      );
    }
  } catch (error) {
    console.warn(`[insight] ${table} upsert failed:`, error);
  }
}

/** A JSON file under the runtime data dir, read once and kept in memory. */
export function createFileStore<T>(fileName: string) {
  let store: Record<string, T> | null = null;
  const file = () => path.join(resolveDataRoot(), "insight", fileName);

  const read = (): Record<string, T> => {
    if (store) return store;
    try {
      const parsed = JSON.parse(fs.readFileSync(file(), "utf8")) as unknown;
      store = parsed && typeof parsed === "object" ? (parsed as Record<string, T>) : {};
    } catch {
      store = {};
    }
    return store;
  };

  return {
    get(key: string): T | undefined {
      return read()[key];
    },
    put(key: string, value: T): void {
      const current = read();
      current[key] = value;
      try {
        const target = file();
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(current, null, 2));
      } catch (error) {
        console.warn(`[insight] could not write ${fileName}:`, error);
      }
    },
  };
}
