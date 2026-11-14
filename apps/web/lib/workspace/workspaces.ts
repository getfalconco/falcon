"use client";

import { useCallback, useState } from "react";
import { FUNNEL_TEST_MODE } from "@/lib/funnel-test-mode";
import { FOCUS_KEY_PREFIX } from "./focus";
import { LAYOUT_KEY_PREFIX } from "./layout";
import { STRATEGIES_KEY_PREFIX } from "./strategies";

/**
 * Workspaces, in this browser only: each has its own focus list, saved
 * strategies and open tabs. The index lives at `falcon.workspaces.v1:<userId>`.
 *
 * Nothing existing moves. The first workspace ("main", named "Main") keeps
 * the original keys (`falcon.focus.v1:<userId>` and so on) and the focus list
 * that syncs with the account; every other workspace stores under
 * `<prefix>:<userId>:<workspaceId>` and its focus list never leaves this
 * browser. The per-workspace "storage scope" passed to focus, layout and
 * strategies in place of the user id is what builds those keys.
 */

export type WorkspaceInfo = { id: string; name: string; createdAt: number };
export type WorkspaceIndex = { list: WorkspaceInfo[]; activeId: string };

export const MAIN_WORKSPACE_ID = "main";
export const MAX_WORKSPACES = 20;
export const MAX_WORKSPACE_NAME = 40;

const KEY_PREFIX = "falcon.workspaces.v1";
const ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const MAIN: WorkspaceInfo = { id: MAIN_WORKSPACE_ID, name: "Main", createdAt: 0 };

let memory: { userId: string; index: WorkspaceIndex } | null = null;

/** The storage scope for a workspace: the user id for "main", `<userId>:<workspaceId>` otherwise. */
export function storageScope(userId: string, workspaceId: string): string {
  return workspaceId === MAIN_WORKSPACE_ID ? userId : `${userId}:${workspaceId}`;
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, MAX_WORKSPACE_NAME);
}

function parse(raw: unknown): WorkspaceIndex {
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const seen = new Set<string>([MAIN_WORKSPACE_ID]);
  const list: WorkspaceInfo[] = [MAIN];
  for (const item of Array.isArray(r.list) ? r.list : []) {
    if (!item || typeof item !== "object") continue;
    const w = item as Record<string, unknown>;
    if (w.id === MAIN_WORKSPACE_ID) {
      // Main can be renamed, never removed.
      const name = typeof w.name === "string" ? cleanName(w.name) : "";
      if (name) list[0] = { ...MAIN, name };
      continue;
    }
    if (typeof w.id !== "string" || !ID_PATTERN.test(w.id) || seen.has(w.id)) continue;
    const name = typeof w.name === "string" ? cleanName(w.name) : "";
    if (!name) continue;
    seen.add(w.id);
    list.push({ id: w.id, name, createdAt: typeof w.createdAt === "number" ? w.createdAt : Date.now() });
    if (list.length >= MAX_WORKSPACES) break;
  }
  const activeId = typeof r.activeId === "string" && seen.has(r.activeId) ? r.activeId : MAIN_WORKSPACE_ID;
  return { list, activeId };
}

export function readWorkspaces(userId: string): WorkspaceIndex {
  if (memory?.userId === userId) return memory.index;
  if (FUNNEL_TEST_MODE || typeof window === "undefined") return parse(null);
  try {
    const raw = localStorage.getItem(`${KEY_PREFIX}:${userId}`);
    return parse(raw ? JSON.parse(raw) : null);
  } catch {
    return parse(null);
  }
}

export function writeWorkspaces(userId: string, index: WorkspaceIndex): void {
  memory = { userId, index };
  if (FUNNEL_TEST_MODE || typeof window === "undefined") return;
  try {
    localStorage.setItem(`${KEY_PREFIX}:${userId}`, JSON.stringify(index));
  } catch {
    // Storage full or blocked: the list lasts as long as the page.
  }
}

/** Removes a deleted workspace's focus list, strategies and layout from this browser. Never main. */
function removeWorkspaceData(userId: string, workspaceId: string): void {
  if (workspaceId === MAIN_WORKSPACE_ID || FUNNEL_TEST_MODE || typeof window === "undefined") return;
  const scope = storageScope(userId, workspaceId);
  for (const prefix of [FOCUS_KEY_PREFIX, LAYOUT_KEY_PREFIX, STRATEGIES_KEY_PREFIX]) {
    try {
      localStorage.removeItem(`${prefix}:${scope}`);
    } catch {
      // Blocked storage: nothing was written either.
    }
  }
}

function newId(): string {
  return `w-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

/** This viewer's workspaces and the actions on them; every change is saved at once. */
export function useWorkspaceIndex(userId: string) {
  const [index, setIndex] = useState<WorkspaceIndex>(() => readWorkspaces(userId));

  const commit = useCallback(
    (next: WorkspaceIndex) => {
      writeWorkspaces(userId, next);
      setIndex(next);
    },
    [userId],
  );

  const switchTo = useCallback(
    (id: string) => {
      const cur = readWorkspaces(userId);
      if (cur.activeId !== id && cur.list.some((w) => w.id === id)) commit({ ...cur, activeId: id });
    },
    [commit, userId],
  );

  /** Creates a workspace and switches to it; null when the name is empty or the list is full. */
  const create = useCallback(
    (name: string): string | null => {
      const cur = readWorkspaces(userId);
      const clean = cleanName(name);
      if (!clean || cur.list.length >= MAX_WORKSPACES) return null;
      const w: WorkspaceInfo = { id: newId(), name: clean, createdAt: Date.now() };
      commit({ list: [...cur.list, w], activeId: w.id });
      return w.id;
    },
    [commit, userId],
  );

  const rename = useCallback(
    (id: string, name: string) => {
      const cur = readWorkspaces(userId);
      const clean = cleanName(name);
      if (!clean) return;
      commit({ ...cur, list: cur.list.map((w) => (w.id === id ? { ...w, name: clean } : w)) });
    },
    [commit, userId],
  );

  /** Deletes a workspace and its data in this browser; main cannot be deleted. */
  const remove = useCallback(
    (id: string) => {
      if (id === MAIN_WORKSPACE_ID) return;
      const cur = readWorkspaces(userId);
      if (!cur.list.some((w) => w.id === id)) return;
      commit({ list: cur.list.filter((w) => w.id !== id), activeId: cur.activeId === id ? MAIN_WORKSPACE_ID : cur.activeId });
      removeWorkspaceData(userId, id);
    },
    [commit, userId],
  );

  const active = index.list.find((w) => w.id === index.activeId) ?? index.list[0];
  return { index, active, switchTo, create, rename, remove };
}
