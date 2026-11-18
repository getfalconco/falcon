/**
 * `insiders(ticker, days?)`: recent Form 4 open-market purchases and sales at
 * one company, with routine and planned trades set aside, totals per
 * insider, and cluster flags.
 *
 * Rules (engine F7 insider detector, packages/engine/src/detectors/insider.ts):
 *   - open market only: codes P (purchase) and S (sale) of common stock;
 *     grants, option exercises, tax withholding and gifts are only counted;
 *   - 10b5-1 trades set aside (box ticked or a footnote naming a plan), and
 *     purchases from offerings, private placements, DRIPs or ESPPs, and
 *     purchases at $5 or less;
 *   - routine insiders set aside (Cohen, Malloy & Pomorski 2012): a Form 4
 *     in the same calendar month in each of the 3 prior years, read from the
 *     insider's own EDGAR filing list;
 *   - cluster: 3+ distinct insiders buying (or selling) within 5 business
 *     days; a single officer or director purchase of $100k+ is flagged too.
 * Reads the newest MAX_FILINGS Form 4s in the window (each one is a request
 * to SEC), so a busy company's window can be cut short; the result says so.
 */

import { archiveBase, companyForTicker, secText, submissions } from "./sec";
import {
  CLUSTER_MAX_BUSINESS_DAYS,
  CLUSTER_MIN_INSIDERS,
  SINGLE_MIN_USD,
  isRoutine,
  openMarketTrades,
  ownerRole,
  parseOwnershipDocument,
  type OwnershipDocument,
  type ReportingOwner,
  type Trade,
} from "./form4";
import { TtlCache, ToolError, addDays, displayName, nyParts, personName, round, weekdayIndex, type DeskToolContext } from "./util";

export const DEFAULT_DAYS = 180;
export const MAX_FILINGS = 40;
/** Of the tool's budget, the share spent reading filings before answering with what arrived. */
const READ_SHARE = 0.75;

const docCache = new TtlCache<OwnershipDocument | null>(7 * 24 * 3_600_000, 2_000);

export type Filing = { accession: string; filed: string; url: string; doc: OwnershipDocument };

export type InsiderTrade = Trade & { accession: string; filed: string; owner: ReportingOwner; ownerKey: string };

export type Routine = (ownerCik: string, ym: string) => Promise<boolean | null>;

/** The insider's own filing list says whether they trade every year in this month. */
export function submissionsRoutine(signal: AbortSignal): Routine {
  return async (ownerCik, ym) => {
    const sub = await submissions(ownerCik, signal);
    const r = sub.filings.recent;
    const dates = r.form.flatMap((f, i) => (f === "4" || f === "4/A" || f === "5" ? [r.filingDate[i]!] : []));
    const oldest = r.form.length >= 1000 ? ([...r.filingDate].sort()[0] ?? null) : null;
    return isRoutine(dates, ym, oldest);
  };
}

type Side = { trades: number; shares: number; valueUsd: number; avgPrice: number | null; firstDate: string; lastDate: string };

function side(trades: Trade[]): Side | null {
  if (!trades.length) return null;
  const shares = trades.reduce((t, x) => t + x.shares, 0);
  const value = trades.reduce((t, x) => t + x.value, 0);
  const dates = trades.map((x) => x.date).sort();
  return { trades: trades.length, shares: Math.round(shares), valueUsd: Math.round(value), avgPrice: shares ? round(value / shares, 2) : null, firstDate: dates[0]!, lastDate: dates.at(-1)! };
}

/** Windows of 5 business days in which 3+ distinct insiders traded one way, merged when they overlap. Pure. */
export function clusters(trades: InsiderTrade[], kind: "buy" | "sell", minInsiders = CLUSTER_MIN_INSIDERS, maxDays = CLUSTER_MAX_BUSINESS_DAYS) {
  const list = trades.filter((t) => t.kind === kind).sort((a, b) => (a.date < b.date ? -1 : 1));
  const out: { kind: "buy" | "sell"; from: string; to: string; insiders: string[]; valueUsd: number }[] = [];
  for (const end of list) {
    const e = weekdayIndex(end.date);
    const win = list.filter((t) => t.date <= end.date && e - weekdayIndex(t.date) < maxDays);
    const owners = new Set(win.map((t) => t.ownerKey));
    if (owners.size < minInsiders) continue;
    const from = win[0]!.date;
    const prev = out.at(-1);
    if (prev && from <= prev.to) {
      const merged = list.filter((t) => t.date >= prev.from && t.date <= end.date);
      prev.to = end.date;
      prev.insiders = Array.from(new Set(merged.map((t) => personName(t.owner.name))));
      prev.valueUsd = Math.round(merged.reduce((s, t) => s + t.value, 0));
    } else {
      out.push({ kind, from, to: end.date, insiders: Array.from(new Set(win.map((t) => personName(t.owner.name)))), valueUsd: Math.round(win.reduce((s, t) => s + t.value, 0)) });
    }
  }
  return out;
}

