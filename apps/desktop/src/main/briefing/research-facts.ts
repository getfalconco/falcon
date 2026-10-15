/**
 * Handover briefing: filings and insiders.
 *
 * What the desktop's own SEC readers already know about the reader's names,
 * put in the briefing as records: a red flag a filing did not carry before,
 * an insider cluster, a linked company reporting this session, new risk
 * factor headings, a customer named for the first time, a share that moved.
 * Each fact keeps its form, its date and its link on sec.gov; the panel words
 * it and no model sees it.
 *
 * Read from what each module keeps, never by asking a provider:
 *
 *   filings      `cached(ticker)`: the last comparison kept on disk
 *   insiders     `peek(...)`: the events read so far, nothing queued
 *   readthrough  `radar(...)`: the radar's own answer, which sits behind a
 *                ten-minute answer cache and per-day caches for every read
 *
 * Every source is optional and fails on its own: one that throws or does not
 * answer in time is listed in `unavailable`, and the facts from the others
 * stand. The ranking and the cap are the engine's (`rankBriefingFacts`).
 *
 * Electron-free: the services and the clock are injected.
 */

import { rankBriefingFacts } from "@meridian/research/briefing";
import type { BriefingFact, BriefingFactSource, BriefingResearchFacts } from "../../shared/briefing-types";
import type { FilingChangeItem, FilingChanges } from "../../shared/filing-changes";
import { nextSession, nyYmdOf } from "../../shared/earnings-time";
import type { InsiderActivityAnswer, InsiderEvent } from "../../shared/insider-types";
import type { ParsedReadthroughRequest, ReadthroughResult, ReadthroughRow } from "../../shared/readthrough-types";

/** A filing change is in the briefing for this many days after it was filed. */
export const FILING_LOOKBACK_DAYS = 7;
/** An insider event is in the briefing for this many days after its latest filing. */
export const INSIDER_LOOKBACK_DAYS = 3;
/** The insider module's significance (0 to 100) an event needs to be listed here. */
export const INSIDER_MIN_SCORE = 40;
/** Customers or suppliers named for the first time, per filing: a long list is one company's story, not five. */
export const MAX_NAMED_PER_FILING = 2;
/** How long one source may take before the briefing goes on without it. */
export const SOURCE_TIMEOUT_MS = 4000;
/** Names one ask reads (held first), the filing changes module's own bound. */
export const MAX_NAMES = 40;

export type FactNames = {
  held: string[];
  watchlist: string[];
  /** Held names with their share counts, for the read-through's account weights. */
  positions: Array<{ ticker: string; shares: number | null }>;
};

export type ResearchFactsDeps = {
  filings?: () => { cached(ticker: string): FilingChanges | null };
  insiders?: () => { peek(request: { held: readonly string[]; watchlist: readonly string[] }): InsiderActivityAnswer };
  readthrough?: () => { radar(request: ParsedReadthroughRequest): Promise<ReadthroughResult> };
  // TODO(guidance): the guidance track record (main/guidance) has no read of
  // what it keeps without fetching: `track(ticker)` reads EDGAR and asks the
  // model on a miss, which the briefing must not set off. When the service
  // gains a cache-only read, add a "guidance" source here (a missed or met
  // guide in a release filed in the lookback window, as a record with its
  // 8-K link) and give it a rank in packages/research/src/briefing/facts.ts.
  now: () => number;
  timeoutMs?: number;
};

const RED_FLAGS = new Set<FilingChangeItem["kind"]>([
  "restatement",
  "going_concern",
  "material_weakness",
  "auditor_change",
  "auditor_name",
  "late_filing",
]);

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);
}

function within(date: string, today: string, days: number): boolean {
  const age = daysBetween(date, today);
  return Number.isFinite(age) && age >= 0 && age <= days;
}

type Scope = "held" | "watchlist";

