"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { citeKey, sourceOf, stripSourceId, verifyCitation, type CiteCheck, type CiteReport, type CiteStatus, type SourceBlock, type UncitedNumber } from "@/lib/desk/citations";
import { matchFigure, measureOf, partOf, type PanelFigure } from "@/lib/desk/citation-panel";
import type { GlossaryLang } from "@/lib/desk/glossary";
import { usePopoverPlacement } from "./TermPopover";
import type { LabTool } from "./sessions";

/**
 * Numeric source citations in a Falcon AI reply (lib/desk/citations.ts): a
 * cited figure (`[%58,9](src:t3 "atmIv30Pct")`) renders as its label with a
 * solid hairline (glossary terms are dotted grey), and a click, Enter or Space
 * opens its source card: the source and dataset, the data's as-of time, when
 * it was fetched, the field and raw value, the command that produced it, the
 * tool output around it and a link to the filing. A figure that did not match
 * its source, or a data-like number with no citation, gets a small warning
 * style and the card says why. The results panel's numbers open the same card
 * (lab/PanelSources.tsx), so the chat and the panel point to the same field.
 */

export type CiteCtx = {
  lang: GlossaryLang;
  checks: Map<string, CiteCheck>;
  uncited: Map<string, UncitedNumber>;
  /** Tools of the session with a source id (a citation of an earlier reply is checked against its stored result). */
  tools: LabTool[];
  /** This reply's tools. */
  own: Set<string>;
  /** The reply's strategy test figures as the results panel shows them. */
  panel?: PanelFigure[];
  /** Whether the route's check came with the reply (older replies have none). */
  checked: boolean;
};

export function citeContext(report: CiteReport | undefined, own: LabTool[], tools: LabTool[], lang: GlossaryLang, panel?: PanelFigure[]): CiteCtx {
  return {
    lang,
    checks: new Map((report?.checks ?? []).map((c) => [citeKey(c), c])),
    uncited: new Map((report?.uncited ?? []).map((u) => [u.text, u])),
    tools,
    own: new Set(own.flatMap((t) => (t.src ? [t.src] : []))),
    ...(panel?.length ? { panel } : {}),
    checked: !!report,
  };
}

const UI = {
  tr: {
    title: "Kaynak",
    status: { verified: "Doğrulandı", mismatch: "Uyuşmuyor", unresolved: "Kaynak yok", unchecked: "Kontrol edilmedi", unverified: "Kaynaksız", derived: "Hesaplandı" },
    dataset: "Veri seti",
    asOf: "Veri tarihi",
    fetched: "Alındı",
    field: "Alan",
    raw: "Ham değer",
    command: "Komut",
    panel: "Sonuç paneli",
    show: "Araç çıktısını göster",
    hide: "Araç çıktısını gizle",
    open: "Kaynağı aç",
    earlier: "Önceki bir yanıttaki araç sonucu.",
    label: (x: string) => `${x}: kaynak`,
    why: {
      mismatchAt: (path: string, value: string, label: string) => `Kaynakta ${path} = ${value}; yanıtta ${label} yazıyor.`,
      mismatchNone: (label: string) => `${label} bu araç sonucunda yok.`,
      failed: "Bu araç çağrısı başarısız oldu, rakam içermiyor.",
      unresolved: (ref: string) => (ref === "audit" ? "Bu yanıtta strateji testinin denetimi yok." : `Bu yanıtta ${ref} kimlikli bir araç sonucu yok.`),
      unchecked: "Kontrol edilmedi: rakam değil ya da alanı belirtilmeden eşleştirilemeyecek kadar kısa.",
      moved: (field: string, path: string) => `Alıntılanan alan (${field}) farklı; bu rakam ${path} alanında.`,
      unverified: "Bu rakam bir araç sonucuna bağlanmadı, doğrulanamadı.",
      derived: "Alıntılanan rakamlardan hesaplandı; kendisi bir araç sonucunda yok.",
      old: "Bu yanıt kontrol eklenmeden önce kaydedildi.",
      panelSame: "Sohbette alıntılanan rakam bu alandan geliyor.",
    },
  },
  en: {
    title: "Source",
    status: { verified: "Verified", mismatch: "Does not match", unresolved: "No source", unchecked: "Not checked", unverified: "No source", derived: "Computed" },
    dataset: "Dataset",
    asOf: "Data as of",
    fetched: "Fetched",
    field: "Field",
    raw: "Raw value",
    command: "Command",
    panel: "Results panel",
    show: "Show tool output",
    hide: "Hide tool output",
    open: "Open source",
    earlier: "A tool result from an earlier reply.",
    label: (x: string) => `${x}: source`,
    why: {
      mismatchAt: (path: string, value: string, label: string) => `The source has ${path} = ${value}; the reply says ${label}.`,
      mismatchNone: (label: string) => `${label} is not in this tool result.`,
      failed: "That tool call failed, so it holds no figures.",
      unresolved: (ref: string) => (ref === "audit" ? "This reply has no audit of a strategy test." : `This reply has no tool result ${ref}.`),
      unchecked: "Not checked: not a number, or too short to match without its field.",
      moved: (field: string, path: string) => `The cited field (${field}) differs; this figure is at ${path}.`,
      unverified: "This number is not linked to a tool result, so it could not be checked.",
      derived: "Computed from cited figures; not itself in a tool result.",
      old: "This reply was saved before checks were added.",
      panelSame: "The figure quoted in the chat comes from this field.",
    },
  },
} as const;

