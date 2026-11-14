"use client";

import { useSyncExternalStore } from "react";
import {
  DEFAULT_RUN,
  blankSpec,
  specHash,
  v1ToV2,
  validateSpec,
  type QualityReport,
  type RunResultV2,
  type SpecDescription,
  type SpecIssue,
  type Strategy,
  type StrategySpecV2,
} from "@falcon/backtest";
import type { Answer, Question } from "@falcon/backtest/ai";

/**
 * Saved strategies, per user, in this browser (moves to the account with the
 * Strategy Lab migration), plus the runs of this page session. Each strategy
 * opens as its own Strategy tab (lib/workspace/layout.ts, `strategy:<id>`).
 *
 * Strategy Lab v2: the source of truth is `spec` (StrategySpec v2). Every
 * change by chat, slider or formula adds a version; every run counts as a
 * trial (the browser's ledger, used for the deflated Sharpe ratio). Strategies
 * saved before v2 carry v1 `rules` and are converted with v1ToV2, which keeps
 * their v1 behaviour (`legacy`). `rules.name` mirrors the spec's name for code
 * that reads the tab title.
 */

/** The window a v1 run uses: the saved dates, or the last 10 years to today (RuleEditor, v1 only). */
export function resolvedWindow(settings: RunSettings, now = new Date()): { start: string; end: string } {
  const end = settings.end ?? now.toISOString().slice(0, 10);
  const d = new Date(`${end}T00:00:00Z`);
  d.setUTCFullYear(d.getUTCFullYear() - 10);
  return { start: settings.start ?? d.toISOString().slice(0, 10), end };
}

/** v1 run settings, kept only to convert strategies saved before v2. */
export type RunSettings = {
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

export type SpecVersion = { v: number; spec: StrategySpecV2; at: number; source: "chat" | "template" | "formula" | "slider" | "settings" | "import" | "sighting" | "blank" };

export type Conversation = {
  intent: string;
  answers: Answer[];
  questionsAsked: number;
  /** Questions waiting for an answer. */
  pending: Question[] | null;
  assumptions: string[];
  notExpressible: string[];
  /** The last assistant note (not a strategy, or an error). */
  note: { tone: "quiet" | "error"; text: string } | null;
};

export type SavedStrategy = {
  id: string;
  /** v1 rules: the original rules for strategies made before v2 (or by Backtest this); `name` mirrors spec.name. */
  rules: Pick<Strategy, "name"> & Partial<Strategy>;
  spec: StrategySpecV2;
  versions: SpecVersion[];
  /** False until the person confirms the interpretation (the gate before the first run). */
  confirmed: boolean;
  conversation: Conversation;
  /** Runs made with this strategy in this browser (each run is a trial). */
  trials: number;
  text: string;
  origin: StrategyOrigin;
  parseNotes: { assumptions: string[]; unsupported: string[] } | null;
  compareIds: string[];
  autorun: boolean;
  ranAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export const DEFAULT_SETTINGS: RunSettings = { start: null, end: null, ...DEFAULT_RUN };

/** A blank v1 rule set (Workspace's "New strategy" passes it); converted to a v2 spec on creation. */
export const BLANK_RULES: Strategy = {
  version: 1,
  name: "Untitled strategy",
  universe: ["SPY"],
  entry: { mode: "all", conditions: [{ type: "price_vs_ma", ticker: null, ma: "sma", period: 200, op: "above" }] },
  exit: { conditions: [{ type: "price_vs_ma", ticker: null, ma: "sma", period: 200, op: "below" }], stopLossPct: null, takeProfitPct: null, maxHoldingDays: null },
  sizing: { maxPositions: 1, positionPct: null },
  rebalance: "none",
};

const KEY_PREFIX = "falcon.strategies.v1";
const MAX_SAVED = 60;
const MAX_VERSIONS = 30;

type Store = { userId: string; items: SavedStrategy[] };
let store: Store = { userId: "", items: [] };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((l) => l());
}

function isRules(v: unknown): v is Strategy {
  const r = v as Strategy | null;
  return Boolean(r && typeof r === "object" && typeof r.name === "string" && Array.isArray(r.universe) && r.entry && Array.isArray(r.entry.conditions) && r.exit && Array.isArray(r.exit.conditions) && r.sizing);
}

function emptyConversation(intent = ""): Conversation {
  return { intent, answers: [], questionsAsked: 0, pending: null, assumptions: [], notExpressible: [], note: null };
}

function settingsConfig(set: Partial<RunSettings> | undefined) {
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const date = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined);
  return {
    start: date(set?.start),
    end: date(set?.end),
    initialCapital: num(set?.initialCapital, DEFAULT_RUN.initialCapital),
    commissionBps: num(set?.commissionBps, DEFAULT_RUN.commissionBps),
    slippageBps: num(set?.slippageBps, DEFAULT_RUN.slippageBps),
  };
}

