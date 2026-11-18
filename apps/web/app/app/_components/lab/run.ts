/**
 * Strategy tests in a Desk reply: the run state the results panel shows,
 * folded from the route's RUN_MARK lines (app/api/desk/chat/route.ts), the
 * smaller copy kept in session storage, and the CSV export of the trades.
 * Pure; no React.
 */

import { compactRunResult, resultSummaryLine, validateRunResult, type RunResult } from "@/lib/desk/run-result";
import { auditSummaryLine, cleanAudit, type DeskAudit } from "@/lib/desk/audit";

/** Matches RUN_MARK in app/api/desk/chat/route.ts: this character, one JSON line, a newline. */
export const RUN_MARK = "\u001c";

export type RunLog = { kind: "data" | "command" | "stdout" | "stderr" | "error"; text: string; rc?: number };

/**
 * A piece of code in the reply, shown as a card where it was written (lab/ScriptCard.tsx):
 * a file the model created ("Created x.py +21"), an edit to one ("Edited x.py +3 -2"), a bash command
 * ("Ran …"), or Falcon's generated event-test script ("Ran falcon_event_backtest.py").
 */
export type RunScript = {
  /** The code-execution call's id (several scripts in one bash call: `id:1`, `id:2`). */
  key: string;
  kind: "created" | "edited" | "command" | "falcon";
  /** The path the call gave ("" when none). */
  path: string;
  /** The file (created, falcon), the new lines (edited) or the command. */
  code: string;
  lang: "python" | "bash";
  /** edited: the lines replaced. */
  old?: string;
  /** Still streaming in from the model. */
  writing?: boolean;
  /** Written and run (or the reply ended): the card shows collapsed. */
  done?: boolean;
  /** The output of the run that came from this call (commands), shortened. */
  out?: string;
  rc?: number;
  /** Where it was written in the reply's text, and how many tool rows came before it. */
  at: number;
  after: number;
};

export type LabRun = {
  id: string;
  /** running until the reply ends; error when it ended without a usable result. */
  status: "running" | "done" | "error";
  /** The last script written (the result's own copy wins once it arrives). */
  code?: string;
  codePath?: string;
  logs: RunLog[];
  result?: RunResult;
  /** What the route fixed or dropped in the result file. */
  problems?: string[];
  error?: string;
  /** Set on the stored copy: how many points / trades the full result had. */
  cut?: { points?: number; trades?: number };
  /** Falcon's independent audit of the result (lib/desk/audit.ts): the evidence label and its checks. */
  audit?: DeskAudit;
  /** Where the test started in the reply's text. */
  at: number;
  /** The code written for the reply, in order, each shown as a card in the chat. */
  scripts?: RunScript[];
};

const LOG_CHARS = 8_000;
const STORED_LOGS = 30;
const STORED_LOG_CHARS = 3_000;
const STORED_CODE_CHARS = 40_000;
const SCRIPT_CHARS = 24_000;
const STORED_SCRIPTS = 16;
const OUT_CHARS = 1_500;

const str = (v: unknown) => (typeof v === "string" ? v : "");

/** Every card written and run: shown collapsed. */
const allDone = (scripts: RunScript[] | undefined) => scripts?.map((s) => (s.done && !s.writing ? s : { ...s, done: true, writing: false }));

/**
 * Applies one RUN_MARK event (not `continue`) to the run. `at`: the reply's text so far; `after`: its tool rows so far
 * (where a code card goes among them).
 */
