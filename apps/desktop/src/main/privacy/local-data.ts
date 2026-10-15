import fs from "node:fs";
import path from "node:path";
import { DEV_DIR, REPORT_FILE } from "../briefing/briefing-store";
import { AgentStore, userDirName } from "../agents/store";
import { createUserEventsStore } from "../calendar/user-events-store";
import type { EngineUsage, LocalDataCategory, LocalDataKind, UsageSummary } from "../../shared/privacy-types";

/**
 * What Falcon keeps under its data root, counted rather than described: the
 * Privacy pane's inventory, its export of the reader's own files, its "Clear
 * local history", and the Usage pane's local counts all read the disk here.
 *
 * Nothing here knows about Electron, so all of it runs against a temp dir.
 */

type Rule = { key: string; label: string; description: string; kind: LocalDataKind };

/**
 * Every top-level entry the app writes, and what it is to the reader. An
 * entry not listed lands in "Other", so a new engine folder is still counted
 * before anyone names it here.
 */
const ENGINE_RULE: Rule = {
  key: "engines",
  label: "Engine state",
  description: "Settings and working files of the market engines, including the tickers they follow.",
  kind: "engine",
};

/**
 * `<data root>/snaptrade/<account id>.bin`, each encrypted with the OS
 * keychain (main/snaptrade/local-secret-store). Never exported: the export
 * reads named files only.
 */
export const SNAPTRADE_RULE: Rule = {
  key: "snaptrade",
  label: "Brokerage link key",
  description: "SnapTrade's key for a linked brokerage, encrypted on this device. Never exported.",
  kind: "personal",
};

const NEWS_RULE: Rule = {
  key: "news",
  label: "News events and signals",
  description: "Market news and the signals derived from it.",
  kind: "cache",
};

/** The reader's settings on this device: language, notifications, system (tray, shortcut, hardware acceleration). */
const PREFERENCES_RULE: Rule = {
  key: "preferences",
  label: "App preferences",
  description: "Language, notification and system settings chosen on this device.",
  kind: "personal",
};

const RULES: Readonly<Record<string, Rule>> = {
  ...Object.fromEntries(
    ["tracker", "base", "classifier", "analyst", "propagation", "gauge", "screen", "quantlab"].map((dir) => [dir, ENGINE_RULE]),
  ),
  profile: { key: "profile", label: "Profile photo", description: "The photo you picked in Account.", kind: "personal" },
  snaptrade: SNAPTRADE_RULE,
  "snaptrade-user.json": SNAPTRADE_RULE,
  "account-cleanup.json": {
    key: "account",
    label: "Account deletion retries",
    description: "Which deleted accounts still have files to remove here. Cleared once that is done.",
    kind: "personal",
  },
  "portfolio-coverage.json": {
    key: "portfolio",
    label: "Portfolio coverage",
    description: "Which of your holdings Falcon has researched or queued.",
    kind: "personal",
  },
  "pending-research.txt": {
    key: "portfolio",
    label: "Portfolio coverage",
    description: "Which of your holdings Falcon has researched or queued.",
    kind: "personal",
  },
  "graph.json": {
    key: "research",
    label: "Company graphs and SEC filings",
    description: "Relationship graphs and the public filings they were read from.",
    kind: "cache",
  },
  research: {
    key: "research",
    label: "Company graphs and SEC filings",
    description: "Relationship graphs and the public filings they were read from.",
    kind: "cache",
  },
  cache: {
    key: "research",
    label: "Company graphs and SEC filings",
    description: "Relationship graphs and the public filings they were read from.",
    kind: "cache",
  },
  insight: { key: "insight", label: "Signal explanations", description: "Written explanations of signals, shared by every account.", kind: "cache" },
  events: NEWS_RULE,
  signals: NEWS_RULE,
  // Article text the news reader fetched (main/news).
  news: NEWS_RULE,
  // Earnings calendars, consensus snapshots and reactions (main/earnings), the same for every account.
  earnings: {
    key: "earnings",
    label: "Earnings dates and estimates",
    description: "Earnings dates, consensus estimates and price reactions, shared by every account.",
    kind: "cache",
  },
  notifications: PREFERENCES_RULE,
  system: PREFERENCES_RULE,
  "ui-language.json": PREFERENCES_RULE,
  // Kept in userData, so only here when the data root is the userData folder itself.
  "data-location.json": PREFERENCES_RULE,
  risk: {
    key: "risk",
    label: "Risk engine",
    description: "Risk readings, with a copy of your paper account when the engine runs here.",
    kind: "engine",
  },
  logs: { key: "logs", label: "Diagnostics", description: "Results of the model self-test.", kind: "engine" },
  // `<data root>/agents/<user id | local>/`: agents.json, each agent's folder
  // (reports, timeline, chat, engine state), outbox.json and digest.json.
  agents: {
    key: "agents",
    label: "Agents",
    description: "Your agents with their reports and chats, and the notifications waiting to go out.",
    kind: "personal",
  },
};

