/**
 * F7 `insider_cluster`: opportunistic open-market purchases by insiders,
 * from Form 4 filings of every US-listed issuer (design 3.2, filter rules
 * for F7; Cohen, Malloy and Pomorski 2012).
 *
 * S0 route, all in code, no LLM:
 *   1. Form 4 accessions filed on the window's days (daily index, Atom for
 *      today), kept only when one of the CIKs it is listed under is a
 *      US-listed company (the issuer), then each submission text is read
 *      once (header: acceptance instant; body: ownershipDocument XML).
 *   2. Purchases: non-derivative rows with transaction code P, acquired,
 *      a price above $5 (liquidity floor), common-type securities, and
 *      none of: the filing's 10b5-1 box ticked (`aff10b5One`), a footnote
 *      naming a 10b5-1 plan, or a footnote saying the shares came from an
 *      offering, a private placement, a DRIP or an ESPP (not open market).
 *   3. Routine insiders (a Form 4 in the same calendar month in each of the
 *      prior 3 years) are dropped through a `RoutineLookup`; the default
 *      reads each candidate owner's EDGAR submissions list.
 *   4. A cluster: 3 or more distinct insiders (joint filers count once)
 *      buying at one issuer within 5 business days (by transaction date).
 *      The event is anchored on the filing that brought the third insider
 *      and fires when that filing's acceptance is in [since, until). Earlier
 *      purchases of the same issuer come from its own filing list (5
 *      business days before `since`).
 *      Or a single officer or director buying $100k or more in one filing
 *      at a company whose market value is under $2B (skipped when unknown).
 * magnitude = purchase dollars / market value, in percent (null when the
 * market value is unknown).
 */

import { yahooCoverage } from "../yahoo.ts";
import { addDays, filingsInWindow, indexPageUrl, nyDate, parseSecHeader, submissionText, type FoundFiling } from "../feed/edgar.ts";
import { parseOwnershipDocument, ownerRole, type OwnershipDocument, type ReportingOwner } from "../feed/form4.ts";
import { filerMeta, isListed, loadListings, sharesOutstanding, type Listings } from "../feed/companies.ts";
import type { Detector, DetectorContext, DetectorEvent } from "./types.ts";
import { businessDayIndex, day, displayName, eachLimit, edgarSource, inWindow, personName, shares as fmtShares, usd } from "./util.ts";

export const MIN_PRICE_USD = 5;
export const CLUSTER_MIN_INSIDERS = 3;
export const CLUSTER_MAX_BUSINESS_DAYS = 5;
export const SINGLE_MIN_USD = 100_000;
export const SINGLE_MAX_MARKET_VALUE_USD = 2e9;

export type Purchase = {
  accession: string;
  acceptedAt: string;
  issuerCik: string;
  issuerName: string;
  ticker: string | null;
  /** Owners on the filing (a joint filing lists several for one purchase). */
  owners: ReportingOwner[];
  date: string;
  securityTitle: string;
  shares: number;
  price: number;
  value: number;
  raw: { shares: string; price: string };
  indexUrl: string;
};

export type Dropped = { reason: string; accession: string };

const NOT_COMMON = /\b(preferred|pref\.?|notes?|debentures?|bonds?|warrants?|rights?|units?|options?)\b/i;
const NOT_OPEN_MARKET =
  /\b(underwritten|public offering|registered direct|private placement|securities purchase agreement|subscription agreement|dividend reinvestment|reinvestment of dividends|employee stock purchase plan|ESPP|DRIP|rights offering|initial public offering|IPO|directed share program|concurrent private)\b/i;
const PLAN_10B51 = /10b5-?1/i;

/**
 * The qualifying purchases of one Form 4, and why the others were left out.
 * Pure.
 */