/**
 * The tool's answer from parsed Form 4s. `routine` says whether an insider's
 * trading in a month is routine (null: unknown, the trade is kept). Pure
 * apart from `routine`.
 */
export async function summarizeInsiders(issuerCik: string, filings: Filing[], routine: Routine | null) {
  const kept: InsiderTrade[] = [];
  const setAside = new Map<string, { trades: number; valueUsd: number; insiders: Set<string> }>();
  const otherCodes: Record<string, number> = {};
  const aside = (reason: string, t: InsiderTrade) => {
    const s = setAside.get(reason) ?? { trades: 0, valueUsd: 0, insiders: new Set<string>() };
    s.trades++;
    s.valueUsd += t.value;
    s.insiders.add(t.ownerKey);
    setAside.set(reason, s);
  };
  for (const f of filings) {
    if (f.doc.documentType !== "4" || f.doc.issuerCik !== issuerCik || !f.doc.owners.length) continue;
    const owner = f.doc.owners[0]!;
    const r = openMarketTrades(f.doc);
    for (const [code, n] of Object.entries(r.otherCodes)) otherCodes[code] = (otherCodes[code] ?? 0) + n;
    const wrap = (t: Trade): InsiderTrade => ({ ...t, accession: f.accession, filed: f.filed, owner, ownerKey: owner.cik });
    for (const s of r.setAside) aside(s.reason, wrap(s.trade));
    for (const t of r.trades) kept.push(wrap(t));
  }

  let routineUnknown = 0;
  if (routine) {
    const checks = new Map<string, Promise<boolean | null>>();
    for (const t of kept) {
      const key = `${t.ownerKey}|${t.date.slice(0, 7)}`;
      if (!checks.has(key)) checks.set(key, routine(t.ownerKey, t.date.slice(0, 7)).catch(() => null));
    }
    const verdict = new Map<string, boolean | null>();
    await Promise.all(Array.from(checks).map(async ([k, p]) => verdict.set(k, await p)));
    for (let i = kept.length - 1; i >= 0; i--) {
      const t = kept[i]!;
      const v = verdict.get(`${t.ownerKey}|${t.date.slice(0, 7)}`);
      if (v === true) {
        aside("routine insider (trades this month every year)", t);
        kept.splice(i, 1);
      } else if (v === null) routineUnknown++;
    }
  }

  const byOwner = new Map<string, InsiderTrade[]>();
  for (const t of kept) byOwner.set(t.ownerKey, [...(byOwner.get(t.ownerKey) ?? []), t]);
  const insiders = Array.from(byOwner.values())
    .map((ts) => {
      const latest = [...ts].sort((a, b) => (a.date < b.date ? 1 : -1))[0]!;
      const buys = side(ts.filter((t) => t.kind === "buy"));
      const sells = side(ts.filter((t) => t.kind === "sell"));
      return {
        name: personName(latest.owner.name),
        role: ownerRole(latest.owner),
        ...(buys ? { bought: buys } : {}),
        ...(sells ? { sold: sells } : {}),
        sharesOwnedAfterLastTrade: latest.sharesOwnedAfter,
        net: Math.round((buys?.valueUsd ?? 0) - (sells?.valueUsd ?? 0)),
      };
    })
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

  const singles = new Map<string, { insider: string; role: string; date: string; valueUsd: number }>();
  for (const t of kept) {
    if (t.kind !== "buy" || !(t.owner.isOfficer || t.owner.isDirector)) continue;
    const s = singles.get(t.accession) ?? { insider: personName(t.owner.name), role: ownerRole(t.owner), date: t.date, valueUsd: 0 };
    s.valueUsd += t.value;
    singles.set(t.accession, s);
  }

  const total = (kind: "buy" | "sell") => {
    const ts = kept.filter((t) => t.kind === kind);
    return { trades: ts.length, insiders: new Set(ts.map((t) => t.ownerKey)).size, valueUsd: Math.round(ts.reduce((s, t) => s + t.value, 0)) };
  };
  return {
    opportunistic: { purchases: total("buy"), sales: total("sell") },
    insiders: insiders.slice(0, 15),
    ...(insiders.length > 15 ? { moreInsiders: insiders.length - 15 } : {}),
    clusters: [...clusters(kept, "buy"), ...clusters(kept, "sell")],
    largeOfficerDirectorPurchases: Array.from(singles.values()).filter((s) => s.valueUsd >= SINGLE_MIN_USD).map((s) => ({ ...s, valueUsd: Math.round(s.valueUsd) })),
    setAside: Object.fromEntries(Array.from(setAside).map(([k, v]) => [k, { trades: v.trades, insiders: v.insiders.size, valueUsd: Math.round(v.valueUsd) }])),
    otherTransactionCodes: otherCodes,
    routineUnknown,
  };
}

