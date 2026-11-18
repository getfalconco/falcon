"use client";

import { Children, Fragment, cloneElement, isValidElement, useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import type { ReactElement, ReactNode } from "react";
import { CornerDownRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { REVEAL_PACE, RevealClock, revealStep, splitWords, wordEnd } from "@/lib/streaming-reveal";

/**
 * A reply that streams in word by word, with its sources and follow-ups.
 *
 *  - Words fade in one by one (opacity and a light blur, 250 ms) at a reading
 *    pace (about 80 ms a word) that speeds up with the backlog, so a fast
 *    stream or a burst is followed closely (lib/streaming-reveal.ts). A thin
 *    caret blinks at the end while the reply is written. Only words inside
 *    text nodes animate; code blocks, tables and other blocks fade in whole.
 *    A shown word never fades again, whatever re-renders or re-parses.
 *  - Inline source chips: a block (paragraph, list item, quote) whose text
 *    cites a source ends with a small chip per source (icon and mono name),
 *    popping in once the block is complete.
 *  - When the reply is done: the actions row fades in with an "N sources"
 *    button (overlapping source icons) that opens the list of sources, and
 *    the follow-up questions rise in one after another; a click asks one.
 *  - Reduced motion: text shows as it arrives, nothing fades, blurs or pops.
 *    A reply that was already complete when it mounted (a reloaded session)
 *    shows in its finished state without animation.
 *
 * Data-driven: the caller renders the text (`render`, returning plain
 * elements whose children are the blocks, e.g. a Markdown renderer called as
 * a function) and passes its sources, follow-ups and actions. Colours are the
 * workspace tokens (fore, quiet, faint, line, surface), so light and dark
 * both follow the app theme; keyframes are in app/globals.css (st-*).
 */

export type StreamingSource = {
  /** The id citations name. */
  id: string;
  /** Full name ("SEC XBRL company facts"). */
  label: string;
  /** The short mono name ("sec.gov", "Databento"); chips with the same name merge. */
  domain: string;
  /** A 12px icon. */
  icon?: ReactNode;
  url?: string;
  /** A second line in the list ("/quote AAPL · as of 2026-11-14"). */
  detail?: string;
};

export type StreamingLabels = {
  sources: (n: number) => string;
  followUps: string;
  sourcesList: string;
};

export const STREAMING_LABELS_EN: StreamingLabels = {
  sources: (n) => (n === 1 ? "1 source" : `${n} sources`),
  followUps: "Follow-ups",
  sourcesList: "Sources",
};

const FADE_MS = 250;
const CHIP_MS = 260;
const FOLLOW_STAGGER_MS = 90;

/* ------------------------------------------------------------------ motion */

const REDUCE = "(prefers-reduced-motion: reduce)";
const subscribeReduce = (cb: () => void) => {
  const mq = typeof window !== "undefined" && typeof window.matchMedia === "function" ? window.matchMedia(REDUCE) : null;
  mq?.addEventListener("change", cb);
  return () => mq?.removeEventListener("change", cb);
};
const readReduce = () => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(REDUCE).matches;

/** The OS reduced-motion setting (the caller can pass its own, e.g. an app setting). */
export function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(subscribeReduce, readReduce, () => false);
}

/**
 * How much of `text` to show, at a word end. `streaming`: the text may still
 * grow. Text already complete when this mounts, or with reduced motion, shows
 * at once.
 */
function useReveal(text: string, streaming: boolean, still: boolean): number {
  const [shown, setShown] = useState(() => (streaming && !still ? 0 : text.length));
  const pos = useRef(shown);
  const frame = useRef(0);
  const target = useRef(text.length);
  const textRef = useRef(text);
  target.current = text.length;
  textRef.current = text;

  useEffect(() => {
    if (still || (typeof document !== "undefined" && document.hidden)) {
      // A background tab gets no animation frames: show the text as it is.
      pos.current = text.length;
      setShown(text.length);
      return;
    }
    if (text.length <= pos.current) {
      pos.current = text.length;
      setShown(text.length);
      return;
    }
    if (frame.current) return;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      pos.current = revealStep(pos.current, target.current, dt);
      // Re-render only when a new word shows.
      const at = wordEnd(textRef.current, Math.floor(pos.current));
      setShown((s) => (s === at ? s : at));
      frame.current = pos.current < target.current ? requestAnimationFrame(tick) : 0;
    };
    frame.current = requestAnimationFrame(tick);
  }, [text.length, still]);

  useEffect(
    () => () => {
      cancelAnimationFrame(frame.current);
      frame.current = 0;
    },
    [],
  );
  return still ? text.length : Math.min(shown, text.length);
}

