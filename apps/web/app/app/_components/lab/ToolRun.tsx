"use client";

import { useId, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronRight, CircleAlert, Clock } from "lucide-react";
import LoadingState, { type LoadingVariant } from "@/components/ui/loading-state";
import { EASE_OUT, useCalmMotion } from "./motion";
import type { LabTool } from "./sessions";

/**
 * The tools Claude ran for a reply, shown as commands: one block per round
 * (calls made together sit together), one row per call, e.g.
 *   ⣿ Searching › /quote AAPL                 0.4s
 *   ✓ Ran       › /quote AAPL                 0.6s
 *   ! Failed    › /insiders KGS               SEC is rate-limiting…
 *   ⣿ Churning  › /options AAPL history 1y    34/51 · 12.3s
 * A row at work is the pixel-grid loading state (components/ui/loading-state.tsx):
 * "Searching" (Orbit) for data lookups, "Churning" (Drive) for code, strategy
 * runs, audits and long downloads. A long download shows its progress (points
 * loaded of the total). A call left still loading (`pending`: the reply could
 * not wait for it) is a neutral row, never a failure, and is hidden once the
 * same command ran again (`superseded`).
 * A finished row opens to the raw result (pretty JSON) with a height animation.
 */

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/20";

type Tool = LabTool;

/** The command for rows saved before the route sent one: read back from the label (lib/desk/tools deskToolLabel). */
function fromLabel(label: string): string {
  const rules: [RegExp, (m: RegExpExecArray) => string][] = [
    [/^Look(?:ing|ed) up (\S+) quote$/, (m) => `/quote ${m[1]}`],
    [/^Load(?:ing|ed) (\S+) (\S+) price history$/, (m) => `/history ${m[1]} ${m[2]}`],
    [/^Read(?:ing)? (\S+) fundamentals from SEC filings$/, (m) => `/fundamentals ${m[1]}`],
    [/^Check(?:ing|ed) (\S+) earnings record$/, (m) => `/earnings ${m[1]}`],
    [/^Check(?:ing|ed) (\S+) insider trades$/, (m) => `/insiders ${m[1]}`],
    [/^Search(?:ing|ed) (\S+) (?:(\S+) )?filings for (".*")$/, (m) => `/filings ${m[1]}${m[2] ? ` ${m[2]}` : ""} ${m[3]}`],
    [/^List(?:ing|ed) (\S+) (?:(\S+) )?filings$/, (m) => `/filings ${m[1]}${m[2] ? ` ${m[2]}` : ""}`],
    [/^Read(?:ing)? (.+)$/, (m) => `/filing ${m[1]}`],
    [/^(?:Running|Ran) (\w+)/, (m) => (/code_execution|python/.test(m[1]!) ? "/run python" : `/${m[1]}`)],
  ];
  for (const [re, f] of rules) {
    const m = re.exec(label);
    if (m) return f(m);
  }
  return label;
}

/** A filing's form and date from an earlier filings result in the same reply that listed its URL. */
function findFiling(ref: string, all: Tool[]): { ticker?: string; form: string; date: string } | null {
  for (const t of all) {
    if (!t.result || !t.result.includes(ref)) continue;
    let hit: { form: string; date: string } | null = null;
    const walk = (v: unknown): void => {
      if (hit || !v || typeof v !== "object") return;
      if (Array.isArray(v)) return v.forEach(walk);
      const o = v as Record<string, unknown>;
      if (o.url === ref && typeof o.form === "string" && typeof o.date === "string") hit = { form: o.form, date: o.date };
      else Object.values(o).forEach(walk);
    };
    try {
      walk(JSON.parse(t.result));
    } catch {
      continue;
    }
    if (hit) {
      const ticker = /^\/filings (\S+)/.exec(t.cmd ?? fromLabel(t.label))?.[1];
      return { ...(hit as { form: string; date: string }), ticker };
    }
  }
  return null;
}

