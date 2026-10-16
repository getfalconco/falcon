import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { subscribeDemoMode } from "@/lib/demo-mode";
import { useHomeTabActivity, useOnHomeTabShown } from "@/lib/home-tab-activity";
import { readPaperAccount, subscribePaperAccount } from "@/lib/paper-account";
import { getWatchlist, subscribeWatchlist } from "@/lib/watchlist";
import {
  storeFailure,
  type CalendarCorporateEvent,
  type CalendarSector,
  type UserCalendarEvent,
  type UserCalendarEventInput,
  type UserEventFailure,
} from "../../../shared/calendar-events";
import type { EconomicEvent } from "../../../shared/economic-calendar";

/**
 * Calendar tab: the data the views draw, held outside React.
 *
 * The reader's own events and the corporate calendar are kept in module
 * stores, not component state, so leaving the tab and coming back draws at
 * once from what was already read instead of asking main again; the main
 * process caches the provider reads on disk besides. Other parts of the app
 * (notifications, say) can subscribe to the user events the same way:
 * `subscribeUserEvents` / `getUserEventsState`, or the window event
 * `USER_EVENTS_CHANGED`, fired after every change.
 */

// ---------------------------------------------------------------------------
// The reader's own events
// ---------------------------------------------------------------------------

export type UserEventsState = {
  status: "idle" | "loading" | "ready" | "unsupported" | "error";
  events: UserCalendarEvent[];
  /** Why the last read failed: a code the tab words in the reader's language (`failureMessage`), and main's English. */
  error: UserEventFailure | null;
};

export const USER_EVENTS_CHANGED = "falcon:calendar-user-events-changed";

let userState: UserEventsState = { status: "idle", events: [], error: null };
const userListeners = new Set<() => void>();

function setUserState(next: UserEventsState): void {
  userState = next;
  for (const fn of userListeners) fn();
  try {
    window.dispatchEvent(new CustomEvent(USER_EVENTS_CHANGED, { detail: next.events }));
  } catch {
    /* no window in a node test */
  }
}

export function getUserEventsState(): UserEventsState {
  return userState;
}

export function subscribeUserEvents(fn: () => void): () => void {
  userListeners.add(fn);
  return () => userListeners.delete(fn);
}

function bridge() {
  return typeof window !== "undefined" ? window.meridian : undefined;
}

/** Reads the events from main. Called on mount and again when the signed-in account changes. */
export async function loadUserEvents(): Promise<void> {
  const list = bridge()?.listCalendarUserEvents;
  if (!list) {
    setUserState({ status: "unsupported", events: [], error: null });
    return;
  }
  if (userState.status !== "ready") setUserState({ ...userState, status: "loading" });
  try {
    const result = await list();
    if (result.ok) setUserState({ status: "ready", events: result.events, error: null });
    else setUserState({ ...userState, status: "error", error: result });
  } catch {
    setUserState({ ...userState, status: "error", error: storeFailure("readFailed") });
  }
}

/** A refusal carries its code: the tab words it with `failureMessage`. */
export type WriteOutcome = { ok: true; event: UserCalendarEvent } | UserEventFailure;

export async function createUserEvent(input: UserCalendarEventInput): Promise<WriteOutcome> {
  const create = bridge()?.createCalendarUserEvent;
  if (!create) return storeFailure("restart");
  try {
    const result = await create(input);
    if (result.ok) setUserState({ ...userState, status: "ready", events: [...userState.events.filter((e) => e.id !== result.event.id), result.event] });
    return result;
  } catch {
    return storeFailure("saveFailed");
  }
}

/**
 * Saves a change. The block moves at once (a drag must not snap back while
 * main writes), and returns to where it was if main refuses.
 */
export async function updateUserEvent(id: string, input: UserCalendarEventInput): Promise<WriteOutcome> {
  const update = bridge()?.updateCalendarUserEvent;
  if (!update) return storeFailure("restart");
  const before = userState.events;
  const current = before.find((e) => e.id === id);
  if (current) setUserState({ ...userState, events: before.map((e) => (e.id === id ? { ...e, ...input } : e)) });
  try {
    const result = await update(id, input);
    if (result.ok) setUserState({ ...userState, events: userState.events.map((e) => (e.id === id ? result.event : e)) });
    else setUserState({ ...userState, events: before });
    return result;
  } catch {
    setUserState({ ...userState, events: before });
    return storeFailure("saveFailed");
  }
}