const BRIEFING_REPORTS: Rule = {
  key: "briefings",
  label: "Saved briefings",
  description: "Briefing reports of the accounts used on this device, with their holdings. Kept 14 days.",
  kind: "personal",
};
const BRIEFING_CACHE: Rule = {
  key: "briefing-cache",
  label: "Briefing market cache",
  description: "Market news and written stories the briefing reuses.",
  kind: "cache",
};
/** `<data root>/calendar/user-events.json`: events the reader added, partitioned by account. */
const CALENDAR_EVENTS: Rule = {
  key: "calendar",
  label: "Calendar events",
  description: "Events you added to the calendar, for each account used on this device.",
  kind: "personal",
};
/** The rest of `<data root>/calendar/`: the sector each company is in (sectors.json), looked up once a month. */
const CALENDAR_CACHE: Rule = {
  key: "calendar-cache",
  label: "Company sectors",
  description: "Which sector each company in the calendar is in, looked up once a month.",
  kind: "cache",
};
const CALENDAR_EVENTS_FILE = "user-events.json";
const OTHER: Rule = { key: "other", label: "Other", description: "Files no part of Falcon claims by name.", kind: "engine" };

type Tally = { files: number; bytes: number };

/** Files and bytes under a path, symlinks not followed. A path that is gone counts as empty. */
export function tallyPath(target: string): Tally {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return { files: 0, bytes: 0 };
  }
  if (stat.isFile()) return { files: 1, bytes: stat.size };
  if (!stat.isDirectory()) return { files: 0, bytes: 0 };
  const out = { files: 0, bytes: 0 };
  let names: string[];
  try {
    names = fs.readdirSync(target);
  } catch {
    return out;
  }
  for (const name of names) {
    const t = tallyPath(path.join(target, name));
    out.files += t.files;
    out.bytes += t.bytes;
  }
  return out;
}

/** Every briefing report file on disk, with the account it belongs to and its target date. */
function briefingReports(root: string): Array<{ file: string; userKey: string; ymd: string; dev: boolean }> {
  const out: Array<{ file: string; userKey: string; ymd: string; dev: boolean }> = [];
  const dir = path.join(root, "briefing");
  for (const d of [dir, path.join(dir, DEV_DIR)]) {
    let names: string[];
    try {
      names = fs.readdirSync(d);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = REPORT_FILE.exec(name);
      if (m) out.push({ file: path.join(d, name), userKey: m[1]!, ymd: m[2]!, dev: d !== dir });
    }
  }
  return out;
}

/** This account's saved briefing reports. "anon" — no session — owns none worth listing. */
export function accountBriefingFiles(root: string, userKey: string): string[] {
  if (!userKey || userKey === "anon") return [];
  return briefingReports(root)
    .filter((r) => r.userKey === userKey)
    .map((r) => r.file);
}