type Status = CiteStatus | "unverified" | "derived";
const WARN: Status[] = ["mismatch", "unresolved", "unverified"];

const parseResult = (raw: string | undefined): unknown => {
  if (!raw) return undefined;
  const s = stripSourceId(raw).content;
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
};

/** The check for a citation: the route's, or, for a citation of an earlier reply's tool, checked here against its stored result. */
function useCheck(ctx: CiteCtx, label: string, ref: string, field?: string): { check: CiteCheck; earlier: boolean; tool?: LabTool } {
  return useMemo(() => {
    const given = ctx.checks.get(citeKey({ ref, field, label }));
    const tool = ctx.tools.find((t) => t.src === ref);
    const earlier = !!tool && !ctx.own.has(ref);
    if (given && !(given.status === "unresolved" && tool?.result)) return { check: given, earlier, tool };
    if (tool?.result) {
      const data = parseResult(tool.result);
      const c = verifyCitation({ label, ref, field }, { id: ref, name: "", input: {}, ok: tool.ok !== false, data, source: sourceOf("", {}, data), ...(tool.cmd ? { cmd: tool.cmd } : {}) });
      return { check: c, earlier, tool };
    }
    return { check: given ?? { ref, label, ...(field ? { field } : {}), status: ctx.checked ? "unresolved" : "unchecked" }, earlier, tool };
  }, [ctx, label, ref, field]);
}

const fmtTime = (iso: string, lang: GlossaryLang) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(lang === "tr" ? "tr-TR" : "en-US", { dateStyle: "medium", timeStyle: "short" });
};
const rawText = (v: number | string | undefined) => (v === undefined ? "" : typeof v === "number" ? String(v) : v);

/** One source card open at a time. */
let closeOpen: (() => void) | null = null;

/** A trigger and its card: click, Enter or Space opens it; Escape and a click outside close it. */
function usePopover() {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLElement | null>(null);
  const card = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  const show = useCallback(() => {
    if (closeOpen && closeOpen !== close) closeOpen();
    closeOpen = close;
    setOpen(true);
  }, [close]);
  useEffect(() => {
    if (!open) {
      if (closeOpen === close) closeOpen = null;
      return;
    }
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchor.current?.contains(t) && !card.current?.contains(t)) close();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, close]);
  return { open, show, close, anchor, card };
}

const STYLE: Record<Status, string> = {
  verified: "decoration-fore/35 decoration-solid hover:decoration-fore/60",
  unchecked: "decoration-fore/20 decoration-solid hover:decoration-fore/45",
  mismatch: "decoration-warn/80 decoration-solid text-warn",
  unresolved: "decoration-warn/80 decoration-solid text-warn",
  unverified: "decoration-warn/60 decoration-dashed",
  derived: "decoration-quiet/50 decoration-dashed",
};

