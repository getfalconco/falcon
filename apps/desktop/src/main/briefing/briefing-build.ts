/**
 * Handover briefing: from a validated request to a report, by way of the cache.
 *
 * The order is the whole point of this module: look for a stored report, join
 * a build that is already running, build, splice in a narrative a model wrote
 * earlier for the same facts, store. Everything it needs from the outside
 * (ports, store, clocks, the signed-in user) is injected, so the flow runs in
 * a test without Electron, a network or a model.
 */

import { gatherBriefing, resolveBriefingWindow } from "@meridian/research/briefing";
import type {
  BriefingPorts,
  BriefingReport,
  BriefingRequest,
  BriefingWindow,
} from "../../shared/briefing-types";
import { BriefingStore, bookHash, cacheUsable, narrativeBudget, type ReportKey } from "./briefing-store";

export type BriefingClock = { now: Date; synthetic: boolean };

/**
 * The clock a report is built against. A developer can pin it to rehearse a
 * Sunday evening or a holiday morning on a Tuesday afternoon; a packaged build
 * never reads the variable, so no shipped install can be talked into showing a
 * made-up morning as the real one.
 */
export function resolveClock(pinned: string | undefined, isPackaged: boolean, realNow: Date): BriefingClock {
  const raw = pinned?.trim();
  if (!isPackaged && raw) {
    const at = new Date(raw);
    if (!Number.isNaN(at.getTime())) return { now: at, synthetic: true };
  }
  return { now: realNow, synthetic: false };
}

export type BriefingBuildDeps = {
  store: BriefingStore;
  /** Built per report: the ports close over that report's window. */
  ports: (window: BriefingWindow | null) => BriefingPorts;
  clock: () => BriefingClock;
  /** The machine's clock, for cache age and the model budget. Never the pinned one. */
  realNowMs: () => number;
  userKey: () => string;
  modelConfigured: () => boolean;
};

export type BriefingBuildResult = { report: BriefingReport; source: "cache" | "fresh" };

export function createBriefingBuilder(deps: BriefingBuildDeps): {
  build(req: BriefingRequest): Promise<BriefingBuildResult>;
} {
  /** Two surfaces asking for the same book at once (the card and the panel) share one build. */
  const inFlight = new Map<string, Promise<BriefingBuildResult>>();

  /**
   * A model narrative written earlier for exactly these facts, and the stories
   * written in the same call, spliced over the template. The stories stand in
   * wholesale rather than by id: they were settled on the same facts hash, and
   * the hash is what says the evidence they rest on has not moved.
   */
  const withStoredNarrative = (report: BriefingReport, userKey: string): BriefingReport => {
    const narrative = deps.store.getNarrative(userKey, report.window.target_session_ymd, report.facts_hash);
    if (!narrative) return report;
    const stories = deps.store.getStories(userKey, report.window.target_session_ymd, report.facts_hash);
    return { ...report, narrative: { ...narrative, pending: false }, stories: stories ?? report.stories };
  };

  const run = async (req: BriefingRequest, clock: BriefingClock, window: BriefingWindow | null, key: ReportKey | null): Promise<BriefingBuildResult> => {
    const userKey = deps.userKey();

    // Whether the renderer is told a model version is on its way. It is only
    // told so when asking for one can succeed: a demo or developer-clock
    // report is never sent to a model, and a session whose budget is spent
    // would answer the follow-up with the same template it already has.
    let narrativePending = false;
    if (!req.demo && !clock.synthetic && window !== null && deps.modelConfigured()) {
      narrativePending = narrativeBudget(deps.store.narrativeSession(userKey, window.target_session_ymd), deps.realNowMs()).allowed;
    }

    const built = await gatherBriefing(req, clock.now, deps.ports(window), { syntheticNow: clock.synthetic, narrativePending });
    const report = req.demo || clock.synthetic ? built : withStoredNarrative(built, userKey);

    // A demo book is never written to disk, and neither is a report whose
    // window could not be resolved: it has no session to be filed under.
    if (key !== null) {
      try {
        deps.store.writeReport(key, report, deps.realNowMs());
      } catch (err) {
        // The report is still good; only the next opening pays for a rebuild.
        console.warn("[briefing] report not stored:", err instanceof Error ? err.message : String(err));
      }
    }
    return { report, source: "fresh" };
  };

  return {
    async build(req) {
      const clock = deps.clock();

      // The assembly survives a clock the session calendar cannot resolve and
      // ships an empty, marked report. Here it only means there is no target
      // session to key a cache entry by.
      let window: BriefingWindow | null = null;
      try {
        window = resolveBriefingWindow(clock.now);
      } catch {
        window = null;
      }

      // One value stands for the book in both keys below. It covers cash as
      // well as the positions: the renderer asks again when either moves, and
      // a key that ignored cash would answer a freshly funded account with the
      // stored report of the same positions and the old balance.
      const book = bookHash(req.holdings, req.cash);

      const key: ReportKey | null =
        req.demo || window === null
          ? null
          : {
              userKey: deps.userKey(),
              targetYmd: window.target_session_ymd,
              bookHash: book,
              synthetic: clock.synthetic,
            };

      if (key !== null && window !== null && !req.force) {
        const stored = deps.store.readReport(key);
        if (cacheUsable(stored, deps.realNowMs(), window.phase)) {
          const report = clock.synthetic ? stored.report : withStoredNarrative(stored.report, key.userKey);
          return { report, source: "cache" };
        }
      }

      const flightKey =
        key === null
          ? `unkeyed:${req.demo ? "demo" : "live"}:${book}`
          : `${key.synthetic ? "dev" : "live"}:${key.userKey}:${key.targetYmd}:${key.bookHash}`;
      const pending = inFlight.get(flightKey);
      if (pending) return pending;

      const task = run(req, clock, window, key).finally(() => inFlight.delete(flightKey));
      inFlight.set(flightKey, task);
      return task;
    },
  };
}