export async function deleteUserEvent(id: string): Promise<{ ok: true } | UserEventFailure> {
  const remove = bridge()?.deleteCalendarUserEvent;
  if (!remove) return storeFailure("restart");
  const before = userState.events;
  setUserState({ ...userState, events: before.filter((e) => e.id !== id) });
  try {
    const result = await remove(id);
    if (!result.ok) setUserState({ ...userState, events: before });
    return result;
  } catch {
    setUserState({ ...userState, events: before });
    return storeFailure("deleteFailed");
  }
}

/** Which account the held events were read for: another account's are dropped before anything is drawn. */
let loadedFor: string | null = null;

export function useUserEvents(accountKey: string): UserEventsState {
  if (loadedFor !== null && loadedFor !== accountKey) {
    loadedFor = null;
    userState = { status: "idle", events: [], error: null };
  }
  const state = useSyncExternalStore(subscribeUserEvents, getUserEventsState, getUserEventsState);
  useEffect(() => {
    loadedFor = accountKey;
    void loadUserEvents();
  }, [accountKey]);
  return state;
}

// ---------------------------------------------------------------------------
// The corporate calendar of held and followed names
// ---------------------------------------------------------------------------

export type CorporateState = {
  status: "idle" | "loading" | "ready" | "unsupported" | "error";
  events: CalendarCorporateEvent[];
  sectors: Record<string, CalendarSector | null>;
  unavailable: string[];
  skipped: string[];
};

const EMPTY_CORPORATE: CorporateState = { status: "idle", events: [], sectors: {}, unavailable: [], skipped: [] };
/** Answers by symbol set, for the session. Main keeps the provider reads for most of a day; this only spares the IPC. */
const corporateCache = new Map<string, { at: number; state: CorporateState }>();
const CORPORATE_TTL_MS = 30 * 60_000;

export function useCorporateCalendar(symbols: readonly string[]): CorporateState {
  const key = useMemo(() => [...new Set(symbols)].sort().join(","), [symbols]);
  const [state, setState] = useState<CorporateState>(() => corporateCache.get(key)?.state ?? EMPTY_CORPORATE);

  useEffect(() => {
    const ask = bridge()?.getCalendarCorporate;
    if (!ask) {
      setState({ ...EMPTY_CORPORATE, status: "unsupported" });
      return;
    }
    if (!key) {
      setState({ ...EMPTY_CORPORATE, status: "ready" });
      return;
    }
    const hit = corporateCache.get(key);
    if (hit && Date.now() - hit.at < CORPORATE_TTL_MS) {
      setState(hit.state);
      return;
    }
    let live = true;
    setState((s) => ({ ...s, status: s.status === "ready" ? "ready" : "loading" }));
    ask({ symbols: key.split(",") })
      .then((result) => {
        const next: CorporateState = result.ok
          ? { status: "ready", events: result.events, sectors: result.sectors, unavailable: result.unavailable, skipped: result.skipped }
          : { ...EMPTY_CORPORATE, status: "error" };
        if (result.ok) corporateCache.set(key, { at: Date.now(), state: next });
        if (live) setState(next);
      })
      .catch(() => {
        if (live) setState({ ...EMPTY_CORPORATE, status: "error" });
      });
    return () => {
      live = false;
    };
  }, [key]);

  return state;
}

// ---------------------------------------------------------------------------
// The economic calendar
// ---------------------------------------------------------------------------

export type EconomicState = {
  status: "idle" | "loading" | "ready" | "unsupported" | "error";
  events: EconomicEvent[];
  /** Some rows are from an earlier read: the source did not answer now. */
  stale: boolean;
  /** Only this week could be read, from the fallback source. */
  partial: boolean;
};

const EMPTY_ECONOMIC: EconomicState = { status: "idle", events: [], stale: false, partial: false };
/** Answers by range and countries. Main keeps the provider reads too; this spares the IPC between redraws. */
const economicCache = new Map<string, { at: number; state: EconomicState }>();
/** Actual figures come out through the day: the tab asks main again after this long. */
export const ECONOMIC_TTL_MS = 10 * 60_000;