export function toolCommand(t: Tool, all: Tool[] = []): string {
  const cmd = t.cmd ?? fromLabel(t.label);
  if (t.ref && cmd.startsWith("/filing ")) {
    const f = findFiling(t.ref, all);
    if (f) {
      const ticker = f.ticker ?? /^\/filing ([A-Z][A-Z.-]{0,9})(?:\s|$)/.exec(cmd)?.[1];
      const query = /\s(".*")$/.exec(cmd)?.[1];
      return ["/filing", ticker, f.form, f.date, query].filter(Boolean).join(" ");
    }
  }
  return cmd;
}

/** A row left still loading that a later call of the same command replaced (it shows the outcome instead). */
export function superseded(t: Tool, all: Tool[]): boolean {
  if (!t.pending) return false;
  const at = all.indexOf(t);
  const cmd = toolCommand(t, all);
  return all.some((u, i) => i > at && toolCommand(u, all) === cmd);
}

/** Pretty JSON when it parses, else the text as it came. */
function pretty(result: string): string {
  try {
    return JSON.stringify(JSON.parse(result), null, 2);
  } catch {
    return result;
  }
}

/** The `error` of a failed call's result, shortened. */
function errorText(result: string): string | null {
  try {
    const e = (JSON.parse(result) as { error?: unknown }).error;
    return typeof e === "string" ? (e.length > 120 ? `${e.slice(0, 120)}…` : e) : null;
  } catch {
    return null;
  }
}

const secs = (ms: number) => (ms < 100 ? `${(ms / 1000).toFixed(2)}s` : ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);

/** Data lookups (lib/desk/tools/command.ts): "Searching". Anything else at work (code, strategy runs, audits, long downloads): "Churning". */
const LOOKUP = /^\/(quote|history|fundamentals|earnings|filings?|insiders|events|news|article|options|flow|sightings|graph|company|falcon_\w*|web\w*|\w*search\w*|\w*fetch\w*)(\s|$)/;

function activity(t: Tool, cmd: string): { label: string; variant: LoadingVariant } {
  const download = !!t.progress || /^\/options \S+ history(\s|$)/.test(cmd);
  return !download && LOOKUP.test(cmd) ? { label: "Searching", variant: "Orbit" } : { label: "Churning", variant: "Drive" };
}

/**
 * When each call was first seen at work (this page visit), by id: the timer
 * keeps counting through a re-render or remount, and a call made again after a
 * resume hop counts from the still-loading row it replaces.
 */
const STARTED = new Map<string, number>();

function startedAt(t: Tool, all: Tool[], cmd: string): number {
  let at = STARTED.get(t.id);
  if (at === undefined) {
    const k = all.indexOf(t);
    const before = all.find((u, i) => i < k && u.pending === true && STARTED.has(u.id) && toolCommand(u, all) === cmd);
    at = before ? STARTED.get(before.id)! : Date.now();
    STARTED.set(t.id, at);
  }
  return at;
}