function Trigger({ status, label, open, onToggle, onKey, anchorRef, controls, children }: { status: Status; label: string; open: boolean; onToggle: () => void; onKey: (e: ReactKeyboardEvent) => void; anchorRef: RefObject<HTMLElement | null>; controls?: string; children: ReactNode }) {
  return (
    <span
      ref={anchorRef as RefObject<HTMLSpanElement>}
      role="button"
      tabIndex={0}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? controls : undefined}
      aria-label={label}
      data-cite={status}
      onClick={onToggle}
      onKeyDown={onKey}
      className={`cursor-pointer rounded-[3px] underline decoration-[1px] underline-offset-[3px] [box-decoration-break:clone] [font-variant-numeric:tabular-nums] transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/25 ${STYLE[status]} ${open ? "bg-line/[0.07]" : "hover:bg-line/[0.04]"}`}
    >
      {children}
      {WARN.includes(status) && status !== "unverified" ? (
        <sup aria-hidden className="ml-px text-[0.62em] font-semibold text-warn">
          !
        </sup>
      ) : null}
    </span>
  );
}

/**
 * A cited figure in the reply (Markdown renders `[label](src:ref "field")` with it). Restyle freely: its look is
 * Trigger's classes and `data-cite` (the status); the card is SourceCard.
 */
export function CitationMark({ ctx, label, refId, field }: { ctx: CiteCtx; label: string; refId: string; field?: string }) {
  const { check, earlier, tool } = useCheck(ctx, label, refId, field);
  const p = usePopover();
  const id = useId();
  const ui = UI[ctx.lang];
  const status: Status = check.status;
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (p.open) p.close();
      else p.show();
    } else if (e.key === "Escape" && p.open) {
      e.preventDefault();
      p.close();
    }
  };
  const reason = (() => {
    if (status === "verified") return check.note && check.field && check.path ? ui.why.moved(check.field, check.path) : null;
    if (status === "mismatch") return check.value !== undefined && check.path ? ui.why.mismatchAt(check.path, rawText(check.value), label) : /failed/.test(check.note ?? "") ? ui.why.failed : ui.why.mismatchNone(label);
    if (status === "unresolved") return ui.why.unresolved(refId);
    return ctx.checked || earlier ? ui.why.unchecked : ui.why.old;
  })();
  const fig = ctx.panel && (refId === "audit" || check.tool === "audit_run") ? matchFigure(ctx.panel, label, { measure: measureOf(field ?? ""), part: partOf(field ?? "") }) : null;
  const excerpt = check.excerpt ?? (tool?.result ? stripSourceId(tool.result).content.slice(0, 1_200) : undefined);
  return (
    <>
      <Trigger status={status} label={`${label}, ${ui.title}: ${ui.status[status]}`} open={p.open} onToggle={() => (p.open ? p.close() : p.show())} onKey={onKey} anchorRef={p.anchor} controls={id}>
        {label}
      </Trigger>
      {p.open ? (
        <SourceCard
          id={id}
          lang={ctx.lang}
          anchor={p.anchor}
          card={p.card}
          onClose={(refocus) => {
            p.close();
            if (refocus) p.anchor.current?.focus({ preventScroll: true });
          }}
          status={status}
          shown={label}
          source={check.source}
          rows={
            fig
              ? // An audit figure: the same field and raw value the results panel shows for it.
                [
                  [ui.field, fig.path, true],
                  [ui.raw, String(fig.value), true],
                  [ui.panel, fig.shown, true],
                  [ui.command, check.cmd ?? tool?.cmd ?? "", true],
                ]
              : [
                  [ui.field, check.path ?? check.field ?? "", true],
                  [ui.raw, rawText(check.value), true],
                  [ui.command, check.cmd ?? tool?.cmd ?? "", true],
                ]
          }
          reason={[reason, earlier ? ui.earlier : null].filter(Boolean).join(" ") || undefined}
          excerpt={excerpt}
          url={check.url ?? check.source?.url}
          refId={refId}
        />
      ) : null}
    </>
  );
}

