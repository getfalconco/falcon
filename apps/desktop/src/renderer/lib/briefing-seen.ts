/**
 * Handover briefing: "shown once per launch", and the decision whether the
 * panel opens by itself on arrival.
 *
 * The panel is the first thing the reader meets when the app comes up, in
 * whatever phase the session is in: before the open it is the handover, in
 * the session it is the session so far, after the close it is the day that
 * was. One showing per launch is what keeps that from becoming a panel that
 * lands on every return to the dashboard.
 *
 * Pure on purpose. The store is injected (sessionStorage in the app, a plain
 * object in tests), so nothing here touches a global, and every decision
 * takes its inputs as arguments.
 *
 * The mark is written when the panel OPENS, not when it closes. If it were
 * written on close, a crash or a force-quit with the panel up would leave no
 * mark, and the panel would come back on every launch until someone managed
 * to close it cleanly. Marking on open costs nothing: the dashboard card and
 * the keyboard shortcut bring the panel back whenever it is wanted.
 */

export type SeenStore = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
};

/**
 * Held in sessionStorage, and that is the whole mechanism. An Electron
 * renderer's sessionStorage lives exactly as long as its window: a Vite
 * reload during development keeps it, so the panel does not open again on
 * every hot reload, and a real relaunch starts a fresh window with an empty
 * store, so the panel is back. localStorage would outlive the relaunch and
 * turn "once per launch" into "once ever".
 *
 * Not scoped to the signed-in user: a launch has one window, and a sign-out
 * inside it that hands the machine to someone else is rarer than the cost of
 * the one showing they would not get.
 */
export const BRIEFING_SHOWN_LAUNCH_KEY = "falcon.ui.briefingShownLaunch.v1";

/** Which target session the panel was shown for this launch, and when. */
export type ShownMark = { ymd: string; at: string };

const YMD = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The mark for this launch, or null. Anything that is not exactly the
 * expected shape reads as "not shown": the worst outcome of a wrong null is
 * one extra showing, while trusting a half-parsed value could hide the panel
 * for a session it was never shown for.
 */
export function readShownThisLaunch(store: SeenStore): ShownMark | null {
  try {
    const raw = store.getItem(BRIEFING_SHOWN_LAUNCH_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    const { ymd, at } = parsed as { ymd?: unknown; at?: unknown };
    if (typeof ymd !== "string" || !YMD.test(ymd) || typeof at !== "string") return null;
    return { ymd, at };
  } catch {
    return null;
  }
}

/**
 * Records that the panel was shown for the session `ymd` hands over to.
 *
 * The session is in the mark because "once per launch" is really "once per
 * session per launch": a window left open from Tuesday evening into Wednesday
 * morning is one launch and two sessions, and Wednesday's report is owed its
 * showing. Writing the new session over the old one is what grants it.
 *
 * A second call for the same session keeps the first timestamp, so `at`
 * stays "when it was first shown" however many times the panel is reopened
 * from the card. A store that throws (a blocked origin, a full disk) is
 * ignored: the cost is one repeat showing, and that must never take the
 * panel down with it.
 */
export function markShownThisLaunch(store: SeenStore, ymd: string, nowIso: string): void {
  if (!YMD.test(ymd)) return;
  try {
    if (readShownThisLaunch(store)?.ymd === ymd) return;
    store.setItem(BRIEFING_SHOWN_LAUNCH_KEY, JSON.stringify({ ymd, at: nowIso }));
  } catch {
    /* see above */
  }
}

/** Whether the mark says the panel was already shown for `targetYmd` this launch. A missing store reads as "not shown". */
export function shownThisLaunchFor(store: SeenStore | null, targetYmd: string): boolean {
  if (!store) return false;
  return readShownThisLaunch(store)?.ymd === targetYmd;
}

/** The dashboard has to have painted before anything is laid over it. */
export const AUTO_OPEN_MIN_MS = 900;

/**
 * What the engine allows itself to assemble one report: `DEFAULT_DEADLINE_MS`
 * in `briefing/gather.ts`. Mirrored rather than imported, because gather.ts is
 * the Node-only half of the package and cannot be loaded here; the test below
 * pins the two together so they are never tuned apart.
 */
export const GATHER_DEADLINE_MS = 12_000;

/**
 * Past this point the reader has been on the dashboard long enough to have
 * started something. A report that only arrives now must not open over their
 * work and take the keyboard focus with it; the card is there instead.
 *
 * It has to stay above GATHER_DEADLINE_MS. The first report of a launch is
 * usually a cold build (nothing cached for this phase and this book), and at
 * six seconds this gave up before the build it was waiting for could land, so
 * the panel showed only when the providers were quick. What the deadline is
 * really guarding against is opening over somebody's work, and `engaged`
 * ends the arrival the moment that becomes possible.
 */
export const AUTO_OPEN_DEADLINE_MS = 15_000;

/**
 * After sign-in the window grows from the login size to the workspace size
 * over about 550 ms, as a run of resize events. A panel that mounts in the
 * middle of that measures the small window and then jumps. Waiting for this
 * long a gap since the last resize event means the growth has finished.
 */
export const RESIZE_SETTLE_MS = 250;

/**
 * How long the app has to sit in the background before coming back counts as
 * a new arrival. The arrival runs the same decision as the launch did, and
 * the mark blocks it for the session it was written for: the panel returns
 * only when the report has moved on to a new target session, which is an
 * evening's window turning into the next morning's.
 */
export const RETURN_AFTER_MS = 30 * 60_000;

export type AutoOpenInput = {
  /** The feature flag. */
  enabled: boolean;
  demo: boolean;
  hasAccount: boolean;
  /** The mark is in the store for the report's own target session. */
  shownThisLaunch: boolean;
  reportReady: boolean;
  /** Every section of the report failed: there is nothing worth interrupting for. */
  fullyDegraded: boolean;
  /** The reader has clicked, typed or scrolled since arriving. */
  engaged: boolean;
  view: string;
  msSinceArrival: number;
  msSinceResize: number;
  otherDialogOpen: boolean;
};

/**
 * "never" is final for this arrival: the caller can stop its timer. "wait"
 * means ask again shortly. The order matters: every "never" is checked before
 * any "wait", so a condition that can only end in "never" (the deadline, a
 * session already shown) is not kept alive by a dialog that happens to be
 * open. There is no phase test: the panel has something to say in every
 * phase, and the reader asked to meet it whenever the app comes up.
 */
export function decideAutoOpen(input: AutoOpenInput): "open" | "wait" | "never" {
  if (!input.enabled || input.demo || !input.hasAccount) return "never";
  if (input.engaged) return "never";
  if (input.view !== "dashboard") return "never";
  if (input.msSinceArrival > AUTO_OPEN_DEADLINE_MS) return "never";
  // Both are judged on the report itself, so neither is known before it lands.
  if (input.reportReady && (input.shownThisLaunch || input.fullyDegraded)) return "never";

  if (!input.reportReady) return "wait";
  if (input.msSinceArrival < AUTO_OPEN_MIN_MS) return "wait";
  if (input.msSinceResize < RESIZE_SETTLE_MS) return "wait";
  if (input.otherDialogOpen) return "wait";
  return "open";
}