/* ------------------------------------------------------------------ tree walk */

type Walk = {
  clock: RevealClock;
  now: number;
  /** Wrap words in fading spans (an animated instance while it reveals). */
  words: boolean;
  /** The instance animates (chips pop, blocks fade). */
  motion: boolean;
  n: number;
  refs: string[];
  citationOf?: (el: ReactElement) => string | null;
};

const SKIP = new Set(["pre", "br", "hr", "svg", "img"]);
const TEXT_BLOCKS = new Set(["p", "blockquote", "h1", "h2", "h3", "h4", "h5", "h6"]);
const CHIP_BLOCKS = new Set(["p", "blockquote", "li"]);

function word(w: Walk, child: ReactNode): ReactNode {
  const key = `w${w.n++}`;
  const fresh = w.clock.fresh(key, w.now);
  return (
    <span key={key} className={fresh ? "st-word" : undefined}>
      {child}
    </span>
  );
}

function inline(node: ReactNode, w: Walk): ReactNode[] {
  if (node === null || node === undefined || typeof node === "boolean") return [];
  if (typeof node === "string" || typeof node === "number") {
    const s = String(node);
    return w.words ? splitWords(s).map((part) => word(w, part)) : [s];
  }
  if (Array.isArray(node)) return node.flatMap((n) => inline(n, w));
  if (!isValidElement(node)) return [node];
  const el = node as ReactElement<{ children?: ReactNode }>;
  const ref = w.citationOf?.(el) ?? null;
  if (ref) w.refs.push(ref);
  // A component (a cited figure, a glossary term) or a block left whole: one word.
  if (ref || typeof el.type !== "string" || SKIP.has(el.type)) return [w.words && (ref || typeof el.type !== "string") ? word(w, el) : el];
  const kids = el.props.children;
  if (kids === undefined || kids === null) return [el];
  return [cloneElement(el, undefined, ...inline(kids, w))];
}

type BlockOpts = {
  w: Walk;
  streaming: boolean;
  caret: boolean;
  chips: (refs: string[], key: string, fresh: boolean) => ReactNode;
};

const caretEl = <span key="st-caret" className="st-caret" aria-hidden />;

/** A paragraph or list item: words, then its source chips (once complete), then the caret (when last). */
function textBlock(el: ReactElement<{ children?: ReactNode }>, key: string, open: boolean, last: boolean, o: BlockOpts): ReactElement {
  o.w.refs = [];
  const kids = inline(el.props.children, o.w);
  const tail: ReactNode[] = [];
  if (!open && CHIP_BLOCKS.has(el.type as string) && o.w.refs.length) {
    const fresh = o.w.motion && o.w.clock.fresh(`chips:${key}`, o.w.now);
    tail.push(<Fragment key={`chips:${key}`}>{o.chips(Array.from(new Set(o.w.refs)), key, fresh)}</Fragment>);
  }
  if (last && o.caret) tail.push(caretEl);
  return cloneElement(el, undefined, ...kids, ...tail);
}

