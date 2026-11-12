"use client";

import { useSyncExternalStore } from "react";
import { addYears, DEFAULT_RUN, todayIso, type BacktestResult, type Strategy } from "@falcon/backtest";

/**
 * Saved strategies, per user, in this browser (moves to the account later),
 * plus the runs of this page session. Each strategy opens as its own Strategy
 * tab (lib/workspace/layout.ts, `strategy:<id>`).
 */

export type RunSettings = {
  /** null = the default window: the last 10 years up to the latest session. */
  start: string | null;
  end: string | null;
  initialCapital: number;
  commissionBps: number;
  slippageBps: number;
};

export type StrategyOrigin =
  | { kind: "blank" }
  | { kind: "template"; templateId: string }
  | { kind: "text" }
  | { kind: "sighting"; cardId: string; eventTicker: string; basis: string; notes: string[]; hasHistory: boolean };

export type SavedStrategy = {
  id: string;
  rules: Strategy;
  settings: RunSettings;
  /** The plain-English description, when there is one. */
  text: string;
  origin: StrategyOrigin;
  /** Notes from turning the text into rules. */
  parseNotes: { assumptions: string[]; unsupported: string[] } | null;
  /** Other saved strategies overlaid on this one's chart. */
  compareIds: string[];
  /** Run as soon as the tab opens (Backtest this), cleared once it ran. */
  autorun: boolean;
  /** Last successful run, ms; a reopened tab runs again quietly (prices are cached). */
  ranAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export const DEFAULT_SETTINGS: RunSettings = { start: null, end: null, ...DEFAULT_RUN };

export const BLANK_RULES: Strategy = {
  version: 1,
  name: "Untitled strategy",
  universe: ["SPY"],
  entry: { mode: "all", conditions: [{ type: "price_vs_ma", ticker: null, ma: "sma", period: 50, op: "crosses_above" }] },
  exit: { conditions: [{ type: "price_vs_ma", ticker: null, ma: "sma", period: 50, op: "crosses_below" }], stopLossPct: null, takeProfitPct: null, maxHoldingDays: null },
  sizing: { maxPositions: 1, positionPct: null },
  rebalance: "none",
};

const KEY_PREFIX = "falcon.strategies.v1";
const MAX_SAVED = 60;

type Store = { userId: string; items: SavedStrategy[] };
let store: Store = { userId: "", items: [] };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function isRules(v: unknown): v is Strategy {
  const r = v as Strategy | null;
  return Boolean(
    r &&
      typeof r === "object" &&
      typeof r.name === "string" &&
      Array.isArray(r.universe) &&
      r.entry &&
      Array.isArray(r.entry.conditions) &&
      r.exit &&
      Array.isArray(r.exit.conditions) &&
      r.sizing &&
      typeof r.sizing.maxPositions === "number",
  );
}

function clean(raw: unknown): SavedStrategy | null {
  const s = raw as Partial<SavedStrategy> | null;
  if (!s || typeof s !== "object" || typeof s.id !== "string" || !isRules(s.rules)) return null;
  const set = (s.settings ?? {}) as Partial<RunSettings>;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  return {
    id: s.id,
    rules: s.rules,
    settings: {
      start: date(set.start),
      end: date(set.end),
      initialCapital: num(set.initialCapital, DEFAULT_RUN.initialCapital),
      commissionBps: num(set.commissionBps, DEFAULT_RUN.commissionBps),
      slippageBps: num(set.slippageBps, DEFAULT_RUN.slippageBps),
    },
    text: typeof s.text === "string" ? s.text : "",
    origin: s.origin && typeof s.origin === "object" && "kind" in s.origin ? s.origin : { kind: "blank" },
    parseNotes: s.parseNotes ?? null,
    compareIds: Array.isArray(s.compareIds) ? s.compareIds.filter((x): x is string => typeof x === "string") : [],
    autorun: s.autorun === true,
    ranAt: typeof s.ranAt === "number" ? s.ranAt : null,
    createdAt: num(s.createdAt, Date.now()),
    updatedAt: num(s.updatedAt, Date.now()),
  };
}

function load(userId: string) {
  if (store.userId === userId) return;
  let items: SavedStrategy[] = [];
  try {
    const raw = typeof window === "undefined" ? null : localStorage.getItem(`${KEY_PREFIX}:${userId}`);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    if (Array.isArray(parsed)) items = parsed.map(clean).filter((s): s is SavedStrategy => s !== null);
  } catch {
    items = [];
  }
  store = { userId, items };
}

function save() {
  try {
    localStorage.setItem(`${KEY_PREFIX}:${store.userId}`, JSON.stringify(store.items));
  } catch {
    // Storage full or blocked: strategies last as long as the page.
  }
}

function commit(items: SavedStrategy[]) {
  store = { ...store, items };
  save();
  emit();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const EMPTY: SavedStrategy[] = [];

/** Every saved strategy of this user, newest first. */
export function useStrategies(userId: string): SavedStrategy[] {
  load(userId);
  return useSyncExternalStore(
    subscribe,
    () => (store.userId === userId ? store.items : EMPTY),
    () => EMPTY,
  );
}

export function getStrategy(userId: string, id: string): SavedStrategy | null {
  load(userId);
  return store.items.find((s) => s.id === id) ?? null;
}

function newId(): string {
  const rand = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `s${Date.now().toString(36)}${rand}`;
}

export function createStrategy(
  userId: string,
  init: Partial<Omit<SavedStrategy, "id" | "createdAt" | "updatedAt">> & { rules: Strategy },
): SavedStrategy {
  load(userId);
  const now = Date.now();
  const s: SavedStrategy = {
    settings: { ...DEFAULT_SETTINGS },
    text: "",
    origin: { kind: "blank" },
    parseNotes: null,
    compareIds: [],
    autorun: false,
    ranAt: null,
    ...init,
    rules: structuredClone(init.rules),
    id: newId(),
    createdAt: now,
    updatedAt: now,
  };
  commit([s, ...store.items].slice(0, MAX_SAVED));
  return s;
}

export function updateStrategy(userId: string, id: string, patch: Partial<SavedStrategy> | ((s: SavedStrategy) => Partial<SavedStrategy>)) {
  load(userId);
  let changed = false;
  const items = store.items.map((s) => {
    if (s.id !== id) return s;
    changed = true;
    const p = typeof patch === "function" ? patch(s) : patch;
    return { ...s, ...p, updatedAt: Date.now() };
  });
  if (changed) commit(items);
}

export function deleteStrategy(userId: string, id: string) {
  load(userId);
  commit(store.items.filter((s) => s.id !== id).map((s) => (s.compareIds.includes(id) ? { ...s, compareIds: s.compareIds.filter((c) => c !== id) } : s)));
}

/** The window a run uses: the saved dates, or the last 10 years to today. */
export function resolvedWindow(settings: RunSettings, now = new Date()): { start: string; end: string } {
  const end = settings.end ?? todayIso(now);
  return { start: settings.start ?? addYears(end, -10), end };
}

/* ------------------------------------------------------------------ */
/* Runs (this page session only; results are large)                    */
/* ------------------------------------------------------------------ */

export type RunState =
  | { status: "running"; startedAt: number; retrying: boolean }
  | { status: "done"; result: BacktestResult; finishedAt: number }
  | { status: "error"; message: string; errors: string[] };

const runs = new Map<string, RunState>();
const inflight = new Map<string, Promise<RunState>>();
const runListeners = new Set<() => void>();
let runVersion = 0;

function setRun(key: string, state: RunState) {
  runs.set(key, state);
  runVersion++;
  runListeners.forEach((l) => l());
}

/** Identity of a run: the exact rules and settings (dates resolved). */
export function runKey(rules: Strategy, settings: RunSettings): string {
  const { start, end } = resolvedWindow(settings);
  return JSON.stringify([rules, start, end, settings.initialCapital, settings.commissionBps, settings.slippageBps]);
}

export function getRun(key: string | null): RunState | null {
  return key ? (runs.get(key) ?? null) : null;
}

/** Re-renders when any run changes. */
export function useRunsVersion(): number {
  return useSyncExternalStore(
    (l) => {
      runListeners.add(l);
      return () => {
        runListeners.delete(l);
      };
    },
    () => runVersion,
    () => 0,
  );
}

async function post(rules: Strategy, settings: RunSettings): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const { start, end } = resolvedWindow(settings);
  const res = await fetch("/api/backtest/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      strategy: rules,
      start,
      end,
      initialCapital: settings.initialCapital,
      commissionBps: settings.commissionBps,
      slippageBps: settings.slippageBps,
    }),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body };
}