export function applyRunEvent(run: LabRun | undefined, ev: Record<string, unknown>, at: number, after = 0): LabRun | undefined {
  const id = str(ev.id);
  const base: LabRun = run ?? { id: id || "run", status: "running", logs: [], at };
  const r: LabRun = { ...base, logs: base.logs };
  const log = (entry: RunLog) => (r.logs = [...r.logs, { ...entry, text: entry.text.slice(-LOG_CHARS) }]);
  const key = str(ev.key);
  /** Sets the card with this key (a new one goes at the end, at this point of the reply). */
  const card = (patch: Partial<RunScript> & Pick<RunScript, "kind" | "lang">) => {
    const list = r.scripts ?? [];
    const k = list.findIndex((s) => s.key === key);
    const prev = k >= 0 ? list[k]! : { key, path: "", code: "", at, after };
    const next: RunScript = { ...prev, ...patch };
    r.scripts = k >= 0 ? list.map((s, i) => (i === k ? next : s)) : [...list, next];
  };
  switch (ev.t) {
    case "started":
      return run ? { ...r, status: "running" } : r;
    case "data":
      log({ kind: "data", text: str(ev.text) });
      return r;
    case "draft": {
      if (!key) return r;
      // A draft left unfinished (a round cut at a hand-off, written again in the next request) is dropped.
      if (!r.scripts?.some((s) => s.key === key)) r.scripts = r.scripts?.filter((s) => !s.writing);
      const prev = r.scripts?.find((s) => s.key === key);
      const from = Math.max(0, Math.min(Number(ev.from) || 0, prev?.code.length ?? 0));
      const lang = ev.lang === "bash" ? "bash" : "python";
      card({ kind: lang === "bash" && !str(ev.path) ? "command" : "created", lang, path: str(ev.path) || prev?.path || "", code: (prev?.code ?? "").slice(0, from) + str(ev.add), writing: true });
      return r;
    }
    case "code": {
      const whole = ev.whole !== false;
      if (whole) {
        r.code = str(ev.code);
        r.codePath = str(ev.path);
      }
      if (key) {
        const kind = ev.kind === "edited" || ev.kind === "falcon" ? ev.kind : "created";
        const path = str(ev.path);
        const lang = /\.(sh|bash)$/i.test(path) ? "bash" : "python";
        if (kind === "edited") card({ kind, lang, path, code: str(ev.new), old: str(ev.old), writing: false });
        else card({ kind, lang, path, code: str(ev.code), writing: false, ...(kind === "falcon" ? { done: true } : {}) });
      }
      return r;
    }
    case "command":
      log({ kind: "command", text: str(ev.command) });
      // A command with no script in it: a card of its own. One that carried scripts has their cards already.
      if (key && ev.bare === true) card({ kind: "command", lang: "bash", path: "", code: str(ev.command), writing: false });
      else if (key) r.scripts = r.scripts?.filter((s) => !(s.key === key && s.writing));
      return r;
    case "stdout": {
      const rc = typeof ev.rc === "number" ? ev.rc : 0;
      if (str(ev.stdout)) log({ kind: "stdout", text: str(ev.stdout), rc });
      if (str(ev.stderr)) log({ kind: "stderr", text: str(ev.stderr), rc });
      if (!str(ev.stdout) && !str(ev.stderr)) log({ kind: "stdout", text: rc ? `(exit code ${rc})` : "(no output)", rc });
      // The run is over: its output goes on the command's card, and every card so far collapses.
      if (key && r.scripts) {
        const all = [str(ev.stdout), str(ev.stderr)].filter(Boolean).join("\n").trim();
        const out = all.length > OUT_CHARS ? `… ${all.slice(-OUT_CHARS)}` : all;
        const k = r.scripts.findIndex((s) => s.key === key && s.kind === "command");
        if (k >= 0) r.scripts = r.scripts.map((s, i) => (i === k ? { ...s, out, rc } : s));
      }
      r.scripts = allDone(r.scripts);
      return r;
    }
    case "result": {
      const v = validateRunResult(ev.result);
      if (!v.ok) {
        log({ kind: "error", text: v.problems.join(" ") });
        return r;
      }
      r.result = v.result;
      if (v.result.code) r.code = v.result.code;
      const problems = Array.isArray(ev.problems) ? ev.problems.filter((p): p is string => typeof p === "string") : [];
      r.problems = problems.length ? problems : undefined;
      r.error = undefined;
      return r;
    }
    case "audit": {
      const a = cleanAudit(ev.audit);
      if (a) r.audit = a;
      return r;
    }
    case "error":
      log({ kind: "error", text: str(ev.message) });
      if (!r.result) r.error = str(ev.message);
      return r;
    case "finished":
      return { ...r, scripts: allDone(r.scripts), status: r.result ? "done" : "error", error: r.result ? undefined : (r.error ?? "The test ended without a results file.") };
    default:
      return run;
  }
}

/** A run whose reply ended (stopped, failed, page reload): no longer running. */
export function settleRun(run: LabRun, reason?: string): LabRun {
  const scripts = run.scripts?.some((s) => s.writing || !s.done) ? allDone(run.scripts) : run.scripts;
  if (run.status !== "running") return scripts === run.scripts ? run : { ...run, scripts };
  return { ...run, scripts, status: run.result ? "done" : "error", error: run.result ? undefined : (reason ?? run.error ?? "The test did not finish.") };
}