function blocks(list: ReactNode[], o: BlockOpts): ReactNode[] {
  const out: ReactNode[] = [];
  list.forEach((b, i) => {
    const last = i === list.length - 1;
    if (!isValidElement(b)) {
      out.push(b);
      return;
    }
    const el = b as ReactElement<{ children?: ReactNode; className?: string }>;
    const key = String(el.key ?? i);
    const type = typeof el.type === "string" ? el.type : null;
    if (type && TEXT_BLOCKS.has(type)) {
      out.push(textBlock(el, key, last && o.streaming, last, o));
      return;
    }
    if (type === "ul" || type === "ol") {
      const items = Children.toArray(el.props.children);
      const next = items.map((li, j) => {
        const lastItem = last && j === items.length - 1;
        return isValidElement(li) && (li as ReactElement).type === "li" ? textBlock(li as ReactElement<{ children?: ReactNode }>, `${key}.${String((li as ReactElement).key ?? j)}`, lastItem && o.streaming, lastItem, o) : li;
      });
      out.push(cloneElement(el, undefined, ...next));
      return;
    }
    // Tables, code and anything else: whole, with a fade the first time they show.
    const fresh = o.w.motion && o.w.clock.fresh(`blk:${key}`, o.w.now);
    if (type) out.push(fresh ? cloneElement(el, { className: cn(el.props.className, "st-block") }) : el);
    else out.push(o.w.words ? <div key={`blk:${key}`} className={fresh ? "st-block" : undefined}>{el}</div> : el);
    if (last && o.caret) out.push(<p key="st-caret-line">{caretEl}</p>);
  });
  return out;
}

/* ------------------------------------------------------------------ chips */

export function SourceChip({ source, fresh = false, title }: { source: StreamingSource; fresh?: boolean; title?: string }) {
  const body = (
    <>
      {source.icon ? <span className="flex h-3 w-3 shrink-0 items-center justify-center text-quiet [&>svg]:h-3 [&>svg]:w-3">{source.icon}</span> : null}
      <span className="font-mono text-[11px] leading-none tracking-[-0.01em]">{source.domain}</span>
    </>
  );
  const cls = cn(
    "ml-1.5 inline-flex h-[20px] translate-y-[-1px] items-center gap-1 whitespace-nowrap rounded-[7px] border border-line/[0.08] bg-line/[0.035] px-1.5 align-middle text-fore-4 shadow-[0_0.5px_0_rgb(var(--f-line)/0.04)] transition-colors duration-150 hover:border-line/[0.14] hover:bg-line/[0.07] hover:text-fore focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/25",
    fresh && "st-pop",
  );
  return source.url ? (
    <a href={source.url} target="_blank" rel="noopener noreferrer nofollow" title={title ?? source.label} className={cls}>
      {body}
    </a>
  ) : (
    <span title={title ?? source.label} className={cls}>
      {body}
    </span>
  );
}

/** Chips for the sources a block cites: one per short name, its title naming every source behind it. */
export function chipsFor(refs: string[], sources: ReadonlyMap<string, StreamingSource>, fresh: boolean): ReactNode {
  const groups = new Map<string, StreamingSource[]>();
  for (const r of refs) {
    const s = sources.get(r);
    if (!s) continue;
    groups.set(s.domain, [...(groups.get(s.domain) ?? []), s]);
  }
  if (!groups.size) return null;
  return Array.from(groups.values()).map((list) => {
    const first = list[0]!;
    const labels = Array.from(new Set(list.map((s) => s.label)));
    const url = list.every((s) => s.url === first.url) ? first.url : undefined;
    return <SourceChip key={first.domain} source={{ ...first, url }} fresh={fresh} title={labels.join("\n")} />;
  });
}

/* ------------------------------------------------------------------ reveal */

export type StreamingRevealProps = {
  text: string;
  streaming: boolean;
  /** Renders text to plain elements whose children are the blocks; `settled`: the text is complete and fully shown. */
  render: (text: string, settled: boolean) => ReactElement;
  /** Show the caret while streaming (the last text part of a reply). */
  caret?: boolean;
  /** The source id a rendered element cites (a citation component), or null. */
  citationOf?: (el: ReactElement) => string | null;
  sources?: ReadonlyMap<string, StreamingSource>;
  reducedMotion?: boolean;
};

const NO_SOURCES: ReadonlyMap<string, StreamingSource> = new Map();

