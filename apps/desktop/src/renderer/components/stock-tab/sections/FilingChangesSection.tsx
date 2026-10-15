import { useEffect, useRef, useState, type ReactNode } from "react";
import { ExternalLink } from "lucide-react";
import { useSay } from "@/components/earnings/earnings-ui";
import { openFilingChangesAgent } from "@/components/agents/agents-store";
import { onFilingChangesViewRequest, useFilingChanges } from "@/lib/filings-store";
import type { MessageKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { FilingChangeItem, FilingChanges, FilingDocRef } from "../../../../shared/filing-changes";
import { changeLabel, filingDate, filingLine, groupOf, quoteOf, safeSecUrl, type ItemGroup } from "../../../../shared/filing-changes-view";
import type { StockSectionProps } from "./types";

/**
 * Stock tab: what the company changed in its latest annual report against
 * the one before (main/filings), read mechanically from SEC EDGAR: risk
 * factor headings added, removed or reworded (quoted from the filing), the
 * latest 10-Q's risk factor update, auditor, controls and going concern
 * language, 8-K items 4.01 and 4.02, late filing notices, and customers or
 * suppliers named for the first time. Every line links to its filing.
 *
 * Nothing read, nothing shown: the section renders null and the tab hides
 * its heading.
 */

const GROUPS: readonly ItemGroup[] = ["flags", "risks", "relations"];
/** Lines a group shows before "Show all". */
const FOLD = 6;

type Say = ReturnType<typeof useSay>["say"];

function SecLink({ url, label, aria }: { url: string | null; label: string; aria: string }) {
  const safe = safeSecUrl(url);
  if (!safe) return <span>{label}</span>;
  return (
    <button
      type="button"
      onClick={() => void window.meridian?.openExternal?.(safe)}
      aria-label={aria}
      className="inline-flex items-center gap-1 rounded-sm underline-offset-2 outline-none hover:text-content-primary hover:underline focus-visible:ring-2 focus-visible:ring-edge-focus"
    >
      <span lang="en">{label}</span>
      <ExternalLink className="h-3 w-3" strokeWidth={1.75} aria-hidden />
    </button>
  );
}

function DocLink({ doc, say, lang }: { doc: FilingDocRef; say: Say; lang: string }) {
  return <SecLink url={doc.sectionUrl ?? doc.url} label={filingLine(doc, say, lang)} aria={say("filings.section.open", { form: doc.form })} />;
}

function Quote({ text, className }: { text: string; className?: string }) {
  return <p className={cn("text-[12px] leading-[1.5] text-content-secondary", className)}>{`“${text}”`}</p>;
}

function Line({ item, say, lang }: { item: FilingChangeItem; say: Say; lang: string }) {
  const label = changeLabel(item, say, lang);
  const quote = quoteOf(item);
  return (
    <li className="grid grid-cols-[88px_minmax(0,1fr)] items-start gap-x-4 py-3">
      <span className="pt-px font-['Geist_Mono'] text-[11.5px] tabular-nums text-content-tertiary">{filingDate(item.date, lang)}</span>
      <div className="min-w-0">
        <p className="text-[13px] leading-5 text-content-primary">{label}</p>
        {quote && item.kind !== "auditor_name" ? <Quote text={quote} className="mt-1" /> : null}
        {item.previous && item.kind !== "auditor_name" ? (
          <p className="mt-1 text-[12px] leading-[1.5] text-content-tertiary">{say("filings.section.was", { text: `“${item.previous}”` })}</p>
        ) : null}
        <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11.5px] leading-4 text-content-tertiary">
          <SecLink url={item.url} label={say("filings.filed", { form: item.form, date: filingDate(item.date, lang) })} aria={say("filings.section.open", { form: item.form })} />
          {item.repeat ? <span>{say("filings.section.repeat")}</span> : null}
        </p>
      </div>
    </li>
  );
}

function Group({ group, items, say, lang }: { group: ItemGroup; items: FilingChangeItem[]; say: Say; lang: string }) {
  const [open, setOpen] = useState(false);
  if (items.length === 0) return null;
  const shown = open ? items : items.slice(0, FOLD);
  return (
    <div className="mt-5 first:mt-0">
      <h3 className="mb-1 text-[12px] font-medium text-content-secondary">{say(`filings.section.group.${group}` as MessageKey)}</h3>
      <ul className="divide-y divide-edge-subtle border-y border-edge-subtle">
        {shown.map((item) => (
          <Line key={item.id} item={item} say={say} lang={lang} />
        ))}
      </ul>
      {items.length > FOLD ? (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-2 rounded-sm text-[12px] text-content-secondary underline-offset-2 outline-none hover:text-content-primary hover:underline focus-visible:ring-2 focus-visible:ring-edge-focus"
        >
          {open ? say("filings.section.showFewer") : say("filings.section.showAll", { count: items.length })}
        </button>
      ) : null}
    </div>
  );
}

