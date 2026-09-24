/**
 * Handover briefing: the main-process host.
 *
 * Wires the engine's ports to what this process can reach (the market data
 * readers, the chain channels, the data folder, the model caller) and owns the
 * three answers the renderer can ask for. The logic with decisions in it lives
 * in the electron-free modules beside this file; this one is the only place
 * that touches `app`, the session bridge and the environment.
 *
 * Nothing that leaves here carries provider text. The report's own failure
 * vocabulary is fixed by the engine, and everything else is reduced to a
 * `BriefingErrorCode`, because the API keys live in this process and an error
 * string is the usual way one escapes it.
 */

import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { BRIEFING_NARRATIVE_MODEL_DEFAULT, coverageStatus, resolveBriefingWindow } from "@meridian/research/briefing";
import { anthropicGlossCaller, glossConfigured } from "@meridian/research/gloss";
import type {
  BriefingGetResult,
  BriefingNarrativeResult,
  BriefingPorts,
  BriefingWindow,
  BriefingWindowResult,
  MacroCalendarOverlay,
} from "../../shared/briefing-types";
import { resolveDataRoot } from "../data-root";
import { invokeChannel } from "../ipc-register";
import { getRendererSession } from "../session-bridge";
import {
  fetchCorporateCalendar,
  fetchLiveQuote,
  fetchMarketHeadlines,
  fetchMarketSnapshot,
  fetchRecentCorporateEvents,
} from "../stock/market-data-service";
import { createBriefingBuilder, resolveClock, type BriefingClock } from "./briefing-build";
import { BriefingStore } from "./briefing-store";
import { createChainPort } from "./chain-port";
import { createCorporateActions } from "./corporate-actions";
import { createMarketNews } from "./market-news";
import { createNarrativeService } from "./narrative-service";
import { toHeldQuote, toMarketSnapshot } from "./ports-map";
import { parseBriefingRequest } from "./request";
import { userKeyFromAccessToken } from "./user-key";

const CORPORATE_ACTIONS_FILE = "corporate-actions.json";
const MARKET_NEWS_FILE = "market-news.json";
const CALENDAR_OVERRIDE_FILE = "macro-calendar.override.json";

function briefingDir(): string {
  return path.join(resolveDataRoot(), "briefing");
}

/** The clock reports are built against: the machine's, unless a developer pinned one. */
export function resolveNow(): BriefingClock {
  return resolveClock(process.env.FALCON_BRIEFING_NOW, app.isPackaged, new Date());
}

/**
 * A developer switch for rehearsing the degraded report: every port that
 * reaches outside this process refuses, and the panel has to stand on its
 * section notes alone. Ignored in a packaged build, like the pinned clock.
 */
function offline(): boolean {
  return process.env.FALCON_BRIEFING_OFFLINE === "1" && !app.isPackaged;
}

function currentUserKey(): string {
  return userKeyFromAccessToken(getRendererSession().accessToken);
}

/**
 * A correction to the shipped macro calendar, dropped into the data folder by
 * hand when an agency moves a release between two app versions. A missing
 * file and a file that does not parse both mean "no corrections": the engine
 * validates what is returned and falls back to the shipped calendar, so a typo
 * in a hand-edited file costs the correction and never the calendar.
 */
async function readCalendarOverlay(): Promise<MacroCalendarOverlay | null> {
  let text: string;
  try {
    text = await fs.promises.readFile(path.join(briefingDir(), CALENDAR_OVERRIDE_FILE), "utf8");
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as MacroCalendarOverlay) : null;
  } catch {
    console.warn(`[briefing] ${CALENDAR_OVERRIDE_FILE} is not valid JSON and was ignored`);
    return null;
  }
}

type Host = {
  builder: ReturnType<typeof createBriefingBuilder>;
  narratives: ReturnType<typeof createNarrativeService>;
};

let host: Host | null = null;

/**
 * Built on first use, not at import. A packaged build moves `userData`, and
 * with it the data root, in the first lines of startup, and every handler
 * module has already been imported by then: a store created at import would
 * write its reports under the folder the app is about to stop using.
 */
