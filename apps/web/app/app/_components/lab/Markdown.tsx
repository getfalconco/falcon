"use client";

import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { findTerms, parseTermLink } from "@/lib/desk/glossary-match";
import type { GlossaryLang } from "@/lib/desk/glossary";
import { Term } from "./TermPopover";
import { dataNumbers, parseCitations } from "@/lib/desk/citations";
import { CitationMark, UncitedMark, type CiteCtx } from "./SourceCite";

/**
 * A small Markdown renderer for Falcon AI replies: paragraphs, bullet and numbered
 * lists, headings, pipe tables, fenced code (language label and copy button), block quotes, rules, and inline
 * **bold**, *italic*, `code` and http(s) links. It builds React elements only
 * (no HTML is ever injected), so a reply cannot add markup or scripts, and it
 * tolerates half-written syntax while a reply streams in.
 *
 * With `terms`, finance terms from the glossary (lib/desk/glossary.ts) become
 * hoverable (lab/TermPopover.tsx): first occurrence per reply, in paragraphs,
 * lists, quotes and tables, never in code, links or headings. The model's
 * explicit `[label](term:key "value")` markup always renders as its label;
 * with `terms` and a known key it is a term carrying that value.
 *
 * Source citations `[%58,9](src:t3 "field")` (lib/desk/citations.ts) always
 * render as their label; with `cites` (the reply's check) the label is a
 * CitationMark that opens its source, and data-like numbers the reply left
 * uncited get an UncitedMark (lab/SourceCite.tsx).
 */

/** Hoverable glossary terms: the reply's language and the keys already highlighted earlier in the reply. */
export type MarkdownTerms = { lang: GlossaryLang; skip?: ReadonlySet<string> };
type TermCtx = { lang: GlossaryLang; seen: Set<string> };

type Block =
  | { kind: "p"; lines: string[] }
  | { kind: "h"; text: string; level: number }
  | { kind: "table"; rows: string[][]; align: ("left" | "right" | "center")[] }
  | { kind: "ul" | "ol"; items: string[]; start: number }
  | { kind: "code"; lines: string[]; lang: string }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" };