/** Streaming text, word by word, with inline source chips. */
export function StreamingReveal({ text, streaming, render, caret = true, citationOf, sources = NO_SOURCES, reducedMotion }: StreamingRevealProps) {
  const osReduce = usePrefersReducedMotion();
  const still = reducedMotion ?? osReduce;
  const shown = useReveal(text, streaming, still);
  // Mounted while text was still to come: this instance animates.
  const [motion] = useState(streaming);
  const clock = useRef<RevealClock | null>(null);
  if (!clock.current) clock.current = new RevealClock(FADE_MS);
  const settled = !streaming && shown >= text.length;
  const animating = motion && !still && !settled;
  const visible = animating ? text.slice(0, shown) : text;
  const live = streaming && !still;
  if (!visible.trim()) return caret && live ? <span className="st-caret" aria-hidden /> : null;
  const tree = render(visible, settled);
  const w: Walk = { clock: clock.current, now: typeof performance !== "undefined" ? performance.now() : 0, words: animating, motion: motion && !still, n: 0, refs: [], citationOf };
  const out = blocks(Children.toArray(tree.props && (tree.props as { children?: ReactNode }).children), {
    w,
    streaming: streaming || shown < text.length,
    caret: caret && (live || (animating && shown < text.length)),
    chips: (refs, _key, fresh) => chipsFor(refs, sources, fresh),
  });
  return cloneElement(tree, undefined, ...out);
}

/* ------------------------------------------------------------------ footer */

function SourceAvatars({ sources }: { sources: StreamingSource[] }) {
  const seen = new Set<string>();
  const icons = sources.filter((s) => s.icon && !seen.has(s.domain) && seen.add(s.domain)).slice(0, 3);
  return (
    <span className="flex items-center -space-x-1.5" aria-hidden>
      {icons.map((s) => (
        <span key={s.domain} className="flex h-5 w-5 items-center justify-center rounded-full border border-line/[0.1] bg-surface-2 text-quiet ring-2 ring-surface [&>svg]:h-[11px] [&>svg]:w-[11px]">
          {s.icon}
        </span>
      ))}
    </span>
  );
}

export function SourcesButton({ sources, open, onToggle, controls, labels = STREAMING_LABELS_EN }: { sources: StreamingSource[]; open: boolean; onToggle: () => void; controls: string; labels?: StreamingLabels }) {
  return (
    <button
      type="button"
      aria-expanded={open}
      aria-controls={controls}
      onClick={onToggle}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 rounded-full border border-line/[0.08] py-0 pl-1 pr-2.5 text-fs-12.5 font-medium text-fore-4 transition-colors duration-150 hover:bg-line/[0.05] hover:text-fore focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/25",
        open && "bg-line/[0.05] text-fore",
      )}
    >
      <SourceAvatars sources={sources} />
      {labels.sources(sources.length)}
    </button>
  );
}