/** Old and new saved shapes in; a v2 SavedStrategy out (v1 rules converted with v1ToV2). */
function clean(raw: unknown): SavedStrategy | null {
  const s = raw as (Partial<SavedStrategy> & { settings?: Partial<RunSettings> }) | null;
  if (!s || typeof s !== "object" || typeof s.id !== "string") return null;
  let spec: StrategySpecV2 | null = null;
  if (s.spec && validateSpec(s.spec).ok) spec = s.spec;
  else if (isRules(s.rules)) {
    try {
      spec = v1ToV2(s.rules, settingsConfig(s.settings), typeof s.text === "string" ? s.text : "");
    } catch {
      spec = null;
    }
  }
  if (!spec) return null;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  const versions = Array.isArray(s.versions) && s.versions.length ? s.versions.filter((v) => v && typeof v.v === "number" && v.spec) : [{ v: 1, spec, at: num(s.createdAt, Date.now()), source: "import" as const }];
  const conv = s.conversation && typeof s.conversation === "object" ? { ...emptyConversation(), ...s.conversation } : emptyConversation(typeof s.text === "string" ? s.text : "");
  return {
    id: s.id,
    rules: isRules(s.rules) ? { ...s.rules, name: spec.name } : { name: spec.name },
    spec,
    versions,
    confirmed: s.confirmed ?? Boolean(s.ranAt || s.origin?.kind === "sighting" || s.origin?.kind === "template"),
    conversation: conv,
    trials: num(s.trials, s.ranAt ? 1 : 0),
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

export type CreateInit = Partial<Omit<SavedStrategy, "id" | "createdAt" | "updatedAt" | "rules" | "spec">> & {
  /** v1 rules (Backtest this, older callers): converted with v1ToV2. */
  rules?: Strategy;
  spec?: StrategySpecV2;
};

export function createStrategy(userId: string, init: CreateInit): SavedStrategy {
  load(userId);
  const now = Date.now();
  const blankV1 = init.rules === BLANK_RULES;
  const spec = init.spec ? structuredClone(init.spec) : blankV1 || !init.rules ? blankSpec() : v1ToV2(init.rules, {}, init.text ?? "");
  const origin = init.origin ?? { kind: "blank" };
  const s: SavedStrategy = {
    text: "",
    parseNotes: null,
    compareIds: [],
    autorun: false,
    ranAt: null,
    trials: 0,
    confirmed: origin.kind === "sighting",
    conversation: emptyConversation(init.text ?? ""),
    ...init,
    origin,
    spec,
    rules: init.rules && !blankV1 ? { ...structuredClone(init.rules), name: spec.name } : { name: spec.name },
    versions: [{ v: 1, spec, at: now, source: origin.kind === "sighting" ? "sighting" : origin.kind === "template" ? "template" : "blank" }],
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
    const next = { ...s, ...p, updatedAt: Date.now() };
    next.rules = { ...next.rules, name: next.spec.name };
    return next;
  });
  if (changed) commit(items);
}

/** A new spec version (chat edit, slider release, formula edit, template). Same spec as the latest: no new version. */
export function setSpec(userId: string, id: string, spec: StrategySpecV2, source: SpecVersion["source"], extra: Partial<SavedStrategy> = {}) {
  updateStrategy(userId, id, (s) => {
    const last = s.versions[s.versions.length - 1];
    const same = last && specHash(last.spec) === specHash(spec) && last.spec.name === spec.name;
    // Typing in a settings field replaces the previous settings version instead of adding one per keystroke.
    const merge = !same && last && source === "settings" && last.source === "settings" && s.versions.length > 1;
    const versions = same
      ? s.versions
      : merge
        ? [...s.versions.slice(0, -1), { ...last, spec, at: Date.now() }]
        : [...s.versions, { v: (last?.v ?? 0) + 1, spec, at: Date.now(), source }].slice(-MAX_VERSIONS);
    return { spec, versions, ...extra };
  });
}

export function deleteStrategy(userId: string, id: string) {
  load(userId);
  commit(store.items.filter((s) => s.id !== id).map((s) => (s.compareIds.includes(id) ? { ...s, compareIds: s.compareIds.filter((c) => c !== id) } : s)));
}

/* ------------------------------------------------------------------ */
/* Runs (this page session only; results are large)                    */
/* ------------------------------------------------------------------ */

export type RunState =
  | { status: "running"; startedAt: number; retrying: boolean }
  | { status: "done"; result: RunResultV2; finishedAt: number }
  | { status: "error"; message: string; errors: string[]; issues: SpecIssue[] };

export type AuditState =
  | { status: "running"; startedAt: number }
  | { status: "done"; quality: QualityReport }
  | { status: "error"; message: string };

const runs = new Map<string, RunState>();
const audits = new Map<string, AuditState>();
const inflight = new Map<string, Promise<RunState>>();
const runListeners = new Set<() => void>();
let runVersion = 0;

function bump() {
  runVersion++;
  runListeners.forEach((l) => l());
}

/** Identity of a run: the spec's hash (everything that changes results). */
export function runKey(spec: StrategySpecV2): string {
  return specHash(spec);
}

export function getRun(key: string | null): RunState | null {
  return key ? (runs.get(key) ?? null) : null;
}

export function getAudit(key: string | null): AuditState | null {
  return key ? (audits.get(key) ?? null) : null;
}

/** Re-renders when any run, audit or review changes. */
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

async function post(path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> | null }> {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  return { status: res.status, body: json };
}

function errorText(status: number, body: Record<string, unknown> | null, fallback: string): string {
  if (status === 429) return "Too many requests in a short time. Try again in a minute.";
  if (status === 504) return "The price data took too long to load. What arrived is cached, so running again is faster.";
  if (typeof body?.error === "string") return body.error;
  if (typeof body?.message === "string") return body.message;
  return fallback;
}

/** Runs a spec on /api/strategy/run once per spec; a deadline (504) is retried once (prices load into the cache). */
export function startRun(spec: StrategySpecV2, opts: { trials?: number; force?: boolean } = {}): Promise<RunState> {
  const key = runKey(spec);
  const existing = runs.get(key);
  if (!opts.force && existing && existing.status !== "error") return inflight.get(key) ?? Promise.resolve(existing);
  const job = (async (): Promise<RunState> => {
    runs.set(key, { status: "running", startedAt: Date.now(), retrying: false });
    bump();
    let final: RunState;
    try {
      let r = await post("/api/strategy/run", { spec, trials: opts.trials ?? 1 });
      if (r.status === 504) {
        runs.set(key, { status: "running", startedAt: Date.now(), retrying: true });
        bump();
        r = await post("/api/strategy/run", { spec, trials: opts.trials ?? 1 });
      }
      if (r.status === 200 && r.body && r.body.version === 2) final = { status: "done", result: r.body as unknown as RunResultV2, finishedAt: Date.now() };
      else {
        const errors = Array.isArray(r.body?.errors) ? (r.body!.errors as unknown[]).filter((e): e is string => typeof e === "string") : [];
        const issues = Array.isArray(r.body?.issues) ? (r.body!.issues as SpecIssue[]) : [];
        final = { status: "error", message: errorText(r.status, r.body, "The backtest could not run right now."), errors, issues };
      }
    } catch {
      final = { status: "error", message: "The backtest service could not be reached.", errors: [], issues: [] };
    }
    runs.set(key, final);
    inflight.delete(key);
    bump();
    return final;
  })();
  inflight.set(key, job);
  return job;
}

/** Tier B checks for a finished run (second request after first paint). */
export async function startAudit(spec: StrategySpecV2, quality: QualityReport): Promise<void> {
  const key = runKey(spec);
  if (audits.get(key)?.status === "running" || audits.get(key)?.status === "done") return;
  audits.set(key, { status: "running", startedAt: Date.now() });
  bump();
  try {
    const r = await post("/api/strategy/audit", { spec, quality });
    const q = r.body?.quality as QualityReport | undefined;
    audits.set(key, r.status === 200 && q ? { status: "done", quality: q } : { status: "error", message: errorText(r.status, r.body, "The extra checks could not run.") });
  } catch {
    audits.set(key, { status: "error", message: "The checks service could not be reached." });
  }
  bump();
}

/* ------------------------------------------------------------------ */
/* Explain                                                             */
/* ------------------------------------------------------------------ */

export type Review = {
  headline: string;
  flags: { check_id: number; severity: "high" | "medium" | "low"; meaning: string; tryNext: string | null }[];
  interpretationRisks: string[];
  nextExperiments: { change: string; why: string }[];
  model: string;
};
export type ReviewState = { status: "running" } | { status: "done"; review: Review } | { status: "error"; message: string };
const reviews = new Map<string, ReviewState>();

export function getReview(key: string | null): ReviewState | null {
  return key ? (reviews.get(key) ?? null) : null;
}

export async function startReview(spec: StrategySpecV2, quality: QualityReport, trials: number): Promise<void> {
  const key = runKey(spec);
  if (reviews.get(key)?.status === "running") return;
  reviews.set(key, { status: "running" });
  bump();
  try {
    const r = await post("/api/strategy/review", { spec, quality, trials });
    reviews.set(key, r.status === 200 && r.body && typeof r.body.headline === "string" ? { status: "done", review: r.body as unknown as Review } : { status: "error", message: errorText(r.status, r.body, "Explain is unavailable right now.") });
  } catch {
    reviews.set(key, { status: "error", message: "Explain could not be reached." });
  }
  bump();
}

/* ------------------------------------------------------------------ */
/* The conversation                                                    */
/* ------------------------------------------------------------------ */

export type TurnAnswer =
  | { kind: "questions"; questions: Question[]; assumptions: string[] }
  | { kind: "spec"; spec: StrategySpecV2; describe: SpecDescription; assumptions: string[]; notExpressible: string[]; repaired: boolean }
  | { kind: "not_a_strategy"; message: string; notExpressible: string[] }
  | { kind: "error"; reason: string; message: string; issues?: SpecIssue[] };

/** POST /api/strategy/turn. */
export async function sendTurn(input: { intent: string; answers: Answer[]; questionsAsked: number; edit?: { request: string; current: StrategySpecV2 } | null }): Promise<TurnAnswer> {
  try {
    const r = await post("/api/strategy/turn", input);
    const b = r.body;
    if (b && (b.kind === "questions" || b.kind === "spec" || b.kind === "not_a_strategy" || b.kind === "error")) return b as unknown as TurnAnswer;
    return { kind: "error", reason: r.status === 503 ? "unavailable" : "error", message: errorText(r.status, b, "The strategy assistant could not answer.") };
  } catch {
    return { kind: "error", reason: "unavailable", message: "The strategy assistant could not be reached." };
  }
}