/**
 * The data root, grouped the way the Privacy pane lists it. Categories with
 * nothing in them are left out; the order is personal first, then caches,
 * then engine state, largest first within each.
 *
 * `legacySnaptradeFile` is the pre-migration plaintext identity outside the
 * data root (`<userData>/snaptrade-user.json`). While it still exists it is
 * counted in the same "Brokerage link key" category as the encrypted files.
 */
export function inventoryLocalData(root: string, opts: { legacySnaptradeFile?: string | null } = {}): LocalDataCategory[] {
  const byKey = new Map<string, LocalDataCategory>();
  const add = (rule: Rule, t: Tally) => {
    if (t.files === 0) return;
    const cur = byKey.get(rule.key);
    if (cur) {
      cur.files += t.files;
      cur.bytes += t.bytes;
    } else {
      byKey.set(rule.key, { key: rule.key, label: rule.label, description: rule.description, kind: rule.kind, ...t });
    }
  };

  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    names = [];
  }
  for (const name of names) {
    const full = path.join(root, name);
    if (name === "briefing") {
      // One folder, two things: the reader's own reports and a shared market cache.
      const reports = new Set(briefingReports(root).map((r) => r.file));
      const reportTally = { files: 0, bytes: 0 };
      for (const file of reports) {
        const t = tallyPath(file);
        reportTally.files += t.files;
        reportTally.bytes += t.bytes;
      }
      const whole = tallyPath(full);
      add(BRIEFING_REPORTS, reportTally);
      add(BRIEFING_CACHE, { files: whole.files - reportTally.files, bytes: whole.bytes - reportTally.bytes });
      continue;
    }
    if (name === "calendar") {
      // The reader's own events beside a public sector cache.
      const events = tallyPath(path.join(full, CALENDAR_EVENTS_FILE));
      const whole = tallyPath(full);
      add(CALENDAR_EVENTS, events);
      add(CALENDAR_CACHE, { files: whole.files - events.files, bytes: whole.bytes - events.bytes });
      continue;
    }
    add(RULES[name] ?? OTHER, tallyPath(full));
  }
  // A data root picked as the userData folder itself already walked it above.
  const legacy = opts.legacySnaptradeFile;
  if (legacy && path.resolve(path.dirname(legacy)) !== path.resolve(root)) add(SNAPTRADE_RULE, tallyPath(legacy));

  const rank: Record<LocalDataKind, number> = { personal: 0, cache: 1, engine: 2 };
  return [...byKey.values()].sort((a, b) => rank[a.kind] - rank[b.kind] || b.bytes - a.bytes);
}

/**
 * "Clear local history": removes this account's saved briefing reports and
 * nothing else. They are the one disposable file that holds the reader's own
 * data — the briefing rebuilds the day's report on the next open. Other
 * caches stay: the filing cache costs model calls to rebuild, and the engines
 * hold their state in memory, so deleting under them would not stick.
 */
export function clearAccountHistory(root: string, userKey: string): { removed: number; bytes: number } {
  let removed = 0;
  let bytes = 0;
  for (const file of accountBriefingFiles(root, userKey)) {
    try {
      const size = fs.statSync(file).size;
      fs.unlinkSync(file);
      removed += 1;
      bytes += size;
    } catch {
      // Locked or already gone: the count only reports what was removed.
    }
  }
  return { removed, bytes };
}

