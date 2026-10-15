import { useSyncExternalStore } from "react";
import { agentsClient, agentsSource, subscribeAgentsSource, type AgentsEvent, type AgentsSource } from "@/lib/agents-client";
import { getLanguage } from "@/lib/i18n";
import { translate } from "@/lib/i18n/translate";
import { readPaperAccount } from "@/lib/paper-account";
import { createFocus, filingChangesWatchDraft } from "./agent-prefill";
import type {
  Agent,
  AgentDetail,
  AgentDraft,
  AgentMessage,
  AgentPatch,
  AgentReport,
  AgentResult,
  AgentRun,
} from "../../../shared/agent-types";

/**
 * One copy of the reader's agents for the whole renderer: the dashboard card,
 * the Agents tab and the page that switches to it all read the same state,
 * and the engine's push channel is listened to once, here.
 *
 * The list comes from `list()`; an agent's reports, activity and chat are
 * fetched with `get(id)` when it is first opened and then kept current by
 * push events. Writes go through the actions below, which apply the engine's
 * answer to the state so a screen never has to refetch after its own change.
 */

export type AgentSubview = "overview" | "reports" | "activity" | "chat";

export type DetailEntry =
  | { status: "loading"; detail?: AgentDetail }
  | { status: "ready"; detail: AgentDetail }
  | { status: "error"; error: string; detail?: AgentDetail };

/** A request to show something in the Agents tab, from anywhere in the app. */
export type AgentsFocus =
  | { kind: "agent"; id: string; view?: AgentSubview; reportId?: string; seq: number }
  | {
      kind: "create";
      seq: number;
      /** Words to start the instruction with (an earnings row's "Create agent"). */
      brief?: string;
      /** A name to start with; when absent the create flow suggests one from the words. */
      name?: string;
      /**
       * A draft built by the screen that asked (`agent-prefill.ts`): the flow
       * opens on its confirm step and nothing is sent to be read. `brief` and
       * `name` are the draft's, in the reader's language.
       */
      draft?: AgentDraft;
    };

export type AgentsSnapshot = {
  phase: "idle" | "loading" | "ready" | "unavailable" | "error";
  source: AgentsSource;
  agents: Agent[];
  error: string | null;
  details: Readonly<Record<string, DetailEntry>>;
  /** Reports that arrived while the app was open, by agent: drawn with a quiet highlight until opened. */
  fresh: Readonly<Record<string, string>>;
  focus: AgentsFocus | null;
};

const INITIAL: AgentsSnapshot = {
  phase: "idle",
  source: "none",
  agents: [],
  error: null,
  details: {},
  fresh: {},
  focus: null,
};

let state: AgentsSnapshot = INITIAL;
const listeners = new Set<() => void>();
const openListeners = new Set<(focus: AgentsFocus) => void>();
let unsubscribeEvents: (() => void) | null = null;
let started = false;
let focusSeq = 0;
let localSeq = 0;

function set(patch: Partial<AgentsSnapshot> | ((s: AgentsSnapshot) => Partial<AgentsSnapshot>)): void {
  const next = typeof patch === "function" ? patch(state) : patch;
  state = { ...state, ...next };
  for (const fn of listeners) fn();
}

const byNewest = <T extends { at: string }>(a: T, b: T) => Date.parse(b.at) - Date.parse(a.at);
const byOldest = <T extends { at: string }>(a: T, b: T) => Date.parse(a.at) - Date.parse(b.at);

function upsertAgent(list: readonly Agent[], agent: Agent): Agent[] {
  const at = list.findIndex((a) => a.id === agent.id);
  if (at < 0) return [agent, ...list];
  const next = [...list];
  next[at] = agent;
  return next;
}

function withDetail(id: string, fn: (d: AgentDetail) => AgentDetail): Partial<AgentsSnapshot> {
  const entry = state.details[id];
  if (!entry?.detail) return {};
  const detail = fn(entry.detail);
  return { details: { ...state.details, [id]: { ...entry, detail } as DetailEntry } };
}

