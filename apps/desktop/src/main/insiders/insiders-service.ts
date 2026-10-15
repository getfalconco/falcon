/**
 * Insider activity, put together: which companies to read (scope.ts), their
 * Form 4s and Schedule 13D / 13G filings from EDGAR, read once and kept on
 * disk, and the events found in them (detect.ts).
 *
 * What it asks EDGAR for and how often (every request goes through the
 * agents engine's spaced queue in agents/edgar.ts: a descriptive User-Agent,
 * at most four requests a second for the whole app):
 *
 *   filing list   a company's submissions index, read again at most every
 *                 three hours on business days (freshness.ts). Only Form 4s
 *                 and new 13D / 13D amendments / new 13G filed inside the
 *                 card's 90-day window are kept from it: an older filing
 *                 holds no event the card shows, so it is never fetched.
 *   Form 4        the ownership XML, once per accession, forever: a filed
 *                 form does not change. Kept as the trades it holds.
 *   13D / 13G     the primary document and the SEC header, once per
 *                 accession, forever. Kept as filer, percent and whether an
 *                 amendment restates its purpose.
 *
 * Read order. A company's filings are read newest first, at most
 * FIRST_LOOK_DOCS requests per company per session. Its "first look" is
 * its list and its newest FIRST_LOOK_DOCS filings; what is left of its
 * window is read after every other own name's first look. A Stock tab
 * request goes first, then the held names, then the watchlist; the linked
 * companies only once the reader's own names have nothing left to read.
 *
 * Pace. A read session makes at most `budget` requests (default 200) and
 * the next one starts no sooner than half a minute after. Once every held
 * and watched name has had its first look, the rest (older filings, linked
 * companies) goes in sessions of BACKGROUND_BUDGET requests a minute apart,
 * so a first look at sixty companies does not hold the queue the agents
 * share for ten minutes. Sessions go on by themselves until nothing queued
 * is left. A list or document that cannot be read is not tried again for
 * half an hour.
 *
 * On disk, under `<data root>/insiders/`:
 *   companies.json      per ticker: when the list was read, the CIK, the kept filings
 *   docs/<cik>.json     per issuer: trades per Form 4, the read of each 13D / 13G
 *                       (null for a schedule this company filed about another one)
 *
 * Electron-free: the readers, the folder and the clock are injected.
 */

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import { parseOwnershipXml } from "../edgar/form4";
import type { FilingRef } from "../agents/sources";
import type { LinkEdge } from "../../shared/earnings-links";
import { nyYmdOf } from "../../shared/earnings-time";
import type { InsiderActivityAnswer, InsiderEvent, InsiderScope, ParsedInsiderRequest } from "../../shared/insider-types";
import { LOOKBACK_DAYS, companyEvents, rankEvents, scheduleKind, tradesOf, type ScheduleRecord, type TradeRecord } from "./detect";
import { isStale } from "./freshness";
import { filerFromHeader, percentOfClass, purposeAmended, subjectCikFromHeader } from "./schedule13";
import { buildScope, type ScopeEntry } from "./scope";

/** The card's window (detect.ts LOOKBACK_DAYS): a filing filed earlier has no trade or schedule inside it. */
export const KEEP_FILINGS_DAYS = LOOKBACK_DAYS;
export const DEFAULT_BUDGET = 200;
export const SESSION_GAP_MS = 30_000;
/** Requests per company per session: its newest filings first, the rest later. */
export const FIRST_LOOK_DOCS = 40;
/** Sessions after every own name's first look: this many requests, this far apart. */
export const BACKGROUND_BUDGET = 60;
export const BACKGROUND_GAP_MS = 60_000;
export const LIST_RETRY_MS = 30 * 60_000;
export const FOCUS_WAIT_MS = 30_000;
export const MAX_EVENTS = 60;
/** A company not read in this long (it left the reader's names and their links) is forgotten, with its reads. */
export const FORGET_COMPANY_MS = 30 * 24 * 60 * 60_000;

