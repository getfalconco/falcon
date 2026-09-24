/**
 * The engine's channel surface — the same names the desktop's IPC layer uses,
 * answered here instead of in the Electron main process.
 *
 * Why a map and not a generic dispatcher: this is a remote procedure call over
 * the public internet, so what may be called is an explicit, auditable list.
 * A channel that is not in this table does not exist, whatever the caller
 * sends. Arguments are read positionally and coerced at the edge for the same
 * reason — nothing here trusts its input's shape.
 *
 * Read channels are safe to call at any time. The write channels (`set-*`,
 * `run-cycle`, `add/remove-ticker`) change what the always-on chain does for
 * everyone, which is exactly why they sit behind the approved-user gate in
 * `auth.ts` rather than behind a shared secret.
 */

import type { EngineChannel } from "@meridian/research/engine-channels";
import { getTrackerEngine } from "@meridian/research/tracker";
import { bandHeadline, DEFAULT_SCREEN_CONFIG } from "@meridian/research/screen";
import { getClassifierHost } from "@meridian/research/classifier";
import { getPropagationHost } from "@meridian/research/propagation/engine";
import { getRiskHost } from "@meridian/research/risk";
import { getScreenHost } from "@meridian/research/screen";
import { getGaugeHost } from "@meridian/research/gauge";
import { getAnalystHost } from "@meridian/research/analyst";
import {
  BaseConfigStore,
  addDueAt,
  replayBase,
  type EarningsCalendar,
} from "@meridian/research/base";
import { getEventsPollStatus, listNewsArticles } from "@meridian/research/news";
import { eventsDir } from "./news-cycle.js";

type Handler = (args: unknown[]) => Promise<unknown> | unknown;


