/**
 * Long ticker lists in what the person typed (design 3.1): found here, in
 * code, so the model never has to copy them. The model sees a short handle
 * ("[ticker list L1: 250 tickers ...]") and writes
 * {"kind": "list", "list": "L1"} as the universe; expandListUniverse() turns
 * that back into a static universe before any check runs.
 *
 * Copying a 250-ticker list cost about 2,500 output tokens per reply (15 to 35
 * s), and a repair round copied it again, which ran past the turn's deadline.
 *
 * Pure; safe in the browser.
 */

/** Lists shorter than this stay in the text as typed (the model copies a few tickers cheaply). */
export const LIST_MIN_TICKERS = 12;
/** The most tickers one strategy may name (matches SPEC_LIMITS.maxTickers). */
export const MAX_LIST_TICKERS = 500;

/**
 * A typed symbol as Yahoo spells it: upper case, no leading $, and class
 * shares with a dash (BRK.B, BRK/B -> BRK-B). Exchange suffixes (VOD.L,
 * SHOP.TO) keep their dot.
 */
export function normalizeTicker(raw: string): string {
  const t = raw.trim().replace(/^\$/, "").toUpperCase();
  const m = /^([A-Z]{1,5})[./]([A-C])$/.exec(t);
  return m ? `${m[1]}-${m[2]}` : t;
}

export type TickerList = {
  /** Handle the model uses, "L1", "L2", ... */
  id: string;
  /** Normalized, unique, in typed order. */
  tickers: string[];
  /** Where the run sits in the text (for replacing it with the handle). */
  start: number;
  end: number;
};

const TOKEN_RE = /^\$?[A-Za-z][A-Za-z0-9]{0,5}(?:[./-][A-Za-z]{1,2})?$/;
const caseOf = (t: string): "upper" | "lower" | null => {
  const s = t.replace(/^\$/, "");
  if (s === s.toUpperCase() && /[A-Z]/.test(s)) return "upper";
  if (s === s.toLowerCase()) return "lower";
  return null;
};

/**
 * Runs of at least `min` ticker-like tokens: separated by commas, semicolons,
 * pipes or line breaks, or (upper case only) by spaces. Words in prose are not
 * tickers: a run is either all upper case or all lower case as typed, so
 * "trailing stop" before an upper-case list is left out.
 */
export function findTickerLists(text: string, min = LIST_MIN_TICKERS, firstId = 1): TickerList[] {
  const tokens: { raw: string; start: number; end: number }[] = [];
  const re = /[^\s,;|]+/g;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // A trailing full stop or bracket ends a sentence, not the ticker.
    const raw = m[0].replace(/[.)\]:]+$/, "").replace(/^[([]+/, "");
    const lead = m[0].indexOf(raw);
    tokens.push({ raw, start: m.index + lead, end: m.index + lead + raw.length });
  }
  const out: TickerList[] = [];
  let run: typeof tokens = [];
  let runCase: "upper" | "lower" | null = null;
  const flush = () => {
    const tickers = Array.from(new Set(run.map((t) => normalizeTicker(t.raw))));
    if (tickers.length >= min) out.push({ id: `L${firstId + out.length}`, tickers, start: run[0]!.start, end: run[run.length - 1]!.end });
    run = [];
    runCase = null;
  };
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i]!;
    // "..., KO and PEP": the connector joins, it is not a ticker.
    if (run.length && /^(and|&)$/i.test(tok.raw)) continue;
    const c = TOKEN_RE.test(tok.raw) ? caseOf(tok.raw) : null;
    if (!c) {
      flush();
      continue;
    }
    if (run.length) {
      const prev = run[run.length - 1]!;
      const sep = text.slice(prev.end, tok.start).replace(/(^|\s)(and|&)(?=\s|$)/gi, ",");
      const listy = /[,;|\n]/.test(sep) && !/[^\s,;|.]/.test(sep);
      const joins = c === runCase && (listy || (c === "upper" && /^[ \t]+$/.test(sep)));
      if (!joins) flush();
    }
    if (!run.length) runCase = c;
    run.push(tok);
  }
  flush();
  return out;
}

/** The text with each list replaced by its handle, for the model. */
export function withHandles(text: string, lists: TickerList[]): string {
  let out = "";
  let at = 0;
  for (const l of [...lists].sort((a, b) => a.start - b.start)) {
    out += text.slice(at, l.start) + listHandle(l);
    at = l.end;
  }
  return out + text.slice(at);
}

export function listHandle(l: Pick<TickerList, "id" | "tickers">, what = "typed by the person"): string {
  return `[ticker list ${l.id}: ${l.tickers.length} tickers ${what}, starting ${l.tickers.slice(0, 5).join(", ")}]`;
}

/**
 * A universe that names a list ({"kind": "list", "list": "L1"}, or "lists":
 * [...], optionally with extra typed "tickers") as a static universe. Other
 * universes are returned unchanged; an unknown handle returns an error.
 */
export function expandListUniverse(universe: unknown, lists: Map<string, string[]>): { universe: unknown; error?: string } {
  if (!universe || typeof universe !== "object" || Array.isArray(universe)) return { universe };
  const u = universe as Record<string, unknown>;
  if (u.kind !== "list") return { universe };
  const ids = ([] as unknown[]).concat(u.list ?? [], u.lists ?? []).map((x) => String(x).trim().toUpperCase());
  if (!ids.length) return { universe, error: 'universe kind "list" needs "list": the handle of a ticker list, e.g. "L1".' };
  const tickers: string[] = [];
  for (const id of ids) {
    const l = lists.get(id);
    if (!l) return { universe, error: `There is no ticker list ${id}; the lists are ${Array.from(lists.keys()).join(", ") || "none"}.` };
    tickers.push(...l);
  }
  if (Array.isArray(u.tickers)) tickers.push(...u.tickers.filter((t): t is string => typeof t === "string").map(normalizeTicker));
  return { universe: { kind: "static", tickers: Array.from(new Set(tickers)) } };
}