export type InsidersDeps = {
  dir: string;
  /** The company's filings, newest first (agents/edgar `filingHistory`). */
  filings: (ticker: string) => Promise<FilingRef[]>;
  /** One file of a filing: the primary document when `name` is null (agents/edgar `filingFile`). */
  file: (filing: FilingRef, name: string | null) => Promise<string | null>;
  graphEdges: () => Promise<readonly LinkEdge[]>;
  now?: () => number;
  budget?: number;
  sessionGapMs?: number;
  backgroundBudget?: number;
  backgroundGapMs?: number;
};

type StoredFiling = Pick<FilingRef, "cik" | "form" | "accession" | "filedAt" | "primaryDocument" | "url">;
type CompanyRecord = { checkedAt: number; cik: string | null; form4: StoredFiling[]; schedules: StoredFiling[] };
type CompaniesFile = { v: number; companies: Record<string, CompanyRecord> };
type DocsFile = { v: number; form4: Record<string, TradeRecord[]>; schedules: Record<string, ScheduleRecord | null> };

const COMPANIES_VERSION = 1;
const TIER: Readonly<Record<InsiderScope, number>> = { focus: 0, held: 1, watchlist: 2, linked: 3 };
const DOCS_VERSION = 3;

export type InsidersService = {
  activity(request: ParsedInsiderRequest): Promise<InsiderActivityAnswer>;
  /**
   * The events already read for the reader's own names (held and watched,
   * no linked companies), from what is kept: nothing is queued and no
   * filing is fetched. For the handover briefing, which only restates.
   */
  peek(request: { held: readonly string[]; watchlist: readonly string[] }): InsiderActivityAnswer;
  /** Resolves when the current read session (if any) has finished: tests. */
  idle(): Promise<void>;
};

function stored(f: FilingRef): StoredFiling {
  return { cik: f.cik, form: f.form, accession: f.accession, filedAt: f.filedAt, primaryDocument: f.primaryDocument, url: f.url };
}

function sameCik(a: string, b: string): boolean {
  return a.replace(/^0+/, "") === b.replace(/^0+/, "");
}

function asRef(f: StoredFiling): FilingRef {
  return { ...f, acceptedAt: null, items: [] };
}