export function purchasesOf(doc: OwnershipDocument, accession: string, acceptedAt: string, indexUrl: string, ticker: string | null): { purchases: Purchase[]; dropped: Dropped[] } {
  const purchases: Purchase[] = [];
  const dropped: Dropped[] = [];
  const buys = doc.transactions.filter((t) => t.code === "P");
  if (buys.length === 0) return { purchases, dropped };
  if (doc.aff10b5One === true) return { purchases, dropped: [{ reason: "10b5-1 flag", accession }] };
  for (const t of buys) {
    const notes = t.footnoteIds.map((id) => doc.footnotes[id] ?? "").join(" ");
    let reason: string | null = null;
    if (t.acquiredDisposed && t.acquiredDisposed !== "A") reason = "not an acquisition";
    else if (!t.shares || t.shares <= 0 || !t.pricePerShare || t.pricePerShare <= 0) reason = "no shares or price";
    else if (NOT_COMMON.test(t.securityTitle)) reason = "not common stock";
    else if (PLAN_10B51.test(notes)) reason = "10b5-1 plan footnote";
    else if (NOT_OPEN_MARKET.test(`${notes} ${doc.remarks}`)) reason = "offering or plan purchase, not open market";
    else if (t.pricePerShare <= MIN_PRICE_USD) reason = "price at or below $5";
    if (reason) {
      dropped.push({ reason, accession });
      continue;
    }
    purchases.push({
      accession,
      acceptedAt,
      issuerCik: doc.issuerCik,
      issuerName: doc.issuerName,
      ticker,
      owners: doc.owners,
      date: t.date,
      securityTitle: t.securityTitle,
      shares: t.shares!,
      price: t.pricePerShare!,
      value: t.shares! * t.pricePerShare!,
      raw: t.raw,
      indexUrl,
    });
  }
  return { purchases, dropped };
}

/**
 * Insider identity across filings: owners that ever file together are one
 * insider (a fund and its general partner). Returns owner CIK -> group key.
 * Pure.
 */
export function insiderGroups(purchases: Purchase[]): Map<string, string> {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r)!;
    parent.set(x, r);
    return r;
  };
  for (const p of purchases) {
    for (const o of p.owners) if (!parent.has(o.cik)) parent.set(o.cik, o.cik);
    const [first, ...rest] = p.owners.map((o) => o.cik);
    if (!first) continue;
    for (const c of rest) {
      const a = find(first);
      const b = find(c);
      if (a !== b) parent.set(b < a ? a : b, b < a ? b : a);
    }
  }
  const out = new Map<string, string>();
  for (const k of parent.keys()) out.set(k, find(k));
  return out;
}

function groupOf(p: Purchase, groups: Map<string, string>): string {
  return groups.get(p.owners[0]?.cik ?? "") ?? p.owners[0]?.cik ?? p.accession;
}

export type Candidate = {
  kind: "cluster" | "single";
  issuerCik: string;
  /** The filing that completed the cluster, or the single filing. */
  anchor: { accession: string; acceptedAt: string; indexUrl: string };
  purchases: Purchase[];
  insiders: number;
};

/**
 * Clusters at one issuer: walking its filings in acceptance order, the first
 * filing after which 3+ distinct insiders bought within 5 business days
 * anchors a cluster; later purchases inside the same 5-day span join it.
 * Pure.
 */
export function findClusters(purchases: Purchase[], minInsiders = CLUSTER_MIN_INSIDERS, maxDays = CLUSTER_MAX_BUSINESS_DAYS): Candidate[] {
  const groups = insiderGroups(purchases);
  const byAcc = new Map<string, Purchase[]>();
  for (const p of purchases) byAcc.set(p.accession, [...(byAcc.get(p.accession) ?? []), p]);
  const filings = [...byAcc.values()].sort((a, b) => a[0]!.acceptedAt.localeCompare(b[0]!.acceptedAt) || a[0]!.accession.localeCompare(b[0]!.accession));
  const out: Candidate[] = [];
  let open: { cand: Candidate; startIdx: number } | null = null;
  const seen: Purchase[] = [];
  for (const f of filings) {
    seen.push(...f);
    const lastDay = Math.max(...f.map((p) => businessDayIndex(p.date)));
    if (open && f.every((p) => businessDayIndex(p.date) - open!.startIdx < maxDays && businessDayIndex(p.date) >= open!.startIdx)) {
      open.cand.purchases.push(...f);
      open.cand.insiders = new Set(open.cand.purchases.map((p) => groupOf(p, groups))).size;
      continue;
    }
    // Purchases (seen so far) within the 5 business days ending at this filing's latest trade.
    const inSpan = seen.filter((p) => {
      const d = businessDayIndex(p.date);
      return d <= lastDay && lastDay - d < maxDays;
    });
    const insiders = new Set(inSpan.map((p) => groupOf(p, groups)));
    const containsThis = f.some((p) => inSpan.includes(p));
    if (insiders.size >= minInsiders && containsThis) {
      const cand: Candidate = {
        kind: "cluster",
        issuerCik: f[0]!.issuerCik,
        anchor: { accession: f[0]!.accession, acceptedAt: f[0]!.acceptedAt, indexUrl: f[0]!.indexUrl },
        purchases: [...inSpan],
        insiders: insiders.size,
      };
      out.push(cand);
      open = { cand, startIdx: Math.min(...inSpan.map((p) => businessDayIndex(p.date))) };
    }
  }
  return out;
}