function Notes({ changes, say }: { changes: FilingChanges; say: Say }) {
  const notes: string[] = [];
  if (changes.missing.includes("previous")) notes.push(say("filings.section.onlyOne"));
  if (changes.missing.includes("risk_section")) notes.push(say("filings.section.noRisk"));
  if (changes.missing.includes("documents")) notes.push(say("filings.section.documents"));
  if (changes.relationships === "graph_older") notes.push(say("filings.section.graphOlder"));
  if (notes.length === 0) return null;
  return (
    <div className="mt-4 space-y-1">
      {notes.map((n) => (
        <p key={n} className="text-[12px] leading-[1.5] text-content-tertiary">
          {n}
        </p>
      ))}
    </div>
  );
}

export default function FilingChangesSection({ ticker }: StockSectionProps) {
  const { say, lang } = useSay();
  const state = useFilingChanges(ticker);
  const root = useRef<HTMLDivElement | null>(null);
  const [wantView, setWantView] = useState(false);
  const changes = state.value;

  useEffect(() => onFilingChangesViewRequest((t) => (t === ticker.toUpperCase() ? (setWantView(true), true) : false)), [ticker]);
  useEffect(() => {
    if (!wantView || !changes || !root.current) return;
    setWantView(false);
    const reduce = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    root.current.closest("section")?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
  }, [wantView, changes]);

  if (!changes || !changes.latest) return null;

  const byGroup = new Map<ItemGroup, FilingChangeItem[]>(GROUPS.map((g) => [g, []]));
  for (const item of changes.items) byGroup.get(groupOf(item.kind))!.push(item);

  let head: ReactNode;
  if (changes.previous) {
    head = say("filings.section.compared", { latest: "{latest}", previous: "{previous}" })
      .split(/(\{latest\}|\{previous\})/)
      .map((part, i) =>
        part === "{latest}" ? <DocLink key={i} doc={changes.latest!} say={say} lang={lang} /> : part === "{previous}" ? <DocLink key={i} doc={changes.previous!} say={say} lang={lang} /> : <span key={i}>{part}</span>,
      );
  } else head = <DocLink doc={changes.latest} say={say} lang={lang} />;

  const quarterLine =
    changes.quarter && changes.quarterRisk ? say(`filings.section.quarter.${changes.quarterRisk}` as MessageKey, { filing: filingLine(changes.quarter, say, lang) }) : null;

  return (
    <div ref={root}>
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1 text-[12px] leading-[1.5] text-content-tertiary">
          <p className="flex flex-wrap items-center gap-x-1">{head}</p>
          {changes.riskCount ? <p className="tabular-nums">{say("filings.section.riskCount", { latest: changes.riskCount.latest, previous: changes.riskCount.previous })}</p> : null}
          {quarterLine ? <p>{quarterLine}</p> : null}
        </div>
        <button
          type="button"
          onClick={() => openFilingChangesAgent(changes.ticker)}
          aria-label={say("filings.watchAria", { ticker: changes.ticker })}
          className="app-no-drag shrink-0 whitespace-nowrap rounded-sm text-[12px] leading-[1.5] text-content-secondary underline-offset-2 outline-none hover:text-content-primary hover:underline focus-visible:ring-2 focus-visible:ring-edge-focus"
        >
          {say("filings.watch")}
        </button>
      </div>
      {changes.items.length === 0 && changes.previous && !changes.missing.includes("documents") ? (
        <p className="text-[13px] text-content-secondary">{say("filings.section.nothing")}</p>
      ) : (
        GROUPS.map((g) => <Group key={g} group={g} items={byGroup.get(g)!} say={say} lang={lang} />)
      )}
      <Notes changes={changes} say={say} />
      <p className="mt-4 text-[11.5px] text-content-tertiary">{say("filings.section.source", { date: filingDate(changes.checkedAt.slice(0, 10), lang) })}</p>
    </div>
  );
}