async function readForm4(url: string, accession: string, signal: AbortSignal): Promise<OwnershipDocument | null> {
  const hit = docCache.get(accession);
  if (hit !== undefined) return hit;
  const doc = parseOwnershipDocument(await secText(url, signal, "application/xml,text/xml,text/plain,*/*"));
  docCache.set(accession, doc);
  return doc;
}

export async function insidersTool(symbol: string, input: { days?: number }, ctx: DeskToolContext, signal: AbortSignal, budgetMs: number) {
  const company = await companyForTicker(symbol, signal);
  if (!company) throw new ToolError(`${symbol} is not in SEC's list of registrants, so it has no Form 4 filings under that ticker.`);
  const days = Math.min(365, Math.max(7, Math.round(input.days ?? DEFAULT_DAYS)));
  const today = nyParts(ctx.now?.() ?? Date.now()).date;
  const since = addDays(today, -days);
  const sub = await submissions(company.cik, signal);
  const r = sub.filings.recent;
  const rows: { accession: string; filed: string; url: string }[] = [];
  let inWindow = 0;
  for (let i = 0; i < r.form.length; i++) {
    if (r.filingDate[i]! < since) break;
    if (r.form[i] !== "4") continue;
    inWindow++;
    if (rows.length >= MAX_FILINGS) continue;
    const acc = r.accessionNumber[i]!;
    const doc = (r.primaryDocument?.[i] ?? "").replace(/^xsl[^/]+\//, "");
    const base = archiveBase(company.cik, acc);
    rows.push({ accession: acc, filed: r.filingDate[i]!, url: /\.xml$/i.test(doc) ? `${base}/${doc}` : `${base}/${acc}.txt` });
  }
  const readSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1_000, budgetMs * READ_SHARE))]);
  const settled = await Promise.allSettled(rows.map(async (row) => ({ ...row, doc: await readForm4(row.url, row.accession, readSignal) })));
  if (signal.aborted) throw new ToolError("SEC did not answer in time.");
  const filings = settled.flatMap((s) => (s.status === "fulfilled" && s.value.doc ? [s.value as Filing] : []));
  const failed = settled.length - filings.length;
  const routineSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(800, budgetMs * (1 - READ_SHARE) - 300))]);
  const summary = await summarizeInsiders(company.cik, filings, submissionsRoutine(routineSignal));
  const notes = [
    "Values are shares x reported price in USD. 'Opportunistic' = open-market trades left after the set-asides (engine F7 rules; Cohen-Malloy-Pomorski routine filter).",
    "Clusters use trade dates and weekdays (NYSE holidays not skipped).",
  ];
  if (inWindow > rows.length) notes.push(`Read the newest ${rows.length} of ${inWindow} Form 4s in the window; earlier ones were not read. Ask for fewer days for a complete picture.`);
  if (failed) notes.push(`${failed} Form 4s could not be read in time and are missing.`);
  if (summary.routineUnknown) notes.push(`${summary.routineUnknown} trades kept without a routine check (the insider's filing history could not be read).`);
  if (inWindow === 0) notes.push(`No Form 4 filings since ${since}.`);
  const { routineUnknown, ...rest } = summary;
  void routineUnknown;
  return {
    ticker: symbol,
    company: displayName(company.name),
    window: { from: since, to: today, days },
    form4Read: filings.length,
    ...rest,
    notes,
    source: "SEC EDGAR Form 4 filings",
  };
}