/** Single large purchases by an officer or director (one filing, $100k or more). Pure. */
export function findSingles(purchases: Purchase[], minUsd = SINGLE_MIN_USD): Candidate[] {
  const byAcc = new Map<string, Purchase[]>();
  for (const p of purchases) byAcc.set(p.accession, [...(byAcc.get(p.accession) ?? []), p]);
  const out: Candidate[] = [];
  for (const ps of byAcc.values()) {
    const officerOrDirector = ps[0]!.owners.some((o) => o.isOfficer || o.isDirector);
    const total = ps.reduce((s, p) => s + p.value, 0);
    if (!officerOrDirector || total < minUsd) continue;
    out.push({ kind: "single", issuerCik: ps[0]!.issuerCik, anchor: { accession: ps[0]!.accession, acceptedAt: ps[0]!.acceptedAt, indexUrl: ps[0]!.indexUrl }, purchases: ps, insiders: 1 });
  }
  return out;
}

/**
 * Whether an insider is a routine trader in a month: true / false, or null
 * when it cannot be told (then the insider is kept). The default reads the
 * owner's EDGAR submissions; a backfill of the SEC Insider Transactions Data
 * Sets can supply a faster, issuer-specific one.
 */
export type RoutineLookup = (ownerCik: string, issuerCik: string, ym: string) => Promise<boolean | null>;

/**
 * Routine by CMP 2012: the insider traded in the same calendar month in each
 * of the 3 prior years. Read here from Form 4 filing dates (any issuer) in
 * the owner's submissions list. Pure.
 */
export function isRoutine(form4Dates: string[], ym: string, oldestCovered: string | null): boolean | null {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const months = new Set(form4Dates.map((d) => d.slice(0, 7)));
  const priorYears = [1, 2, 3].map((k) => `${y - k}-${String(m).padStart(2, "0")}`);
  if (priorYears.every((p) => months.has(p))) return true;
  // The list may be cut short (EDGAR's recent list holds the last 1,000 filings).
  if (oldestCovered && oldestCovered > `${priorYears[2]}-01`) {
    const missing = priorYears.filter((p) => !months.has(p));
    if (missing.every((p) => p < oldestCovered.slice(0, 7))) return null;
  }
  return false;
}

export const submissionsRoutineLookup: RoutineLookup = async (ownerCik, _issuerCik, ym) => {
  const meta = await filerMeta(ownerCik);
  if (!meta) return null;
  const dates = meta.recent.filter((r) => r.form === "4" || r.form === "4/A" || r.form === "5").map((r) => r.filingDate);
  const oldest = meta.recent.length >= 1000 ? (meta.recent.map((r) => r.filingDate).sort()[0] ?? null) : null;
  return isRoutine(dates, ym, oldest);
};

export type MarketValueLookup = (ticker: string | null, cik: string, lastPrice: number) => Promise<{ usd: number; source: string } | null>;