function readJsonFile(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

function readTextFile(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * The reader's own files on this machine, for "Export my data". Caches of
 * public data (filings, graphs, news) are not theirs and are left out, as is
 * the photo, which the caller reads through the profile store.
 */
export function collectLocalExport(root: string, userKey: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const briefings = accountBriefingFiles(root, userKey).map((file) => ({
    file: path.basename(file),
    content: readJsonFile(file) ?? null,
  }));
  if (briefings.length > 0) out.briefing_reports = briefings;
  const coverage = readJsonFile(path.join(root, "portfolio-coverage.json"));
  if (coverage !== undefined) out.portfolio_coverage = coverage;
  const pending = readTextFile(path.join(root, "pending-research.txt"));
  if (pending !== undefined) out.pending_research = pending.split(/\r?\n/).filter((l) => l.trim());
  const riskAccount = readJsonFile(path.join(root, "risk", "account.json"));
  if (riskAccount !== undefined) out.risk_account = riskAccount;
  const screenWatchlist = readJsonFile(path.join(root, "screen", "watchlist.json"));
  if (screenWatchlist !== undefined) out.screen_watchlist = screenWatchlist;
  const agents = collectAgentsExport(root, userKey);
  if (agents) out.agents = agents;
  const calendar = collectCalendarExport(root, userKey);
  if (calendar) out.calendar_events = calendar;
  return out;
}

/** Bumped when a section's shape changes, so a reader of an old export knows which one it holds. */
/** Agents v2: `digest` added; agents may carry `ends` and `nextCheckAt`, and `channels` may be empty or hold "digest". */
export const AGENTS_EXPORT_SCHEMA = { schema: "falcon-agents", schema_version: 2 } as const;
export const CALENDAR_EXPORT_SCHEMA = { schema: "falcon-calendar-events", schema_version: 1 } as const;

/** A field name that holds a credential, compared with case, `_` and `-` ignored. */
const SECRET_FIELD = /^(token|.*(secret|password|passwd|apikey|privatekey|authorization|accesstoken|refreshtoken|pushtoken|bearer|credential)s?)$/;
/** Credential shapes inside free text (a provider error quoted into an agent's error line, say). */
const SECRET_TEXT = /\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{16,}|Bearer\s+[A-Za-z0-9._~+/-]{16,}=*|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,})/g;

/**
 * A copy with credential-named fields dropped and credential-shaped text
 * masked. Nothing these stores write is meant to hold one; this keeps a future
 * field or a quoted provider error from carrying one into a file the reader
 * may pass on.
 */
export function withoutSecrets(value: unknown): unknown {
  if (typeof value === "string") return value.replace(SECRET_TEXT, "[removed]");
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SECRET_FIELD.test(k.toLowerCase().replace(/[_-]/g, ""))) continue;
      out[k] = withoutSecrets(v);
    }
    return out;
  }
  return value;
}

/** A signed-in account's key, or null: the signed-out pool ("anon" / "local") is no one's to export. */
function signedInKey(userKey: string): string | null {
  const key = userDirName(userKey);
  return key === "local" ? null : key;
}

/**
 * The account's agents, each with its reports, timeline and chat, plus the
 * outbox of mobile deliveries and the reports held for the daily digest
 * (digest.json), read from `<data root>/agents/<user id>/` only.
 * The engine's per-agent bookkeeping (state.json: dedupe keys, cooldowns,
 * cached earnings dates) is not the reader's data and stays out.
 */
export function collectAgentsExport(root: string, userKey: string): Record<string, unknown> | null {
  const key = signedInKey(userKey);
  if (!key) return null;
  const store = new AgentStore(root, key);
  return withoutSecrets({
    ...AGENTS_EXPORT_SCHEMA,
    agents: store.list().map((agent) => ({
      agent,
      reports: store.reports(agent.id),
      activity: store.activity(agent.id),
      messages: store.messages(agent.id),
    })),
    mobile_outbox: store.outbox(),
    digest: store.digest(),
  }) as Record<string, unknown>;
}