function errorText(status: number, body: Record<string, unknown> | null): string {
  if (status === 429) return "Too many runs in a short time. Try again in a minute.";
  if (status === 504) return "The price data took too long to load. What arrived is cached, so running again is faster.";
  if (typeof body?.error === "string") return body.error;
  return "The backtest could not run right now.";
}

/**
 * Runs the rules on /api/backtest/run once per key; a run already going or
 * done is reused. A deadline (504) is retried once: the data loaded so far is
 * cached on the server, so the second try is faster.
 */
export function startRun(rules: Strategy, settings: RunSettings, opts: { force?: boolean } = {}): Promise<RunState> {
  const key = runKey(rules, settings);
  const existing = runs.get(key);
  if (!opts.force && existing && existing.status !== "error") {
    return inflight.get(key) ?? Promise.resolve(existing);
  }
  const job = (async (): Promise<RunState> => {
    setRun(key, { status: "running", startedAt: Date.now(), retrying: false });
    let final: RunState;
    try {
      let r = await post(rules, settings);
      if (r.status === 504) {
        setRun(key, { status: "running", startedAt: Date.now(), retrying: true });
        r = await post(rules, settings);
      }
      if (r.status === 200 && r.body && Array.isArray(r.body.equity)) {
        final = { status: "done", result: r.body as unknown as BacktestResult, finishedAt: Date.now() };
      } else {
        const errors = Array.isArray(r.body?.errors) ? (r.body!.errors as unknown[]).filter((e): e is string => typeof e === "string") : [];
        final = { status: "error", message: errorText(r.status, r.body), errors };
      }
    } catch {
      final = { status: "error", message: "The backtest service could not be reached.", errors: [] };
    }
    setRun(key, final);
    inflight.delete(key);
    return final;
  })();
  inflight.set(key, job);
  return job;
}