function mergeById<T extends { id: string }>(list: readonly T[], item: T): T[] {
  return list.some((x) => x.id === item.id) ? list.map((x) => (x.id === item.id ? item : x)) : [...list, item];
}

function normalizeDetail(d: AgentDetail): AgentDetail {
  return {
    agent: d.agent,
    reports: [...(d.reports ?? [])].sort(byNewest),
    activity: [...(d.activity ?? [])].sort(byNewest),
    messages: [...(d.messages ?? [])].sort(byOldest),
  };
}

function applyEvent(e: AgentsEvent): void {
  switch (e.type) {
    case "agent-updated":
      set((s) => ({
        agents: upsertAgent(s.agents, e.agent),
        ...withDetail(e.agent.id, (d) => ({ ...d, agent: e.agent })),
      }));
      return;
    case "agent-removed":
      set((s) => {
        const details = { ...s.details };
        delete details[e.id];
        const fresh = { ...s.fresh };
        delete fresh[e.id];
        return { agents: s.agents.filter((a) => a.id !== e.id), details, fresh };
      });
      return;
    case "report":
      set((s) => ({
        agents: upsertAgent(s.agents, e.agent),
        fresh: { ...s.fresh, [e.agent.id]: e.report.id },
        ...withDetail(e.agent.id, (d) => ({
          ...d,
          agent: e.agent,
          reports: mergeById(d.reports, e.report).sort(byNewest),
        })),
      }));
      return;
    case "activity":
      set(withDetail(e.activity.agentId, (d) => ({ ...d, activity: mergeById(d.activity, e.activity).sort(byNewest) })));
      return;
    case "message":
      set(
        withDetail(e.message.agentId, (d) => {
          // The engine echoing the reader's own line replaces the copy drawn
          // while it was on its way.
          const messages =
            e.message.role === "user"
              ? d.messages.filter((m) => !(m.id.startsWith("local:") && m.text === e.message.text))
              : d.messages;
          return { ...d, messages: mergeById(messages, e.message).sort(byOldest) };
        }),
      );
      return;
    case "open-agent": {
      // The contract names it `agentId`; an early engine build sent `id`.
      const id = e.agentId ?? (e as { id?: string }).id;
      if (id) openAgent(id, e.reportId ? "reports" : undefined, e.reportId);
      return;
    }
    default:
      // An event type this build does not know: additive contract fields are
      // allowed, and ignoring them is the compatible answer.
      return;
  }
}

/** Fetches the list (again). Safe to call at any time. */
export async function refreshAgents(): Promise<void> {
  const client = agentsClient();
  if (!client) {
    set({ phase: "unavailable", source: "none", agents: [], error: null });
    return;
  }
  set((s) => ({ phase: s.phase === "ready" ? "ready" : "loading", source: agentsSource() }));
  try {
    const res = await client.list();
    if (res.ok) set({ phase: "ready", agents: res.data, error: null });
    else set({ phase: "error", error: res.error });
  } catch (err) {
    set({ phase: "error", error: err instanceof Error ? err.message : String(err) });
  }
}

function attach(): void {
  unsubscribeEvents?.();
  unsubscribeEvents = null;
  const client = agentsClient();
  if (client) {
    try {
      unsubscribeEvents = client.onEvent(applyEvent);
    } catch (err) {
      console.error("[agents] could not listen for events:", err);
    }
  }
  void refreshAgents();
}

function start(): void {
  if (started) return;
  started = true;
  attach();
  // An adapter installed later (a preview harness, the dev fixtures) starts
  // the store over against it.
  subscribeAgentsSource(() => {
    state = { ...INITIAL, focus: state.focus };
    attach();
  });
}

export function subscribeAgents(fn: () => void): () => void {
  listeners.add(fn);
  start();
  return () => listeners.delete(fn);
}

export function getAgentsSnapshot(): AgentsSnapshot {
  return state;
}