/** A data-like number the reply did not cite. */
export function UncitedMark({ ctx, entry, children }: { ctx: CiteCtx; entry: UncitedNumber; children: ReactNode }) {
  const p = usePopover();
  const id = useId();
  const ui = UI[ctx.lang];
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      if (p.open) p.close();
      else p.show();
    } else if (e.key === "Escape" && p.open) {
      e.preventDefault();
      p.close();
    }
  };
  return (
    <>
      <Trigger status={entry.status} label={`${entry.text}, ${ui.title}: ${ui.status[entry.status]}`} open={p.open} onToggle={() => (p.open ? p.close() : p.show())} onKey={onKey} anchorRef={p.anchor} controls={id}>
        {children}
      </Trigger>
      {p.open ? (
        <SourceCard
          id={id}
          lang={ctx.lang}
          anchor={p.anchor}
          card={p.card}
          onClose={(refocus) => {
            p.close();
            if (refocus) p.anchor.current?.focus({ preventScroll: true });
          }}
          status={entry.status}
          shown={entry.text}
          rows={[]}
          reason={entry.status === "derived" ? ui.why.derived : ui.why.unverified}
        />
      ) : null}
    </>
  );
}

/** A results panel number: the card names the audit or result field it shows (lab/PanelSources.tsx). */
export function PanelSourceCard({ anchor, fig, quoted, lang, onClose }: { anchor: RefObject<HTMLElement | null>; fig: PanelFigure; quoted: boolean; lang: GlossaryLang; onClose: () => void }) {
  const card = useRef<HTMLDivElement>(null);
  const id = useId();
  const ui = UI[lang];
  useEffect(() => {
    const away = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!anchor.current?.contains(t) && !card.current?.contains(t)) onClose();
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [anchor, onClose]);
  const fromAudit = fig.path.startsWith("audit.");
  return (
    <SourceCard
      id={id}
      lang={lang}
      anchor={anchor}
      card={card}
      onClose={onClose}
      status={fromAudit ? "verified" : "unchecked"}
      shown={fig.shown}
      source={fromAudit ? { label: lang === "tr" ? "Falcon'un bağımsız test denetimi" : "Falcon's independent audit of the test", dataset: lang === "tr" ? "Tam eğri üzerinde sunucuda hesaplandı" : "Computed on the server from the full curve" } : { label: lang === "tr" ? "Test betiğinin sonuç dosyası (falcon_result.json)" : "The test script's result file (falcon_result.json)" }}
      rows={[
        [ui.field, fig.path, true],
        [ui.raw, String(fig.value), true],
      ]}
      reason={quoted ? ui.why.panelSame : undefined}
      refId="audit"
    />
  );
}

const CARD =
  "fixed z-[90] flex w-[min(340px,calc(100vw-16px))] flex-col overflow-hidden rounded-[16px] border border-line/[0.1] bg-raised/[0.86] text-fore shadow-[0_20px_50px_-14px_rgba(0,0,0,0.28),0_2px_8px_rgba(0,0,0,0.06)] backdrop-blur-2xl backdrop-saturate-150 dark:border-line/[0.12] dark:bg-raised/[0.82] dark:shadow-[0_20px_50px_-10px_rgba(0,0,0,0.75),0_0_0_0.5px_rgba(255,255,255,0.04)]";

function pretty(excerpt: string): string {
  try {
    return JSON.stringify(JSON.parse(excerpt), null, 2);
  } catch {
    return excerpt;
  }
}

