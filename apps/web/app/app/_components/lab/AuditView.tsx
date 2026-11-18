"use client";

import { Check, CircleMinus, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import type { AuditCheck, DeskAudit } from "@/lib/desk/audit";
import { benchmarkLong, fmtPct } from "@/lib/desk/run-result";
import { wholeOf } from "@/lib/desk/robustness";
import { MONO, SERIF } from "../parts";
import type { LabRun } from "./run";

/**
 * Falcon's independent audit of a Desk strategy test in the results panel:
 * `EvidenceCard` (the label, its reasons and the source, top of Overview, as
 * in the Strategy Lab) and `AuditChecks` (the Audit section: every check with
 * pass / flag, and strategy vs the list held equally vs SPY).
 */

export function EvidenceCard({ run }: { run: LabRun }) {
  const a = run.audit;
  if (!a) {
    if (run.status !== "running") return null;
    return (
      <div className="flex items-center gap-2 rounded-xl border border-line/[0.08] bg-surface-3 px-4 py-3 text-fs-12.5 text-quiet" role="status">
        <LoaderCircle width={13} height={13} strokeWidth={2} className="animate-spin" aria-hidden />
        Checking the result: code review, re-runs with doubled costs, a one-day delay and random versions.
      </div>
    );
  }
  const level = a.label.level;
  const tone = level === "consistent" ? "border-l-line/40" : level === "some" ? "border-l-line/25" : "border-l-line/12";
  return (
    <section aria-label="Evidence" className={`rounded-xl border border-l-[3px] border-line/[0.08] bg-surface-3 px-4 py-3.5 ${tone}`}>
      <span className="text-fs-11 uppercase tracking-[0.16em] text-fore/50" style={{ fontFamily: MONO }}>
        {a.label.heading}
      </span>
      <p className="mt-1 text-fs-22 leading-fs-28 text-fore" style={{ fontFamily: SERIF }}>
        {a.label.title}
      </p>
      {a.label.reasons.length ? <p className="mt-1 text-fs-12.5 leading-fs-19 text-fore-4">{a.label.reasons.join(" ")}</p> : null}
      <p className="mt-2 text-fs-11.5 leading-fs-17 text-quiet">
        {a.label.subtitle}
        {a.label.source.url ? (
          <>
            {" "}
            <a href={a.label.source.url} target="_blank" rel="noreferrer" className="underline underline-offset-2 hover:text-fore" title={a.label.source.label}>
              Source
            </a>
          </>
        ) : null}
      </p>
    </section>
  );
}

const ICON = {
  pass: { I: Check, cls: "text-up", word: "Passed" },
  flag: { I: TriangleAlert, cls: "text-warn", word: "Flagged" },
  info: { I: Info, cls: "text-quiet", word: "Note" },
  skipped: { I: CircleMinus, cls: "text-faint", word: "Not run" },
} as const;

function CheckRow({ c }: { c: AuditCheck }) {
  const s = ICON[c.status];
  return (
    <li className="flex gap-3 border-b border-line/[0.06] py-3 last:border-b-0">
      <s.I width={15} height={15} strokeWidth={2} className={`mt-[2px] shrink-0 ${s.cls}`} aria-hidden />
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-fs-13.5 font-medium text-fore">{c.name}</span>
          <span className={`text-fs-11.5 ${s.cls}`}>{s.word}</span>
        </div>
        <p className="text-fs-13 leading-fs-20 text-fore-3">{c.detail}</p>
        {c.items?.length ? (
          <ul className="flex flex-col gap-0.5 pl-0.5 text-fs-12 leading-fs-18 text-fore-4" style={{ fontFamily: MONO }}>
            {c.items.map((it, i) => (
              <li key={i} className="break-words">
                · {it}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </li>
  );
}

function Comparison({ a }: { a: DeskAudit }) {
  const c = a.comparison;
  if (!c) return null;
  const rows: [string, number | null][] = [
    ["Strategy", c.strategy],
    [`${c.listName.charAt(0).toUpperCase()}${c.listName.slice(1)}, held equally`, c.list],
    ["SPY held throughout", c.spy],
  ];
  // The test's own benchmark when it is not SPY (SPY stays as the market reference).
  if (a.benchmark && a.benchmark !== "SPY" && a.headline) rows.push([`${benchmarkLong(a.benchmark)} (the benchmark)`, wholeOf(a.headline)?.bench_cagr ?? null]);
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-fs-12 font-medium uppercase tracking-[0.06em] text-faint">Strategy vs the list vs SPY (CAGR)</h3>
      <dl className="grid grid-cols-[minmax(0,1fr)_max-content] gap-x-6 gap-y-1.5 rounded-xl border border-line/[0.08] bg-surface-3 px-4 py-3 text-fs-13 leading-fs-20">
        {rows.map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="truncate text-quiet">{k}</dt>
            <dd className={`text-right tabular-nums ${v === null ? "text-faint" : v > 0 ? "text-up" : v < 0 ? "text-down" : "text-fore"}`} style={{ fontFamily: MONO }}>
              {fmtPct(v)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-fs-12 leading-fs-18 text-faint">If the list held equally beat SPY by about as much as the strategy did, most of the gain came from knowing today which companies made the list.</p>
    </section>
  );
}

export function AuditChecks({ run }: { run: LabRun }) {
  const a = run.audit;
  if (!a) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        {run.status === "running" ? <LoaderCircle width={18} height={18} strokeWidth={2} className="animate-spin text-faint" aria-hidden /> : null}
        <p className="max-w-[420px] text-fs-13.5 text-fore-4">
          {run.status === "running" ? "The audit runs after the test: a code review for look-ahead, re-runs with doubled costs, a one-day delay and random versions." : "This test has no audit (it ended before the audit ran, or it predates audits)."}
        </p>
      </div>
    );
  }
  const flagged = a.checks.filter((c) => c.status === "flag").length;
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto px-5 py-5">
      <EvidenceCard run={run} />
      <section className="flex flex-col gap-2">
        <h3 className="text-fs-12 font-medium uppercase tracking-[0.06em] text-faint">
          Checks · {a.checks.length} run{flagged ? `, ${flagged} flagged` : ""}
        </h3>
        <ul className="flex flex-col rounded-xl border border-line/[0.08] px-4">
          {a.checks.map((c) => (
            <CheckRow key={c.id} c={c} />
          ))}
        </ul>
      </section>
      <Comparison a={a} />
      <p className="text-fs-12 leading-fs-18 text-faint">
        Computed by Falcon outside the strategy&apos;s own script: an independent code review, the day&apos;s high and low for every fill, and re-runs of the script in the same sandbox. Random versions keep the rules and pick at random.
      </p>
    </div>
  );
}