/** Yahoo market cap, else SEC cover-page shares outstanding x the filed purchase price. */
export const defaultMarketValue: MarketValueLookup = async (ticker, cik, lastPrice) => {
  if (ticker) {
    const cov = await yahooCoverage(ticker);
    if (cov?.marketCapUsd) return { usd: cov.marketCapUsd, source: "Yahoo market cap" };
  }
  const so = await sharesOutstanding(cik).catch(() => null);
  if (so) return { usd: so.shares * lastPrice, source: `shares outstanding (${so.asOf}) x filed price` };
  return null;
};

export type InsiderOptions = {
  routine?: RoutineLookup | null;
  marketValue?: MarketValueLookup;
  /** Parallel reads queued at once (secGet spaces them at 4/s anyway). */
  batch?: number;
};

type ParsedFiling = { found: FoundFiling; acceptedAt: string | null; doc: OwnershipDocument | null };

async function readForm4(f: FoundFiling): Promise<ParsedFiling> {
  const txt = await submissionText(f);
  const header = parseSecHeader(txt);
  return { found: f, acceptedAt: header.acceptedAt ?? f.acceptedAt, doc: parseOwnershipDocument(txt) };
}

/** `fn` over `items` with `size` running at once (a sliding window, so one slow read does not hold a batch). */
async function inBatches<T, R>(items: T[], size: number, fn: (x: T) => Promise<R>, onError: (x: T, e: Error) => void): Promise<R[]> {
  const out: R[] = [];
  await eachLimit(items, size, async (x) => {
    try {
      out.push(await fn(x));
    } catch (err) {
      onError(x, err as Error);
    }
  });
  return out;
}

