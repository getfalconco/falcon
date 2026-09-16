import { normalizeCompanyName } from "./normalize.js";

const GENERIC_EXACT = new Set([
  "manufacturers",
  "suppliers",
  "customers",
  "partners",
  "competitors",
  "oems",
  "original equipment manufacturers",
  "distributors",
  "resellers",
  "carriers",
  "retailers",
]);

const GENERIC_PREFIX =
  /^(third party|various|certain|numerous|several|multiple|other|our|its)\b/;

/** Pre-audit guard: generic groups are not named counterparties. */
export function isGenericCounterparty(name: string): boolean {
  const norm = normalizeCompanyName(name);
  if (!norm) return false;
  if (GENERIC_EXACT.has(norm)) return true;
  return GENERIC_PREFIX.test(norm);
}