function getHost(): Host {
  if (host) return host;

  const store = new BriefingStore(briefingDir());
  const chain = createChainPort(invokeChannel);
  const corporate = createCorporateActions({
    file: path.join(briefingDir(), CORPORATE_ACTIONS_FILE),
    fetchCalendar: fetchCorporateCalendar,
    fetchEvents: fetchRecentCorporateEvents,
  });
  const marketNews = createMarketNews({
    file: path.join(briefingDir(), MARKET_NEWS_FILE),
    fetch: fetchMarketHeadlines,
  });

  /** Concurrency, per-call timeouts and the overall deadline are the assembly's; the ports only fetch. */
  const buildPorts = (window: BriefingWindow | null): BriefingPorts => {
    const refuse = <T>(): Promise<T> => Promise.reject(new Error("briefing offline switch is on"));
    const guard = <A extends unknown[], T>(port: (...args: A) => Promise<T>) =>
      (...args: A): Promise<T> => (offline() ? refuse<T>() : port(...args));

    const sessionOpenMs = window === null ? Number.NaN : Date.parse(window.target_open_at);
    return {
      marketSnapshot: guard(async (symbol: string) => toMarketSnapshot(await fetchMarketSnapshot(symbol))),
      // The live quote, not the snapshot: a held US name trades before and
      // after the bell, and the move since the close is exactly that print.
      heldQuote: guard(async (symbol: string) => toHeldQuote(await fetchLiveQuote(symbol))),
      quant: guard((symbol: string) => chain.quant(symbol)),
      chainSlice: guard((ticker: string, held: string[], since: string) => chain.chainSlice(ticker, held, since)),
      riskLatest: guard(() => chain.riskLatest()),
      corporateCalendar: guard((symbol: string) =>
        corporate.get(symbol, Number.isFinite(sessionOpenMs) ? { eventsNotBeforeMs: sessionOpenMs } : {}),
      ),
      // Nine provider queries behind one ten-minute cache: see market-news.ts.
      marketNews: guard((since: string) => marketNews.get(since)),
      // Read from disk, so it answers with the switch on as well.
      calendarOverlay: readCalendarOverlay,
    };
  };

  host = {
    builder: createBriefingBuilder({
      store,
      ports: buildPorts,
      clock: resolveNow,
      realNowMs: Date.now,
      userKey: currentUserKey,
      modelConfigured: glossConfigured,
    }),
    narratives: createNarrativeService({
      store,
      userKey: currentUserKey,
      modelConfigured: glossConfigured,
      caller: anthropicGlossCaller,
      model: () => process.env.FALCON_BRIEFING_MODEL?.trim() || BRIEFING_NARRATIVE_MODEL_DEFAULT,
      realNowMs: Date.now,
    }),
  };
  return host;
}

/** Pure over the clock: no port is called, so the renderer can ask this on every focus. */
export function getBriefingWindow(): BriefingWindowResult {
  try {
    const window = resolveBriefingWindow(resolveNow().now);
    return { ok: true, window, calendar_coverage: coverageStatus(window.target_session_ymd) };
  } catch (err) {
    console.warn("[briefing] window failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "unavailable" };
  }
}

export async function getBriefing(raw: unknown): Promise<BriefingGetResult> {
  const req = parseBriefingRequest(raw);
  if (req === null) return { ok: false, error: "invalid_request" };
  try {
    const { report, source } = await getHost().builder.build(req);
    return { ok: true, report, source };
  } catch (err) {
    console.warn("[briefing] build failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "build_failed" };
  }
}

export async function getBriefingNarrative(raw: unknown): Promise<BriefingNarrativeResult> {
  try {
    return await getHost().narratives.getNarrative(raw);
  } catch (err) {
    console.warn("[briefing] narrative failed:", err instanceof Error ? err.message : String(err));
    return { ok: false, error: "unavailable" };
  }
}
