"use client";

import { useCallback, useSyncExternalStore } from "react";
import { SESSION_ENDED, authHeaders } from "@/lib/workspace/api-auth";
import type { PreparedImage } from "./images";
import { RUN_MARK, applyRunEvent, cleanRun, runForHistory, settleRun, storedRun, type LabRun } from "./run";
import { askForHistory, askFromStream, askToSend, cleanAsk, type AskAnswer, type DeskAsk } from "@/lib/desk/ask";
import { normalizeChart, type ChartSpec } from "@/lib/desk/chart-spec";
import { LIVE_MS, mergeIncoming, type StoredSession } from "@/lib/desk/session-storage";
import { PAGE_ID, forgetStoredSessions, readStoredSessions, scheduleServerSave, setStreaming, startServerSync, streamingElsewhere, watchStoredSessions, writeStoredSessions } from "./session-store";
import { applyMemoryFromStream, memoryForRequest } from "./memory-store";
import { parseAppAction, type AppAction } from "@/lib/desk/app-actions";
import { appSnapshot, runAppAction } from "./app-bridge";
import { reattemptHop, rewound } from "@/lib/desk/resume";
import { cleanCiteReport, stripCitations, type CiteReport } from "@/lib/desk/citations";
import { cleanFollowups, splitFollowups } from "@/lib/desk/followups";
import { stripHistoryMarkers, wireHistory, type WireMessage } from "@/lib/desk/history-context";

/**
 * Desk chat sessions, kept per workspace in this browser across visits
 * (localStorage, and the account once its table exists: lab/session-store.ts).
 * Module state behind it so two
 * Desk panes in split view show the same sessions, and a reply keeps
 * streaming when the viewer goes back to the grid.
 *
 * Replies stream from POST /api/desk/chat (Claude). Storage keeps text and
 * small image thumbnails; full images live in memory for this page visit
 * only, so after a reload Claude no longer sees them (the thread says so).
 */

/** The word on the New card and the title of a session until it is renamed. */
export const LAB_NEW_LABEL = "New session";

/** `thumb` is a small data: URL, or null when storage had no room for it. */
export type LabImage = { id: string; thumb: string | null; w: number; h: number };
/**
 * A data lookup Claude made while answering (the route's tool activity lines).
 * `at` is where it happened in the reply's text, so the rows show between the
 * paragraphs written before and after it. `result` is the raw JSON Claude read
 * (shortened in storage).
 */
export type LabTool = { id: string; label: string; state: "running" | "done"; ok?: boolean; ms?: number; result?: string; at: number; /** "/quote AAPL" (lib/desk/tools/command.ts) */ cmd?: string; /** filing_text: the filing URL */ ref?: string; /** show_chart: the chart drawn here (lib/desk/chart-spec.ts; lab/ChartBlock.tsx) */ chart?: ChartSpec; /** An app action Falcon AI took (lib/desk/app-actions.ts; lab/AppActionChip.tsx); run once when it streams, never from storage */ action?: AppAction; /** A long download while it runs: points loaded of the total (an options history pull) */ progress?: { loaded: number; total: number }; /** Done but still loading when the reply could not wait (a neutral row; hidden once the same command ran later) */ pending?: boolean; /** Its source id in the conversation ("t3"), which the reply's citations name (lib/desk/citations.ts) */ src?: string };
export type LabMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  at: number;
  images?: LabImage[];
  /** Assistant only: still arriving, stopped by the viewer, or failed (`error` says why). */
  status?: "streaming" | "stopped" | "error";
  /** A reply streaming in another tab of this browser: that page's id (lab/session-store.ts PAGE_ID); stored with a streaming reply. */
  tab?: string;
  error?: string;
  /** Assistant only: data lookups made for this reply, in order. */
  tools?: LabTool[];
  /** Assistant only: the viewer's thumbs up or down (kept here; no backend yet). */
  vote?: "up" | "down";
  /** Assistant only: a strategy test run for this reply (lab/run.ts; the results panel shows it). */
  run?: LabRun;
  /** Assistant only: a question card Claude asked with (ask_user, lib/desk/ask.ts; lab/AskCard.tsx) and the viewer's answer. */
  ask?: DeskAsk;
  /** Assistant only: the route's check of the reply's numeric citations (lib/desk/citations.ts; lab/SourceCite.tsx). */
  cites?: CiteReport;
  /** Assistant only: follow-up questions the model suggested (its hidden <followups> block, lib/desk/followups.ts). */
  followups?: string[];
};
/**
 * A session. The stored array is the grid order (pinned ones first, then the
 * rest, each group in the viewer's order); `pinned` keeps a session at the top.
 */
export type LabSession = { id: string; title: string; createdAt: number; updatedAt: number; pinned?: boolean; messages: LabMessage[] };

