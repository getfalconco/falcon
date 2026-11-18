import { FUNNEL_TEST_MODE } from "../funnel-test-mode";

/**
 * The member's position cap: the largest share of the account one holding
 * should take (Settings > Portfolio, 5% to 50%, default 10%). A display
 * preference kept per person in this browser, like Appearance; the Dashboard's
 * Portfolio Overview marks a weight above it in red (positions-view.ts
 * capText). Not data about the portfolio itself.
 */

export const CAP_MIN = 5;
export const CAP_MAX = 50;
export const CAP_DEFAULT = 10;
export const CAP_OPTIONS = [5, 10, 15, 20, 25, 30, 40, 50] as const;

const PREFIX = "falcon.position-cap.v1";
const memory = new Map<string, number>();
const listeners = new Set<() => void>();

/** Pure: a stored or typed cap as a whole percent within 5 to 50; the default when unreadable. */
export function cleanCap(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number.parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) return CAP_DEFAULT;
  return Math.min(CAP_MAX, Math.max(CAP_MIN, Math.round(n)));
}

export function subscribeCap(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The cap for a person (the part of a workspace scope before ":"). */
export function readCap(scope: string): number {
  const user = scope.split(":")[0]!;
  if (memory.has(user)) return memory.get(user)!;
  if (FUNNEL_TEST_MODE || typeof window === "undefined") return CAP_DEFAULT;
  try {
    const raw = localStorage.getItem(`${PREFIX}:${user}`);
    return raw === null ? CAP_DEFAULT : cleanCap(raw);
  } catch {
    return CAP_DEFAULT;
  }
}

export function writeCap(scope: string, cap: number): void {
  const user = scope.split(":")[0]!;
  const value = cleanCap(cap);
  memory.set(user, value);
  if (!FUNNEL_TEST_MODE && typeof window !== "undefined") {
    try {
      localStorage.setItem(`${PREFIX}:${user}`, String(value));
    } catch {
      // Blocked storage: this visit keeps it.
    }
  }
  for (const l of listeners) l();
}