/** The account's own calendar events, from its partition of `<data root>/calendar/user-events.json` only. */
export function collectCalendarExport(root: string, userKey: string): Record<string, unknown> | null {
  const key = signedInKey(userKey);
  if (!key) return null;
  const store = createUserEventsStore({ file: path.join(root, "calendar", CALENDAR_EVENTS_FILE), userKey: () => key });
  return withoutSecrets({ ...CALENDAR_EXPORT_SCHEMA, events: store.list() }) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** First day of the month `nowMs` falls in, on this machine's clock, as YYYY-MM-DD. */
export function monthStartYmd(nowMs: number): string {
  const d = new Date(nowMs);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}

/** A timestamp's local YYYY-MM-DD, or null when it does not parse. */
function localYmd(iso: unknown): string | null {
  if (typeof iso !== "string") return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

const ENGINE_METRICS: ReadonlyArray<{ key: EngineUsage["key"]; label: string; unit: string; field: string }> = [
  { key: "propagation", label: "Propagation", unit: "runs", field: "runs_ok" },
  { key: "classifier", label: "News classifier", unit: "verdicts", field: "verdicts_ok" },
  { key: "analyst", label: "Analyst", unit: "write-ups", field: "outputs_ok" },
];

/**
 * The Usage pane's local figures. Each comes from a file some part of Falcon
 * already writes: the extractor's per-filing meta and stats, the briefing
 * report names, and each engine's metrics file. A figure no file records is
 * not produced.
 *
 * `seedDir` is the bundled seed data of a packaged build: an extraction that
 * shipped with the app is not usage, so it is counted apart.
 */
export function summarizeLocalUsage(
  root: string,
  opts: { userKey: string; nowMs: number; seedDir: string | null; enginesRemote: boolean },
): UsageSummary {
  const monthStart = monthStartYmd(opts.nowMs);
  const monthPrefix = monthStart.slice(0, 7);

  const extractions = { total: 0, thisMonth: 0, bundled: 0, withStats: 0, inputTokens: 0, outputTokens: 0, estimatedCostUsd: 0 };
  const researchDir = path.join(root, "research");
  let names: string[] = [];
  try {
    names = fs.readdirSync(researchDir);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (!name.endsWith(".meta.json")) continue;
    const meta = readJsonFile(path.join(researchDir, name)) as { generatedAt?: unknown } | undefined;
    if (!meta || typeof meta !== "object") continue;
    if (opts.seedDir && fs.existsSync(path.join(opts.seedDir, "research", name))) {
      const seeded = readJsonFile(path.join(opts.seedDir, "research", name)) as { generatedAt?: unknown } | undefined;
      if (seeded?.generatedAt === meta.generatedAt) {
        extractions.bundled += 1;
        continue;
      }
    }
    extractions.total += 1;
    if (localYmd(meta.generatedAt)?.startsWith(monthPrefix)) extractions.thisMonth += 1;
    const stats = readJsonFile(path.join(researchDir, name.replace(/\.meta\.json$/, ".stats.json"))) as
      | Record<string, unknown>
      | undefined;
    if (stats && typeof stats === "object") {
      extractions.withStats += 1;
      extractions.inputTokens += num(stats.input_tokens);
      extractions.outputTokens += num(stats.output_tokens);
      extractions.estimatedCostUsd += num(stats.estimated_cost_usd);
    }
  }

  // Reports built on the developer clock are not usage.
  const mine = briefingReports(root).filter((r) => !r.dev && opts.userKey !== "anon" && r.userKey === opts.userKey);
  const briefings = { total: mine.length, thisMonth: mine.filter((r) => r.ymd.startsWith(monthPrefix)).length };

  const engines: EngineUsage[] = [];
  if (!opts.enginesRemote) {
    for (const e of ENGINE_METRICS) {
      const file = readJsonFile(path.join(root, e.key, "metrics.json")) as { metrics?: Record<string, unknown> } | undefined;
      const m = file?.metrics;
      if (!m || typeof m !== "object") continue;
      engines.push({
        key: e.key,
        label: e.label,
        unit: e.unit,
        completed: num(m[e.field]),
        inputTokens: num(m.input_tokens),
        outputTokens: num(m.output_tokens),
      });
    }
  }

  return { monthStart, extractions, briefings, enginesRemote: opts.enginesRemote, engines };
}