const EMPTY: LabSession[] = [];
const ENDPOINT = "/api/desk/chat";
/** Messages sent per request (the route keeps 20 too). */
const HISTORY = 20;
/** Base64 characters of images per request: under the hosting's 6 MB body limit with room for text. */
const IMAGE_BUDGET = 4_500_000;
const IMAGES_PER_REQUEST = 8;
/** Matches ERROR_MARK in app/api/desk/chat/route.ts. */
const ERROR_MARK = "\u001e";
/** Matches TOOL_MARK in app/api/desk/chat/route.ts: this character, one JSON line, a newline. */
const TOOL_MARK = "\u001d";
/** A tool result kept in session storage is cut to this many characters. */
const STORED_RESULT_CHARS = 6_000;
/** Hops a reply may take: MAX_RESUMES (12) plus FREE_HOPS (4) in app/api/desk/chat/route.ts; the route enforces its own cap. */
const MAX_RESUMES = 16;

const cache = new Map<string, LabSession[]>();
const listeners = new Map<string, Set<() => void>>();
/** Full images by id, for this page visit. */
const fullImages = new Map<string, { mediaType: string; data: string }>();
/** Replies in flight, by session id. */
const inFlight = new Map<string, AbortController>();

export function newId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
}

/** Whether Claude can still see this image (false after a reload). */
export function imageKept(id: string): boolean {
  return fullImages.has(id);
}

function cleanImages(v: unknown): LabImage[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v
    .filter((i): i is LabImage => !!i && typeof i.id === "string" && (typeof i.thumb === "string" || i.thumb === null))
    .map((i) => ({ id: i.id, thumb: typeof i.thumb === "string" && i.thumb.startsWith("data:image/") ? i.thumb : null, w: Number(i.w) || 0, h: Number(i.h) || 0 }));
  return list.length ? list : undefined;
}

function cleanTools(v: unknown): LabTool[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list = v
    .filter((t): t is LabTool => !!t && typeof t.id === "string" && typeof t.label === "string")
    .map((t) => {
      // A lookup still running when the page went away did not finish.
      const out: LabTool = { id: t.id, label: t.label, state: "done", at: Math.max(0, Number(t.at) || 0) };
      out.ok = t.state === "done" ? t.ok !== false : false;
      if (typeof t.ms === "number") out.ms = t.ms;
      if (typeof t.result === "string") out.result = t.result;
      if (typeof t.cmd === "string") out.cmd = t.cmd;
      if (typeof t.ref === "string") out.ref = t.ref;
      if (t.pending === true) out.pending = true;
      if (typeof t.src === "string" && /^t\d{1,6}$/.test(t.src)) out.src = t.src;
      if (t.chart) {
        const c = normalizeChart(t.chart);
        if (c.ok) out.chart = c.spec;
      }
      const action = t.action ? parseAppAction(t.action) : null;
      if (action) out.action = action;
      return out;
    });
  return list.length ? list : undefined;
}

/**
 * Splits the raw reply stream into its text, the tool activity and a trailing
 * error (after ERROR_MARK). An activity line still arriving is left for the
 * next chunk.
 */
