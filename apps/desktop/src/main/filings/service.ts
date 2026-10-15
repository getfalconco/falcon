/**
 * Filing changes, put together: for one company, the latest annual report
 * (10-K or 20-F) against the one before, the latest 10-Q's risk factor
 * update, and the red flags EDGAR's own index carries.
 *
 * What it asks EDGAR for and how often:
 *
 *   index      the company's submissions JSON (the agents engine's reader,
 *              which spaces every SEC request and keeps the answer four
 *              minutes), at most once per company per New York day
 *   documents  the primary document of each filing compared (the newest
 *              10-K or 20-F, the one before it, the latest 10-Q since),
 *              never an exhibit, read once ever: a filing never changes, so
 *              its reading (digest) is kept on disk for good, with the plain
 *              text of annual reports beside it (gzip) for name searches.
 *              The 10-Q filed right before the newest report, which says
 *              what that report already carried (`carried`), is read only
 *              for a caller that asks for it (the agents' filing changes
 *              watch), not for the dashboard or the Stock tab.
 *
 * Parsing (a 10-K of ten megabytes takes about half a second) runs in a
 * worker thread (parse-pool.ts), or on the calling thread when none starts.
 *
 * The dashboard's queue reads the held names first, a short pause apart,
 * then the watchlist, `watchlistGapMs` apart.
 *
 * A read that fails is not tried again for half an hour; the last answer
 * stands meanwhile. The filing graph (step1) supplies the customer and
 * supplier names; nothing here calls a model.
 *
 * Electron-free: the readers, the folder and the clock are injected.
 */

import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import { nyYmdOf } from "../../shared/earnings-time";
import {
  FILINGS_MAX_NAMES,
  overviewRows,
  kindRank,
  type FilingChangeItem,
  type FilingChangeKind,
  type FilingChanges,
  type FilingChangesMissing,
  type FilingDocRef,
  type FilingOverviewRequest,
  type FilingOverviewResult,
  type QuarterRiskStatus,
  type RelationshipCoverage,
} from "../../shared/filing-changes";
import { companyKey, normalizeHeading, sameAuditor, type RiskHeading } from "./parse";
import { REWORD_BELOW, diffConcentration, diffHeadings, headingSimilarity, namedIn, newSentences } from "./diff";
import { DIGEST_VERSION, isAnnual, type FilingDigest, type FilingLike, type ReadFiling } from "./digest";
import { parseInThread } from "./parse-pool";

export { DIGEST_VERSION, digestOf, isAnnual, type FilingDigest, type FilingLike } from "./digest";

const gunzip = promisify(zlib.gunzip);
const gzip = promisify(zlib.gzip);

/** 2: items carry `carried`. */
const CHANGES_VERSION = 2;
/** A kept answer that does not cover a filing asked about is read again, but not more often than this. */
export const COVERING_RETRY_MS = 10 * 60_000;
export const FAILURE_RETRY_MS = 30 * 60_000;
/** Late notices and 8-K items older than this are left out whatever the annual reports' dates. */
const FLAG_WINDOW_DAYS = 730;
const MAX_NAMED = 8;
const MAX_SOLE_SOURCE = 2;
const SHARE_NOTABLE_POINTS = 5;

/** A filing graph edge, as main/research/graph-edges.ts reads it. */
export type EdgeLike = {
  root_ticker?: string;
  counterparty_name?: string;
  counterparty_ticker?: string | null;
  category?: string;
  disclosed_share_pct?: number | null;
  evidence_quote?: string;
  accession_number?: string | null;
  filing_date?: string;
};

