import fs from "node:fs";
import path from "node:path";
import type { Agent, AgentActivity, AgentMessage, AgentReport } from "../../shared/agent-types";
import { readJson, writeJsonAtomic } from "../briefing/json-file";
import { ID_SHAPE, LIMITS } from "./validate";

/**
 * Agents on this machine, one folder per account:
 *
 *   <data root>/agents/<user id | local>/agents.json        the agents
 *   <data root>/agents/<user id | local>/<agent id>/reports.json
 *                                                  activity.json
 *                                                  messages.json
 *                                                  state.json    engine bookkeeping
 *   <data root>/agents/<user id | local>/outbox.json        mobile deliveries
 *   <data root>/agents/<user id | local>/digest.json        reports held for the daily digest
 *
 * Every write is a temp file renamed into place, so a crash never leaves half
 * a file. Histories are capped (newest kept), so a long-lived agent never
 * grows its files without bound. Synchronous on purpose: the engine is the
 * only writer, the files are small, and a sync write cannot interleave with
 * another one from the same process.
 *
 * Nothing here knows about Electron, so it can be driven against a temp dir.
 */

/** Engine bookkeeping for one agent. Not part of the contract; never sent to the renderer. */
export type AgentEngineState = {
  /** When the scheduler should look at this agent again (ISO). */
  nextCheckAt?: string;
  /** Consecutive failed checks, for backoff. */
  failures: number;
  /** Event keys that already produced a report: the same event never fires twice. */
  firedKeys: string[];
  /** Last time each trigger fired, by trigger signature (cooldowns). */
  lastFiredByTrigger: Record<string, string>;
  /** Write-up attempts that failed for the event currently in hand. */
  pendingEvent?: { key: string; attempts: number };
  /** Best known earnings date per ticker (YYYY-MM-DD), with when it was read. */
  earnings?: Record<string, { date: string; estimated: boolean | null; readAt: string }>;
  /** Consensus read before a release, per ticker: the provider rolls estimates forward once results are out. */
  consensus?: Record<string, { lines: string[]; readAt: string }>;
  /**
   * Per `linked` trigger (by signature), the companies in its set and when
   * each joined it (ISO): a company that comes with a rebuilt graph counts
   * from then, not from the agent's start.
   */
  linked?: Record<string, Record<string, string>>;
};

export const EMPTY_STATE: AgentEngineState = { failures: 0, firedKeys: [], lastFiredByTrigger: {} };

const MAX_FIRED_KEYS = 300;
const MAX_OUTBOX = 500;

export type OutboxEntry = {
  id: string;
  at: string;
  agentId: string;
  reportId: string;
  channel: "mobile_push";
  title: string;
  body: string;
  status: string;
};

type AgentsFile = { version: 1; agents: Agent[] };

/** One report waiting for the daily digest. */
export type DigestEntry = {
  id: string;
  at: string;
  agentId: string;
  reportId: string;
  /** The agent's name, as the notification says it. */
  title: string;
  /** The report's headline. */
  body: string;
};

/** The daily digest: what waits for it, and the New York day it last went out. */
export type DigestFile = { version: 1; lastSentDay?: string; entries: DigestEntry[] };

const MAX_DIGEST = 200;

/** The folder name for an account: its id, or "local" when no one is signed in. */
export function userDirName(userKey: string | null | undefined): string {
  const key = typeof userKey === "string" ? userKey.trim().toLowerCase() : "";
  if (!key || key === "anon" || !/^[a-z0-9-]{1,64}$/.test(key)) return "local";
  return key;
}

function requireSafeId(id: string): string {
  if (!ID_SHAPE.test(id)) throw new Error("Not an agent id");
  return id;
}

