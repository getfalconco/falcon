"use client";

import type { ReactElement } from "react";
import { StreamingReveal, type StreamingSource } from "@/components/ui/streaming-text";
import { Markdown } from "./Markdown";
import type { MarkdownTerms } from "./Markdown";
import { CitationMark, type CiteCtx } from "./SourceCite";
import { useCalmMotion } from "./motion";

/**
 * A reply's text while it streams (components/ui/streaming-text.tsx): words
 * fade in one by one at a reading pace that keeps up with the stream, a thin
 * caret blinks at the end, and a paragraph or list item that cites a source
 * ends with that source's chip (lab/ReplyFooter.tsx names them). The revealed
 * part is rendered by the same Markdown renderer as the final reply, so the
 * finished text does not jump. Glossary terms and the source cards
 * (lab/SourceCite.tsx) apply once the text has settled. Reduced motion (the
 * app's Motion setting): text appears as it arrives, no fade, no caret.
 */

/** The source id a rendered element cites: a citation (CitationMark), or its plain label while the reply streams (Markdown's data-src). */
export function citationOf(el: ReactElement): string | null {
  const p = el.props as { refId?: unknown; "data-src"?: unknown };
  if (el.type === CitationMark && typeof p.refId === "string") return p.refId;
  return typeof p["data-src"] === "string" ? p["data-src"] : null;
}

export function StreamingText({
  text,
  live,
  caret,
  terms,
  cites,
  sources,
}: {
  text: string;
  live: boolean;
  caret: boolean;
  terms?: MarkdownTerms;
  /** Source citations (lab/SourceCite.tsx), once the reply is checked. */
  cites?: CiteCtx;
  /** The reply's sources by id, for the inline chips. */
  sources?: ReadonlyMap<string, StreamingSource>;
}) {
  const still = useCalmMotion();
  return (
    <StreamingReveal
      text={text}
      streaming={live}
      caret={caret}
      reducedMotion={still}
      citationOf={citationOf}
      sources={sources}
      // Called as a function (it uses no hooks), so the reveal can walk its elements.
      render={(t, settled) => Markdown({ text: t, terms: settled ? terms : undefined, cites: settled ? cites : undefined })}
    />
  );
}