export function insiderClusterDetector(opts: InsiderOptions = {}): Detector {
  const routine = opts.routine === undefined ? submissionsRoutineLookup : opts.routine;
  const marketValue = opts.marketValue ?? defaultMarketValue;
  const batch = opts.batch ?? 16;
  return {
    eventTypes: ["insider_cluster"],
    async detect(ctx: DetectorContext): Promise<DetectorEvent[]> {
      const t0 = Date.now();
      const listings = await loadListings();
      const { filings, stats } = await filingsInWindow(["4"], ctx.since, ctx.until, ctx.log);
      const listed = filings.filter((f) => f.ciks.some((c) => isListed(listings.byCik.get(c))));
      ctx.log(`insider: ${stats.accessions} Form 4 accessions (${stats.rows} index rows, ${stats.daysFromIndex} index days, ${stats.daysFromAtom} feed days, holidays ${stats.missingDays.join(",") || "none"}); ${listed.length} at listed issuers`);
      let failed = 0;
      const parsed = await inBatches(listed, batch, readForm4, (f, e) => {
        failed++;
        if (failed <= 5) ctx.log(`insider: ${f.accession} unreadable (${e.message.split("\n")[0]})`);
      });
      const all: Purchase[] = [];
      const dropCounts = new Map<string, number>();
      const addFiling = (p: ParsedFiling) => {
        if (!p.doc || !p.acceptedAt || p.doc.documentType !== "4") return;
        const listing = listings.byCik.get(p.doc.issuerCik);
        if (!isListed(listing)) return;
        const r = purchasesOf(p.doc, p.found.accession, p.acceptedAt, indexPageUrl(p.doc.issuerCik, p.found.accession), listing!.ticker);
        for (const d of r.dropped) dropCounts.set(d.reason, (dropCounts.get(d.reason) ?? 0) + 1);
        all.push(...r.purchases);
      };
      for (const p of parsed) if (p.acceptedAt && Date.parse(p.acceptedAt) < ctx.until.getTime()) addFiling(p);
      const inWin = all.filter((p) => inWindow(p.acceptedAt, ctx.since, ctx.until));
      const issuers = [...new Set(inWin.map((p) => p.issuerCik))];
      const seenAcc = new Set(parsed.map((p) => p.found.accession));

      // Lookback: earlier Form 4s of issuers with fewer than 3 insiders buying in the window.
      const lookbackFrom = addDays(nyDate(ctx.since.getTime()), -9);
      const sinceDay = nyDate(ctx.since.getTime());
      const needLookback = issuers.filter((cik) => new Set(all.filter((p) => p.issuerCik === cik).map((p) => p.owners[0]?.cik)).size < CLUSTER_MIN_INSIDERS);
      const metas = await inBatches(needLookback, batch, async (cik) => ({ cik, meta: await filerMeta(cik) }), () => failed++);
      const earlier: FoundFiling[] = [];
      for (const { cik, meta } of metas) {
        for (const r of meta?.recent ?? []) {
          if (r.form !== "4" || r.filingDate < lookbackFrom || r.filingDate > sinceDay || seenAcc.has(r.accession)) continue;
          seenAcc.add(r.accession);
          earlier.push({ form: "4", accession: r.accession, cik, ciks: [cik], companyName: meta!.name, dateFiled: r.filingDate, acceptedAt: null, items: null, txtUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${r.accession}.txt` });
        }
      }
      const more = await inBatches(earlier, batch, readForm4, () => failed++);
      for (const p of more) if (p.acceptedAt && Date.parse(p.acceptedAt) < ctx.since.getTime()) addFiling(p);
      const lookbackReads = more.length;

      // Routine insiders out.
      let routineDropped = 0;
      let routineUnknown = 0;
      if (routine) {
        const verdict = new Map<string, boolean | null>();
        const candidatesNow = issuers.flatMap((cik) => {
          const ps = all.filter((p) => p.issuerCik === cik);
          return [...findClusters(ps), ...findSingles(ps.filter((p) => inWindow(p.acceptedAt, ctx.since, ctx.until)))];
        });
        const toCheck = new Map<string, Purchase>();
        for (const c of candidatesNow) for (const p of c.purchases) toCheck.set(`${p.owners[0]?.cik}|${p.issuerCik}|${p.date.slice(0, 7)}`, p);
        await inBatches(
          [...toCheck],
          batch,
          async ([key, p]) => verdict.set(key, await routine(p.owners[0]!.cik, p.issuerCik, p.date.slice(0, 7)).catch(() => null)),
          () => undefined,
        );
        for (let i = all.length - 1; i >= 0; i--) {
          const p = all[i]!;
          const v = verdict.get(`${p.owners[0]?.cik}|${p.issuerCik}|${p.date.slice(0, 7)}`);
          if (v === true) {
            all.splice(i, 1);
            routineDropped++;
          } else if (v === null) routineUnknown++;
        }
      }

      const events: DetectorEvent[] = [];
      for (const cik of issuers) {
        const ps = all.filter((p) => p.issuerCik === cik);
        const clusters = findClusters(ps).filter((c) => inWindow(c.anchor.acceptedAt, ctx.since, ctx.until));
        const inCluster = new Set(clusters.flatMap((c) => c.purchases.map((p) => p.accession)));
        const singles = findSingles(ps.filter((p) => inWindow(p.acceptedAt, ctx.since, ctx.until) && !inCluster.has(p.accession)));
        if (clusters.length === 0 && singles.length === 0) continue;
        const last = ps[ps.length - 1]!;
        const mv = await marketValue(last.ticker, cik, last.price).catch(() => null);
        for (const c of clusters) events.push(toEvent(c, mv, listings));
        for (const s of singles) {
          if (!mv || mv.usd >= SINGLE_MAX_MARKET_VALUE_USD) continue;
          events.push(toEvent(s, mv, listings));
        }
      }
      ctx.log(
        `insider: ${parsed.length} read (${failed} failed), ${lookbackReads} lookback reads, ${all.length + routineDropped} purchases kept before routine check, ` +
          `dropped ${[...dropCounts].map(([k, v]) => `${k} ${v}`).join(", ") || "none"}, routine ${routineDropped} (unknown ${routineUnknown}); ` +
          `${events.length} events in ${((Date.now() - t0) / 1000).toFixed(1)}s`,
      );
      return events.sort((a, b) => a.acceptedAt.localeCompare(b.acceptedAt));
    },
  };
}

/** The event for a cluster or a single purchase. Pure apart from formatting. */
export function toEvent(c: Candidate, mv: { usd: number; source: string } | null, listings: Pick<Listings, "byCik">): DetectorEvent {
  const ps = [...c.purchases].sort((a, b) => a.date.localeCompare(b.date) || a.acceptedAt.localeCompare(b.acceptedAt));
  const first = ps[0]!;
  const listing = listings.byCik.get(c.issuerCik);
  const company = displayName(listing?.name ?? first.issuerName);
  const ticker = listing?.ticker ?? first.ticker;
  const total = ps.reduce((s, p) => s + p.value, 0);
  const totalShares = ps.reduce((s, p) => s + p.shares, 0);
  const d1 = ps[0]!.date;
  const d2 = ps[ps.length - 1]!.date;
  // Per insider: name, role, shares, dollars.
  const groups = insiderGroups(ps);
  const byInsider = new Map<string, { owner: ReportingOwner; shares: number; value: number }>();
  for (const p of ps) {
    const key = groups.get(p.owners[0]!.cik) ?? p.owners[0]!.cik;
    const known = byInsider.get(key) ?? { owner: p.owners[0]!, shares: 0, value: 0 };
    known.shares += p.shares;
    known.value += p.value;
    byInsider.set(key, known);
  }
  const insiders = [...byInsider.values()].sort((a, b) => b.value - a.value);
  const who = (i: { owner: ReportingOwner }) => `${personName(i.owner.name)} (${ownerRole(i.owner)})`;
  const span = d1 === d2 ? `on ${day(d1)}` : `between ${day(d1)} and ${day(d2)}`;
  const title =
    c.kind === "cluster"
      ? `${insiders.length} insiders bought ${usd(total)} of ${company} stock ${span}`
      : `${who(insiders[0]!)} bought ${usd(total)} of ${company} stock ${span}`;
  const listed = insiders.slice(0, 4).map((i) => `${who(i)} ${fmtShares(i.shares)} shares for ${usd(i.value)}`);
  const summary = [
    `${c.kind === "cluster" ? "Form 4 filings show open-market purchases by" : "A Form 4 filing shows an open-market purchase by"} ${listed.join("; ")}${insiders.length > 4 ? `; and ${insiders.length - 4} more` : ""}.`,
    `In all, ${fmtShares(totalShares)} shares for ${usd(total)}, at prices from $${Math.min(...ps.map((p) => p.price)).toFixed(2)} to $${Math.max(...ps.map((p) => p.price)).toFixed(2)}, traded ${span}.`,
  ];
  const quotes = ps.map((p) => `${p.owners[0]!.name} (${ownerRole(p.owners[0]!)}): ${p.securityTitle}, ${p.date}, code P, ${p.raw.shares} shares at ${p.raw.price}`);
  const accs = [...new Set(ps.map((p) => p.accession))];
  const anchor = c.anchor;
  const sources = [anchor.accession, ...accs.filter((a) => a !== anchor.accession)].map((acc) => {
    const p = ps.find((x) => x.accession === acc)!;
    return edgarSource(`Form 4: ${personName(p.owners[0]!.name)}, ${company}`, p.indexUrl, p.acceptedAt);
  });
  return {
    id: `insider_cluster-${anchor.accession}`,
    eventType: "insider_cluster",
    family: "F7",
    cik: c.issuerCik,
    ticker: ticker ?? null,
    companyName: company,
    acceptedAt: anchor.acceptedAt,
    accession: anchor.accession,
    form: "4",
    items: [],
    title,
    summary,
    sign: 1,
    magnitude: mv ? Math.round((total / mv.usd) * 100 * 10_000) / 10_000 : null,
    facts: {
      rule: c.kind === "cluster" ? `${CLUSTER_MIN_INSIDERS}+ insiders within ${CLUSTER_MAX_BUSINESS_DAYS} business days` : `officer or director purchase of $100k+ at a company under $2B`,
      insiders: insiders.length,
      insiderNames: insiders.map(who).join("; "),
      totalUsd: Math.round(total),
      totalShares: Math.round(totalShares),
      firstTradeDate: d1,
      lastTradeDate: d2,
      filings: accs.length,
      marketValueUsd: mv ? Math.round(mv.usd) : null,
      marketValueSource: mv?.source ?? null,
    },
    sources,
    quotes,
    propagates: "own",
    watchOnlyReasons: [],
  };
}
