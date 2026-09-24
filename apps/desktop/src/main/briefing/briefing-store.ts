/**
 * Handover briefing: what is kept on disk between two openings of the panel.
 *
 * One report file per user, target session and book, so a reader who closes
 * and reopens the panel is not made to wait for seventeen market reads again,
 * and so the narrative service can find the exact report a narrative was asked
 * for. Beside the reports, one `narratives.json` holds the model-written
 * paragraphs, the stories written in the same call, and the count that bounds
 * how many are written per session.
 *
 * Electron-free: the directory is a constructor argument, so the whole store
 * runs against a temp dir in a test. The cache rules are exported as pure
 * functions for the same reason.
 */

import fs from "node:fs";
import path from "node:path";
import {
  BRIEFING_SCHEMA_VERSION,
  mergeHoldings,
  type BriefingHolding,
  type BriefingNarrative,
  type BriefingPhase,
  type BriefingReport,
  type BriefingSectionKey,
  type Story,
} from "../../shared/briefing-types";
import { readJson, writeJsonAtomic } from "./json-file";

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

/** Two trading weeks: long enough to look back at last week's handover, short enough that the folder stays small. */
export const REPORT_MAX_AGE_MS = 14 * DAY_MS;

export const MAX_GENERATIONS_PER_SESSION = 3;
export const MIN_GENERATION_GAP_MS = 20 * MINUTE_MS;

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

/** FNV-1a, the function the narrative's facts hash and the Insight cache already key with. */
function fnv1a(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(36);
}

/**
 * Identifies a book by what is held, not by how the renderer happened to list
 * it: lots are merged and rows sorted first, so the same positions in another
 * order, or one position sent as two lots, land on the same cached report.
 * Shares are rounded to six places because fractional lots summed in a
 * different order differ in the last float digit, which is not a new book.
 */
export function holdingsHash(holdings: ReadonlyArray<Pick<BriefingHolding, "symbol" | "shares">>): string {
  const merged = mergeHoldings(holdings.map((h) => ({ symbol: h.symbol, shares: h.shares, cost_usd: 0 })));
  const rows = merged
    .map((h) => `${h.symbol}:${Number(h.shares.toFixed(6))}`)
    .sort();
  return fnv1a(rows.join("|"));
}

/**
 * What "the same book" means for a stored report, positions and cash together.
 * Cash belongs in it as much as the share counts do: equity, both exposures,
 * the overnight move and every implication's share of the book are computed
 * from it, so a book that was funded while the positions stood still is not
 * the book the stored report was written for. Rounded to the dollar, as the
 * renderer's own key is, because cash carries float residue after a fill and
 * residue is not a change. The two are folded into one hash so a report file
 * is still named by a single short value.
 */
export function bookHash(holdings: ReadonlyArray<Pick<BriefingHolding, "symbol" | "shares">>, cash: number): string {
  // A cash that is not a number is unknown, not empty. Rounding it to zero
  // would file it under the same report as a book that truly holds no cash.
  const dollars = Number.isFinite(cash) ? Math.round(cash) : "unknown";
  return fnv1a(`${holdingsHash(holdings)}|${dollars}`);
}

const CHAIN_SECTIONS: ReadonlySet<BriefingSectionKey> = new Set<BriefingSectionKey>(["chain_news", "quant", "risk"]);

/**
 * How long a stored report answers for.
 *
 * A failed chain section is nearly always the app's first minute: the engine
 * is asked before the renderer has handed over the token it authenticates
 * with. Holding that report for ten minutes would show "no chain coverage"
 * long after the chain became reachable, so it is kept just long enough to
 * absorb a burst of reopenings. Before the open, prices and headlines move and
 * the reader is watching, so ten minutes; at any other hour the overnight
 * picture is settled and thirty is plenty.
 */
export function reportTtlMs(report: Pick<BriefingReport, "degraded" | "window">): number {
  const degraded = Array.isArray(report.degraded) ? report.degraded : [];
  if (degraded.some((d) => CHAIN_SECTIONS.has(d.section))) return MINUTE_MS;
  return report.window?.phase === "pre_open" ? 10 * MINUTE_MS : 30 * MINUTE_MS;
}

export type StoredReport = {
  /** The machine's own clock when the file was written. Never the synthetic one: see `cacheUsable`. */
  saved_at: string;
  report: BriefingReport;
};

/**
 * Whether a stored report may be served instead of building a new one.
 *
 * Age is measured on the real clock even for a report built against a
 * developer clock: that clock stands still, so against it nothing would ever
 * expire. The phase has to match as well. A report stored at 19:55 ET says
 * "between sessions"; served at 20:05 ET it would keep saying so for half an
 * hour into the pre-open window it exists for.
 */
export function cacheUsable(stored: StoredReport | null, nowMs: number, phase: BriefingPhase): stored is StoredReport {
  if (!stored || !stored.report || stored.report.schema_version !== BRIEFING_SCHEMA_VERSION) return false;
  const savedAt = Date.parse(stored.saved_at);
  if (!Number.isFinite(savedAt)) return false;
  const age = nowMs - savedAt;
  // A negative age is a clock that was set back; the file is not from the future, it is unverifiable.
  if (age < 0 || age >= reportTtlMs(stored.report)) return false;
  return stored.report.window?.phase === phase;
}