export type FilingsDeps = {
  dir: string;
  now?: () => number;
  /** Every filing the company's EDGAR index lists, newest first; [] when EDGAR has no such ticker. */
  filings: (ticker: string) => Promise<FilingLike[]>;
  /** A filing's primary document, whole. */
  document: (filing: FilingLike) => Promise<string>;
  graphEdges: () => Promise<readonly EdgeLike[]>;
  /**
   * The background queue (the dashboard's names) starts no sooner than this
   * instant (epoch ms), so the first minute after launch is left to the
   * window and the first render; a Stock tab ask is answered at once.
   */
  backgroundStartAt?: number;
  /** A pause between two held names the background queue reads. */
  backgroundGapMs?: number;
  /** A pause before each watchlist name the background queue reads (they come after every held name). */
  watchlistGapMs?: number;
  /** Reads a filing's HTML into its digest (parse-pool.ts); the calling thread when not given. */
  parse?: (filing: FilingLike, html: string, keepText: boolean) => Promise<ReadFiling>;
};

const QUARTER_FORMS = new Set(["10-Q", "10-QT"]);

function refOf(d: FilingDigest | null, f: FilingLike): FilingDocRef {
  const url = d?.url ?? f.url;
  return {
    form: f.form,
    accession: f.accession,
    filedAt: f.filedAt,
    url,
    sectionUrl: d?.anchor && f.primaryDocument ? `${url}#${encodeURIComponent(d.anchor)}` : null,
  };
}