function ToolRun({ t, all, live }: { t: Tool; all: Tool[]; live: boolean }) {
  const still = useCalmMotion();
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const running = t.state === "running";
  // Left still loading (the reply could not wait): the loading state while the reply is still coming, then a neutral row.
  const loading = !running && t.pending === true;
  const failed = !running && !loading && t.ok === false;
  const cmd = toolCommand(t, all);
  const error = failed ? (t.result ? errorText(t.result) : null) ?? "Did not finish" : null;
  const canOpen = !running && !loading && !!t.result;
  const verb = loading ? "Loading" : failed ? "Failed" : "Ran";
  const progress = (running || loading) && t.progress ? `${t.progress.loaded}/${t.progress.total}` : "";
  const clock = !running && typeof t.ms === "number" && t.ms > 0 ? secs(t.ms) : "";
  const time = [progress, clock].filter(Boolean).join(" · ");
  // At work: the loading state, with the command beside it and the progress before the timer.
  const busy = running || (loading && live);

  const chip = (
    <code
      className={`min-w-0 truncate rounded-md px-1.5 py-px font-mono text-fs-12 leading-fs-20 ${
        failed ? "bg-down/[0.07] text-down/90" : "bg-line/[0.06] text-fore-3"
      }`}
    >
      <span aria-hidden className="mr-1 text-faint">
        ›
      </span>
      {cmd}
    </code>
  );

  if (busy) {
    const { label, variant } = activity(t, cmd);
    return (
      <div className="flex w-full min-w-0 items-center gap-2 px-3 py-[7px]">
        <LoadingState
          size="sm"
          label={label}
          variant={variant}
          startedAt={startedAt(t, all, cmd)}
          announce={false}
          meta={progress ? <span title={`${t.progress!.loaded} of ${t.progress!.total} loaded`}>{progress}</span> : undefined}
          className="w-full"
          labelClassName="min-w-[58px]"
        >
          {chip}
        </LoadingState>
        <span className="w-[13px] shrink-0" aria-hidden />
      </div>
    );
  }

  const icon = loading ? (
    <Clock width={13} height={13} strokeWidth={2} aria-hidden className="shrink-0 text-faint" />
  ) : failed ? (
    <CircleAlert width={13} height={13} strokeWidth={2} aria-hidden className="shrink-0 text-down" />
  ) : (
    <Check width={13} height={13} strokeWidth={2.25} aria-hidden className="shrink-0 text-up/80" />
  );

  const row = (
    <>
      {icon}
      <span className={`w-[58px] shrink-0 text-fs-12.5 ${failed ? "text-down/90" : "text-quiet"}`}>{verb}</span>
      {chip}
      <span className="ml-auto shrink-0 pl-2 font-mono text-fs-11.5 tabular-nums text-faint" {...(progress ? { title: `${t.progress!.loaded} of ${t.progress!.total} loaded` } : {})}>
        {time}
      </span>
      {canOpen ? (
        <ChevronRight
          width={13}
          height={13}
          strokeWidth={1.75}
          aria-hidden
          className={`shrink-0 text-faint transition-transform duration-200 group-hover:text-fore-3 ${open ? "rotate-90" : ""}`}
        />
      ) : (
        <span className="w-[13px] shrink-0" aria-hidden />
      )}
    </>
  );

  return (
    <div className="min-w-0">
      {canOpen ? (
        <button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((o) => !o)}
          className={`group flex w-full min-w-0 items-center gap-2 px-3 py-[7px] text-left transition-colors hover:bg-line/[0.035] ${FOCUS} focus-visible:ring-inset`}
        >
          {row}
        </button>
      ) : (
        <div className="flex w-full min-w-0 items-center gap-2 px-3 py-[7px]">{row}</div>
      )}
      {error ? <p className="-mt-1 px-3 pb-2 pl-[99px] text-fs-12 leading-fs-18 text-down/80">{error}</p> : null}
      <AnimatePresence initial={false}>
        {open && canOpen ? (
          <motion.div
            id={panelId}
            key="result"
            initial={still ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={still ? { height: 0, opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: EASE_OUT }}
            className="overflow-hidden"
          >
            <pre className="mx-3 mb-2.5 max-h-[280px] overflow-auto whitespace-pre-wrap break-all rounded-lg border border-line/[0.08] bg-well px-3 py-2 font-mono text-fs-11.5 leading-fs-16 text-fore-3">
              {pretty(t.result ?? "")}
            </pre>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

/** One round of tool calls. `all`: every tool of the reply (a filing's form and date come from an earlier list). */
export function ToolGroup({ tools, all, live }: { tools: Tool[]; all: Tool[]; live: boolean }) {
  const still = useCalmMotion();
  const [animate] = useState(live && !still);
  return (
    <motion.div
      initial={animate ? { opacity: 0, y: 4 } : false}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22, ease: EASE_OUT }}
      className="w-[34rem] max-w-full overflow-hidden rounded-xl border border-line/[0.08] bg-line/[0.02]"
    >
      <ul aria-label={tools.length > 1 ? `${tools.length} tool runs` : "Tool run"} className="flex flex-col divide-y divide-line/[0.06]">
        <AnimatePresence initial={false}>
          {tools.map((t) => (
            <motion.li
              key={t.id}
              initial={still ? false : { opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
              className="overflow-hidden"
            >
              <ToolRun t={t} all={all} live={live} />
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>
    </motion.div>
  );
}