/* ------------------------------------------------------------------ */
/* Plain English                                                       */
/* ------------------------------------------------------------------ */

export type ParseAnswer =
  | {
      ok: true;
      rules: Strategy;
      range: { start: string | null; end: string | null };
      assumptions: string[];
      unsupported: string[];
    }
  | { ok: false; reason: string; message: string; unsupported: string[] };

let configured: Promise<boolean> | null = null;

/** Whether the server has plain-English parsing switched on (asked once per page). */
function parsingConfigured(): Promise<boolean> {
  configured ??= fetch("/api/backtest/parse", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : { configured: true }))
    .then((b: { configured?: unknown }) => b.configured !== false)
    .catch(() => true);
  return configured;
}

/** POST /api/backtest/parse. `reason: "unavailable"` means parsing is not switched on. */
export async function parseText(text: string): Promise<ParseAnswer> {
  if (!(await parsingConfigured())) return { ok: false, reason: "unavailable", message: "Parsing is not switched on.", unsupported: [] };
  try {
    const res = await fetch("/api/backtest/parse", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
    if (res.ok && body && isRules(body.strategy)) {
      const range = (body.range ?? {}) as { start?: unknown; end?: unknown };
      return {
        ok: true,
        rules: body.strategy,
        range: {
          start: typeof range.start === "string" ? range.start : null,
          end: typeof range.end === "string" ? range.end : null,
        },
        assumptions: list(body.assumptions),
        unsupported: list(body.unsupported),
      };
    }
    if (res.status === 429) return { ok: false, reason: "rate", message: "Too many requests in a short time. Try again in a minute.", unsupported: [] };
    return {
      ok: false,
      reason: typeof body?.reason === "string" ? body.reason : res.status === 503 ? "unavailable" : "error",
      message: typeof body?.error === "string" ? body.error : "The description could not be read.",
      unsupported: list(body?.unsupported),
    };
  } catch {
    return { ok: false, reason: "unavailable", message: "The service could not be reached.", unsupported: [] };
  }
}