function capNewest<T>(list: T[], max: number): T[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

export class AgentStore {
  readonly dir: string;

  constructor(root: string, userKey: string | null | undefined) {
    this.dir = path.join(root, "agents", userDirName(userKey));
  }

  private agentsFile(): string {
    return path.join(this.dir, "agents.json");
  }

  private agentFile(id: string, name: string): string {
    return path.join(this.dir, requireSafeId(id), name);
  }

  list(): Agent[] {
    const file = readJson<AgentsFile>(this.agentsFile());
    return Array.isArray(file?.agents) ? file.agents.filter((a) => a && typeof a.id === "string" && ID_SHAPE.test(a.id)) : [];
  }

  get(id: string): Agent | null {
    return this.list().find((a) => a.id === id) ?? null;
  }

  /** Inserts or replaces by id. */
  put(agent: Agent): Agent {
    requireSafeId(agent.id);
    const agents = this.list();
    const i = agents.findIndex((a) => a.id === agent.id);
    if (i === -1) {
      if (agents.length >= LIMITS.agentsPerUser) {
        throw new Error(`You can have at most ${LIMITS.agentsPerUser} agents. Remove one to make room.`);
      }
      agents.push(agent);
    } else {
      agents[i] = agent;
    }
    writeJsonAtomic(this.agentsFile(), { version: 1, agents } satisfies AgentsFile);
    return agent;
  }

  /** Applies `fn` to the stored agent and saves the result. Null when it is gone. */
  update(id: string, fn: (agent: Agent) => Agent): Agent | null {
    const current = this.get(id);
    if (!current) return null;
    return this.put(fn(current));
  }

  remove(id: string): boolean {
    requireSafeId(id);
    const agents = this.list();
    const next = agents.filter((a) => a.id !== id);
    if (next.length === agents.length) return false;
    writeJsonAtomic(this.agentsFile(), { version: 1, agents: next } satisfies AgentsFile);
    fs.rmSync(path.join(this.dir, id), { recursive: true, force: true });
    return true;
  }

  reports(id: string): AgentReport[] {
    const list = readJson<AgentReport[]>(this.agentFile(id, "reports.json"));
    return Array.isArray(list) ? list : [];
  }

  addReport(report: AgentReport): AgentReport {
    const list = capNewest([...this.reports(report.agentId), report], LIMITS.reportsPerAgent);
    writeJsonAtomic(this.agentFile(report.agentId, "reports.json"), list);
    return report;
  }

  /** Marks every report read; returns how many changed. */
  markReportsRead(id: string): number {
    const list = this.reports(id);
    let changed = 0;
    const next = list.map((r) => {
      if (r.read) return r;
      changed++;
      return { ...r, read: true };
    });
    if (changed > 0) writeJsonAtomic(this.agentFile(id, "reports.json"), next);
    return changed;
  }

  activity(id: string): AgentActivity[] {
    const list = readJson<AgentActivity[]>(this.agentFile(id, "activity.json"));
    return Array.isArray(list) ? list : [];
  }

  /**
   * Appends a timeline entry. "checked", "waiting" and "error" entries that repeat the
   * previous one word for word only move its time forward: a watch that
   * checks every ten minutes for a week must not leave a thousand identical
   * lines. Returns the entry as stored and whether it is new.
   */
  addActivity(entry: AgentActivity): { activity: AgentActivity; appended: boolean } {
    const list = this.activity(entry.agentId);
    const last = list[list.length - 1];
    if (
      last &&
      (entry.kind === "checked" || entry.kind === "waiting" || entry.kind === "error") &&
      last.kind === entry.kind &&
      last.text === entry.text
    ) {
      const bumped = { ...last, at: entry.at };
      list[list.length - 1] = bumped;
      writeJsonAtomic(this.agentFile(entry.agentId, "activity.json"), list);
      return { activity: bumped, appended: false };
    }
    const next = capNewest([...list, entry], LIMITS.activityPerAgent);
    writeJsonAtomic(this.agentFile(entry.agentId, "activity.json"), next);
    return { activity: entry, appended: true };
  }

  messages(id: string): AgentMessage[] {
    const list = readJson<AgentMessage[]>(this.agentFile(id, "messages.json"));
    return Array.isArray(list) ? list : [];
  }

  addMessages(id: string, messages: AgentMessage[]): void {
    const next = capNewest([...this.messages(id), ...messages], LIMITS.messagesPerAgent);
    writeJsonAtomic(this.agentFile(id, "messages.json"), next);
  }

  state(id: string): AgentEngineState {
    const raw = readJson<Partial<AgentEngineState>>(this.agentFile(id, "state.json"));
    return {
      ...EMPTY_STATE,
      ...(raw ?? {}),
      failures: typeof raw?.failures === "number" ? raw.failures : 0,
      firedKeys: Array.isArray(raw?.firedKeys) ? raw.firedKeys : [],
      lastFiredByTrigger: raw?.lastFiredByTrigger && typeof raw.lastFiredByTrigger === "object" ? raw.lastFiredByTrigger : {},
    };
  }

  setState(id: string, state: AgentEngineState): void {
    if (!this.get(id)) return;
    writeJsonAtomic(this.agentFile(id, "state.json"), {
      ...state,
      firedKeys: capNewest(state.firedKeys, MAX_FIRED_KEYS),
    });
  }

  outbox(): OutboxEntry[] {
    const list = readJson<OutboxEntry[]>(path.join(this.dir, "outbox.json"));
    return Array.isArray(list) ? list : [];
  }

  appendOutbox(entry: OutboxEntry): void {
    writeJsonAtomic(path.join(this.dir, "outbox.json"), capNewest([...this.outbox(), entry], MAX_OUTBOX));
  }

  digest(): DigestFile {
    const raw = readJson<Partial<DigestFile>>(path.join(this.dir, "digest.json"));
    const entries = Array.isArray(raw?.entries) ? raw.entries.filter((e) => e && typeof e.agentId === "string" && typeof e.reportId === "string") : [];
    return { version: 1, ...(typeof raw?.lastSentDay === "string" ? { lastSentDay: raw.lastSentDay } : {}), entries };
  }

  /** Holds one report for the next digest; one entry per agent, its newest report. */
  appendDigest(entry: DigestEntry): void {
    const file = this.digest();
    const entries = capNewest([...file.entries.filter((e) => e.agentId !== entry.agentId), entry], MAX_DIGEST);
    this.setDigest({ ...file, entries });
  }

  setDigest(file: DigestFile): void {
    writeJsonAtomic(path.join(this.dir, "digest.json"), file);
  }
}
