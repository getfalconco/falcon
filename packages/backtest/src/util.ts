/**
 * Small deterministic helpers shared by both engines, FSL and the audit:
 * a stable hash (the spec hash is the seed of every random choice in a run)
 * and a seeded random generator. Pure; no Node APIs, so the browser can use it.
 */

/** cyrb53: a fast 53-bit string hash. Stable across platforms. */
export function hash53(text: string, seed = 0): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** JSON with object keys sorted, so equal values always serialize (and hash) the same. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>)
    .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`).join(",")}}`;
}

/** Hex hash of any JSON value (key order does not matter). */
export function hashOf(value: unknown): string {
  return hash53(canonicalJson(value)).toString(16).padStart(14, "0");
}

/** mulberry32: a seeded generator of floats in [0, 1). */
export function rng(seed: number): () => number {
  let a = (seed >>> 0) || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The seeded tie-break: orders candidates by a hash of (seed, date, ticker),
 * so the order never depends on how a list was typed and is the same on every
 * rerun of the same spec.
 */
export function seededOrder<T extends string>(items: readonly T[], seed: string, date: string): T[] {
  const key = new Map(items.map((t) => [t, hash53(`${seed}|${date}|${t}`)]));
  return [...items].sort((a, b) => key.get(a)! - key.get(b)! || (a < b ? -1 : a > b ? 1 : 0));
}

export const round = (x: number, digits = 4) => {
  const f = 10 ** digits;
  return Math.round(x * f) / f;
};