/**
 * One name's filing changes as facts: the notable items filed in the last
 * week that the filing before did not already carry. New risk factor headings
 * of one filing are one fact with their count, the first heading kept.
 */
export function factsFromFilings(changes: FilingChanges, scope: Scope, today: string): BriefingFact[] {
  const ticker = changes.ticker;
  const out: BriefingFact[] = [];
  const risk = new Map<string, Extract<BriefingFact, { kind: "risk_factor" }>>();
  const named = new Map<string, number>();
  for (const item of changes.items ?? []) {
    if (!item.notable || item.repeat || !within(item.date, today, FILING_LOOKBACK_DAYS)) continue;
    const base = { ticker, scope, date: item.date, url: item.url, form: item.form };
    if (RED_FLAGS.has(item.kind)) {
      out.push({
        ...base,
        id: `filing:${ticker}:${item.id}`,
        kind: "red_flag",
        flag: item.kind as Extract<BriefingFact, { kind: "red_flag" }>["flag"],
        name: item.kind === "auditor_name" ? item.name : null,
        previous: item.kind === "auditor_name" ? item.previous : null,
      });
    } else if (item.kind === "risk_new" || item.kind === "quarter_risk_new") {
      const key = `${item.form}|${item.date}`;
      const known = risk.get(key);
      if (known) known.count += 1;
      else risk.set(key, { ...base, id: `filing:${ticker}:risk:${item.form}:${item.date}`, kind: "risk_factor", count: 1, heading: item.text });
    } else if ((item.kind === "customer_named" || item.kind === "supplier_named") && item.name) {
      const key = `${item.form}|${item.date}`;
      const count = named.get(key) ?? 0;
      if (count >= MAX_NAMED_PER_FILING) continue;
      named.set(key, count + 1);
      out.push({
        ...base,
        id: `filing:${ticker}:${item.id}`,
        kind: "counterparty_named",
        role: item.kind === "customer_named" ? "customer" : "supplier",
        name: item.name,
        pct: item.pct,
      });
    } else if ((item.kind === "customer_share" || item.kind === "customer_share_new") && item.name && item.pct !== null) {
      const basis = item.detail === "receivables" ? "receivables" : "revenue";
      out.push({
        ...base,
        id: `filing:${ticker}:${item.id}`,
        kind: "share_change",
        name: item.name,
        basis,
        pct: item.pct,
        previous_pct: item.kind === "customer_share" ? item.previousPct : null,
      });
    }
  }
  return [...out, ...risk.values()];
}

/** The day an insider event became public: the latest filing behind it. */
function filedOn(e: InsiderEvent): { date: string; url: string | null } {
  let date = "";
  let url: string | null = null;
  for (const t of e.trades ?? []) {
    if (typeof t.filedAt === "string" && t.filedAt > date) {
      date = t.filedAt;
      url = t.url;
    }
  }
  if (e.filing && e.filing.filedAt > date) {
    date = e.filing.filedAt;
    url = e.filing.url;
  }
  return { date: date || e.date, url };
}

/**
 * The reader's own names' insider events, filed in the last three days, at
 * or above the significance bar. Linked companies are left to the insider
 * card: the briefing is about the names the reader holds or watches.
 */
