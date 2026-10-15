import { randomBytes } from "node:crypto";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import {
  USER_EVENTS_PER_USER_MAX,
  USER_EVENT_ID,
  readStoredUserEvent,
  storeFailure,
  validateUserEventInput,
  type UserCalendarEvent,
  type UserEventFailure,
} from "../../shared/calendar-events";

/**
 * Calendar tab: the reader's own events, kept on this machine.
 *
 * One file, `<data root>/calendar/user-events.json`, partitioned by user key
 * (the account id from the session bridge, "anon" when signed out), so two
 * accounts on one machine never see each other's events. Every write goes
 * through the shared validator and is written atomically; a row that does
 * not read back on load is dropped on its own, never the file.
 *
 * Electron-free: the file, the user key, the clock and the id source are
 * injected, so the tests drive it against a temp dir.
 */

const SCHEMA_VERSION = 1;

type StoreFile = { schema_version: number; users: Record<string, unknown[]> };

export type UserEventsStoreDeps = {
  file: string;
  userKey: () => string;
  now?: () => Date;
  newId?: () => string;
};

export type StoreWrite = { ok: true; event: UserCalendarEvent } | UserEventFailure;

/** Lower-case letters, digits and hyphens: the shape `userKeyFromAccessToken` hands out. */
const USER_KEY = /^[a-z0-9-]{1,64}$/;

function defaultId(): string {
  return `ue_${randomBytes(12).toString("base64url")}`;
}

/** Timed events by start, all-day ones by their first date at the top of that day. */
function sortKey(e: UserCalendarEvent): string {
  return e.all_day ? `${e.date}T00:00:00.000Z` : (e.start_at ?? "");
}

export function createUserEventsStore(deps: UserEventsStoreDeps) {
  const now = deps.now ?? (() => new Date());
  const newId = deps.newId ?? defaultId;

  const readFile = (): StoreFile => {
    const file = readJson<StoreFile>(deps.file);
    if (!file || file.schema_version !== SCHEMA_VERSION || file.users === null || typeof file.users !== "object" || Array.isArray(file.users)) {
      return { schema_version: SCHEMA_VERSION, users: {} };
    }
    return file;
  };

  const key = (): string => {
    const k = deps.userKey();
    if (!USER_KEY.test(k)) throw new Error("invalid user key");
    return k;
  };

  /** The current user's events, every row re-validated. */
  const listFor = (file: StoreFile, userKey: string): UserCalendarEvent[] => {
    const rows = Array.isArray(file.users[userKey]) ? file.users[userKey] : [];
    const out: UserCalendarEvent[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      const event = readStoredUserEvent(row);
      if (event && !seen.has(event.id)) {
        seen.add(event.id);
        out.push(event);
      }
    }
    return out.sort((a, b) => sortKey(a).localeCompare(sortKey(b)) || a.id.localeCompare(b.id));
  };

  const save = (file: StoreFile, userKey: string, events: UserCalendarEvent[]): void => {
    file.users[userKey] = events;
    writeJsonAtomic(deps.file, file);
  };

  return {
    list(): UserCalendarEvent[] {
      return listFor(readFile(), key());
    },

    create(raw: unknown): StoreWrite {
      const checked = validateUserEventInput(raw);
      if (!checked.ok) return checked;
      const userKey = key();
      const file = readFile();
      const events = listFor(file, userKey);
      if (events.length >= USER_EVENTS_PER_USER_MAX) return storeFailure("full");
      const stamp = now().toISOString();
      let id = newId();
      while (events.some((e) => e.id === id)) id = newId();
      const event: UserCalendarEvent = { id, ...checked.value, created_at: stamp, updated_at: stamp };
      save(file, userKey, [...events, event]);
      return { ok: true, event };
    },

    update(id: unknown, raw: unknown): StoreWrite {
      if (typeof id !== "string" || !USER_EVENT_ID.test(id)) return storeFailure("missing");
      const checked = validateUserEventInput(raw);
      if (!checked.ok) return checked;
      const userKey = key();
      const file = readFile();
      const events = listFor(file, userKey);
      const index = events.findIndex((e) => e.id === id);
      if (index === -1) return storeFailure("missing");
      const event: UserCalendarEvent = { ...events[index], ...checked.value, id, updated_at: now().toISOString() };
      const next = [...events];
      next[index] = event;
      save(file, userKey, next);
      return { ok: true, event };
    },

    /** Deleting an event that is already gone succeeds: the reader's intent holds either way. */
    remove(id: unknown): { ok: true } | UserEventFailure {
      if (typeof id !== "string" || !USER_EVENT_ID.test(id)) return storeFailure("missing");
      const userKey = key();
      const file = readFile();
      const events = listFor(file, userKey);
      const next = events.filter((e) => e.id !== id);
      if (next.length !== events.length) save(file, userKey, next);
      return { ok: true };
    },
  };
}

export type UserEventsStore = ReturnType<typeof createUserEventsStore>;