export function useAgents(): AgentsSnapshot {
  return useSyncExternalStore(subscribeAgents, getAgentsSnapshot, getAgentsSnapshot);
}

/** Loads an agent's reports, activity and chat; a second call refreshes them in place. */
export async function loadAgentDetail(id: string): Promise<void> {
  const client = agentsClient();
  if (!client) return;
  const prior = state.details[id]?.detail;
  set((s) => ({ details: { ...s.details, [id]: { status: "loading", detail: prior } } }));
  try {
    const res = await client.get(id);
    set((s) => ({
      details: {
        ...s.details,
        [id]: res.ok ? { status: "ready", detail: normalizeDetail(res.data) } : { status: "error", error: res.error, detail: prior },
      },
      ...(res.ok ? { agents: upsertAgent(s.agents, res.data.agent) } : {}),
    }));
  } catch (err) {
    set((s) => ({
      details: { ...s.details, [id]: { status: "error", error: err instanceof Error ? err.message : String(err), detail: prior } },
    }));
  }
}

/** Calls the engine, turning a thrown error into the contract's failure shape. */
async function call<T>(fn: (c: NonNullable<ReturnType<typeof agentsClient>>) => Promise<AgentResult<T>>): Promise<AgentResult<T>> {
  const client = agentsClient();
  if (!client) return { ok: false, error: translate(getLanguage(), "agents.error.unavailable") };
  try {
    return await fn(client);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function applyAgent(agent: Agent): void {
  set((s) => ({ agents: upsertAgent(s.agents, agent), ...withDetail(agent.id, (d) => ({ ...d, agent })) }));
}

/** The open positions, so "companies linked to my holdings" can name them (the starters read the same account). */
function heldTickers(): string[] {
  try {
    return Object.values(readPaperAccount().positions)
      .filter((p) => p && Number.isFinite(p.shares) && p.shares !== 0)
      .map((p) => p.symbol.toUpperCase());
  } catch {
    return [];
  }
}

export function draftFromBrief(brief: string): Promise<AgentResult<AgentDraft>> {
  return call((c) => c.draftFromBrief(brief, { held: heldTickers() }));
}

export async function createAgent(draft: AgentDraft): Promise<AgentResult<Agent>> {
  const res = await call((c) => c.create(draft));
  if (res.ok) applyAgent(res.data);
  return res;
}

export async function updateAgent(id: string, patch: AgentPatch): Promise<AgentResult<Agent>> {
  const res = await call((c) => c.update(id, patch));
  if (res.ok) applyAgent(res.data);
  return res;
}

export async function setAgentStatus(id: string, status: "active" | "paused"): Promise<AgentResult<Agent>> {
  const res = await call((c) => c.setStatus(id, status));
  if (res.ok) applyAgent(res.data);
  return res;
}

export async function removeAgent(id: string): Promise<AgentResult<{ id: string }>> {
  const res = await call((c) => c.remove(id));
  if (res.ok) applyEvent({ type: "agent-removed", id });
  return res;
}

export async function runAgentNow(id: string): Promise<AgentResult<AgentRun>> {
  const res = await call((c) => c.runNow(id));
  if (res.ok && res.data.report) {
    const report = res.data.report;
    set(withDetail(id, (d) => ({ ...d, reports: mergeById(d.reports, report).sort(byNewest) })));
  }
  return res;
}

export async function markAgentRead(id: string): Promise<void> {
  const had = state.agents.find((a) => a.id === id);
  if (!had || (had.unread === 0 && !state.fresh[id])) return;
  // Cleared at once on screen; the engine's agent-updated confirms it.
  set((s) => {
    const fresh = { ...s.fresh };
    delete fresh[id];
    return {
      fresh,
      agents: s.agents.map((a) => (a.id === id ? { ...a, unread: 0 } : a)),
      ...withDetail(id, (d) => ({ ...d, agent: { ...d.agent, unread: 0 }, reports: d.reports.map((r) => ({ ...r, read: true })) })),
    };
  });
  await call((c) => c.markRead(id));
}

/**
 * Sends one chat line. The reader's line is drawn straight away; the reply
 * arrives as the call's answer (and may also come over the push channel,
 * which is merged by id).
 */
export async function sendAgentMessage(id: string, text: string): Promise<AgentResult<AgentMessage>> {
  const local: AgentMessage = { id: `local:${++localSeq}`, agentId: id, role: "user", at: new Date().toISOString(), text };
  set(withDetail(id, (d) => ({ ...d, messages: [...d.messages, local] })));
  const res = await call((c) => c.sendMessage(id, text));
  if (res.ok) {
    const reply = res.data;
    set(withDetail(id, (d) => ({ ...d, messages: mergeById(d.messages, reply).sort(byOldest) })));
  } else {
    set(withDetail(id, (d) => ({ ...d, messages: d.messages.filter((m) => m.id !== local.id) })));
  }
  return res;
}

/** Ask the app to show this agent in the Agents tab. */
export function openAgent(id: string, view?: AgentSubview, reportId?: string): void {
  const focus: AgentsFocus = { kind: "agent", id, view, reportId, seq: ++focusSeq };
  set({ focus });
  for (const fn of openListeners) fn(focus);
}

/**
 * Ask the app to open the Agents tab on the create flow.
 *
 *   openCreateAgent(words, name?)  the instruction already written, and the
 *                                  name when one is given (else the flow
 *                                  suggests one, "NVDA earnings"); Next sends
 *                                  the words to be read as usual
 *   openCreateAgent(draft)         a draft built by the screen that knows
 *                                  what to watch (`agent-prefill.ts`): the
 *                                  flow opens on "Did we understand you?"
 *                                  with the trigger set, and nothing is read,
 *                                  so it works in any language with the model
 *                                  unreachable
 */
export function openCreateAgent(briefOrDraft?: string | AgentDraft, name?: string): void {
  const focus = createFocus(briefOrDraft, name, ++focusSeq);
  set({ focus });
  for (const fn of openListeners) fn(focus);
}

/**
 * The create flow, started on a filing changes watch for one company, every
 * kind of change, with the starter's words and name in the reader's language
 * (the Filing changes card and Stock tab section). The trigger is set here,
 * not read from the words.
 */
export function openFilingChangesAgent(ticker: string): void {
  const t = ticker.trim().toUpperCase();
  if (!t) return;
  openCreateAgent(filingChangesWatchDraft({ ticker: t }, getLanguage()));
}

/** Told whenever something asks for the Agents tab: HomePage switches to it. */
export function onAgentsOpenRequest(fn: (focus: AgentsFocus) => void): () => void {
  openListeners.add(fn);
  start();
  return () => openListeners.delete(fn);
}

/** The newest reports across every agent, for the dashboard card. */
export function latestReports(snapshot: AgentsSnapshot, limit: number): Array<{ agent: Agent; report: AgentReport }> {
  const out: Array<{ agent: Agent; report: AgentReport }> = [];
  for (const agent of snapshot.agents) {
    const detail = snapshot.details[agent.id]?.detail;
    for (const report of detail?.reports ?? []) out.push({ agent, report });
  }
  return out.sort((a, b) => byNewest(a.report, b.report)).slice(0, limit);
}

/**
 * The card lists the newest reports across agents, which live in each
 * agent's detail. Fetches the details of the agents that fired most recently
 * and are not loaded yet; a handful, since the card shows only a few rows.
 */
export function ensureRecentDetails(limit: number): void {
  const recent = [...state.agents]
    .filter((a) => a.lastFiredAt)
    .sort((a, b) => Date.parse(b.lastFiredAt!) - Date.parse(a.lastFiredAt!))
    .slice(0, limit);
  for (const agent of recent) {
    if (!state.details[agent.id]) void loadAgentDetail(agent.id);
  }
}