function SourceCard({
  id,
  lang,
  anchor,
  card,
  onClose,
  status,
  shown,
  source,
  rows,
  reason,
  excerpt,
  url,
  refId,
}: {
  id: string;
  lang: GlossaryLang;
  anchor: RefObject<HTMLElement | null>;
  card: RefObject<HTMLDivElement>;
  onClose: (refocus: boolean) => void;
  status: Status;
  shown: string;
  source?: SourceBlock;
  rows: [string, string, boolean][];
  reason?: string;
  excerpt?: string;
  url?: string;
  refId?: string;
}) {
  const ui = UI[lang];
  const [output, setOutput] = useState(false);
  const pos = usePopoverPlacement(anchor as RefObject<HTMLElement>, card, [output]);
  const meta: [string, string, boolean][] = [
    ...(source?.dataset ? ([[ui.dataset, source.dataset, false]] as [string, string, boolean][]) : []),
    ...(source?.as_of ? ([[ui.asOf, /^\d{4}-\d{2}-\d{2}T/.test(source.as_of) ? fmtTime(source.as_of, lang) : source.as_of, false]] as [string, string, boolean][]) : []),
    ...(source?.fetched_at ? ([[ui.fetched, fmtTime(source.fetched_at, lang), false]] as [string, string, boolean][]) : []),
    ...rows.filter(([, v]) => v),
  ];
  const warn = WARN.includes(status);
  const body = (
    <div
      ref={card}
      id={id}
      role="dialog"
      aria-label={ui.label(shown)}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          onClose(true);
        }
      }}
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, maxHeight: pos?.maxH, visibility: pos ? "visible" : "hidden" }}
      className={`${CARD} ${pos ? `animate-in fade-in-0 zoom-in-[0.98] duration-150 ease-out motion-reduce:animate-none ${pos.above ? "slide-in-from-bottom-1" : "slide-in-from-top-1"}` : ""}`}
    >
      <div className={`min-h-0 flex-1 overflow-y-auto overscroll-contain px-3.5 pb-2.5 pt-2.5 ${pos?.maxH ? "[mask-image:linear-gradient(to_bottom,black_calc(100%-12px),transparent)]" : ""}`}>
        <h3 className="mb-1 flex items-center gap-2 text-fs-12.5 font-semibold leading-fs-18 tracking-[-0.01em] text-fore-3">
          <span className="shrink-0">{ui.title}</span>
          {refId ? <span className="shrink-0 font-mono text-fs-11 font-medium text-faint">{refId}</span> : null}
          <span aria-hidden className="h-px flex-1 bg-line/[0.16]" />
          <span className={`shrink-0 rounded-full px-1.5 py-px text-fs-11 font-medium ${warn ? "bg-warn/10 text-warn" : status === "verified" ? "bg-up/10 text-up" : "bg-line/[0.06] text-quiet"}`}>{ui.status[status]}</span>
        </h3>
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span className="text-fs-17 font-semibold leading-fs-22 text-fore [font-variant-numeric:tabular-nums]">{shown}</span>
          {source ? <span className="min-w-0 text-fs-12.5 leading-fs-17 text-quiet">{source.label}</span> : null}
        </p>
        {reason ? <p className={`mt-1.5 rounded-[9px] px-2 py-1 text-fs-12.5 leading-fs-17 ${warn ? "bg-warn/[0.08] text-fore-2" : "bg-line/[0.045] text-fore-3"}`}>{reason}</p> : null}
        {meta.length ? (
          <dl className="mt-2 grid grid-cols-[max-content_1fr] gap-x-3 gap-y-0.5 text-fs-12 leading-fs-17">
            {meta.map(([k, v, mono]) => (
              <div key={k} className="contents">
                <dt className="text-faint">{k}</dt>
                <dd className={`min-w-0 break-words text-fore-2 ${mono ? "font-mono text-fs-11.5" : ""}`}>{v}</dd>
              </div>
            ))}
          </dl>
        ) : null}
        {excerpt ? (
          <div className="mt-2">
            <button
              type="button"
              aria-expanded={output}
              onClick={() => setOutput((o) => !o)}
              className="inline-flex items-center gap-1 rounded text-fs-12 font-medium text-quiet transition-colors hover:text-fore focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/25"
            >
              <ChevronDown width={13} height={13} strokeWidth={1.75} aria-hidden className={`transition-transform ${output ? "rotate-180" : ""}`} />
              {output ? ui.hide : ui.show}
            </button>
            {output ? <pre className="mt-1 max-h-[180px] overflow-auto whitespace-pre-wrap break-words rounded-[9px] border border-line/[0.08] bg-line/[0.035] px-2 py-1.5 font-mono text-fs-11 leading-fs-16 text-fore-2">{pretty(excerpt)}</pre> : null}
          </div>
        ) : null}
        {url && /^https:\/\//.test(url) ? (
          <a href={url} target="_blank" rel="noopener noreferrer nofollow" className="mt-2 inline-flex items-center gap-1 rounded text-fs-12.5 font-medium text-fore underline decoration-line/30 underline-offset-2 hover:decoration-line/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/25">
            {ui.open}
            <ArrowUpRight width={13} height={13} strokeWidth={1.75} aria-hidden />
          </a>
        ) : null}
      </div>
    </div>
  );
  return createPortal(body, document.body);
}