export type NarrativeSession = {
  /** Model calls spent on this target session, successful or not. */
  generated: number;
  last_generated_at: string | null;
};

export type NarrativeBudget = { allowed: true } | { allowed: false; reason: string };

/**
 * Whether another model call may be spent on this target session.
 *
 * The facts hash moves whenever a lead index crosses a size band, so on a busy
 * morning it can move every few minutes, and each move asks for a new
 * paragraph. The cap and the gap are what stand between that and a model call
 * per refresh. The reasons are shown to the reader, so they are fixed strings.
 */
export function narrativeBudget(session: NarrativeSession | null, nowMs: number): NarrativeBudget {
  if (!session) return { allowed: true };
  if (session.generated >= MAX_GENERATIONS_PER_SESSION) {
    return { allowed: false, reason: "model budget for this session is used up" };
  }
  const last = session.last_generated_at === null ? Number.NaN : Date.parse(session.last_generated_at);
  if (Number.isFinite(last) && nowMs - last < MIN_GENERATION_GAP_MS) {
    return { allowed: false, reason: "a model narrative was written less than 20 minutes ago" };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export type ReportKey = {
  userKey: string;
  targetYmd: string;
  /** Positions and cash together: see `bookHash`. */
  bookHash: string;
  /** Built against a developer clock: kept apart so it can never be served as a real morning. */
  synthetic: boolean;
};

const USER_KEY_SHAPE = /^[a-z0-9-]{1,64}$/;
const YMD_SHAPE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_SHAPE = /^[a-z0-9]{1,16}$/;

const REPORT_FILE = /^report\.([a-z0-9-]{1,64})\.(\d{4}-\d{2}-\d{2})\.([a-z0-9]{1,16})\.json$/;
const DEV_DIR = "_dev";
const NARRATIVES_FILE = "narratives.json";
const NARRATIVES_SCHEMA_VERSION = 1;

type NarrativesFile = {
  schema_version: number;
  /** Keyed `userKey:targetYmd`. */
  sessions: Record<
    string,
    NarrativeSession & {
      by_facts: Record<string, BriefingNarrative>;
      /**
       * The stories settled on in the same model call, by the same facts hash.
       * Optional so a file written before stories existed still reads; a
       * narrative with no stories beside it is served alone.
       */
      stories_by_facts?: Record<string, Story[]>;
    }
  >;
};

function sessionKey(userKey: string, targetYmd: string): string {
  return `${userKey}:${targetYmd}`;
}

export class BriefingStore {
  constructor(private readonly dir: string) {}

  /**
   * Every part of the name comes from outside (a token claim, a request, a
   * hash of request data), so each is held to its shape before it touches a
   * path. A part that fails is a bug upstream, and throwing keeps it from
   * becoming a file written somewhere else.
   */
  private reportFile(key: ReportKey): string {
    if (!USER_KEY_SHAPE.test(key.userKey) || !YMD_SHAPE.test(key.targetYmd) || !HASH_SHAPE.test(key.bookHash)) {
      throw new Error("briefing store: malformed report key");
    }
    const name = `report.${key.userKey}.${key.targetYmd}.${key.bookHash}.json`;
    return key.synthetic ? path.join(this.dir, DEV_DIR, name) : path.join(this.dir, name);
  }

  readReport(key: ReportKey): StoredReport | null {
    const stored = readJson<StoredReport>(this.reportFile(key));
    return stored && typeof stored.saved_at === "string" && stored.report && typeof stored.report === "object" ? stored : null;
  }

  writeReport(key: ReportKey, report: BriefingReport, nowMs: number): void {
    const stored: StoredReport = { saved_at: new Date(nowMs).toISOString(), report };
    writeJsonAtomic(this.reportFile(key), stored);
    this.prune(nowMs);
  }

  /**
   * The newest stored report of this user and target session that was written
   * from exactly these facts. Developer-clock reports are not searched: a
   * narrative is never written for one.
   */
  findReportByFacts(userKey: string, targetYmd: string, factsHash: string): { key: ReportKey; stored: StoredReport } | null {
    let names: string[];
    try {
      names = fs.readdirSync(this.dir);
    } catch {
      return null;
    }
    let best: { key: ReportKey; stored: StoredReport } | null = null;
    for (const name of names) {
      const match = REPORT_FILE.exec(name);
      if (!match || match[1] !== userKey || match[2] !== targetYmd) continue;
      const key: ReportKey = { userKey, targetYmd, bookHash: match[3]!, synthetic: false };
      const stored = this.readReport(key);
      if (!stored || stored.report.facts_hash !== factsHash) continue;
      if (best === null || Date.parse(stored.saved_at) > Date.parse(best.stored.saved_at)) best = { key, stored };
    }
    return best;
  }

  /**
   * Swaps the narrative of a stored report, and the stories when given, and
   * leaves `saved_at` alone: the figures are as old as they were, and a later
   * narrative must not buy the report a second lifetime in the cache.
   */
  replaceNarrative(key: ReportKey, narrative: BriefingNarrative, stories?: Story[]): void {
    const stored = this.readReport(key);
    if (!stored) return;
    const report = stories === undefined ? { ...stored.report, narrative } : { ...stored.report, narrative, stories };
    writeJsonAtomic(this.reportFile(key), { ...stored, report } satisfies StoredReport);
  }

  private narrativesPath(): string {
    return path.join(this.dir, NARRATIVES_FILE);
  }

  private readNarratives(): NarrativesFile {
    const file = readJson<NarrativesFile>(this.narrativesPath());
    if (!file || file.schema_version !== NARRATIVES_SCHEMA_VERSION || file.sessions === null || typeof file.sessions !== "object") {
      return { schema_version: NARRATIVES_SCHEMA_VERSION, sessions: {} };
    }
    return file;
  }

  private writeNarratives(file: NarrativesFile, nowMs: number): void {
    // A session older than the reports it belongs to can never be asked for again.
    const oldest = new Date(nowMs - REPORT_MAX_AGE_MS).toISOString().slice(0, 10);
    for (const key of Object.keys(file.sessions)) {
      const ymd = key.slice(key.lastIndexOf(":") + 1);
      if (!YMD_SHAPE.test(ymd) || ymd < oldest) delete file.sessions[key];
    }
    writeJsonAtomic(this.narrativesPath(), file);
  }

  getNarrative(userKey: string, targetYmd: string, factsHash: string): BriefingNarrative | null {
    const narrative = this.readNarratives().sessions[sessionKey(userKey, targetYmd)]?.by_facts?.[factsHash];
    return narrative && typeof narrative.text === "string" && narrative.source === "model" ? narrative : null;
  }

  /**
   * The stories kept beside a model narrative, or null when none were. Only
   * answered where a model narrative is stored for the same facts: the two
   * were written in one call and are served together or not at all, so a
   * reader never sees model stories under a template lead.
   */
  getStories(userKey: string, targetYmd: string, factsHash: string): Story[] | null {
    if (this.getNarrative(userKey, targetYmd, factsHash) === null) return null;
    const stories = this.readNarratives().sessions[sessionKey(userKey, targetYmd)]?.stories_by_facts?.[factsHash];
    return Array.isArray(stories) ? stories : null;
  }

  narrativeSession(userKey: string, targetYmd: string): NarrativeSession | null {
    const session = this.readNarratives().sessions[sessionKey(userKey, targetYmd)];
    if (!session) return null;
    return {
      generated: typeof session.generated === "number" && Number.isFinite(session.generated) ? session.generated : 0,
      last_generated_at: typeof session.last_generated_at === "string" ? session.last_generated_at : null,
    };
  }

  /**
   * Counts a model call before it is made. Counting afterwards would let a
   * call that hangs, or a process that dies mid-call, go unrecorded, and those
   * are the calls a budget is for.
   */
  noteGeneration(userKey: string, targetYmd: string, nowMs: number): void {
    const file = this.readNarratives();
    const key = sessionKey(userKey, targetYmd);
    const session = file.sessions[key] ?? { generated: 0, last_generated_at: null, by_facts: {} };
    file.sessions[key] = {
      ...session,
      generated: (Number.isFinite(session.generated) ? session.generated : 0) + 1,
      last_generated_at: new Date(nowMs).toISOString(),
    };
    this.writeNarratives(file, nowMs);
  }

  putNarrative(userKey: string, targetYmd: string, factsHash: string, narrative: BriefingNarrative, nowMs: number, stories?: Story[]): void {
    const file = this.readNarratives();
    const key = sessionKey(userKey, targetYmd);
    const session = file.sessions[key] ?? { generated: 0, last_generated_at: null, by_facts: {} };
    file.sessions[key] = {
      ...session,
      by_facts: { ...(session.by_facts ?? {}), [factsHash]: narrative },
      ...(stories === undefined ? {} : { stories_by_facts: { ...(session.stories_by_facts ?? {}), [factsHash]: stories } }),
    };
    this.writeNarratives(file, nowMs);
  }

  /**
   * Removes report files past their age, here and under the developer folder,
   * and temp files a crashed write left behind. Only names this store writes
   * are touched: the folder also holds the corporate-actions cache and the
   * hand-written calendar override, and neither is this store's to delete.
   */
  prune(nowMs: number): void {
    for (const dir of [this.dir, path.join(this.dir, DEV_DIR)]) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const name of names) {
        const ours = REPORT_FILE.test(name) || /^report\..+\.tmp$/.test(name);
        if (!ours) continue;
        const file = path.join(dir, name);
        try {
          if (nowMs - fs.statSync(file).mtimeMs > REPORT_MAX_AGE_MS) fs.unlinkSync(file);
        } catch {
          // Locked or already gone: the next write tries again.
        }
      }
    }
  }
}