export function factsFromInsiders(events: readonly InsiderEvent[], today: string): BriefingFact[] {
  const out: BriefingFact[] = [];
  for (const e of events) {
    if (e.scope !== "held" && e.scope !== "watchlist") continue;
    if (!(e.score >= INSIDER_MIN_SCORE)) continue;
    const { date, url } = filedOn(e);
    if (!within(date, today, INSIDER_LOOKBACK_DAYS)) continue;
    out.push({
      id: `insider:${e.id}`,
      kind: "insider",
      ticker: e.ticker,
      scope: e.scope,
      date,
      url,
      // "Form 4" spelled out: a bare "4" beside a date reads as a count.
      form: e.filing ? e.filing.form : "Form 4",
      event: e.kind,
      insiders: e.insiders,
      value_usd: e.value,
      role: e.roles?.[0] ?? null,
      filer: e.filing?.filer ?? null,
      score: e.score,
    });
  }
  return out;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Held names' linked companies reporting from today through the session
 * after the one this report hands over to. The measured line travels with
 * it: the sample size always, the figures only from three reports up (the
 * read-through module's own minimum, under which `stats` is null).
 */
export function factsFromReadthrough(rows: readonly ReadthroughRow[], today: string, targetYmd: string): BriefingFact[] {
  const last = nextSession(targetYmd);
  const out: BriefingFact[] = [];
  for (const row of rows) {
    if (!row.held || row.kind !== "upcoming" || !row.date) continue;
    if (row.date < today || row.date > last) continue;
    out.push({
      id: `linked:${row.id}:${row.date}`,
      kind: "linked_report",
      ticker: row.holding,
      scope: "held",
      date: row.date,
      url: row.sourceUrl,
      form: row.form,
      counterparty: row.counterparty,
      relation: row.relation,
      time: row.time,
      on_session: row.date <= targetYmd,
      sample: row.sample,
      with_it: row.stats ? row.stats.withIt : null,
      avg_abs_move_pct: row.stats ? round1(row.stats.avgAbsMove * 100) : null,
    });
  }
  return out;
}

/** Settles with the source's facts, or null when it threw or ran past the timeout. */
async function settle(run: () => Promise<BriefingFact[]> | BriefingFact[], timeoutMs: number): Promise<BriefingFact[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(run), late]);
  } catch (err) {
    console.warn("[briefing] a filings source failed:", err instanceof Error ? err.message : String(err));
    return null;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Every source asked at once, each under its own timeout; the facts ranked
 * and capped. Never throws: with no source at all the answer is empty.
 */
export async function collectResearchFacts(deps: ResearchFactsDeps, names: FactNames, targetYmd: string): Promise<BriefingResearchFacts> {
  const timeoutMs = deps.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const held = [...new Set(names.held)];
  const watchlist = [...new Set(names.watchlist)].filter((t) => !held.includes(t));
  if (held.length === 0 && watchlist.length === 0) return { facts: [], unavailable: [] };
  const today = nyYmdOf(deps.now());
  const scopeOf = (t: string): Scope => (held.includes(t) ? "held" : "watchlist");

  const jobs: Array<{ source: BriefingFactSource; run: () => Promise<BriefingFact[]> | BriefingFact[] }> = [];
  const filingsOf = deps.filings;
  if (filingsOf) {
    jobs.push({
      source: "filings",
      run: () => {
        const service = filingsOf();
        return [...held, ...watchlist].slice(0, MAX_NAMES).flatMap((t) => {
          const changes = service.cached(t);
          return changes ? factsFromFilings(changes, scopeOf(t), today) : [];
        });
      },
    });
  }
  const insidersOf = deps.insiders;
  if (insidersOf) {
    jobs.push({
      source: "insiders",
      run: () => {
        const answer = insidersOf().peek({ held, watchlist });
        return factsFromInsiders(answer.events, today);
      },
    });
  }
  const readthroughOf = deps.readthrough;
  if (readthroughOf && held.length > 0) {
    jobs.push({
      source: "readthrough",
      run: async () => {
        const answer = await readthroughOf().radar({ held: names.positions, watchlist, focus: null });
        if (!answer || answer.ok !== true) throw new Error("read-through answered without rows");
        return factsFromReadthrough(answer.rows, answer.today || today, targetYmd);
      },
    });
  }

  const settled = await Promise.all(jobs.map((job) => settle(job.run, timeoutMs)));
  const facts: BriefingFact[] = [];
  const unavailable: BriefingFactSource[] = [];
  settled.forEach((result, i) => {
    if (result === null) unavailable.push(jobs[i]!.source);
    else facts.push(...result);
  });
  return { facts: rankBriefingFacts(facts), unavailable };
}