/** The copy kept in session storage: a downsampled result, the first 500 trades, recent logs. */
export function storedRun(run: LabRun): LabRun {
  const out: LabRun = {
    ...run,
    logs: run.logs.slice(-STORED_LOGS).map((l) => (l.text.length > STORED_LOG_CHARS ? { ...l, text: `… ${l.text.slice(-STORED_LOG_CHARS)}` } : l)),
    code: run.code && run.code.length > STORED_CODE_CHARS ? `${run.code.slice(0, STORED_CODE_CHARS)}\n# … (shortened)` : run.code,
  };
  if (run.scripts) {
    const cut = (t: string) => (t.length > SCRIPT_CHARS ? `${t.slice(0, SCRIPT_CHARS)}\n# … (shortened)` : t);
    out.scripts = run.scripts.slice(-STORED_SCRIPTS).map((s) => ({ ...s, code: cut(s.code), ...(s.old !== undefined ? { old: cut(s.old) } : {}) }));
  }
  if (run.result && !run.cut) {
    const c = compactRunResult(run.result);
    out.result = { ...c.result, code: "" };
    if (c.cut.points || c.cut.trades) out.cut = c.cut;
  }
  return out;
}

/** A stored run read back (anything malformed is dropped). */
export function cleanRun(v: unknown): LabRun | undefined {
  const x = v as LabRun | null;
  if (!x || typeof x !== "object" || typeof x.id !== "string") return undefined;
  const logs = Array.isArray(x.logs)
    ? x.logs.filter((l): l is RunLog => !!l && typeof l.text === "string" && ["data", "command", "stdout", "stderr", "error"].includes(l.kind))
    : [];
  const out: LabRun = { id: x.id, status: x.status === "done" || x.status === "error" ? x.status : "running", logs, at: Math.max(0, Number(x.at) || 0) };
  if (typeof x.code === "string") out.code = x.code;
  if (typeof x.codePath === "string") out.codePath = x.codePath;
  if (typeof x.error === "string") out.error = x.error;
  if (Array.isArray(x.problems)) out.problems = x.problems.filter((p) => typeof p === "string");
  if (x.audit) out.audit = cleanAudit(x.audit);
  if (Array.isArray(x.scripts)) {
    const scripts = x.scripts
      .filter((s): s is RunScript => !!s && typeof s.key === "string" && typeof s.code === "string" && ["created", "edited", "command", "falcon"].includes(s.kind))
      .map((s): RunScript => ({
        key: s.key,
        kind: s.kind,
        path: typeof s.path === "string" ? s.path : "",
        code: s.code,
        lang: s.lang === "bash" ? "bash" : "python",
        ...(typeof s.old === "string" ? { old: s.old } : {}),
        ...(typeof s.out === "string" ? { out: s.out.slice(-OUT_CHARS) } : {}),
        ...(typeof s.rc === "number" ? { rc: s.rc } : {}),
        // Loaded from history: finished, collapsed.
        done: true,
        at: Math.max(0, Number(s.at) || 0),
        after: Math.max(0, Number(s.after) || 0),
      }));
    if (scripts.length) out.scripts = scripts;
  }
  if (x.cut && typeof x.cut === "object") out.cut = { points: Number(x.cut.points) || undefined, trades: Number(x.cut.trades) || undefined };
  if (x.result) {
    const v = validateRunResult(x.result);
    if (v.ok) out.result = v.result;
  }
  return settleRun(out, "The page was reloaded before the test finished.");
}

/** What the model is told about the last test in a reply it wrote: the numbers and the final script (history context, lib/desk/history-context.ts). */
export function runForHistory(run: LabRun): string {
  const parts: string[] = [];
  if (run.result) parts.push(`Strategy test in your previous reply: ${resultSummaryLine(run.result)}${run.audit ? ` ${auditSummaryLine(run.audit)}` : ""}`);
  else if (run.error) parts.push(`Strategy test in your previous reply did not finish: ${run.error}`);
  if (run.code) {
    const code = run.code.length > 12_000 ? `${run.code.slice(0, 12_000)}\n# … (shortened)` : run.code;
    parts.push(`Its script:\n\`\`\`python\n${code}\n\`\`\``);
  }
  return parts.join("\n");
}

/** The trades as CSV text. */
export function tradesCsv(r: RunResult): string {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const rows = r.trades.map((t) => [t.date, t.ticker, t.side, t.qty, t.weight, t.price, t.pnl].map(esc).join(","));
  return ["date,ticker,side,qty,weight,price,pnl", ...rows].join("\n");
}

/** The daily curve as CSV text: date, strategy equity, SPY equity, drawdown. */
export function seriesCsv(r: RunResult): string {
  const s = r.series;
  const rows = s.dates.map((d, i) => [d, s.equity[i], s.benchmark_equity[i] ?? "", s.drawdown[i]].join(","));
  return ["date,equity,spy_equity,drawdown", ...rows].join("\n");
}