function addDays(ymd: string, days: number): string {
  const ms = Date.parse(`${ymd}T00:00:00Z`) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Picks the filings to compare from the index: newest annual, the annual
 * before it, the latest 10-Q after it, and `prior`, the 10-Q filed right
 * before the newest of those reports (the 10-Q before the latest one since
 * the annual report, or with no 10-Q since, the last 10-Q before the annual
 * report), which says what the newest report merely carried over.
 */
export function pickFilings(filings: readonly FilingLike[]): {
  latest: FilingLike | null;
  previous: FilingLike | null;
  quarter: FilingLike | null;
  prior: FilingLike | null;
} {
  const annual = filings.filter((f) => isAnnual(f.form) && f.primaryDocument);
  const latest = annual[0] ?? null;
  const previous = annual[1] ?? null;
  const quarters = filings.filter((f) => QUARTER_FORMS.has(f.form) && f.primaryDocument);
  const quarter = latest ? (quarters.find((f) => f.filedAt > latest.filedAt) ?? null) : null;
  let prior: FilingLike | null = null;
  if (latest && quarter) prior = quarters.find((f) => f !== quarter && f.filedAt > latest.filedAt) ?? null;
  else if (latest) prior = quarters.find((f) => f.filedAt <= latest.filedAt && (!previous || f.filedAt > previous.filedAt)) ?? null;
  return { latest, previous, quarter, prior };
}

/** Whether an answer covers a filing: compares it, or lists an item from it. */
export function coversFiling(changes: FilingChanges, accession: string): boolean {
  if (changes.latest?.accession === accession || changes.quarter?.accession === accession) return true;
  return changes.items.some((i) => i.id.split(":")[1] === accession);
}

/** A heading the other list has, verbatim or with small edits (diff.ts REWORD_BELOW). */
function headingIn(text: string, list: readonly RiskHeading[]): boolean {
  const key = normalizeHeading(text);
  return list.some((h) => normalizeHeading(h.text) === key || headingSimilarity(text, h.text) >= REWORD_BELOW);
}

type Inputs = {
  ticker: string;
  today: string;
  checkedAt: string;
  filings: readonly FilingLike[];
  digests: ReadonlyMap<string, FilingDigest>;
  /** The previous annual report's searchable text (diff.ts searchableText), when kept. */
  previousText: string | null;
  /** The latest annual report's searchable text, when kept: a share no longer stated in a sentence may still sit in a table. */
  latestText?: string | null;
  edges: readonly EdgeLike[];
  /**
   * The 10-Q before the newest report was asked for (default): without its
   * digest the answer misses a document. False: it is left out unless kept,
   * and nothing is marked `carried`.
   */
  withPrior?: boolean;
};

function item(base: Omit<FilingChangeItem, "text" | "previous" | "name" | "pct" | "previousPct" | "detail" | "repeat"> & Partial<FilingChangeItem>): FilingChangeItem {
  return { text: null, previous: null, name: null, pct: null, previousPct: null, detail: null, repeat: false, ...base };
}

const accessionKey = (a: string | null | undefined) => (a ?? "").replace(/-/g, "");

/**
 * The comparison itself, from the index, the digests and the graph. Pure, so
 * every rule here is tested on fixtures.
 */
export function buildChanges(input: Inputs): FilingChanges {
  const { ticker, filings, digests } = input;
  const { latest, previous, quarter, prior } = pickFilings(filings);
  const missing: FilingChangesMissing[] = [];
  const items: FilingChangeItem[] = [];
  const dLatest = latest ? (digests.get(latest.accession) ?? null) : null;
  const dPrev = previous ? (digests.get(previous.accession) ?? null) : null;
  const dQuarter = quarter ? (digests.get(quarter.accession) ?? null) : null;
  const dPrior = prior ? (digests.get(prior.accession) ?? null) : null;

  if (!latest) missing.push("annual");
  else if (!previous) missing.push("previous");
  const priorMissing = prior !== null && !dPrior && input.withPrior !== false;
  if ((latest && !dLatest) || (previous && !dPrev) || (quarter && !dQuarter) || priorMissing) missing.push("documents");

  const latestRef = latest ? refOf(dLatest, latest) : null;
  const linkOf = (ref: FilingDocRef) => ref.sectionUrl ?? ref.url;

  // Risk factors: latest annual against the previous one.
  let riskCount: FilingChanges["riskCount"] = null;
  if (latest && dLatest && previous && dPrev && latestRef) {
    if (dLatest.headings.length === 0 || dPrev.headings.length === 0) missing.push("risk_section");
    else {
      riskCount = { latest: dLatest.headings.length, previous: dPrev.headings.length };
      const diff = diffHeadings(dLatest.headings, dPrev.headings);
      const base = { form: latest.form, date: latest.filedAt, url: linkOf(latestRef) };
      diff.added.forEach((h, i) => items.push(item({ ...base, id: `risk_new:${latest.accession}:${i}`, kind: "risk_new", text: h.text, notable: true })));
      const prevRef = refOf(dPrev, previous);
      diff.removed.forEach((h, i) =>
        items.push(item({ ...base, id: `risk_removed:${latest.accession}:${i}`, kind: "risk_removed", text: h.text, url: linkOf(prevRef), notable: false })),
      );
      diff.reworded.forEach((r, i) =>
        items.push(item({ ...base, id: `risk_reworded:${latest.accession}:${i}`, kind: "risk_reworded", text: r.now.text, previous: r.before.text, notable: false })),
      );
    }
  }

  // The latest 10-Q's Item 1A against the annual report it updates.
  let quarterRisk: QuarterRiskStatus | null = null;
  if (quarter && dQuarter && dLatest) {
    const qRef = refOf(dQuarter, quarter);
    if (dQuarter.headings.length > 0) {
      quarterRisk = "updated";
      const diff = diffHeadings(dQuarter.headings, dLatest.headings);
      const base = { form: quarter.form, date: quarter.filedAt, url: linkOf(qRef) };
      diff.added.forEach((h, i) => items.push(item({ ...base, id: `quarter_risk_new:${quarter.accession}:${i}`, kind: "quarter_risk_new", text: h.text, notable: true })));
      diff.reworded.forEach((r, i) =>
        items.push(item({ ...base, id: `quarter_risk_reworded:${quarter.accession}:${i}`, kind: "quarter_risk_reworded", text: r.now.text, previous: r.before.text, notable: false })),
      );
      if (diff.added.length === 0 && diff.reworded.length === 0 && dQuarter.noMaterialChanges) quarterRisk = "no_material_changes";
    } else quarterRisk = dQuarter.noMaterialChanges ? "no_material_changes" : dQuarter.riskFound ? "unclear" : null;
  }

  // Red flags in the reports' own text.
  const flag = (kind: "going_concern" | "material_weakness", pick: (d: FilingDigest) => string | null) => {
    if (latest && dLatest && latestRef) {
      const now = pick(dLatest);
      if (now) {
        const repeat = dPrev ? pick(dPrev) !== null : false;
        items.push(item({ id: `${kind}:${latest.accession}`, kind, form: latest.form, date: latest.filedAt, url: latestRef.url, text: now, notable: !repeat, repeat }));
      }
    }
    if (quarter && dQuarter) {
      const now = pick(dQuarter);
      if (now && !(dLatest && pick(dLatest))) {
        items.push(item({ id: `${kind}:${quarter.accession}`, kind, form: quarter.form, date: quarter.filedAt, url: refOf(dQuarter, quarter).url, text: now, notable: true }));
      }
    }
  };
  flag("going_concern", (d) => d.goingConcern);
  flag("material_weakness", (d) => d.materialWeakness);

  if (latest && dLatest?.auditor && dPrev?.auditor && !sameAuditor(dLatest.auditor, dPrev.auditor) && latestRef) {
    items.push(
      item({ id: `auditor_name:${latest.accession}`, kind: "auditor_name", form: latest.form, date: latest.filedAt, url: latestRef.url, name: dLatest.auditor, previous: dPrev.auditor, notable: true }),
    );
  }

  // Red flags in EDGAR's index: 8-K items 4.01 and 4.02, late filing notices.
  const floor = addDays(input.today, -FLAG_WINDOW_DAYS);
  const since = previous && previous.filedAt > floor ? previous.filedAt : floor;
  for (const f of filings) {
    if (f.filedAt <= since) continue;
    const base = { form: f.form, date: f.filedAt, url: f.url };
    if (/^8-K/.test(f.form)) {
      if (f.items.includes("4.01")) items.push(item({ ...base, id: `auditor_change:${f.accession}`, kind: "auditor_change", detail: "4.01", notable: true }));
      if (f.items.includes("4.02")) items.push(item({ ...base, id: `restatement:${f.accession}`, kind: "restatement", detail: "4.02", notable: true }));
    } else if (/^NT /.test(f.form)) {
      items.push(item({ ...base, id: `late_filing:${f.accession}`, kind: "late_filing", detail: f.form, notable: true }));
    }
  }

  // Customers and suppliers.
  let relationships: RelationshipCoverage = "none";
  if (latest && dLatest && latestRef) {
    const own = input.edges.filter(
      (e) =>
        (e.root_ticker ?? "").toUpperCase() === ticker &&
        (e.category === "customer" || e.category === "supplier") &&
        typeof e.counterparty_name === "string" &&
        e.counterparty_name.trim() !== "",
    );
    if (own.length > 0) {
      const fromLatest = own.filter((e) => accessionKey(e.accession_number) === accessionKey(latest.accession) || e.filing_date === latest.filedAt);
      if (fromLatest.length === 0) relationships = "graph_older";
      else if (input.previousText !== null) {
        relationships = "compared";
        const seen = new Set<string>();
        let named = 0;
        for (const e of fromLatest) {
          const name = e.counterparty_name!.trim();
          const key = `${e.category}|${companyKey(name)}`;
          if (seen.has(key)) continue;
          seen.add(key);
          if (namedIn(name, input.previousText)) continue;
          if (named++ >= MAX_NAMED) break;
          const kind: FilingChangeKind = e.category === "customer" ? "customer_named" : "supplier_named";
          items.push(
            item({
              id: `${kind}:${latest.accession}:${companyKey(name)}`,
              kind,
              form: latest.form,
              date: latest.filedAt,
              url: latestRef.url,
              name,
              text: e.evidence_quote ?? null,
              pct: typeof e.disclosed_share_pct === "number" ? e.disclosed_share_pct : null,
              notable: true,
            }),
          );
        }
      }
    }
  }

  if (latest && dLatest && dPrev && latestRef) {
    for (const c of diffConcentration(dLatest.concentration, dPrev.concentration)) {
      const base = { form: latest.form, date: latest.filedAt, url: latestRef.url, name: c.label, text: c.quote };
      const id = `${c.basis}:${companyKey(c.label)}`;
      if (c.kind === "share") {
        items.push(item({ ...base, id: `customer_share:${latest.accession}:${id}`, kind: "customer_share", pct: c.pct, previousPct: c.previousPct, detail: c.basis, notable: Math.abs(c.pct - c.previousPct) >= SHARE_NOTABLE_POINTS }));
      } else if (c.kind === "new") {
        items.push(item({ ...base, id: `customer_share_new:${latest.accession}:${id}`, kind: "customer_share_new", pct: c.pct, detail: c.basis, notable: true }));
      } else if (!(input.latestText && namedIn(c.label, input.latestText))) {
        items.push(item({ ...base, id: `customer_share_dropped:${latest.accession}:${id}`, kind: "customer_share_dropped", previousPct: c.previousPct, detail: c.basis, notable: false }));
      }
    }
    newSentences(dLatest.soleSource, dPrev.soleSource)
      .slice(0, MAX_SOLE_SOURCE)
      .forEach((s, i) => items.push(item({ id: `sole_source_new:${latest.accession}:${i}`, kind: "sole_source_new", form: latest.form, date: latest.filedAt, url: latestRef.url, text: s, notable: false })));
  }

  // What the 10-Q right before the newest report already carried: new
  // against the base, but not new to a reader of every report.
  const newest = quarter ?? latest;
  if (newest && dPrior) {
    for (const it of items) {
      if (it.id.split(":")[1] !== newest.accession) continue;
      if (it.kind === "risk_new" || it.kind === "quarter_risk_new") it.carried = headingIn(it.text ?? "", dPrior.headings);
      else if (it.kind === "going_concern") it.carried = dPrior.goingConcern !== null;
      else if (it.kind === "material_weakness") it.carried = dPrior.materialWeakness !== null;
    }
  }

  items.sort((a, b) => b.date.localeCompare(a.date) || kindRank(a.kind) - kindRank(b.kind));
  return {
    ticker,
    checkedAt: input.checkedAt,
    latest: latestRef,
    previous: previous ? refOf(dPrev, previous) : null,
    quarter: quarter ? refOf(dQuarter, quarter) : null,
    quarterRisk,
    riskCount,
    relationships,
    items,
    missing,
  };
}

/** `carried`: false when the 10-Q before the newest report was not read (absent on older files: it was). */
type ChangesFile = { v: number; day: string; changes: FilingChanges; carried?: boolean };

export type ChangesOptions = {
  covering?: string;
  /**
   * Read the 10-Q filed right before the newest report too, so items it
   * already held are marked `carried` (the agents' watch). A kept answer
   * without it is read again; only that one document is fetched.
   */
  carried?: boolean;
};

export type FilingsService = {
  /**
   * One company, compared; read from EDGAR at most once per New York day.
   * `covering`: an accession the caller has seen in the index (a new 10-Q, an
   * 8-K): a kept answer that neither compares it nor lists an item from it is
   * read again, at most every ten minutes (the agents' filing changes watch).
   */
  changes(ticker: string, opts?: ChangesOptions): Promise<FilingChanges>;
  /** What is kept for the company, whatever its day; null when nothing is. */
  cached(ticker: string): FilingChanges | null;
  /**
   * The dashboard's lines for the reader's names from what is kept; names not
   * read today are queued and read one at a time in the background.
   */
  overview(request: FilingOverviewRequest): FilingOverviewResult;
  /** Queues every name of the last overview that is not read today. */
  refreshDue(): void;
  /** Resolves when the background queue is empty (tests). */
  idle(): Promise<void>;
  /**
   * Drops what is no longer worth keeping on disk (PRUNE_* below): answers
   * for names not read in months, the plain text of annual reports no kept
   * answer compares, and digests no kept answer names. Never throws.
   */
  prune(): Promise<{ changes: number; texts: number; digests: number }>;
};

/** An answer for a name not read in this long is dropped (the name left the dashboard). */
export const PRUNE_CHANGES_DAYS = 90;
/** An annual report's plain text no kept answer compares is dropped after this long. */
export const PRUNE_TEXT_DAYS = 30;
/** A digest no kept answer names is dropped after this long (a 10-Q digest is needed for a year at most). */
export const PRUNE_DIGEST_DAYS = 400;

export function createFilingsService(deps: FilingsDeps): FilingsService {
  const now = deps.now ?? Date.now;
  const memory = new Map<string, ChangesFile>();
  const failedAt = new Map<string, number>();
  const inflight = new Map<string, Promise<FilingChanges>>();
  /** The dashboard's names to read, held ones first. */
  const queue: { ticker: string; held: boolean }[] = [];
  let running: Promise<void> | null = null;
  let lastNames: { ticker: string; held: boolean }[] = [];
  const parse = deps.parse ?? parseInThread;

  const changesFile = (t: string) => path.join(deps.dir, "changes", `${t}.json`);
  const digestFile = (acc: string) => path.join(deps.dir, "digests", `${acc}.json`);
  const textFile = (acc: string) => path.join(deps.dir, "text", `${acc}.txt.gz`);

  const kept = (ticker: string): ChangesFile | null => {
    const mem = memory.get(ticker);
    if (mem) return mem;
    const disk = readJson<ChangesFile>(changesFile(ticker));
    if (disk && disk.v === CHANGES_VERSION && disk.changes && Array.isArray(disk.changes.items)) {
      memory.set(ticker, disk);
      return disk;
    }
    return null;
  };

  const readDigest = (acc: string): FilingDigest | null => {
    const d = readJson<FilingDigest>(digestFile(acc));
    return d && d.v === DIGEST_VERSION ? d : null;
  };

  const readText = async (acc: string): Promise<string | null> => {
    try {
      return (await gunzip(await fs.promises.readFile(textFile(acc)))).toString("utf8");
    } catch {
      return null;
    }
  };

  /** The digest of one filing, read from EDGAR once and then from disk. */
  const digest = async (f: FilingLike, keepText: boolean): Promise<FilingDigest | null> => {
    const have = readDigest(f.accession);
    if (have && (!keepText || fs.existsSync(textFile(f.accession)))) return have;
    try {
      const html = await deps.document(f);
      const { digest: d, searchable } = await parse(f, html, keepText);
      writeJsonAtomic(digestFile(f.accession), d);
      if (keepText && searchable !== null) {
        const packed = await gzip(Buffer.from(searchable, "utf8"));
        await fs.promises.mkdir(path.dirname(textFile(f.accession)), { recursive: true });
        await fs.promises.writeFile(textFile(f.accession), packed);
      }
      return d;
    } catch (err) {
      console.warn("[filings] document read failed:", f.form, f.accession, err instanceof Error ? err.message : String(err));
      return have;
    }
  };

  const compute = async (ticker: string, withPrior: boolean): Promise<FilingChanges> => {
    const filings = await deps.filings(ticker);
    const { latest, previous, quarter, prior } = pickFilings(filings);
    const digests = new Map<string, FilingDigest>();
    for (const [f, keepText] of [
      // The latest annual's text is kept too: it is next year's previous report.
      [latest, true],
      [previous, true],
      [quarter, false],
    ] as const) {
      if (!f) continue;
      const d = await digest(f, keepText);
      if (d) digests.set(f.accession, d);
    }
    // The 10-Q before the newest report: fetched only when asked for, used whenever kept.
    if (prior) {
      const d = withPrior ? await digest(prior, false) : readDigest(prior.accession);
      if (d) digests.set(prior.accession, d);
    }
    let edges: readonly EdgeLike[] = [];
    try {
      edges = await deps.graphEdges();
    } catch {
      edges = [];
    }
    const nowMs = now();
    const changes = buildChanges({
      ticker,
      today: nyYmdOf(nowMs),
      checkedAt: new Date(nowMs).toISOString(),
      filings,
      digests,
      previousText: previous ? await readText(previous.accession) : null,
      latestText: latest ? await readText(latest.accession) : null,
      edges,
      withPrior,
    });
    const file: ChangesFile = { v: CHANGES_VERSION, day: nyYmdOf(nowMs), changes, carried: !prior || digests.has(prior.accession) };
    // An answer missing a document is shown but read again on the next ask.
    if (!changes.missing.includes("documents")) {
      memory.set(ticker, file);
      try {
        writeJsonAtomic(changesFile(ticker), file);
      } catch (err) {
        console.warn("[filings] cache write failed:", err instanceof Error ? err.message : String(err));
      }
    } else {
      failedAt.set(ticker, nowMs);
      if (!memory.has(ticker)) memory.set(ticker, { ...file, day: "" });
    }
    return changes;
  };

  const isFresh = (ticker: string): boolean => kept(ticker)?.day === nyYmdOf(now());
  const isPaused = (ticker: string): boolean => {
    const at = failedAt.get(ticker);
    return at !== undefined && now() - at < FAILURE_RETRY_MS;
  };

  /** Reads under way, and whether each reads the 10-Q before the newest report. */
  const inflightPrior = new Map<string, boolean>();

  const changes = (ticker: string, opts?: ChangesOptions): Promise<FilingChanges> => {
    const have = kept(ticker);
    const covering = opts?.covering;
    const withPrior = opts?.carried === true;
    const covered = !covering || (have !== null && coversFiling(have.changes, covering));
    // A kept answer read without that 10-Q does not do for a caller that asks for it.
    const complete = !withPrior || have?.carried !== false;
    if (have && isPaused(ticker)) return Promise.resolve(have.changes);
    if (have && have.day === nyYmdOf(now()) && covered && complete) return Promise.resolve(have.changes);
    if (have && !covered && now() - Date.parse(have.changes.checkedAt) < COVERING_RETRY_MS) return Promise.resolve(have.changes);
    const pending = inflight.get(ticker);
    if (pending) {
      if (!withPrior || inflightPrior.get(ticker)) return pending;
      // A read without it is under way: this one follows it (the documents it read are kept by then).
      return pending.then(
        () => changes(ticker, opts),
        () => changes(ticker, opts),
      );
    }
    inflightPrior.set(ticker, withPrior);
    const task = compute(ticker, withPrior)
      .catch((err) => {
        failedAt.set(ticker, now());
        console.warn("[filings] read failed:", ticker, err instanceof Error ? err.message : String(err));
        if (have) return have.changes;
        throw err;
      })
      .finally(() => {
        inflight.delete(ticker);
        inflightPrior.delete(ticker);
      });
    inflight.set(ticker, task);
    return task;
  };

  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  let released = false;
  const pump = () => {
    if (running || holdTimer) return;
    if (!released) {
      const hold = (deps.backgroundStartAt ?? 0) - now();
      if (hold > 0 && queue.length > 0) {
        holdTimer = setTimeout(() => {
          holdTimer = null;
          released = true;
          pump();
        }, hold);
        holdTimer.unref?.();
        return;
      }
      released = true;
    }
    running = (async () => {
      let first = true;
      while (queue.length > 0) {
        const { ticker: t, held } = queue.shift()!;
        if (isFresh(t) || isPaused(t)) continue;
        const gap = held ? deps.backgroundGapMs : (deps.watchlistGapMs ?? deps.backgroundGapMs);
        if (!first && gap) await new Promise((r) => setTimeout(r, gap));
        first = false;
        try {
          await changes(t);
        } catch {
          // Logged in `changes`; the next name goes on.
        }
      }
    })().finally(() => {
      running = null;
    });
  };

  const enqueue = (names: readonly { ticker: string; held: boolean }[]) => {
    for (const n of names) {
      if (isFresh(n.ticker) || isPaused(n.ticker) || inflight.has(n.ticker)) continue;
      const at = queue.findIndex((q) => q.ticker === n.ticker);
      if (at >= 0) {
        if (queue[at]!.held === n.held) continue;
        queue.splice(at, 1);
      }
      // A held name goes before every watchlist name already waiting.
      const firstWatch = queue.findIndex((q) => !q.held);
      if (n.held && firstWatch >= 0) queue.splice(firstWatch, 0, n);
      else queue.push(n);
    }
    pump();
  };

  return {
    changes: (ticker, opts) => changes(ticker, opts),
    cached: (ticker) => kept(ticker)?.changes ?? null,
    overview(request) {
      const names = [...new Set([...request.held, ...request.watchlist])].slice(0, FILINGS_MAX_NAMES);
      lastNames = names.map((t) => ({ ticker: t, held: request.held.includes(t) }));
      enqueue(lastNames);
      const answers: { changes: FilingChanges; held: boolean; watchlist: boolean }[] = [];
      for (const t of names) {
        const have = kept(t);
        if (!have) continue;
        answers.push({ changes: have.changes, held: request.held.includes(t), watchlist: request.watchlist.includes(t) });
      }
      const pending = names.filter((t) => !isFresh(t) && !isPaused(t));
      return { ok: true, rows: overviewRows(answers, nyYmdOf(now())), pending, checked: names.length - pending.length };
    },
    refreshDue: () => enqueue(lastNames),
    idle: async () => {
      while (running) await running;
    },
    prune: async () => {
      const removed = { changes: 0, texts: 0, digests: 0 };
      const dayMs = 86_400_000;
      const list = async (sub: string): Promise<{ name: string; file: string; ageMs: number }[]> => {
        const dir = path.join(deps.dir, sub);
        let names: string[];
        try {
          names = await fs.promises.readdir(dir);
        } catch {
          return [];
        }
        const out: { name: string; file: string; ageMs: number }[] = [];
        for (const name of names) {
          const file = path.join(dir, name);
          try {
            const st = await fs.promises.stat(file);
            if (st.isFile()) out.push({ name, file, ageMs: now() - st.mtimeMs });
          } catch {
            // Gone meanwhile.
          }
        }
        return out;
      };
      const drop = async (file: string): Promise<boolean> => {
        try {
          await fs.promises.unlink(file);
          return true;
        } catch {
          return false;
        }
      };
      try {
        // What the kept answers still compare or name.
        const compared = new Set<string>();
        const named = new Set<string>();
        for (const c of await list("changes")) {
          const ticker = c.name.replace(/\.json$/, "");
          if (c.ageMs > PRUNE_CHANGES_DAYS * dayMs && !inflight.has(ticker)) {
            if (await drop(c.file)) {
              removed.changes++;
              memory.delete(ticker);
            }
            continue;
          }
          const kept = readJson<ChangesFile>(c.file)?.changes;
          if (!kept) continue;
          for (const ref of [kept.latest, kept.previous]) if (ref) compared.add(ref.accession);
          for (const ref of [kept.latest, kept.previous, kept.quarter]) if (ref) named.add(ref.accession);
          for (const it of kept.items ?? []) named.add(it.id.split(":")[1] ?? "");
        }
        for (const t of await list("text")) {
          const acc = t.name.replace(/\.txt\.gz$/, "");
          if (!compared.has(acc) && t.ageMs > PRUNE_TEXT_DAYS * dayMs && (await drop(t.file))) removed.texts++;
        }
        for (const d of await list("digests")) {
          const acc = d.name.replace(/\.json$/, "");
          if (!named.has(acc) && d.ageMs > PRUNE_DIGEST_DAYS * dayMs && (await drop(d.file))) removed.digests++;
        }
      } catch (err) {
        console.warn("[filings] prune failed:", err instanceof Error ? err.message : String(err));
      }
      return removed;
    },
  };
}
