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
  // `risk:account-update`, like any other channel. Every risk channel is
  // answered for the signed-in user only: the service keys risk state by the
  // user id it verified from the session token, never by anything in `args`.
  "risk:status",
  "risk:latest",
  "risk:history",
  "risk:recompute",
  "risk:account-update",
  "risk:set-card-enabled",
  // Account deletion: erase the caller's own risk state (paper-account copy
  // and snapshot history). On the service it is scoped to the verified user
  // like every risk channel; locally it clears this machine's risk files.
  "risk:delete-user-data",
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

  // The news feed the dashboard's News card reads: every story the server's
  // poll has fetched, with the classifier's reading where there is one. The
  // poll itself runs only on the service — the desktop never asks Finnhub for
  // this — so the feed follows it there.
  "news:feed",
] as const;

export type EngineChannel = (typeof ENGINE_CHANNELS)[number];

const LOOKUP: ReadonlySet<string> = new Set(ENGINE_CHANNELS);

export function isEngineChannel(channel: string): channel is EngineChannel {
  return LOOKUP.has(channel);
}

/**
 * The channels that change what the shared chain does for EVERY user: the
 * on/off switches and calibration flags, the manual "run now" buttons that
 * spend the shared provider budget, and removing a name from the shared
 * universe. Any approved user could call these, so one member could switch
 * the classifier off for everybody. They are answered for staff only (see
 * `isEngineStaff`); everyone else gets a 403 with a plain reason.
 *
 * Deliberately NOT here: `tracker:add-ticker` (the portfolio coverage flow
 * adds a member's holdings to the universe), the per-user risk and screen
 * writes (`risk:account-update`, `risk:recompute`, `screen:set-watchlist`,
 * `risk:delete-user-data`), which only touch the caller's own state.
 */
export const STAFF_ENGINE_CHANNELS = [
  "tracker:remove-ticker",
  "tracker:run-cycle",
  "tracker:recompute",
  "classifier:set-enabled",
  "classifier:set-rescore",
  "classifier:run-cycle",
  "classifier:refresh-metadata",
  "propagation:set-enabled",
  "propagation:set-surfacing",
  "propagation:run-cycle",
  "propagation:fast-path",
  "risk:set-card-enabled",
  "screen:rescan",
  "gauge:reload-config",
  "analyst:run-cycle",
  "analyst:set-enabled",
] as const satisfies readonly EngineChannel[];

export type StaffEngineChannel = (typeof STAFF_ENGINE_CHANNELS)[number];

const STAFF_LOOKUP: ReadonlySet<string> = new Set(STAFF_ENGINE_CHANNELS);

export function isStaffEngineChannel(channel: string): channel is StaffEngineChannel {
  return STAFF_LOOKUP.has(channel);
}

/**
 * The invited internal roles (`app_metadata.role`, written only by the
 * service role, so it cannot be self-assigned) that may flip the shared
 * engine switches. Least privilege: `talent_manager` is also an invited role,
 * but it only runs internships in the web admin, so it is not engine staff.
 * Mirrored by `ENGINE_STAFF_ROLES` in apps/desktop/src/shared/staff.ts; keep
 * the two in sync.
 */
export const ENGINE_STAFF_ROLES = ["staff", "deputy", "leader"] as const;

/** Whether a verified user's `app_metadata` makes them staff for the engine. */
export function isEngineStaff(appMetadata: Record<string, unknown> | null | undefined): boolean {
  const role = typeof appMetadata?.role === "string" ? appMetadata.role.trim().toLowerCase() : "";
  return (ENGINE_STAFF_ROLES as readonly string[]).includes(role);
}

/** What a non-staff caller is told when they try one of the channels above. */
export const STAFF_ONLY_ERROR = "Only Falcon staff can change this. It applies to every account.";
