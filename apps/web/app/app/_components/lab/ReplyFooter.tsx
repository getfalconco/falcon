"use client";

import { useMemo } from "react";
import type { ReactNode } from "react";
import { Calculator, Database, Landmark, Layers, LineChart } from "lucide-react";
import { MessageActions } from "@/components/ui/ai-message";
import { STREAMING_LABELS_EN, StreamingFooter, type StreamingLabels, type StreamingSource } from "@/components/ui/streaming-text";
import { replySources, type SourceKind } from "@/lib/desk/reply-sources";
import type { GlossaryLang } from "@/lib/desk/glossary";
import type { LabMessage } from "./sessions";
import { useCalmMotion } from "./motion";

/**
 * A finished Falcon AI reply's footer (components/ui/streaming-text.tsx): the
 * actions (copy, regenerate, thumbs), the time, an "N sources" button that
 * opens the reply's sources (lib/desk/reply-sources.ts: each data lookup,
 * named by the citation check) and, on the last reply, the follow-up
 * questions the model suggested (lib/desk/followups.ts); a click asks one.
 */

const ICON: Record<SourceKind, ReactNode> = {
  databento: <Database strokeWidth={1.75} aria-hidden />,
  sec: <Landmark strokeWidth={1.75} aria-hidden />,
  yahoo: <LineChart strokeWidth={1.75} aria-hidden />,
  falcon: <Layers strokeWidth={1.75} aria-hidden />,
  computed: <Calculator strokeWidth={1.75} aria-hidden />,
};

const LABELS: Record<GlossaryLang, StreamingLabels> = {
  en: STREAMING_LABELS_EN,
  tr: { sources: (n) => `${n} kaynak`, followUps: "Takip soruları", sourcesList: "Kaynaklar" },
};
const AS_OF: Record<GlossaryLang, string> = { en: "as of", tr: "veri tarihi" };

/** The reply's sources for the chips and the list, by id too. */
export function useReplySources(m: LabMessage, lang: GlossaryLang): { list: StreamingSource[]; byId: ReadonlyMap<string, StreamingSource> } {
  return useMemo(() => {
    const list = replySources(m.tools, m.cites).map((s): StreamingSource => {
      const detail = [s.command, s.asOf ? `${AS_OF[lang]} ${s.asOf}` : ""].filter(Boolean).join(" · ");
      return { id: s.id, label: s.label, domain: s.domain, icon: ICON[s.kind], ...(s.url ? { url: s.url } : {}), ...(detail ? { detail } : {}) };
    });
    return { list, byId: new Map(list.map((s) => [s.id, s])) };
  }, [m.tools, m.cites, lang]);
}

export function ReplyFooter({
  m,
  lang,
  sources,
  copyText,
  onRetry,
  onVote,
  timestamp,
  onFollowUp,
  followUpsDisabled,
  animate,
}: {
  m: LabMessage;
  lang: GlossaryLang;
  sources: StreamingSource[];
  copyText?: string;
  onRetry?: () => void;
  onVote?: (v: "up" | "down") => void;
  timestamp?: string;
  /** Set on the last reply: asks a follow-up. */
  onFollowUp?: (q: string) => void;
  followUpsDisabled?: boolean;
  /** The reply just finished here (fade the footer in). */
  animate: boolean;
}) {
  const still = useCalmMotion();
  return (
    <StreamingFooter
      animate={animate && !still}
      labels={LABELS[lang]}
      actions={
        <span className="-ml-1.5 flex items-center gap-0.5">
          <MessageActions reveal="visible" copyText={copyText} onRetry={onRetry} retryLabel="Regenerate" onVote={onVote} vote={m.vote ?? null} />
        </span>
      }
      meta={timestamp ? <span className="ml-1 text-xs tabular-nums text-quiet">{timestamp}</span> : null}
      sources={sources}
      followUps={onFollowUp ? m.followups : undefined}
      onFollowUp={onFollowUp}
      followUpsDisabled={followUpsDisabled}
    />
  );
}