/**
 * Releases, decisions and speeches between two UTC dates for the countries
 * named, from main (`calendar:economic`). `refresh` is any value that changes
 * when the tab wants a fresh look (a ten minute tick); a cached answer younger
 * than the TTL is reused whatever it is.
 */
export function useEconomicCalendar(from: string, to: string, countries: readonly string[], refresh = 0): EconomicState {
  const key = `${from}|${to}|${[...countries].sort().join(",")}`;
  const [state, setState] = useState<EconomicState>(() => economicCache.get(key)?.state ?? EMPTY_ECONOMIC);

  useEffect(() => {
    const ask = bridge()?.getEconomicCalendar;
    if (!ask) {
      setState({ ...EMPTY_ECONOMIC, status: "unsupported" });
      return;
    }
    const hit = economicCache.get(key);
    if (hit) setState(hit.state);
    if (hit && Date.now() - hit.at < ECONOMIC_TTL_MS) return;
    let live = true;
    if (!hit) setState((s) => ({ ...s, status: s.status === "ready" ? "ready" : "loading" }));
    const [f, t, list] = key.split("|");
    ask({ from: f!, to: t!, countries: list ? list.split(",") : [] })
      .then((result) => {
        if (result.ok) {
          const next: EconomicState = { status: "ready", events: result.events, stale: result.stale, partial: result.partial };
          economicCache.set(key, { at: Date.now(), state: next });
          if (live) setState(next);
        } else if (live) {
          // A failed refresh keeps what was already drawn.
          setState((s) => (s.status === "ready" ? { ...s, stale: true } : { ...EMPTY_ECONOMIC, status: "error" }));
        }
      })
      .catch(() => {
        if (live) setState((s) => (s.status === "ready" ? { ...s, stale: true } : { ...EMPTY_ECONOMIC, status: "error" }));
      });
    return () => {
      live = false;
    };
  }, [key, refresh]);

  return state;
}

// ---------------------------------------------------------------------------
// What the reader holds and follows
// ---------------------------------------------------------------------------

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** Watchlist tickers, upper-cased, following changes from anywhere in the app. */
export function useWatchlistTickers(): string[] {
  const read = () => getWatchlist().map((e) => e.ticker.toUpperCase());
  const [tickers, setTickers] = useState<string[]>(read);
  useEffect(() => {
    const update = () => setTickers((prev) => {
      const next = read();
      return sameList(prev, next) ? prev : next;
    });
    update();
    return subscribeWatchlist(update);
  }, []);
  return tickers;
}

/** Symbols of the open positions (the demo book while demo mode is on), sorted. */
export function useHeldTickers(): string[] {
  const read = () =>
    Object.values(readPaperAccount().positions)
      .filter((p) => p && Number.isFinite(p.shares) && p.shares !== 0)
      .map((p) => p.symbol.toUpperCase())
      .sort();
  const [tickers, setTickers] = useState<string[]>(read);
  useEffect(() => {
    const update = () => setTickers((prev) => {
      const next = read();
      return sameList(prev, next) ? prev : next;
    });
    update();
    const offAccount = subscribePaperAccount(update);
    const offDemo = subscribeDemoMode(update);
    return () => {
      offAccount();
      offDemo();
    };
  }, []);
  return tickers;
}

/**
 * The minute the wall clock is on, re-read as each minute turns (and at once
 * when a hidden window comes back), for the current-time line. Not while the
 * home page keeps the calendar behind another tab: the turn redraws the whole
 * grid, so it is read again when the tab comes back instead.
 */
export function useMinute(): number {
  const [minute, setMinute] = useState(() => Math.floor(Date.now() / 60_000));
  const activity = useHomeTabActivity();
  useOnHomeTabShown(() => setMinute(Math.floor(Date.now() / 60_000)));
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => setMinute(Math.floor(Date.now() / 60_000));
    const arm = () => {
      timer = setTimeout(() => {
        if (activity.isActive()) read();
        arm();
      }, 60_000 - (Date.now() % 60_000) + 20);
    };
    const onVisible = () => {
      if (!document.hidden && activity.isActive()) read();
    };
    arm();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      if (timer !== undefined) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [activity]);
  return minute;
}