export function parseReply(raw: string): { text: string; tools: LabTool[]; error: string | null; run?: LabRun; resume: string | null; cites?: CiteReport } {
  let text = "";
  const tools: LabTool[] = [];
  let run: LabRun | undefined;
  let resume: string | null = null;
  let cites: CiteReport | undefined;
  let i = 0;
  for (;;) {
    const tm = raw.indexOf(TOOL_MARK, i);
    const rm = raw.indexOf(RUN_MARK, i);
    // The next control line, tool or run activity.
    const t = tm < 0 ? rm : rm < 0 ? tm : Math.min(tm, rm);
    const e = raw.indexOf(ERROR_MARK, i);
    if (e >= 0 && (t < 0 || e < t)) return { text: text + raw.slice(i, e), tools, error: raw.slice(e + 1).trim() || "Something went wrong.", run, resume, cites };
    if (t < 0) return { text: text + raw.slice(i), tools, error: null, run, resume, cites };
    text += raw.slice(i, t);
    const nl = raw.indexOf("\n", t);
    if (nl < 0) return { text, tools, error: null, run, resume, cites };
    if (t === rm) {
      try {
        const ev = JSON.parse(raw.slice(t + 1, nl)) as Record<string, unknown>;
        if (ev.t === "continue") {
          resume = typeof ev.token === "string" ? ev.token : null;
          // A round cut mid-word (lib/desk/resume.ts): the next request writes that word again.
          text = rewound(text, ev.rewind);
        }
        // The check of the reply's citations, sent once it is complete (lib/desk/citations.ts).
        else if (ev.t === "cites") cites = cleanCiteReport(ev.report) ?? cites;
        // A question card (ask_user): read by askFromStream.
        else if (ev.t !== "ask") run = applyRunEvent(run, ev, text.length, tools.length);
      } catch {
        // A line this client cannot read: skip it.
      }
      i = nl + 1;
      continue;
    }
    try {
      const ev = JSON.parse(raw.slice(t + 1, nl)) as Partial<LabTool> & { id?: unknown };
      if (typeof ev.id === "string") {
        const k = tools.findIndex((x) => x.id === ev.id);
        const prev = k >= 0 ? tools[k] : null;
        const next: LabTool = {
          id: ev.id,
          label: typeof ev.label === "string" ? ev.label : (prev?.label ?? "Looking up data"),
          state: ev.state === "done" ? "done" : "running",
          at: prev?.at ?? text.length,
        };
        if (typeof ev.ok === "boolean") next.ok = ev.ok;
        if (typeof ev.ms === "number") next.ms = ev.ms;
        if (typeof ev.result === "string") next.result = ev.result;
        const cmd = typeof ev.cmd === "string" ? ev.cmd : prev?.cmd;
        const ref = typeof ev.ref === "string" ? ev.ref : prev?.ref;
        if (cmd) next.cmd = cmd;
        if (ref) next.ref = ref;
        // A running row keeps its last progress until the next one (a heartbeat or another hop's start line has none).
        const progress = ev.progress && typeof ev.progress === "object" ? ev.progress : next.state === "running" ? prev?.progress : undefined;
        if (progress && Number.isFinite(progress.loaded) && Number.isFinite(progress.total) && progress.total > 0) next.progress = { loaded: Number(progress.loaded), total: Number(progress.total) };
        if (ev.pending === true) next.pending = true;
        if (typeof ev.src === "string") next.src = ev.src;
        // The route sends a checked spec (lib/desk/tools/chart.ts); storage re-checks it on load (cleanTools).
        const chart = ev.chart && typeof ev.chart === "object" ? ev.chart : prev?.chart;
        if (chart) next.chart = chart;
        const action = ev.action ? parseAppAction(ev.action) : (prev?.action ?? null);
        if (action) next.action = action;
        if (k >= 0) tools[k] = next;
        else tools.push(next);
      }
    } catch {
      // A line this client cannot read: skip it.
    }
    i = nl + 1;
  }
}

/** Tools for storage: results shortened so a long session still fits. */
function storedTools(tools: LabTool[]): LabTool[] | undefined {
  if (!tools.length) return undefined;
  return tools.map((t) => (t.result && t.result.length > STORED_RESULT_CHARS ? { ...t, result: `${t.result.slice(0, STORED_RESULT_CHARS)}… (shortened)` } : t));
}

function cleanMessage(m: unknown): LabMessage | null {
  const x = m as LabMessage;
  if (!x || typeof x.id !== "string" || (x.role !== "user" && x.role !== "assistant") || typeof x.text !== "string" || typeof x.at !== "number") return null;
  const out: LabMessage = { id: x.id, role: x.role, text: x.text, at: x.at };
  const images = x.role === "user" ? cleanImages(x.images) : undefined;
  if (images) out.images = images;
  // A reply still streaming in another live tab shows as running there; one whose page went away is as far as it got.
  if (x.status === "streaming" && streamingElsewhere(x.tab)) {
    out.status = "streaming";
    out.tab = x.tab;
  } else if (x.status === "streaming" || x.status === "stopped") out.status = "stopped";
  else if (x.status === "error") {
    out.status = "error";
    out.error = typeof x.error === "string" ? x.error : "Something went wrong.";
  }
  if (x.role === "assistant" && (x.vote === "up" || x.vote === "down")) out.vote = x.vote;
  const tools = x.role === "assistant" ? cleanTools(x.tools) : undefined;
  if (tools) out.tools = tools;
  const run = x.role === "assistant" ? cleanRun(x.run) : undefined;
  if (run) out.run = run;
  const ask = x.role === "assistant" ? cleanAsk(x.ask) : undefined;
  if (ask) out.ask = ask;
  const cites = x.role === "assistant" ? cleanCiteReport(x.cites) : undefined;
  if (cites) out.cites = cites;
  const followups = x.role === "assistant" ? cleanFollowups(x.followups) : undefined;
  if (followups) out.followups = followups;
  // A reply saved before echoed history markers were cut out (lib/desk/history-context.ts) loses them now.
  if (x.role === "assistant" && stripHistoryMarkers(out.text, false).text !== out.text) {
    const v = visibleReply(out, false);
    out.text = v.text;
    if (v.tools) out.tools = v.tools;
    if (v.run) out.run = v.run;
  }
  return out;
}

function read(scope: string): LabSession[] {
  return cleanList(readStoredSessions(scope));
}

