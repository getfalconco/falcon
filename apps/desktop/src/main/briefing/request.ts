/**
 * Handover briefing: what the renderer may ask for.
 *
 * Both requests arrive over IPC from an account a person types into, and the
 * symbols in them end up in provider URLs and in a cache file's keys. Anything
 * that is not exactly the expected shape is refused here, before a port, a
 * file name or a model sees it. A refusal is `null`; the handler turns it into
 * the fixed "invalid_request" code.
 */

import type { BriefingHolding, BriefingNarrativeRequest, BriefingRequest } from "../../shared/briefing-types";

/** More positions than any book this app serves; past it the request is a bug or an attack, not a portfolio. */
export const MAX_HOLDINGS = 200;

/** The same shape the engine's assembly accepts, so a symbol that passes here is never dropped there. */
const SYMBOL_SHAPE = /^[A-Z0-9.\-^=]{1,12}$/;

const YMD_SHAPE = /^\d{4}-\d{2}-\d{2}$/;

/** A facts hash is FNV-1a in base 36, or the literal "none" when the template itself failed. */
const FACTS_HASH_SHAPE = /^[a-z0-9]{1,16}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

export function parseBriefingRequest(raw: unknown): BriefingRequest | null {
  if (!isRecord(raw)) return null;
  if (!Array.isArray(raw.holdings) || raw.holdings.length > MAX_HOLDINGS) return null;
  if (!finite(raw.cash)) return null;

  const holdings: BriefingHolding[] = [];
  for (const row of raw.holdings) {
    if (!isRecord(row) || typeof row.symbol !== "string") return null;
    const symbol = row.symbol.trim().toUpperCase();
    if (!SYMBOL_SHAPE.test(symbol) || !finite(row.shares) || !finite(row.cost_usd)) return null;
    holdings.push({ symbol, shares: row.shares, cost_usd: row.cost_usd });
  }

  // Flags are read strictly: a truthy string is not a request to skip the
  // cache, and a demo flag that is merely present must not switch persistence off.
  return { holdings, cash: raw.cash, demo: raw.demo === true, force: raw.force === true };
}

export function parseNarrativeRequest(raw: unknown): BriefingNarrativeRequest | null {
  if (!isRecord(raw)) return null;
  const { target_session_ymd: target, facts_hash: hash } = raw;
  if (typeof target !== "string" || !YMD_SHAPE.test(target)) return null;
  if (typeof hash !== "string" || !FACTS_HASH_SHAPE.test(hash)) return null;
  return { target_session_ymd: target, facts_hash: hash };
}