const str = (v: unknown): string => (typeof v === "string" ? v : "");
const bool = (v: unknown): boolean => v === true;
const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// Record<EngineChannel, …>: a channel the shared list names but this file does
// not implement is a compile error here, and one implemented but not listed is
// a compile error too. The desktop forwards exactly this set.
export const CHANNELS: Record<EngineChannel, Handler> = {
  // --- tracker -------------------------------------------------------------
  "tracker:messages": (a) => {
    const o = (a ?? {}) as { limit?: number; ticker?: string };
    return { ok: true, messages: getTrackerEngine().listMessages(o) };
  },
  "tracker:status": () => ({ ok: true, status: getTrackerEngine().getStatus() }),
  "tracker:config": () => ({ ok: true, config: getTrackerEngine().getConfig() }),
  "tracker:ticker-state": (a) => {
    const engine = getTrackerEngine();
    const state = engine.getTickerState(str(a[0]));
    if (!state) return { ok: false, error: `${str(a[0])} is not tracked` };
    return { ok: true, state, dataDir: engine.getDataDir() };
  },
  "tracker:benchmark-bars": () => ({ ok: true, benchmark: getTrackerEngine().getBenchmarkBars() }),
  "tracker:quant": async (a) => {
    const quant = await getTrackerEngine().getQuantContext(str(a[0]));
    return quant ? { ok: true, quant } : { ok: false, error: `${str(a[0])} is not tracked` };
  },
  "tracker:add-ticker": async (a) => {
    await getTrackerEngine().addTicker(str(a[0]));
    return { ok: true, status: getTrackerEngine().getStatus() };
  },
  "tracker:remove-ticker": (a) => {
    getTrackerEngine().removeTicker(str(a[0]));
    return { ok: true, status: getTrackerEngine().getStatus() };
  },
  "tracker:run-cycle": async () => {
    await getTrackerEngine().runCycle();
    return { ok: true, status: getTrackerEngine().getStatus() };
  },

  "tracker:recompute": async () => {
    const result = await getTrackerEngine().recomputeCloseState();
    return { ok: true, ...result, status: getTrackerEngine().getStatus() };
  },

  // --- base ----------------------------------------------------------------
  "base:config": () => {
    const store = new BaseConfigStore();
    const config = store.load();
    // The panel reads a flat projection, not the raw BaseConfig — mirror it
    // exactly, or every field it renders comes back undefined.
    return {
      ok: true,
      config: {
        measurementSilenceMs: config.window.measurementSilenceMs,
        hardCapMs: config.window.hardCapMs,
        relatedLookbackMs: config.window.relatedLookbackMs,
        bands: config.priority.bands,
        proximityMultipliers: config.priority.proximityMultipliers,
        tagWeights: config.tags.weights,
        positiveBonusCap: config.tags.positiveBonusCap,
        configFile: store.configFile,
        rescoreEnabled: config.classifier.rescoreEnabled,
      },
    };
  },
  "base:replay": (a) => {
    const options = (a[0] ?? {}) as { limit?: number; ticker?: string; held?: string[]; watchlist?: string[] };
    const engine = getTrackerEngine();
    const config = new BaseConfigStore().load();
    const messages = engine.listMessages({
      limit: num(options.limit) ?? 1000,
      ticker: options.ticker ? str(options.ticker) : undefined,
    });
    // The Tracker’s confirmed calendar drives the pre-earnings preview cap;
    // the stream’s own scheduled_event messages are merged in by replayBase.
    const calendar: EarningsCalendar = new Map();
    for (const t of engine.getStatus().tickers) {
      const state = engine.getTickerState(t.ticker);
      for (const e of state?.scheduledEarnings ?? []) {
        if (e.confirmed) addDueAt(calendar, t.ticker, e.dueAt);
      }
    }
    return {
      ok: true,
      result: replayBase(messages, {
        config,
        userContext: { held: options.held ?? [], watchlist: options.watchlist ?? [] },
        // Real wall clock, so a window that has since elapsed reads as closed.
        now: new Date().toISOString(),
        verdictLookup: getClassifierHost().verdictLookup(config),
        earningsCalendar: calendar,
      }),
    };
  },

  // --- classifier ----------------------------------------------------------
  "classifier:status": () => ({ ok: true, status: getClassifierHost().status() }),
  "classifier:verdicts": (a) => {
    const options = (a[0] ?? {}) as { limit?: number };
    return { ok: true, verdicts: getClassifierHost().listVerdicts(num(options.limit) ?? 200) };
  },
  "classifier:set-enabled": (a) => {
    getClassifierHost().setEnabled(bool(a[0]));
    return { ok: true, status: getClassifierHost().status() };
  },
  "classifier:set-rescore": (a) => {
    getClassifierHost().setRescoreEnabled(bool(a[0]));
    return { ok: true, status: getClassifierHost().status() };
  },
  "classifier:run-cycle": async (a) => {
    const options = (a[0] ?? {}) as { limit?: number; dryRun?: boolean; maxRequests?: number };
    const run = await getClassifierHost().runCycle({
      limit: num(options.limit),
      dryRun: bool(options.dryRun),
      maxRequests: num(options.maxRequests),
    });
    return { ok: true, run, status: getClassifierHost().status() };
  },
  "classifier:refresh-metadata": async (a) => {
    const result = await getClassifierHost().refreshMetadata(bool(a[0]));
    return { ok: true, ...result, status: getClassifierHost().status() };
  },

  // --- propagation ---------------------------------------------------------
  "propagation:status": () => ({ ok: true, status: getPropagationHost().status() }),
  "propagation:runs": (a) => {
    // Every filter the rail passes, defaulted the way the desktop defaults
    // them: 200 rows, fixtures excluded unless asked for.
    const options = (a[0] ?? {}) as {
      limit?: number;
      status?: "ok" | "stage1_only" | "failed";
      ticker?: string;
      currentOnly?: boolean;
      openOnly?: boolean;
      synthetic?: "exclude" | "only" | "all";
    };
    return { ok: true, runs: getPropagationHost().listRuns({ limit: 200, ...options }) };
  },
  "propagation:run": (a) => {
    const host = getPropagationHost();
    const run = host.getRun(str(a[0]));
    if (!run) return { ok: false, error: "no such run" };
    return { ok: true, run, chain: host.runsForIncident(run.incident_id) };
  },
  "propagation:absorption": (a) => ({
    ok: true,
    curve: getPropagationHost().absorption(str(a[0]), str(a[1])),
  }),
  "propagation:pair-history": (a) => ({
    ok: true,
    history: getPropagationHost().pairHistory(str(a[0]), str(a[1])),
  }),
  "propagation:set-enabled": (a) => {
    const host = getPropagationHost();
    host.setEnabled(bool(a[0]));
    return { ok: true, status: host.status() };
  },
  "propagation:set-surfacing": (a) => {
    const host = getPropagationHost();
    host.setSurfacingEnabled(bool(a[0]));
    return { ok: true, status: host.status() };
  },
  "propagation:run-cycle": async (a) => {
    const options = (a[0] ?? {}) as { limit?: number; dryRun?: boolean; maxRequests?: number; stage2?: boolean };
    const host = getPropagationHost();
    const run = await host.runCycle({
      limit: num(options.limit),
      dryRun: bool(options.dryRun),
      maxRequests: num(options.maxRequests),
      stage2: options.stage2 !== false,
    });
    return { ok: true, run, status: host.status() };
  },
  "propagation:fast-path": async (a) => ({
    ok: true,
    run: await getPropagationHost().runFastPath(str(a[0]).toUpperCase()),
  }),

  // --- risk ----------------------------------------------------------------
  "risk:status": () => ({ ok: true, status: getRiskHost().status() }),
  "risk:latest": () => ({ ok: true, ...getRiskHost().latest() }),
  "risk:history": (a) => {
    const options = (a[0] ?? {}) as { limit?: number };
    return { ok: true, history: getRiskHost().history(num(options.limit) ?? 200) };
  },
  "risk:recompute": async () => {
    const host = getRiskHost();
    await host.recomputeNow();
    return { ok: true, ...host.latest(), status: host.status() };
  },
  "risk:account-update": (a) => {
    // The reader's paper book. Guarded exactly as the desktop guarded it: a
    // payload that is not the paper account is refused, not coerced.
    const push = a[0] as { account?: string; positions?: unknown } | null;
    if (!push || push.account !== "paper" || !Array.isArray(push.positions)) {
      return { ok: false, error: "invalid account payload" };
    }
    getRiskHost().setAccount(push as never);
    return { ok: true };
  },
  "risk:set-card-enabled": (a) => {
    const host = getRiskHost();
    host.setCardEnabled(bool(a[0]));
    return { ok: true, status: host.status() };
  },

  // --- screen --------------------------------------------------------------
  "screen:status": () => ({ ok: true, status: getScreenHost().status() }),
  "screen:findings": () => ({ ok: true, ...getScreenHost().findings() }),
  "screen:set-watchlist": (a) => {
    const tickers = Array.isArray(a[0]) ? (a[0] as unknown[]).map(str).filter(Boolean) : [];
    getScreenHost().setWatchlist(tickers);
    return { ok: true };
  },
  "screen:emitted": (a) => {
    const options = (a[0] ?? {}) as { limit?: number; ticker?: string };
    return {
      ok: true,
      messages: getScreenHost().messageStore.read({
        limit: num(options.limit) ?? 200,
        ticker: options.ticker ? str(options.ticker) : undefined,
      }),
    };
  },
  "screen:rescan": async () => {
    const host = getScreenHost();
    const scan = await host.rescanNow();
    return { ok: true, scan, ...host.findings() };
  },

  // --- gauge ---------------------------------------------------------------
  "gauge:readout": (a) => {
    const req = (a[0] ?? {}) as { ticker?: string };
    if (!str(req.ticker)) return { ok: false, error: "ticker required" };
    return { ok: true, ...getGaugeHost().readout(req as never) };
  },
  "gauge:status": () => ({ ok: true, status: getGaugeHost().status() }),
  "gauge:tickers": () => ({ ok: true, tickers: getGaugeHost().tickers() }),
  "gauge:reload-config": () => {
    const host = getGaugeHost();
    host.reloadConfig();
    return { ok: true, status: host.status() };
  },

  // --- analyst -------------------------------------------------------------
  "analyst:status": () => ({ ok: true, status: getAnalystHost().status() }),
  "analyst:outputs": (a) => {
    const options = (a[0] ?? {}) as Record<string, unknown>;
    return { ok: true, outputs: getAnalystHost().listOutputs({ limit: 200, ...options } as never) };
  },
  "analyst:output-detail": (a) => {
    // Two positional args on the desktop: (incidentId, requestId).
    const detail = getAnalystHost().outputDetail(str(a[0]), str(a[1]));
    return detail ? { ok: true, detail } : { ok: false, error: "output not found" };
  },
  "analyst:run-cycle": async (a) => {
    const host = getAnalystHost();
    const run = await host.runCycle((a[0] ?? {}) as never);
    return { ok: true, run, status: host.status() };
  },
  "analyst:set-enabled": (a) => {
    const host = getAnalystHost();
    host.setEnabled(bool(a[0]));
    return { ok: true, status: host.status() };
  },

  // --- news ----------------------------------------------------------------
  // The feed: every story the poll has filed, newest first, each with the
  // sector of the names it was fetched for — read off the classifier's
  // company table, which is the one place this service already knows a
  // sector. The poll's own status rides along so the card can say how fresh
  // the feed is.
  "news:feed": async (a) => {
    const o = (a[0] ?? {}) as { days?: number; limit?: number };
    const articles = await listNewsArticles(eventsDir(), {
      days: num(o.days) ?? 3,
      limit: num(o.limit) ?? 300,
    });
    const metadata = getClassifierHost().metadata;
    const sectorOf = new Map<string, string | null>();
    const sector = (t: string): string | null => {
      if (!sectorOf.has(t)) sectorOf.set(t, metadata.context(t).sector);
      return sectorOf.get(t) ?? null;
    };
    return {
      ok: true,
      articles: articles.map((x) => ({
        ...x,
        sectors: [...new Set(x.tickers.map(sector).filter((s): s is string => Boolean(s)))],
      })),
      status: getEventsPollStatus(),
    };
  },
};

export function channelNames(): string[] {
  return Object.keys(CHANNELS).sort();
}