/** Stored sessions (this browser, another tab or the account) checked into LabSessions. */
function cleanList(list: unknown): LabSession[] {
  try {
    if (!Array.isArray(list)) return EMPTY;
    return list
      .filter((s): s is LabSession => !!s && typeof s.id === "string" && typeof s.title === "string" && Array.isArray(s.messages))
      .map((s) => ({
        id: s.id,
        title: s.title,
        createdAt: typeof s.createdAt === "number" ? s.createdAt : 0,
        ...(s.pinned === true ? { pinned: true } : {}),
        updatedAt: typeof s.updatedAt === "number" ? s.updatedAt : 0,
        messages: s.messages.map(cleanMessage).filter((m): m is LabMessage => !!m),
      }));
  } catch {
    return EMPTY;
  }
}

/** Pinned sessions first, each group keeping its order. Sessions stored before pinning existed keep theirs. */
function grouped(list: LabSession[]): LabSession[] {
  return [...list.filter((s) => s.pinned), ...list.filter((s) => !s.pinned)];
}

/** This tab's own copy of each session it is streaming a reply for. */
function keepInFlight(list: LabSession[], here: LabSession[]): LabSession[] {
  return grouped(list.map((s) => (inFlight.has(s.id) ? (here.find((h) => h.id === s.id) ?? s) : s)));
}

const rechecks = new Map<string, ReturnType<typeof setTimeout>>();
/** A reply shown as streaming in another tab: checked again later, so it shows as stopped if that tab went away without a word. */
function recheckElsewhere(scope: string, list: LabSession[]) {
  if (typeof window === "undefined" || rechecks.has(scope)) return;
  if (!list.some((s) => !inFlight.has(s.id) && s.messages.some((m) => m.status === "streaming" && m.tab))) return;
  rechecks.set(
    scope,
    setTimeout(() => {
      rechecks.delete(scope);
      const here = get(scope);
      put(scope, keepInFlight(cleanList(here), here), false);
    }, LIVE_MS),
  );
}

function get(scope: string): LabSession[] {
  let list = cache.get(scope);
  if (!list) {
    list = typeof window === "undefined" ? EMPTY : grouped(read(scope));
    cache.set(scope, list);
    if (typeof window !== "undefined") {
      // Another tab's change shows here: its list, plus sessions only this tab has (unless that tab deleted them); a
      // reply still streaming in this tab keeps this tab's copy.
      watchStoredSessions(scope, (incoming, deleted) => {
        const here = get(scope);
        put(scope, keepInFlight(mergeIncoming(here, cleanList(incoming), deleted), here), false);
      });
      startServerSync(
        scope,
        () => get(scope) as unknown as StoredSession[],
        (merged) => put(scope, grouped(cleanList(merged)).map((s) => (inFlight.has(s.id) ? (get(scope).find((h) => h.id === s.id) ?? s) : s))),
      );
    }
  }
  return list;
}

/**
 * Writes the sessions to this browser (lab/session-store.ts; pruned to fit,
 * oldest first: long tool results, then thumbnails; the page keeps them) and
 * queues the account save.
 */
function persist(scope: string, list: LabSession[]) {
  // Test results go in smaller (lab/run.ts storedRun); the page keeps the full ones. A reply this page is streaming
  // is stored with the page's id, so other tabs show it as running while this page lives.
  // (A reply streaming in another tab already carries that tab's id.)
  const own = (m: LabMessage) => m.status === "streaming" && !m.tab;
  if (list.some((s) => s.messages.some(own))) setStreaming(true);
  const stored = list.map((s) => {
    if (!s.messages.some((m) => m.run || own(m))) return s;
    return { ...s, messages: s.messages.map((m) => ({ ...m, ...(m.run ? { run: storedRun(m.run) } : {}), ...(own(m) ? { tab: PAGE_ID } : {}) })) };
  }) as unknown as StoredSession[];
  // Merged with what other tabs stored (lab/session-store.ts): their new sessions show here too.
  const written = writeStoredSessions(scope, stored);
  const ids = (l: { id: string }[]) => l.map((s) => s.id).join(",");
  if (written && (written.adopted || ids(written.list) !== ids(list))) {
    const fresh = new Map(cleanList(written.list).map((s) => [s.id, s]));
    // Copies this tab already has stay the same objects (no re-render for them).
    const next = written.list.map((w) => {
      const here = list.find((s) => s.id === w.id);
      return here && here.updatedAt >= w.updatedAt ? here : fresh.get(w.id)!;
    });
    cache.set(scope, keepInFlight(next.filter(Boolean), list));
  }
  scheduleServerSave(scope, (written?.list ?? stored) as StoredSession[]);
}

function put(scope: string, list: LabSession[], save = true) {
  cache.set(scope, list);
  if (save) persist(scope, list);
  recheckElsewhere(scope, cache.get(scope) ?? list);
  listeners.get(scope)?.forEach((l) => l());
}

