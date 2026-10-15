import path from "node:path";
import { resolveDataRoot } from "../data-root";
import { registerIpcHandler } from "../ipc-register";
import { getRendererSession } from "../session-bridge";
import { getCorporateActions } from "../briefing/briefing-service";
import { userKeyFromAccessToken } from "../briefing/user-key";
import { fetchCompanySector } from "../stock/market-data-service";
import {
  parseCorporateRequest,
  storeFailure,
  type CalendarCorporateResult,
  type UserEventDeleteResult,
  type UserEventWriteResult,
  type UserEventsListResult,
} from "../../shared/calendar-events";
import { buildCorporateCalendar } from "./corporate-calendar";
import { createSectorCache, type SectorCache } from "./sector-cache";
import { createUserEventsStore, type UserEventsStore } from "./user-events-store";

/**
 * Calendar tab IPC surface. All local, none of it an engine channel.
 *
 *   calendar:user-events:list | create | update | delete
 *       The reader's own events, under `<data root>/calendar/user-events.json`,
 *       partitioned by the signed-in account (from the session bridge, never
 *       from the renderer's word).
 *   calendar:corporate
 *       Earnings, dividend and split dates of the names asked about, with each
 *       name's sector, read through the briefing's corporate-actions cache and
 *       a month-long sector cache.
 *
 * Validation and store errors are our own codes (with the English sentence
 * beside them) and are passed through; anything else is logged here and
 * answered with a fixed code, because an error string is how a provider's
 * reply (or a key) would cross into the renderer.
 */

let store: UserEventsStore | null = null;
let sectors: SectorCache | null = null;

/** Built on first use: the data root moves early in a packaged build's startup. */
function userEvents(): UserEventsStore {
  if (!store) {
    store = createUserEventsStore({
      file: path.join(resolveDataRoot(), "calendar", "user-events.json"),
      userKey: () => userKeyFromAccessToken(getRendererSession().accessToken),
    });
  }
  return store;
}

/**
 * The one sector cache. The Earnings tab reads through the same instance:
 * two would each keep their own copy of the same file and overwrite each
 * other's answers.
 */
export function sectorCache(): SectorCache {
  if (!sectors) {
    sectors = createSectorCache({
      file: path.join(resolveDataRoot(), "calendar", "sectors.json"),
      fetch: fetchCompanySector,
    });
  }
  return sectors;
}

export function registerCalendarHandlers(): void {
  registerIpcHandler("calendar:user-events:list", (): UserEventsListResult => {
    try {
      return { ok: true, events: userEvents().list() };
    } catch (err) {
      console.warn("[calendar] list failed:", err);
      return storeFailure("readFailed");
    }
  });

  registerIpcHandler("calendar:user-events:create", (_event, input: unknown): UserEventWriteResult => {
    try {
      return userEvents().create(input);
    } catch (err) {
      console.warn("[calendar] create failed:", err);
      return storeFailure("saveFailed");
    }
  });

  registerIpcHandler("calendar:user-events:update", (_event, id: unknown, input: unknown): UserEventWriteResult => {
    try {
      return userEvents().update(id, input);
    } catch (err) {
      console.warn("[calendar] update failed:", err);
      return storeFailure("saveFailed");
    }
  });

  registerIpcHandler("calendar:user-events:delete", (_event, id: unknown): UserEventDeleteResult => {
    try {
      return userEvents().remove(id);
    } catch (err) {
      console.warn("[calendar] delete failed:", err);
      return storeFailure("deleteFailed");
    }
  });

  registerIpcHandler("calendar:corporate", async (_event, request: unknown): Promise<CalendarCorporateResult> => {
    const parsed = parseCorporateRequest(request);
    if (!parsed) return { ok: false, error: "invalid_request" };
    try {
      const corporate = getCorporateActions();
      const cache = sectorCache();
      const outcome = await buildCorporateCalendar(parsed.symbols, {
        corporate: (symbol) => corporate.get(symbol),
        sector: (symbol) => cache.get(symbol),
      });
      return { ok: true, ...outcome, skipped: parsed.skipped };
    } catch (err) {
      console.warn("[calendar] corporate failed:", err instanceof Error ? err.message : String(err));
      return { ok: false, error: "unavailable" };
    }
  });
}
