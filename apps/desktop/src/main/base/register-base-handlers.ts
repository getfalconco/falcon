import { BaseConfigStore, addDueAt, replayBase, type EarningsCalendar } from "@meridian/research/base";
import { getTrackerEngine } from "@meridian/research/tracker";
import { registerIpcHandler } from "../ipc-register";
import { getClassifierHost } from "../classifier/classifier-host";
import { stableIncidentId } from "@meridian/research/analyst";
import { ScreenMessageStore } from "@meridian/research/screen";

/**
 * Base Engine IPC surface — read-only.
 *
 * Base has no live dispatch loop yet (§5 is unbuilt), so the panel runs the
 * §9 "replay first" step instead: the incident model, priority scorer and
 * routing table are run over Tracker's recorded message stream and the result
 * is returned for inspection. Nothing is dispatched and nothing is persisted.
 */

export type BaseReplayRequest = {
  limit?: number;
  ticker?: string;
  /** Simulated user context so the proximity multiplier can be inspected. */
  held?: string[];
  watchlist?: string[];
};

export function registerBaseHandlers(): void {
  const store = new BaseConfigStore();

  registerIpcHandler("base:replay", (_event, options?: BaseReplayRequest) => {
    try {
      const engine = getTrackerEngine();
      // S2: Screen's emitted tape_structure messages are part of the stream
      // Base coordinates, so the replay panel shows them in their incidents
      // whether or not the dispatch flag is on.
      let screenMessages: ReturnType<ScreenMessageStore["read"]> = [];
      try {
        screenMessages = new ScreenMessageStore().read({ limit: 500, ticker: options?.ticker });
      } catch {
        screenMessages = [];
      }
      const messages = [
        ...engine.listMessages({ limit: options?.limit ?? 1000, ticker: options?.ticker }),
        ...screenMessages,
      ].sort((x, y) => x.timestamp.localeCompare(y.timestamp) || x.id.localeCompare(y.id));
      const config = store.load();
      // Pre-earnings preview cap: the Tracker's confirmed earnings calendar
      // (the stream's own scheduled_event messages are merged in by replayBase).
      const earningsCalendar: EarningsCalendar = new Map();
      for (const t of engine.getStatus().tickers) {
        const state = engine.getTickerState(t.ticker);
        for (const s of state?.scheduledEarnings ?? []) if (s.confirmed) addDueAt(earningsCalendar, t.ticker, s.dueAt);
      }
      const result = replayBase(messages, {
        config,
        userContext: { held: options?.held ?? [], watchlist: options?.watchlist ?? [] },
        // Real wall clock, so a window that has since elapsed reads as closed.
        now: new Date().toISOString(),
        // B9: Classifier verdicts — propagation candidates always, re-score
        // only when config.classifier.rescoreEnabled (Phase B).
        verdictLookup: getClassifierHost().verdictLookup(config),
        earningsCalendar,
        // Same deterministic ids the Analyst host uses, so an analyst output
        // links back to the incident shown here.
        makeIncidentId: stableIncidentId,
      });
      return { ok: true as const, result };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  registerIpcHandler("base:config", () => {
    try {
      const config = store.load();
      return {
        ok: true as const,
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
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
}