/** A newer updatedAt for a session this tab changed (the merge across tabs keeps the copy updated last). */
const touched = (s: { updatedAt: number }) => Math.max(Date.now(), (s.updatedAt || 0) + 1);

function patchMessage(scope: string, sessionId: string, messageId: string, fn: (m: LabMessage) => LabMessage, save: boolean) {
  const list = get(scope);
  put(
    scope,
    // A saved change (a finished reply, a vote) is newer than any copy another tab holds.
    list.map((s) => (s.id === sessionId ? { ...s, ...(save ? { updatedAt: touched(s) } : {}), messages: s.messages.map((m) => (m.id === messageId ? fn(m) : m)) } : s)),
    save,
  );
}

/**
 * The last messages for the request (lib/desk/history-context.ts): each reply's own words, with what it showed
 * (charts, a question card, the newest strategy test) as context on the member message after it.
 */
function requestHistory(messages: LabMessage[]): WireMessage[] {
  return wireHistory(messages, {
    limit: HISTORY,
    run: (m) => (m.run && (m.run.result || m.run.code) ? runForHistory(m.run) : null),
    image: (id) => fullImages.get(id),
    imageBudget: IMAGE_BUDGET,
    imagesPerRequest: IMAGES_PER_REQUEST,
  });
}

/**
 * The reply's visible text (no follow-up block, no echoed history marker, nothing half-written while streaming),
 * its follow-ups, and its tool rows and test moved to match the text once a marker is cut out.
 */
function visibleReply<T extends { text: string; tools?: LabTool[]; run?: LabRun }>(r: T, streaming: boolean) {
  const f = splitFollowups(r.text, streaming);
  const { pos } = stripHistoryMarkers(r.text, streaming);
  const tools = r.tools?.map((t) => ({ ...t, at: pos(t.at) }));
  const run = r.run ? { ...r.run, at: pos(r.run.at), ...(r.run.scripts ? { scripts: r.run.scripts.map((s) => ({ ...s, at: pos(s.at) })) } : {}) } : undefined;
  return { text: f.text, followups: f.followups, tools, run };
}

/** Sessions being titled now (one request each). */
const titling = new Set<string>();

/**
 * After a finished reply, names a session that still has the default title from its first question and answer
 * (POST /api/desk/title, a short title in the member's language). Any failure keeps the default title.
 */
async function autoTitle(scope: string, sessionId: string) {
  const s = get(scope).find((x) => x.id === sessionId);
  if (!s || s.title !== LAB_NEW_LABEL || titling.has(sessionId)) return;
  const question = s.messages.find((m) => m.role === "user" && m.text.trim());
  // A first reply that is only a question card (ask_user) still names the session, from its question.
  const reply = s.messages.find((m) => m.role === "assistant" && (m.text.trim() || m.ask) && !m.status);
  const answer = reply ? [stripCitations(reply.text).trim(), reply.ask ? askForHistory(reply.ask) : ""].filter(Boolean).join("\n\n") : "";
  if (!question || !answer) return;
  titling.add(sessionId);
  try {
    const res = await fetch("/api/desk/title", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await authHeaders()) },
      body: JSON.stringify({ question: question.text, answer: answer.slice(0, 1_500) }),
    });
    const title = res.ok ? ((await res.json().catch(() => null)) as { title?: unknown } | null)?.title : null;
    if (typeof title !== "string" || !title.trim()) return;
    // Only while the member has not renamed it in the meantime.
    const list = get(scope);
    if (list.find((x) => x.id === sessionId)?.title === LAB_NEW_LABEL) put(scope, list.map((x) => (x.id === sessionId ? { ...x, title: title.trim().slice(0, 60), updatedAt: touched(x) } : x)));
  } catch {
    // keep the default title
  } finally {
    titling.delete(sessionId);
  }
}

/**
 * Failed replies that can carry on (this page visit only), by reply id: the stream so far and the route's resume
 * token. Set when the route sent a token with its error (RUN_MARK `continue` with `retry`) or the connection broke
 * after a hand-off; Retry then continues the reply instead of asking again.
 */
const continuable = new Map<string, { raw: string; token: string }>();

