/**
 * The channels the always-on engine service owns.
 *
 * One list, in the package both sides already depend on, because the two sides
 * disagreeing is the failure that would be hardest to see: the desktop would
 * forward a channel the server does not implement (a 404 the panel renders as
 * an empty card), or keep answering one locally that the server owns (stale
 * data from a chain that is no longer running). Typing the server's handler
 * map as `Record<EngineChannel, Handler>` turns both into compile errors.
 *
 * These are the deterministic chain's questions — what the Tracker has seen,
 * what Base made of it, what the Classifier ruled, what Propagation produced.
 * Anything that reads the local machine (risk, screen, gauge, analyst, auth,
 * window chrome) is deliberately absent: it stays in the desktop.
 */

export const ENGINE_CHANNELS = [
  // The Shift+T stream. Left off the list when the chain moved to the service,
  // so the panel read its header from the engine and its message list from the
  // local store: "running · 429 today" above a stream whose newest entry was
  // from the previous day. One panel, two sources, no error anywhere.
  "tracker:messages",
  "tracker:status",
  "tracker:config",
  "tracker:ticker-state",
  "tracker:benchmark-bars",
  "tracker:quant",
  "tracker:add-ticker",
  "tracker:remove-ticker",
  "tracker:run-cycle",
  "tracker:recompute",
  "base:config",
  "base:replay",
  "classifier:status",
  "classifier:verdicts",
  "classifier:set-enabled",
  "classifier:set-rescore",
  "classifier:run-cycle",
  "classifier:refresh-metadata",
  "propagation:status",
  "propagation:runs",
  "propagation:run",
  "propagation:absorption",
  "propagation:pair-history",
  "propagation:set-enabled",
  "propagation:set-surfacing",
  "propagation:run-cycle",
  "propagation:fast-path",

  // The engines that read the Tracker follow it to wherever it is actually
  // being polled. Risk is fed the reader's paper account over
  // `risk:account-update`, like any other channel.
  "risk:status",
  "risk:latest",
  "risk:history",
  "risk:recompute",
  "risk:account-update",
  "risk:set-card-enabled",
  "screen:status",
  "screen:findings",
  "screen:set-watchlist",
  "screen:emitted",
  "screen:rescan",
  "gauge:readout",
  "gauge:status",
  "gauge:tickers",
  "gauge:reload-config",
  "analyst:status",
  "analyst:outputs",
  "analyst:output-detail",
  "analyst:run-cycle",
  "analyst:set-enabled",
] as const;

export type EngineChannel = (typeof ENGINE_CHANNELS)[number];

const LOOKUP: ReadonlySet<string> = new Set(ENGINE_CHANNELS);

export function isEngineChannel(channel: string): channel is EngineChannel {
  return LOOKUP.has(channel);
}