export function createInsidersService(deps: InsidersDeps): InsidersService {
  const now = deps.now ?? (() => Date.now());
  const budgetPerSession = deps.budget ?? DEFAULT_BUDGET;
  const gap = deps.sessionGapMs ?? SESSION_GAP_MS;
  const backgroundBudget = deps.backgroundBudget ?? BACKGROUND_BUDGET;
  const backgroundGap = deps.backgroundGapMs ?? BACKGROUND_GAP_MS;
  const companiesFile = path.join(deps.dir, "companies.json");

  let companies: Record<string, CompanyRecord> | null = null;
  const docs = new Map<string, DocsFile>();
  const dirtyDocs = new Set<string>();
  const listFailedAt = new Map<string, number>();
  /** Documents that could not be read, by accession: tried again after LIST_RETRY_MS. */
  const docFailedAt = new Map<string, number>();
  const docDue = (accession: string) => {
    const at = docFailedAt.get(accession);
    return at === undefined || now() - at >= LIST_RETRY_MS;
  };

  function loadCompanies(): Record<string, CompanyRecord> {
    if (companies) return companies;
    const file = readJson<CompaniesFile>(companiesFile);
    companies = file && file.v === COMPANIES_VERSION && file.companies && typeof file.companies === "object" ? file.companies : {};
    return companies;
  }

  /** Forgets companies not read in FORGET_COMPANY_MS, and the reads of an issuer no kept company has. */
  function forgetOld(recs: Record<string, CompanyRecord>): void {
    const gone = new Set<string>();
    for (const [ticker, rec] of Object.entries(recs)) {
      if (now() - rec.checkedAt <= FORGET_COMPANY_MS) continue;
      delete recs[ticker];
      if (rec.cik) gone.add(rec.cik);
    }
    for (const rec of Object.values(recs)) if (rec.cik) gone.delete(rec.cik);
    for (const cik of gone) {
      docs.delete(cik);
      dirtyDocs.delete(cik);
      fs.promises.unlink(path.join(deps.dir, "docs", `${cik}.json`)).catch(() => undefined);
    }
  }

  /**
   * Drops an issuer's reads of filings no kept list names any more: a list
   * keeps the last KEEP_FILINGS_DAYS, so older reads are never shown again.
   */
  function trimDocs(cik: string): boolean {
    const d = docsFor(cik);
    let changed = false;
    const listed = new Set<string>();
    for (const rec of Object.values(loadCompanies())) {
      if (rec.cik !== cik) continue;
      for (const f of rec.form4) listed.add(f.accession);
      for (const f of rec.schedules) listed.add(f.accession);
    }
    for (const acc of Object.keys(d.form4)) {
      if (listed.has(acc)) continue;
      delete d.form4[acc];
      changed = true;
    }
    for (const acc of Object.keys(d.schedules)) {
      if (listed.has(acc)) continue;
      delete d.schedules[acc];
      changed = true;
    }
    return changed;
  }

  function saveCompanies(): void {
    forgetOld(loadCompanies());
    try {
      writeJsonAtomic(companiesFile, { v: COMPANIES_VERSION, companies: loadCompanies() } satisfies CompaniesFile);
    } catch (err) {
      console.warn("[insiders] could not save the filing lists:", err instanceof Error ? err.message : String(err));
    }
  }

  function docsFor(cik: string): DocsFile {
    let d = docs.get(cik);
    if (d) return d;
    const file = readJson<DocsFile>(path.join(deps.dir, "docs", `${cik}.json`));
    d = file && file.v === DOCS_VERSION && file.form4 && file.schedules ? file : { v: DOCS_VERSION, form4: {}, schedules: {} };
    docs.set(cik, d);
    return d;
  }

  function saveDocs(): void {
    for (const cik of dirtyDocs) {
      try {
        writeJsonAtomic(path.join(deps.dir, "docs", `${cik}.json`), docsFor(cik));
      } catch (err) {
        console.warn("[insiders] could not save filings read:", err instanceof Error ? err.message : String(err));
      }
    }
    dirtyDocs.clear();
  }

  /**
   * The first New York day inside the window the card shows: a filing filed
   * earlier holds no trade or schedule inside it, so it is never fetched.
   */
  function windowStart(): string {
    const today = nyYmdOf(now());
    return new Date(Date.parse(`${today}T00:00:00Z`) - KEEP_FILINGS_DAYS * 86_400_000).toISOString().slice(0, 10);
  }

  /** A company's kept Form 4s and schedules inside the window, newest first. */
  function windowFilings(rec: CompanyRecord): StoredFiling[] {
    const start = windowStart();
    return [...rec.form4, ...rec.schedules].filter((f) => !!f.filedAt && f.filedAt >= start).sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  }

  function isRead(d: DocsFile, f: StoredFiling): boolean {
    return f.form === "4" ? f.accession in d.form4 : f.accession in d.schedules;
  }

  /** Still to fetch: inside the window, not read, not waiting out a failure. Newest first. */
  function unread(rec: CompanyRecord, newestOnly: boolean): StoredFiling[] {
    if (!rec.cik) return [];
    const d = docsFor(rec.cik);
    const list = windowFilings(rec);
    return (newestOnly ? list.slice(0, FIRST_LOOK_DOCS) : list).filter((f) => !isRead(d, f) && docDue(f.accession));
  }

  function listDue(ticker: string): boolean {
    const rec = loadCompanies()[ticker];
    const failed = listFailedAt.get(ticker);
    const listable = failed === undefined || now() - failed >= LIST_RETRY_MS;
    return listable && (!rec || isStale(rec.checkedAt, now()));
  }

  /** The first look is not done: the list is due, or one of the newest FIRST_LOOK_DOCS filings is unread. */
  function firstLookPending(ticker: string): boolean {
    if (listDue(ticker)) return true;
    const rec = loadCompanies()[ticker];
    return !!rec && unread(rec, true).length > 0;
  }

  /** Does this company still have something to read? */
  function pendingFor(ticker: string): boolean {
    if (listDue(ticker)) return true;
    const rec = loadCompanies()[ticker];
    return !!rec && unread(rec, false).length > 0;
  }

  // ---- the read queue ---------------------------------------------------

  /** Read order: a Stock tab ask, then held, watched, linked names. */
  type Job = { ticker: string; tier: number };
  const work: Job[] = [];
  const waiters = new Map<string, Array<() => void>>();
  let worker: Promise<void> | null = null;
  let lastSessionEnd = 0;
  let budget = 0;
  /** Ends the pause between sessions early: a Stock tab request does not wait it out. */
  let wake: (() => void) | null = null;
  /** A Stock tab request is waiting: the next session starts without the pause. */
  let urgent = false;

  function settle(ticker: string): void {
    for (const resolve of waiters.get(ticker) ?? []) resolve();
    waiters.delete(ticker);
  }

  async function readList(ticker: string): Promise<void> {
    const recs = loadCompanies();
    const rec = recs[ticker];
    if (!listDue(ticker)) return;
    if (budget <= 0) return;
    budget--;
    try {
      const list = await deps.filings(ticker);
      const start = windowStart();
      // EDGAR lists newest first; only what the window can show is kept.
      const recent = list.filter((f) => !!f.filedAt && f.filedAt >= start).sort((a, b) => b.filedAt.localeCompare(a.filedAt));
      recs[ticker] = {
        checkedAt: now(),
        cik: list[0]?.cik ?? rec?.cik ?? null,
        form4: recent.filter((f) => f.form === "4").map(stored),
        schedules: recent.filter((f) => {
          const k = scheduleKind(f.form);
          return k === "13d" || k === "13d_a" || k === "13g";
        }).map(stored),
      };
      listFailedAt.delete(ticker);
      saveCompanies();
    } catch (err) {
      listFailedAt.set(ticker, now());
      console.warn(`[insiders] ${ticker} filing list failed:`, err instanceof Error ? err.message : String(err));
    }
  }

  async function readForm4(cik: string, d: DocsFile, f: StoredFiling): Promise<void> {
    budget--;
    const xml = await deps.file(asRef(f), null);
    if (xml === null) {
      docFailedAt.set(f.accession, now());
      return;
    }
    const doc = parseOwnershipXml(xml);
    // The submissions index also lists forms this company filed as an
    // owner of another company's shares: those are not its insiders' trades.
    const about = doc !== null && (!doc.issuerCik || sameCik(doc.issuerCik, cik));
    d.form4[f.accession] = doc && about ? tradesOf(doc, { accession: f.accession, filedAt: f.filedAt, url: f.url }) : [];
    dirtyDocs.add(cik);
  }

  async function readSchedule(cik: string, d: DocsFile, f: StoredFiling): Promise<void> {
    budget--;
    const header = await deps.file(asRef(f), `${f.accession}-index-headers.html`);
    if (header === null) {
      docFailedAt.set(f.accession, now());
      return;
    }
    // Listed because this company filed it about another one: not about this company.
    const subject = subjectCikFromHeader(header);
    if (subject && !sameCik(subject, cik)) {
      d.schedules[f.accession] = null;
      dirtyDocs.add(cik);
      return;
    }
    budget--;
    const body = await deps.file(asRef(f), null);
    if (body === null) {
      docFailedAt.set(f.accession, now());
      return;
    }
    d.schedules[f.accession] = {
      form: f.form,
      filer: filerFromHeader(header),
      filedAt: f.filedAt,
      accession: f.accession,
      url: f.url,
      percent: percentOfClass(body),
      purposeAmended: scheduleKind(f.form) === "13d_a" ? purposeAmended(body) : false,
    };
    dirtyDocs.add(cik);
  }

  /**
   * Reads a company's unread filings newest first, at most `cap` requests:
   * the newest FIRST_LOOK_DOCS only (`newestOnly`), or everything left in
   * the window. Returns the requests made.
   */
  async function readDocs(ticker: string, newestOnly: boolean, cap: number): Promise<number> {
    const rec = loadCompanies()[ticker];
    if (!rec?.cik) return 0;
    const cik = rec.cik;
    const d = docsFor(cik);
    if (trimDocs(cik)) dirtyDocs.add(cik);
    const start = budget;
    for (const f of cap > 0 ? unread(rec, newestOnly) : []) {
      const spent = start - budget;
      // A Form 4 is one request; a schedule two (its SEC header, then the document).
      const cost = f.form === "4" ? 1 : 2;
      if (spent >= cap || budget <= 0) break;
      if (budget < cost) continue;
      if (f.form === "4") await readForm4(cik, d, f);
      else await readSchedule(cik, d, f);
    }
    saveDocs();
    return start - budget;
  }

  /**
   * The next read of this session. Own names (a Stock tab ask, held, then
   * watched) before linked companies, and linked companies only once the
   * own names have nothing left to read. Within each: every company's first
   * look (its list and newest filings) in tier order, then the rest of each
   * company's window, at most FIRST_LOOK_DOCS requests per company per
   * session. Reads left for a later session end this one.
   */
  function nextRead(looked: ReadonlySet<string>, spent: ReadonlyMap<string, number>, filled: ReadonlySet<string>): { ticker: string; first: boolean } | null {
    const own = work.filter((j) => j.tier < TIER.linked).sort((a, b) => a.tier - b.tier);
    const linked = work.filter((j) => j.tier >= TIER.linked);
    for (const group of [own, linked]) {
      const first = group.find((j) => !looked.has(j.ticker));
      if (first) return { ticker: first.ticker, first: true };
      const rest = group.find((j) => !filled.has(j.ticker) && (spent.get(j.ticker) ?? 0) < FIRST_LOOK_DOCS && pendingFor(j.ticker));
      if (rest) return { ticker: rest.ticker, first: false };
      if (group.some((j) => pendingFor(j.ticker))) return null;
    }
    return null;
  }

  /** One read session; returns whether it asked EDGAR for anything. */
  async function session(): Promise<boolean> {
    // Once every own name has had its first look, the rest (older filings,
    // linked companies) is read in smaller sessions further apart.
    const background = !urgent && !work.some((j) => j.tier < TIER.linked && firstLookPending(j.ticker));
    const pause = background ? Math.max(gap, backgroundGap) : gap;
    const wait = lastSessionEnd + pause - now();
    if (wait > 0 && !urgent) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, wait);
        wake = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      wake = null;
    }
    budget = urgent || !background ? budgetPerSession : Math.min(budgetPerSession, backgroundBudget);
    urgent = false;
    const startBudget = budget;
    const looked = new Set<string>();
    const filled = new Set<string>();
    const spent = new Map<string, number>();
    try {
      while (budget > 0) {
        const next = nextRead(looked, spent, filled);
        if (!next) break;
        const t = next.ticker;
        try {
          if (next.first) {
            await readList(t);
            spent.set(t, (spent.get(t) ?? 0) + (await readDocs(t, true, FIRST_LOOK_DOCS)));
          } else {
            spent.set(t, (spent.get(t) ?? 0) + (await readDocs(t, false, FIRST_LOOK_DOCS - (spent.get(t) ?? 0))));
          }
        } catch (err) {
          console.warn(`[insiders] ${t} read failed:`, err instanceof Error ? err.message : String(err));
        }
        if (next.first) {
          looked.add(t);
          settle(t);
        } else filled.add(t);
      }
    } finally {
      lastSessionEnd = now();
      for (const t of [...waiters.keys()]) settle(t);
      // Kept: the companies with reads left, for the next session.
      for (let i = work.length - 1; i >= 0; i--) if (!pendingFor(work[i]!.ticker)) work.splice(i, 1);
    }
    return budget < startBudget;
  }

  /** Sessions until nothing queued is left to read (or a session gets nowhere: the next ask starts again). */
  async function run(): Promise<void> {
    try {
      while (work.length > 0) {
        if (!(await session())) break;
      }
    } finally {
      work.length = 0;
      for (const t of [...waiters.keys()]) settle(t);
      worker = null;
    }
  }

  /** Queue the companies with something to read; resolves when each has had its first look. */
  function enqueue(jobs: readonly Job[], front: boolean): Promise<void> {
    const todo = jobs.filter((j) => pendingFor(j.ticker));
    if (todo.length === 0) return Promise.resolve();
    const promises = todo.map(
      (j) =>
        new Promise<void>((resolve) => {
          const list = waiters.get(j.ticker);
          if (list) list.push(resolve);
          else waiters.set(j.ticker, [resolve]);
        }),
    );
    for (const j of todo) {
      const at = work.findIndex((w) => w.ticker === j.ticker);
      if (at >= 0) {
        // A Stock tab ask keeps its place in front until read; a name changing scope moves.
        if (work[at]!.tier === TIER.focus && !front) continue;
        work.splice(at, 1);
      }
      work.push(j);
    }
    if (front) {
      urgent = true;
      // A background session gets a full budget for the Stock tab's company.
      if (worker) budget = Math.max(budget, budgetPerSession);
      wake?.();
    }
    if (!worker) worker = run();
    return Promise.all(promises).then(() => undefined);
  }

  // ---- the answer -------------------------------------------------------

  function eventsFor(entries: readonly ScopeEntry[], today: string): InsiderEvent[] {
    const recs = loadCompanies();
    const all: InsiderEvent[] = [];
    for (const entry of entries) {
      const rec = recs[entry.ticker];
      if (!rec?.cik) continue;
      const d = docsFor(rec.cik);
      const trades = rec.form4.flatMap((f) => d.form4[f.accession] ?? []);
      const schedules = rec.schedules.flatMap((f) => {
        const read = d.schedules[f.accession];
        return read ? [read] : [];
      });
      all.push(...companyEvents(trades, schedules, { ticker: entry.ticker, today, scope: entry.scope, via: entry.via }));
    }
    return rankEvents(all).slice(0, MAX_EVENTS);
  }

  function answer(entries: readonly ScopeEntry[]): InsiderActivityAnswer {
    const today = nyYmdOf(now());
    const recs = loadCompanies();
    const checked = entries.map((e) => recs[e.ticker]?.checkedAt).filter((n): n is number => typeof n === "number");
    return {
      ok: true,
      today,
      events: eventsFor(entries, today),
      companies: entries.length,
      pending: entries.filter((e) => pendingFor(e.ticker)).length,
      checkedAt: checked.length > 0 ? new Date(Math.min(...checked)).toISOString() : null,
    };
  }

  return {
    async activity(request) {
      fs.mkdirSync(deps.dir, { recursive: true });
      if (request.focus) {
        const t = request.focus;
        const scope = request.held.includes(t) ? "held" : request.watchlist.includes(t) ? "watchlist" : "focus";
        const entries: ScopeEntry[] = [{ ticker: t, scope, via: null }];
        let timer: ReturnType<typeof setTimeout> | null = null;
        await Promise.race([
          enqueue([{ ticker: t, tier: TIER.focus }], true),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, FOCUS_WAIT_MS);
          }),
        ]);
        if (timer) clearTimeout(timer);
        return answer(entries);
      }
      const edges = await deps.graphEdges().catch(() => [] as LinkEdge[]);
      const entries = buildScope(request.held, request.watchlist, edges);
      void enqueue(
        entries.map((e) => ({ ticker: e.ticker, tier: TIER[e.scope] })),
        false,
      );
      return answer(entries);
    },
    peek(request) {
      return answer(buildScope(request.held, request.watchlist, []));
    },
    idle() {
      return worker ?? Promise.resolve();
    },
  };
}