async function run(scope: string, sessionId: string, replyId: string, from?: { raw: string; token: string }) {
  const session = get(scope).find((s) => s.id === sessionId);
  if (!session) return;
  continuable.delete(replyId);
  const controller = new AbortController();
  inFlight.get(sessionId)?.abort();
  inFlight.set(sessionId, controller);
  setStreaming(true);
  const history = requestHistory(session.messages.filter((m) => m.id !== replyId));
  // Source ids go on from the conversation's last one, so a citation never names an earlier reply's tool (lib/desk/citations.ts).
  const srcBase = session.messages.filter((m) => m.id !== replyId).reduce((n, m) => Math.max(n, ...(m.tools ?? []).map((t) => Number(t.src?.slice(1)) || 0)), 0);
  /** The answer to a question card just before this reply (lib/desk/ask.ts); sent with every hop so a resume keeps the same history. */
  const ask = askToSend(session.messages.filter((m) => m.id !== replyId));
  const patch = (fn: (m: LabMessage) => LabMessage, save = false) => patchMessage(scope, sessionId, replyId, fn, save);
  let raw = from?.raw ?? "";
  /** App actions already run in this reply (each runs once, as its done line arrives). */
  const acted = new Set<string>();
  const act = (tools: LabTool[]) => {
    for (const t of tools) {
      if (!t.action || t.state !== "done" || acted.has(t.id)) continue;
      acted.add(t.id);
      runAppAction(t.action);
    }
  };
  // Lines already handled before a Retry that continues (each app action runs once).
  if (from) for (const t of parseReply(from.raw).tools) if (t.action) acted.add(t.id);
  /** A reply longer than one request (a long answer, a strategy test) carries on with the route's resume token (RUN_MARK `continue`). */
  let resume: string | null = from?.token ?? null;
  /** The stream before this hop: a hop that breaks starts again from here with the same token. */
  let hopStart = raw;
  let attempts = 0;
  /** Lookups still running did not finish. */
  const settle = (m: LabMessage) => (m.tools ? storedTools(m.tools.map((t) => (t.state === "running" ? { ...t, state: "done" as const, ok: false } : t))) : undefined);
  try {
    for (let hop = 0; ; hop++) {
      hopStart = raw;
      let res: Response;
      let r: ReturnType<typeof parseReply>;
      try {
        res = await fetch(ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(await authHeaders()) },
          body: JSON.stringify({ messages: history, ...(resume ? { resume } : {}), ...(ask ? { ask } : {}), memory: memoryForRequest(scope), app: appSnapshot(), srcBase }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          const error = res.status === 401 ? SESSION_ENDED : res.status === 413 ? "The images are too large to send. Remove one and try again." : (body?.error ?? "Falcon AI is unavailable right now.");
          // A later hop refused for now (busy, rate limited): Retry carries on from the last hand-off.
          if (resume && res.status !== 400 && res.status !== 401) continuable.set(replyId, { raw: hopStart, token: resume });
          patch((m) => ({ ...m, status: "error", error, tools: settle(m), run: m.run ? settleRun(m.run, error) : undefined }), true);
          return;
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          raw += decoder.decode(value, { stream: true });
          const p = parseReply(raw);
          act(p.tools);
          // The follow-up block and echoed history markers are never shown, not even half-written (lib/desk/followups.ts).
          const v = visibleReply(p, true);
          patch((m) => ({ ...m, text: v.text, tools: v.tools?.length ? v.tools : undefined, run: v.run }));
        }
        raw += decoder.decode();
        r = parseReply(raw);
      } catch (error) {
        // The connection broke mid-hop: after a hand-off, post the same hop again once (its text so far is dropped and comes again).
        if (!reattemptHop({ aborted: controller.signal.aborted, token: resume, attempts })) throw error;
        attempts++;
        raw = hopStart;
        hop--;
        continue;
      }
      act(r.tools);
      // remember / forget calls in this reply (lab/memory-store.ts; each applied once).
      applyMemoryFromStream(scope, raw);
      if (r.error === null && r.resume && r.resume !== resume && hop < MAX_RESUMES) {
        resume = r.resume;
        attempts = 0;
        continue;
      }
      const f = visibleReply({ text: r.text, tools: storedTools(r.tools), run: r.run ? settleRun(r.run, r.error ?? undefined) : undefined }, false);
      const { tools, run } = f;
      if (r.error !== null) {
        // The route sent a token with its error (lib/desk/resume.ts): Retry carries on from where the reply stopped.
        const cut = raw.lastIndexOf(ERROR_MARK);
        if (r.resume && r.resume !== resume) continuable.set(replyId, { raw: cut >= 0 ? raw.slice(0, cut) : raw, token: r.resume });
        patch((m) => ({ ...m, text: f.text, tools, run, status: "error", error: r.error ?? undefined, ...(r.cites ? { cites: r.cites } : {}) }), true);
      } else {
        patch((m) => ({ ...m, text: f.text, tools, run, ask: askFromStream(raw, RUN_MARK), status: undefined, cites: r.cites, followups: f.followups.length ? f.followups : undefined }), true);
        void autoTitle(scope, sessionId);
      }
      return;
    }
  } catch {
    if (controller.signal.aborted) patch((m) => ({ ...m, tools: settle(m), run: m.run ? settleRun(m.run, "Stopped.") : undefined, status: "stopped" }), true);
    else {
      // After a hand-off, Retry carries on from it.
      if (resume) continuable.set(replyId, { raw: hopStart, token: resume });
      const lost = (m: LabMessage) => (resume ? "The connection was lost before Falcon AI finished. Retry to continue from where it stopped." : m.text ? "The answer was cut off." : "Falcon AI could not be reached. Check the connection.");
      patch((m) => ({ ...m, tools: settle(m), run: m.run ? settleRun(m.run, "The connection was lost.") : undefined, status: "error", error: lost(m) }), true);
    }
  } finally {
    if (inFlight.get(sessionId) === controller) inFlight.delete(sessionId);
    if (!inFlight.size) setStreaming(false);
  }
}

