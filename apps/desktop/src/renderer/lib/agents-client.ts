import type {
  Agent,
  AgentDetail,
  AgentDraft,
  AgentDraftContext,
  AgentMessage,
  AgentPatch,
  AgentPushEvent,
  AgentResult,
  AgentRun,
} from "../../shared/agent-types";

/**
 * The renderer's one way to the agent engine.
 *
 * In the app that is `window.meridian.agents`, the IPC surface described at
 * the head of `shared/agent-types.ts`. Nothing else stands in for it there:
 * a build whose main process has no agent handlers gets `null` here, and the
 * screens say plainly that agents are not available, rather than showing
 * made-up agents as if they were the reader's.
 *
 * The one exception is deliberate and local: a preview harness (or a dev
 * build with `falcon.dev.agentFixtures` set to "1") installs an in-memory
 * adapter with `installAgentsAdapter`, so the screens can be looked at
 * without an engine. The real bridge always wins when it is present.
 */

/**
 * Push events, as the contract defines them (`open-agent` included: a click
 * on an agent's native notification asks the app to show it). Event types
 * this build does not know are ignored by the store.
 */
export type AgentsEvent = AgentPushEvent;

export type AgentsBridge = {
  list: () => Promise<AgentResult<Agent[]>>;
  get: (id: string) => Promise<AgentResult<AgentDetail>>;
  draftFromBrief: (brief: string, context?: AgentDraftContext) => Promise<AgentResult<AgentDraft>>;
  create: (draft: AgentDraft) => Promise<AgentResult<Agent>>;
  update: (id: string, patch: AgentPatch) => Promise<AgentResult<Agent>>;
  setStatus: (id: string, status: "active" | "paused") => Promise<AgentResult<Agent>>;
  remove: (id: string) => Promise<AgentResult<{ id: string }>>;
  runNow: (id: string) => Promise<AgentResult<AgentRun>>;
  sendMessage: (id: string, text: string) => Promise<AgentResult<AgentMessage>>;
  markRead: (id: string) => Promise<AgentResult<{ id: string }>>;
  onEvent: (cb: (e: AgentsEvent) => void) => () => void;
};

export type AgentsSource = "bridge" | "fixtures" | "none";

let installed: AgentsBridge | null = null;
const listeners = new Set<() => void>();

/** Read without assuming the bridge's typing has the field yet. */
function bridgeAgents(): AgentsBridge | null {
  if (typeof window === "undefined") return null;
  const meridian = window.meridian as unknown as { agents?: Partial<AgentsBridge> } | undefined;
  const agents = meridian?.agents;
  return agents && typeof agents.list === "function" && typeof agents.onEvent === "function"
    ? (agents as AgentsBridge)
    : null;
}

/** The engine to talk to right now, or null when this build has none. */
export function agentsClient(): AgentsBridge | null {
  return bridgeAgents() ?? installed;
}

export function agentsSource(): AgentsSource {
  if (bridgeAgents()) return "bridge";
  return installed ? "fixtures" : "none";
}

/** Preview and dev only: stand an in-memory engine in for the missing bridge. */
export function installAgentsAdapter(adapter: AgentsBridge | null): void {
  installed = adapter;
  for (const fn of listeners) fn();
}

/** Told when an adapter is installed or removed, so a store can start over. */
export function subscribeAgentsSource(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// A dev build can opt into the fixtures from the console:
//   localStorage.setItem("falcon.dev.agentFixtures", "1")
// Loaded lazily so a production bundle never carries the made-up agents.
if (import.meta.env.DEV && typeof window !== "undefined") {
  let wanted = false;
  try {
    wanted = localStorage.getItem("falcon.dev.agentFixtures") === "1";
  } catch {
    wanted = false;
  }
  if (wanted && !bridgeAgents()) {
    void import("@/components/agents/agent-fixtures").then((m) => {
      if (!bridgeAgents() && !installed) installAgentsAdapter(m.createFixtureAgents());
    });
  }
}