const BULLET = /^\s{0,6}[-*•+]\s+(.*)$/;
const NUMBER = /^\s{0,6}(\d{1,3})[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s{0,3}(```|~~~)\s*([\w+#.-]*)/;
const TABLE_ROW = /^\s{0,3}\|.*\|\s*$/;
const TABLE_SEP = /^\s{0,3}\|?(\s*:?-+:?\s*\|)+\s*(:?-+:?\s*)?\|?\s*$/;

function cells(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());
}
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  let cur: Block | null = null;
  const close = () => {
    if (cur) blocks.push(cur);
    cur = null;
  };
  for (const line of src.replace(/\r\n?/g, "\n").split("\n")) {
    if (cur?.kind === "code") {
      if (FENCE.test(line)) close();
      else cur.lines.push(line);
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence) {
      close();
      cur = { kind: "code", lines: [], lang: fence[2] ?? "" };
      continue;
    }
    if (cur?.kind === "table") {
      if (TABLE_SEP.test(line)) {
        cur.align = cells(line).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left"));
        continue;
      }
      if (TABLE_ROW.test(line)) {
        cur.rows.push(cells(line));
        continue;
      }
    }
    if (!line.trim()) {
      close();
      continue;
    }
    let m: RegExpMatchArray | null;
    if (TABLE_ROW.test(line)) {
      close();
      cur = { kind: "table", rows: [cells(line)], align: [] };
    } else if (RULE.test(line)) {
      close();
      blocks.push({ kind: "hr" });
    } else if ((m = line.match(HEADING))) {
      close();
      blocks.push({ kind: "h", text: m[2]!, level: m[1]!.length });
    } else if ((m = line.match(BULLET))) {
      if (cur?.kind !== "ul") {
        close();
        cur = { kind: "ul", items: [], start: 1 };
      }
      cur.items.push(m[1]);
    } else if ((m = line.match(NUMBER))) {
      if (cur?.kind !== "ol") {
        close();
        cur = { kind: "ol", items: [], start: Number(m[1]) || 1 };
      }
      cur.items.push(m[2]);
    } else if ((m = line.match(QUOTE))) {
      if (cur?.kind !== "quote") {
        close();
        cur = { kind: "quote", lines: [] };
      }
      cur.lines.push(m[1]);
    } else if ((cur?.kind === "ul" || cur?.kind === "ol") && /^\s+\S/.test(line)) {
      // An indented line continues the last list item.
      cur.items[cur.items.length - 1] += `\n${line.trim()}`;
    } else {
      if (cur?.kind !== "p") {
        close();
        cur = { kind: "p", lines: [] };
      }
      cur.lines.push(line);
    }
  }
  close();
  return blocks;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*|__[^_\n]+?__)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(\[[^\]\n]{1,120}\]\(term:[a-z0-9-]{1,40}(?:\s+"[^"\n]{0,400}")?\))|(\[[^\]\n]{1,80}\]\(src:[A-Za-z0-9_-]{1,24}(?:\s+"[^"\n]{0,120}")?\))|(\*[^*\s][^*\n]*?\*)/g;
/** A term link still being written at the end of a streaming reply: show only its label. */
const PARTIAL_TERM = /\[([^\]\n]{1,120})\]\(term:[^)\n]*$/;
/** A source citation still being written: show only its label. */
const PARTIAL_SRC = /\[([^\]\n]{1,80})\]\(src:[^)\n]*$/;

function inline(text: string, keyBase: string, terms: TermCtx | null = null, cites: CiteCtx | null = null): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let i = 0;
  const pushText = (t: string) => {
    // Single line breaks inside a paragraph or list item stay line breaks.
    t.split("\n").forEach((part, j) => {
      if (j) out.push(<br key={`${keyBase}-br${i}-${j}`} />);
      if (!part) return;
      // Data-like numbers the reply did not cite (the route's check lists them) carry a mark; terms in the rest.
      const pieces: (string | { n: string; at: number })[] = [];
      let from = 0;
      if (cites?.uncited.size)
        for (const n of dataNumbers(part)) {
          if (!cites.uncited.has(n.text)) continue;
          if (n.start > from) pieces.push(part.slice(from, n.start));
          pieces.push({ n: n.text, at: n.start });
          from = n.end;
        }
      if (from < part.length) pieces.push(part.slice(from));
      for (const piece of pieces) {
        if (typeof piece !== "string") {
          out.push(
            <UncitedMark key={`${keyBase}-u${i}-${j}-${piece.at}`} ctx={cites!} entry={cites!.uncited.get(piece.n)!}>
              {piece.n}
            </UncitedMark>,
          );
          continue;
        }
        if (!terms) {
          out.push(piece);
          continue;
        }
        let at = 0;
        for (const h of findTerms(piece, terms.seen)) {
          if (h.start > at) out.push(piece.slice(at, h.start));
          out.push(
            <Term key={`${keyBase}-t${i}-${j}-${h.start}-${out.length}`} termKey={h.key} lang={terms.lang}>
              {piece.slice(h.start, h.end)}
            </Term>,
          );
          at = h.end;
        }
        if (at < piece.length) out.push(piece.slice(at));
      }
    });
  };
  const partial = PARTIAL_TERM.exec(text) ?? PARTIAL_SRC.exec(text);
  if (partial) text = text.slice(0, partial.index) + partial[1];
  for (const m of Array.from(text.matchAll(INLINE))) {
    const at = m.index ?? 0;
    if (at > last) pushText(text.slice(last, at));
    const tok = m[0];
    const key = `${keyBase}-${i++}`;
    if (m[1]) out.push(<code key={key} className="rounded bg-line/[0.07] px-1 py-px font-mono text-[0.9em] text-fore">{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key} className="font-semibold text-fore">{inline(tok.slice(2, -2), key, terms, cites)}</strong>);
    else if (m[3]) {
      const close = tok.indexOf("](");
      out.push(
        <a key={key} href={tok.slice(close + 2, -1)} target="_blank" rel="noopener noreferrer nofollow" className="text-fore underline decoration-line/30 underline-offset-2 hover:decoration-line/60">
          {tok.slice(1, close)}
        </a>,
      );
    } else if (m[4]) {
      // Explicit term: the label always shows; only a known key makes it a term (the definition stays the glossary's).
      const t = parseTermLink(tok);
      if (t?.key && terms) {
        terms.seen.add(t.key);
        out.push(
          <Term key={key} termKey={t.key} lang={terms.lang} value={t.value}>
            {t.label}
          </Term>,
        );
      } else out.push(t?.label ?? tok);
    } else if (m[5]) {
      // A source citation: its label, opening its source once the reply's check is in.
      const c = parseCitations(tok)[0];
      if (c && cites) out.push(<CitationMark key={key} ctx={cites} label={c.label} refId={c.ref} field={c.field} />);
      else out.push(<span key={key} data-src={c?.ref} className="[font-variant-numeric:tabular-nums]">{c?.label ?? tok}</span>);
    } else out.push(<em key={key}>{inline(tok.slice(1, -1), key, terms, cites)}</em>);
    last = at + tok.length;
  }
  if (last < text.length) pushText(text.slice(last));
  return out;
}

/** A fenced code block: language label and a copy button over the code. */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  return (
    <div className="min-w-0 overflow-hidden rounded-xl border border-line/[0.08] bg-line/[0.035]">
      <div className="flex h-8 items-center justify-between border-b border-line/[0.07] pl-3 pr-1">
        <span className="font-mono text-fs-11.5 lowercase text-faint">{lang || "text"}</span>
        <button
          type="button"
          aria-label={copied ? "Copied" : "Copy code"}
          title={copied ? "Copied" : "Copy code"}
          onClick={() => {
            navigator.clipboard?.writeText(code).then(
              () => setCopied(true),
              () => undefined,
            );
          }}
          className="inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-fs-11.5 text-quiet transition-colors hover:bg-line/[0.06] hover:text-fore focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/25"
        >
          {copied ? <Check width={12} height={12} strokeWidth={2} aria-hidden /> : <Copy width={12} height={12} strokeWidth={1.75} aria-hidden />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="overflow-x-auto px-3 py-2.5 font-mono text-fs-13 leading-fs-20 text-fore [font-variant-numeric:tabular-nums]">
        <code>{code}</code>
      </pre>
    </div>
  );
}

/** Right-align columns that are mostly numbers ("$1.2B", "-3.4%", "12,000"). */
const NUMERIC = /^[\s$€£¥%+\-−(]*[\d.,]+\s*[%xKMBT)]*\s*$/i;

function tableAlign(rows: string[][], align: ("left" | "right" | "center")[], col: number): "left" | "right" | "center" {
  if (align[col] && align[col] !== "left") return align[col]!;
  const body = rows.slice(1).map((r) => r[col] ?? "").filter((c) => c && c !== "-" && c !== "—");
  return body.length && body.filter((c) => NUMERIC.test(c.replace(/\*\*/g, "").replace(/\[([^\]\n]{1,80})\]\(src:[^)\n]*\)/g, "$1"))).length / body.length >= 0.6 ? "right" : "left";
}

export function Markdown({ text, terms, cites }: { text: string; terms?: MarkdownTerms; cites?: CiteCtx }) {
  const cc = cites ?? null;
  // One set per render: each term is highlighted once (keys from earlier parts of the reply are skipped).
  const ctx: TermCtx | null = terms ? { lang: terms.lang, seen: new Set(terms.skip) } : null;
  return (
    <div className="flex flex-col gap-3">
      {parse(text).map((b, n) => {
        const k = `b${n}`;
        switch (b.kind) {
          case "p":
            return <p key={k}>{inline(b.lines.join("\n"), k, ctx, cc)}</p>;
          case "h":
            return b.level <= 2 ? (
              <h3 key={k} className="mt-1 text-fs-16 font-semibold leading-fs-24 tracking-[-0.01em] text-fore">
                {inline(b.text, k)}
              </h3>
            ) : (
              <h4 key={k} className="mt-0.5 text-fs-15 font-semibold text-fore">
                {inline(b.text, k)}
              </h4>
            );
          case "table": {
            const [head, ...body] = b.rows;
            const cols = Math.max(...b.rows.map((r) => r.length));
            const al = Array.from({ length: cols }, (_, c) => tableAlign(b.rows, b.align, c));
            const cls = (c: number) => (al[c] === "right" ? "text-right" : al[c] === "center" ? "text-center" : "text-left");
            return (
              <div key={k} className="min-w-0 overflow-x-auto rounded-xl border border-line/[0.08]">
                <table className="w-full border-collapse text-fs-13.5 leading-fs-20 [font-variant-numeric:tabular-nums]">
                  <thead className="bg-line/[0.035]">
                    <tr>
                      {Array.from({ length: cols }, (_, c) => (
                        <th key={c} scope="col" className={`whitespace-nowrap px-3 py-2 font-medium text-fore ${cls(c)}`}>
                          {inline(head?.[c] ?? "", `${k}-h${c}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {body.map((r, j) => (
                      <tr key={j} className="border-t border-line/[0.07]">
                        {Array.from({ length: cols }, (_, c) => (
                          <td key={c} className={`px-3 py-1.5 align-top text-fore-2 ${cls(c)}`}>
                            {inline(r[c] ?? "", `${k}-${j}-${c}`, ctx, cc)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          }
          case "ul":
            return (
              <ul key={k} className="flex list-disc flex-col gap-1 pl-5 marker:text-faint">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${k}-${j}`, ctx, cc)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={k} start={b.start} className="flex list-decimal flex-col gap-1 pl-5 marker:text-faint">
                {b.items.map((it, j) => (
                  <li key={j}>{inline(it, `${k}-${j}`, ctx, cc)}</li>
                ))}
              </ol>
            );
          case "code":
            return <CodeBlock key={k} code={b.lines.join("\n")} lang={b.lang} />;
          case "quote":
            return (
              <blockquote key={k} className="border-l-2 border-line/[0.15] pl-3 text-quiet">
                {inline(b.lines.join("\n"), k, ctx, cc)}
              </blockquote>
            );
          case "hr":
            return <hr key={k} className="border-line/[0.1]" />;
        }
      })}
    </div>
  );
}