/**
 * Sessions of this workspace in grid order (pinned first; new sessions go
 * first among the unpinned, and using a session does not move it), and the actions:
 * `send` appends the viewer's message (creating the session on the first one,
 * so an untouched New screen leaves nothing behind) and streams the reply;
 * `stop` ends a reply; `answer` answers a question card; `retry` asks again for a reply; `vote` keeps a thumbs up or down;
 * `rename`, `pin`, `moveTo` (within its group) and `remove` manage the grid.
 */
export function useLabSessions(scope: string) {
  const subscribe = useCallback(
    (l: () => void) => {
      let set = listeners.get(scope);
      if (!set) listeners.set(scope, (set = new Set()));
      set.add(l);
      return () => {
        set.delete(l);
      };
    },
    [scope],
  );
  const sessions = useSyncExternalStore(
    subscribe,
    () => get(scope),
    () => EMPTY,
  );

  const send = useCallback(
    (sessionId: string, text: string, images: PreparedImage[] = []) => {
      if (inFlight.has(sessionId)) return;
      const now = Date.now();
      for (const img of images) fullImages.set(img.id, { mediaType: img.mediaType, data: img.data });
      const message: LabMessage = { id: newId(), role: "user", text, at: now };
      if (images.length) message.images = images.map((i) => ({ id: i.id, thumb: i.thumb, w: i.w, h: i.h }));
      const reply: LabMessage = { id: newId(), role: "assistant", text: "", at: now, status: "streaming" };
      const list = get(scope);
      const found = list.find((s) => s.id === sessionId);
      const session: LabSession = found
        ? // A question card left open is passed over: the message goes back as the answer (lib/desk/ask.ts askToSend).
          { ...found, updatedAt: now, messages: [...found.messages.map((m, i) => (i === found.messages.length - 1 && m.ask && !m.ask.answers ? { ...m, ask: { ...m.ask, skipped: true } } : m)), message, reply] }
        : { id: sessionId, title: LAB_NEW_LABEL, createdAt: now, updatedAt: now, messages: [message, reply] };
      // A new session goes first among the unpinned ones; a used one keeps its place in the viewer's order.
      if (found) put(scope, list.map((s) => (s.id === sessionId ? session : s)));
      else {
        const at = list.filter((s) => s.pinned).length;
        put(scope, [...list.slice(0, at), session, ...list.slice(at)]);
      }
      void run(scope, sessionId, reply.id);
    },
    [scope],
  );

  const stop = useCallback((sessionId: string) => {
    inFlight.get(sessionId)?.abort();
  }, []);

  /** Answers the question card on the last reply (ask_user); Claude carries on in a new reply below it. */
  const answer = useCallback(
    (sessionId: string, replyId: string, answers: AskAnswer[]) => {
      if (inFlight.has(sessionId)) return;
      const list = get(scope);
      const s = list.find((x) => x.id === sessionId);
      const at = s ? s.messages.findIndex((m) => m.id === replyId) : -1;
      const m = s?.messages[at];
      if (!s || !m?.ask || m.ask.answers || m.ask.skipped || at !== s.messages.length - 1) return;
      const reply: LabMessage = { id: newId(), role: "assistant", text: "", at: Date.now(), status: "streaming" };
      put(
        scope,
        list.map((x) => (x.id === sessionId ? { ...x, updatedAt: reply.at, messages: [...x.messages.slice(0, at), { ...m, ask: { ...m.ask!, answers } }, reply] } : x)),
      );
      void run(scope, sessionId, reply.id);
    },
    [scope],
  );

  /**
   * Asks again for a reply (the last one by default): the thread is cut back to
   * the user turn before it, and a new reply streams in its place.
   */
  const retry = useCallback(
    (sessionId: string, replyId?: string) => {
      if (inFlight.has(sessionId)) return;
      const list = get(scope);
      const s = list.find((x) => x.id === sessionId);
      if (!s) return;
      const at = replyId ? s.messages.findIndex((m) => m.id === replyId) : s.messages.length - 1;
      if (at < 0 || s.messages[at].role !== "assistant") return;
      // A reply that failed part-way with a resume token: carry on from where it stopped, keeping what it wrote.
      const target = s.messages[at];
      const from = target.status === "error" && at === s.messages.length - 1 ? continuable.get(target.id) : undefined;
      if (from) {
        patchMessage(scope, sessionId, target.id, (m) => ({ ...m, status: "streaming", error: undefined }), false);
        void run(scope, sessionId, target.id, from);
        return;
      }
      const reply: LabMessage = { id: newId(), role: "assistant", text: "", at: Date.now(), status: "streaming" };
      put(
        scope,
        list.map((x) => (x.id === sessionId ? { ...x, updatedAt: reply.at, messages: [...x.messages.slice(0, at), reply] } : x)),
      );
      void run(scope, sessionId, reply.id);
    },
    [scope],
  );

  /**
   * Edits one of the viewer's messages and asks again: the thread is cut back
   * to that message (its images kept), its text replaced, and a new reply streams.
   */
  const edit = useCallback(
    (sessionId: string, messageId: string, text: string) => {
      if (inFlight.has(sessionId)) return;
      const list = get(scope);
      const s = list.find((x) => x.id === sessionId);
      const at = s ? s.messages.findIndex((m) => m.id === messageId) : -1;
      if (!s || at < 0 || s.messages[at].role !== "user") return;
      const reply: LabMessage = { id: newId(), role: "assistant", text: "", at: Date.now(), status: "streaming" };
      const message: LabMessage = { ...s.messages[at], text, at: reply.at };
      put(
        scope,
        list.map((x) => (x.id === sessionId ? { ...x, updatedAt: reply.at, messages: [...x.messages.slice(0, at), message, reply] } : x)),
      );
      void run(scope, sessionId, reply.id);
    },
    [scope],
  );

  /** Keeps the viewer's thumbs up or down on a reply. */
  const vote = useCallback(
    (sessionId: string, replyId: string, value: "up" | "down") => {
      patchMessage(scope, sessionId, replyId, (m) => ({ ...m, vote: value }), true);
    },
    [scope],
  );

  /** Renames a session; an unsaved one is saved right away (empty) so the name sticks. */
  const rename = useCallback(
    (sessionId: string, title: string) => {
      const now = Date.now();
      const list = get(scope);
      const found = list.find((s) => s.id === sessionId);
      if (found) put(scope, list.map((s) => (s.id === sessionId ? { ...s, title, updatedAt: touched(s) } : s)));
      else {
        const at = list.filter((s) => s.pinned).length;
        put(scope, [...list.slice(0, at), { id: sessionId, title, createdAt: now, updatedAt: now, messages: [] }, ...list.slice(at)]);
      }
    },
    [scope],
  );

  /** Pins a session (first among the pinned) or unpins it (first among the rest). */
  const pin = useCallback(
    (sessionId: string, pinned: boolean) => {
      const list = get(scope);
      const found = list.find((s) => s.id === sessionId);
      if (!found || !!found.pinned === pinned) return;
      const rest = list.filter((s) => s.id !== sessionId);
      const next: LabSession = pinned ? { ...found, pinned: true, updatedAt: touched(found) } : { id: found.id, title: found.title, createdAt: found.createdAt, updatedAt: touched(found), messages: found.messages };
      const at = pinned ? 0 : rest.filter((s) => s.pinned).length;
      put(scope, [...rest.slice(0, at), next, ...rest.slice(at)]);
    },
    [scope],
  );

  /** Moves a session to `index` within its own group (pinned or not); it cannot leave the group. */
  const moveTo = useCallback(
    (sessionId: string, index: number) => {
      const list = get(scope);
      const found = list.find((s) => s.id === sessionId);
      if (!found) return;
      const group = list.filter((s) => !!s.pinned === !!found.pinned && s.id !== sessionId);
      const i = Math.max(0, Math.min(group.length, Math.round(index)));
      group.splice(i, 0, found);
      const pinned = found.pinned ? group : list.filter((s) => s.pinned);
      const rest = found.pinned ? list.filter((s) => !s.pinned) : group;
      const next = [...pinned, ...rest];
      if (next.every((s, k) => s === list[k])) return;
      put(scope, next);
    },
    [scope],
  );

  /** Deletes a session, stopping its reply if one is streaming. */
  const remove = useCallback(
    (sessionId: string) => {
      inFlight.get(sessionId)?.abort();
      const list = get(scope);
      const found = list.find((s) => s.id === sessionId);
      if (!found) return;
      for (const m of found.messages) m.images?.forEach((i) => fullImages.delete(i.id));
      // Tombstoned first: the merge with other tabs' copies (lab/session-store.ts) must not bring it back.
      forgetStoredSessions(scope, [sessionId]);
      put(
        scope,
        list.filter((s) => s.id !== sessionId),
      );
    },
    [scope],
  );

  return { sessions, send, stop, answer, retry, edit, vote, rename, pin, moveTo, remove };
}