export function SourcesList({ id, sources, open, labels = STREAMING_LABELS_EN }: { id: string; sources: StreamingSource[]; open: boolean; labels?: StreamingLabels }) {
  return (
    <div id={id} data-open={open} className="st-collapse" aria-hidden={!open}>
      <div>
        <ul aria-label={labels.sourcesList} className="mt-1 flex flex-col overflow-hidden rounded-xl border border-line/[0.08]">
          {sources.map((s, i) => {
            const inner = (
              <>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line/[0.08] bg-surface-2 text-quiet [&>svg]:h-3 [&>svg]:w-3">{s.icon}</span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="min-w-0 truncate text-fs-13 leading-fs-18 text-fore-2">
                    <span className="st-underline">{s.label}</span>
                  </span>
                  {s.detail ? <span className="min-w-0 truncate font-mono text-[11px] leading-[15px] text-faint">{s.detail}</span> : null}
                </span>
                <span className="shrink-0 font-mono text-[11px] text-faint">{s.domain}</span>
              </>
            );
            const cls = cn("st-row flex items-center gap-2.5 px-3 py-2 transition-colors duration-150", i && "border-t border-line/[0.06]", s.url ? "hover:bg-line/[0.035] focus-visible:bg-line/[0.05] focus-visible:outline-none" : "");
            return (
              <li key={s.id}>
                {s.url ? (
                  <a href={s.url} target="_blank" rel="noopener noreferrer nofollow" tabIndex={open ? undefined : -1} className={cls}>
                    {inner}
                  </a>
                ) : (
                  <div className={cls}>{inner}</div>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

export function FollowUps({ items, onPick, animate = false, disabled = false, labels = STREAMING_LABELS_EN }: { items: string[]; onPick: (q: string) => void; animate?: boolean; disabled?: boolean; labels?: StreamingLabels }) {
  const head = useId();
  if (!items.length) return null;
  return (
    <section aria-labelledby={head} className="mt-1 flex flex-col">
      <h3 id={head} className={cn("mb-1 text-fs-12.5 font-medium text-quiet", animate && "st-fade-up")}>
        {labels.followUps}
      </h3>
      <ul className="flex flex-col">
        {items.map((q, i) => (
          <li key={q} className={cn("border-t border-line/[0.07]", animate && "st-fade-up")} style={animate ? { animationDelay: `${(i + 1) * FOLLOW_STAGGER_MS}ms` } : undefined}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => onPick(q)}
              className="group flex w-full items-start gap-2.5 rounded-lg px-1 py-2 text-left text-fs-14 leading-fs-20 text-fore-3 transition-colors duration-150 hover:bg-line/[0.035] hover:text-fore focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-line/25 disabled:pointer-events-none disabled:opacity-50"
            >
              <CornerDownRight width={14} height={14} strokeWidth={1.75} aria-hidden className="mt-[3px] shrink-0 text-faint transition-colors group-hover:text-fore" />
              <span className="min-w-0">{q}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export type StreamingFooterProps = {
  /** The actions (copy, retry, thumbs). */
  actions?: ReactNode;
  /** Shown after the actions ("14:32"). */
  meta?: ReactNode;
  sources?: StreamingSource[];
  followUps?: string[];
  onFollowUp?: (q: string) => void;
  followUpsDisabled?: boolean;
  /** Fade the footer in (the reply just finished here); false for a reloaded reply. */
  animate?: boolean;
  labels?: StreamingLabels;
};

/** The finished reply's footer: actions and the sources button, the sources list, the follow-ups. */
export function StreamingFooter({ actions, meta, sources = [], followUps = [], onFollowUp, followUpsDisabled, animate = false, labels = STREAMING_LABELS_EN }: StreamingFooterProps) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  return (
    <div className="flex flex-col gap-1.5">
      <div className={cn("flex min-h-[28px] flex-wrap items-center gap-x-1 gap-y-1.5", animate && "st-fade")}>
        {actions}
        {meta}
        {sources.length ? (
          <span className="ml-auto">
            <SourcesButton sources={sources} open={open} onToggle={() => setOpen((v) => !v)} controls={listId} labels={labels} />
          </span>
        ) : null}
      </div>
      {sources.length ? <SourcesList id={listId} sources={sources} open={open} labels={labels} /> : null}
      {followUps.length && onFollowUp ? <FollowUps items={followUps} onPick={onFollowUp} animate={animate} disabled={followUpsDisabled} labels={labels} /> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ all in one */

export type StreamingTextProps = Omit<StreamingRevealProps, "sources"> & Omit<StreamingFooterProps, "animate">;

/**
 * One streaming reply: the text, then (once it is done) its footer. For a
 * reply split around other content (tool rows), use StreamingReveal per text
 * part and StreamingFooter once.
 */
export function StreamingText({ actions, meta, sources = [], followUps, onFollowUp, followUpsDisabled, labels, ...reveal }: StreamingTextProps) {
  const [motion] = useState(reveal.streaming);
  const map = new Map(sources.map((s) => [s.id, s]));
  return (
    <div className="flex flex-col gap-3">
      <StreamingReveal {...reveal} sources={map} />
      {reveal.streaming ? null : <StreamingFooter actions={actions} meta={meta} sources={sources} followUps={followUps} onFollowUp={onFollowUp} followUpsDisabled={followUpsDisabled} animate={motion && !reveal.reducedMotion} labels={labels} />}
    </div>
  );
}

export default StreamingText;
