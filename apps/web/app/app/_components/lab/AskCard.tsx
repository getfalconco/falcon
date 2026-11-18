"use client";

import { useEffect, useId, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowUp, Check, CornerDownLeft, MessageSquareText } from "lucide-react";
import { answerText, type AskAnswer, type AskQuestion, type DeskAsk } from "@/lib/desk/ask";
import { EASE_OUT, useCalmMotion } from "./motion";

/**
 * A question Claude asked with `ask_user` (lib/desk/ask.ts), inline in its
 * reply: a short question per chip, 2-4 options (the recommended one first and
 * marked) and "Other" for the viewer's own words. One single-choice question
 * answers on click; several questions or a multi-select one answer with Send.
 * Keys: arrows move within a question, Enter or Space picks, 1-5 picks by
 * number, Ctrl/Cmd+Enter sends. Answered, it folds to a one-line summary; when
 * the viewer wrote a message instead, it says so.
 */

const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/20";

type Pick = { chosen: string[]; otherOn: boolean; other: string };

const empty = (): Pick => ({ chosen: [], otherOn: false, other: "" });

function toAnswer(p: Pick): AskAnswer {
  const other = p.otherOn ? p.other.trim() : "";
  return other ? { choices: p.chosen, other } : { choices: p.chosen };
}

const done = (p: Pick) => p.chosen.length > 0 || (p.otherOn && !!p.other.trim());

export function AskCard({ ask, answerable, onAnswer }: { ask: DeskAsk; answerable: boolean; onAnswer?: (answers: AskAnswer[]) => void }) {
  const still = useCalmMotion();
  const open = !ask.answers && !ask.skipped;
  return (
    <AnimatePresence initial={false} mode="wait">
      {open ? (
        <motion.div
          key="open"
          initial={still ? false : { opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={still ? { opacity: 0, transition: { duration: 0 } } : { opacity: 0, height: 0, transition: { duration: 0.18, ease: EASE_OUT } }}
          transition={{ duration: 0.22, ease: EASE_OUT }}
          className="w-[34rem] max-w-full overflow-hidden"
        >
          <OpenCard ask={ask} answerable={answerable && !!onAnswer} onAnswer={(a) => onAnswer?.(a)} />
        </motion.div>
      ) : (
        <motion.div
          key="done"
          initial={still ? false : { opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          transition={{ duration: 0.22, ease: EASE_OUT }}
          className="w-[34rem] max-w-full overflow-hidden"
        >
          <Summary ask={ask} />
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function Summary({ ask }: { ask: DeskAsk }) {
  if (!ask.answers)
    return (
      <p className="flex min-w-0 items-center gap-2 rounded-xl border border-line/[0.08] bg-line/[0.02] px-3 py-2 text-fs-13 leading-fs-20" title={ask.questions.map((q) => q.question).join("\n")}>
        <MessageSquareText width={13} height={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-faint" />
        <span className="min-w-0 truncate text-quiet">
          {ask.questions.map((q) => q.header).join(", ")}
          <span className="text-faint"> · not picked, you replied in the chat</span>
        </span>
      </p>
    );
  return (
    <ul aria-label="Your answer" className="flex flex-col gap-1 rounded-xl border border-line/[0.08] bg-line/[0.02] px-3 py-2">
      {ask.questions.map((q, i) => {
        const a = ask.answers?.[i];
        return (
          <li key={i} className="flex min-w-0 items-center gap-2 text-fs-13 leading-fs-20" title={q.question}>
            <Check width={13} height={13} strokeWidth={2.25} aria-hidden className="shrink-0 text-up/80" />
            <span className="shrink-0 text-quiet">{q.header}</span>
            <span className="min-w-0 truncate font-medium text-fore-2">{a ? answerText(a) : "No answer"}</span>
          </li>
        );
      })}
    </ul>
  );
}

function OpenCard({ ask, answerable, onAnswer }: { ask: DeskAsk; answerable: boolean; onAnswer: (answers: AskAnswer[]) => void }) {
  const [picks, setPicks] = useState<Pick[]>(() => ask.questions.map(empty));
  const rootRef = useRef<HTMLDivElement>(null);
  // One single-choice question answers on click; anything else waits for Send.
  const instant = ask.questions.length === 1 && !ask.questions[0]!.multiSelect;
  const complete = picks.every(done);

  // A card that arrives while the viewer waits takes the focus (not over a message they are typing).
  useEffect(() => {
    if (!answerable) return;
    const a = document.activeElement;
    if (a && a !== document.body && !(a instanceof HTMLTextAreaElement && !a.value)) return;
    rootRef.current?.querySelector<HTMLElement>('[data-ask-option][tabindex="0"]')?.focus({ preventScroll: true });
    // Only when it first shows.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const send = (next: Pick[] = picks) => {
    if (answerable && next.every(done)) onAnswer(next.map(toAnswer));
  };

  const update = (qi: number, fn: (p: Pick) => Pick) => {
    const next = picks.map((p, i) => (i === qi ? fn(p) : p));
    setPicks(next);
    return next;
  };

  /** Picks option k of question qi (k === options.length is Other). */
  const choose = (qi: number, k: number) => {
    if (!answerable) return;
    const q = ask.questions[qi]!;
    if (k === q.options.length) {
      update(qi, (p) => (q.multiSelect ? { ...p, otherOn: !p.otherOn } : { chosen: [], otherOn: true, other: p.other }));
      // The text field mounts with this render.
      requestAnimationFrame(() => rootRef.current?.querySelector<HTMLInputElement>(`[data-ask-other="${qi}"]`)?.focus());
      return;
    }
    const label = q.options[k]!.label;
    const next = update(qi, (p) =>
      q.multiSelect ? { ...p, chosen: p.chosen.includes(label) ? p.chosen.filter((c) => c !== label) : q.options.map((o) => o.label).filter((l) => l === label || p.chosen.includes(l)) } : { chosen: [label], otherOn: false, other: p.other },
    );
    if (instant) send(next);
    else if (!q.multiSelect && qi + 1 < ask.questions.length) {
      // On to the next question.
      rootRef.current?.querySelector<HTMLElement>(`[data-ask-q="${qi + 1}"] [data-ask-option]`)?.focus();
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!answerable) return;
    const target = e.target as HTMLElement;
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
      return;
    }
    if (target instanceof HTMLInputElement) return;
    const group = target.closest<HTMLElement>("[data-ask-q]");
    const qi = Number(group?.dataset.askQ ?? 0);
    const q = ask.questions[qi];
    if (!q) return;
    const items = Array.from(rootRef.current?.querySelectorAll<HTMLElement>(`[data-ask-q="${qi}"] [data-ask-option]`) ?? []);
    const at = items.indexOf(target);
    const move = (to: number) => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    if (e.key === "ArrowDown" || e.key === "ArrowRight") move(at + 1);
    else if (e.key === "ArrowUp" || e.key === "ArrowLeft") move(at - 1);
    else if (e.key === "Home") move(0);
    else if (e.key === "End") move(items.length - 1);
    else if (/^[1-9]$/.test(e.key) && !e.altKey && !e.metaKey && !e.ctrlKey) {
      const k = Number(e.key) - 1;
      if (k > q.options.length) return;
      e.preventDefault();
      items[k]?.focus();
      choose(qi, k);
    }
  };

  return (
    <div
      ref={rootRef}
      role="group"
      aria-label={answerable ? "Falcon AI asks" : "Falcon AI asked"}
      onKeyDown={onKeyDown}
      className={`flex flex-col rounded-xl border border-line/[0.1] bg-surface-2 shadow-[0_1px_2px_rgba(0,0,0,0.03)] ${answerable ? "" : "opacity-70"}`}
    >
      {ask.questions.map((q, qi) => (
        <Question
          key={qi}
          q={q}
          qi={qi}
          pick={picks[qi]!}
          answerable={answerable}
          divided={qi > 0}
          onChoose={(k) => choose(qi, k)}
          onOther={(text) => update(qi, (p) => ({ ...p, other: text }))}
          onOtherDone={(how) => {
            if (how === "cancel") {
              update(qi, (p) => ({ ...p, otherOn: false }));
              rootRef.current?.querySelector<HTMLElement>(`[data-ask-q="${qi}"] [data-ask-option="other"]`)?.focus();
            } else if (complete) send();
            else rootRef.current?.querySelector<HTMLElement>(`[data-ask-q="${qi + 1}"] [data-ask-option]`)?.focus();
          }}
        />
      ))}
      <div className="flex items-center gap-3 border-t border-line/[0.06] px-3.5 py-2">
        <p className="hidden min-w-0 flex-1 truncate text-fs-11.5 leading-fs-16 text-faint sm:block">
          {answerable ? (instant ? "↑↓ to move · Enter or 1–5 to pick · or type a reply below" : "↑↓ to move · Enter or 1–5 to pick · ⌘/Ctrl+Enter to send") : "Waiting for the reply to finish"}
        </p>
        {!instant || picks[0]!.otherOn ? (
          <button
            type="button"
            disabled={!answerable || !complete}
            onClick={() => send()}
            className={`ml-auto inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-fore px-3 text-fs-12.5 font-medium text-surface transition-opacity hover:opacity-85 disabled:pointer-events-none disabled:opacity-25 ${FOCUS}`}
          >
            Send
            <ArrowUp width={13} height={13} strokeWidth={2} aria-hidden />
          </button>
        ) : null}
      </div>
    </div>
  );
}

function Question({
  q,
  qi,
  pick,
  answerable,
  divided,
  onChoose,
  onOther,
  onOtherDone,
}: {
  q: AskQuestion;
  qi: number;
  pick: Pick;
  answerable: boolean;
  divided: boolean;
  onChoose: (k: number) => void;
  onOther: (text: string) => void;
  onOtherDone: (how: "enter" | "cancel") => void;
}) {
  const still = useCalmMotion();
  const id = useId();
  const role = q.multiSelect ? "checkbox" : "radio";
  const n = q.options.length;
  // Roving focus: the picked option (or the first) is the one Tab reaches.
  const firstPicked = pick.otherOn && !pick.chosen.length ? n : Math.max(0, q.options.findIndex((o) => pick.chosen.includes(o.label)));
  return (
    <div data-ask-q={qi} className={`flex flex-col ${divided ? "border-t border-line/[0.06]" : ""}`}>
      <div className="flex flex-col gap-1.5 px-3.5 pb-1.5 pt-3">
        <div className="flex items-center gap-2">
          <span className="rounded-md bg-line/[0.07] px-1.5 py-px text-fs-11 font-medium uppercase tracking-[0.04em] text-fore-3">{q.header}</span>
          {q.multiSelect ? <span className="text-fs-11.5 text-faint">Pick any</span> : null}
        </div>
        <p id={id} className="text-fs-14 font-medium leading-fs-20 text-fore">
          {q.question}
        </p>
      </div>
      <div role={q.multiSelect ? "group" : "radiogroup"} aria-labelledby={id} className="flex flex-col px-1.5 pb-1.5">
        {q.options.map((o, k) => (
          <Option
            key={o.label}
            role={role}
            index={k}
            label={o.label}
            description={o.description}
            recommended={!!o.recommended}
            checked={pick.chosen.includes(o.label)}
            tabbable={k === firstPicked}
            disabled={!answerable}
            onClick={() => onChoose(k)}
          />
        ))}
        <Option role={role} index={n} label="Other" description="Write your own answer" checked={pick.otherOn} tabbable={firstPicked === n} disabled={!answerable} other onClick={() => onChoose(n)} />
        <AnimatePresence initial={false}>
          {pick.otherOn ? (
            <motion.div
              key="other"
              initial={still ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={still ? { height: 0, opacity: 0, transition: { duration: 0 } } : { height: 0, opacity: 0 }}
              transition={{ duration: 0.2, ease: EASE_OUT }}
              className="overflow-hidden"
            >
              <div className="flex items-center gap-2 px-2 pb-1.5 pl-[38px] pt-0.5">
                <input
                  data-ask-other={qi}
                  value={pick.other}
                  maxLength={500}
                  disabled={!answerable}
                  aria-label={`Your own answer: ${q.question}`}
                  placeholder="Your answer…"
                  onChange={(e) => onOther(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.nativeEvent.isComposing && !e.metaKey && !e.ctrlKey) {
                      e.preventDefault();
                      onOtherDone("enter");
                    } else if (e.key === "Escape") {
                      e.preventDefault();
                      onOtherDone("cancel");
                    }
                  }}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-line/[0.12] bg-surface px-2.5 text-fs-13.5 text-fore outline-none placeholder:text-faint-2 focus:border-line/[0.28]"
                />
                <CornerDownLeft width={13} height={13} strokeWidth={1.75} aria-hidden className="shrink-0 text-faint" />
              </div>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Option({
  role,
  index,
  label,
  description,
  recommended = false,
  checked,
  tabbable,
  disabled,
  other = false,
  onClick,
}: {
  role: "radio" | "checkbox";
  index: number;
  label: string;
  description: string;
  recommended?: boolean;
  checked: boolean;
  tabbable: boolean;
  disabled: boolean;
  other?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      aria-keyshortcuts={String(index + 1)}
      tabIndex={tabbable ? 0 : -1}
      data-ask-option={other ? "other" : index}
      onClick={disabled ? undefined : onClick}
      className={`group flex w-full min-w-0 items-start gap-2.5 rounded-lg px-2 py-[7px] text-left transition-colors ${FOCUS} ${
        checked ? "bg-line/[0.06]" : "hover:bg-line/[0.04]"
      } ${disabled ? "cursor-default" : ""}`}
    >
      <span
        aria-hidden
        className={`mt-[3px] inline-flex h-[18px] w-[18px] shrink-0 items-center justify-center font-mono text-fs-11 tabular-nums transition-colors ${role === "radio" ? "rounded-full" : "rounded-[5px]"} ${
          checked ? "bg-fore text-surface" : "border border-line/[0.16] text-faint group-hover:border-line/[0.3] group-hover:text-fore-3"
        }`}
      >
        {checked ? <Check width={11} height={11} strokeWidth={2.75} /> : index + 1}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
          <span className={`text-fs-13.5 font-medium leading-fs-20 ${other ? "text-fore-3" : "text-fore-2"}`}>{label}</span>
          {recommended ? <span className="rounded-full bg-iris/[0.12] px-1.5 text-fs-11 font-medium leading-fs-17 text-iris">Recommended</span> : null}
        </span>
        {description ? <span className="text-fs-12.5 leading-fs-18 text-quiet">{description}</span> : null}
      </span>
    </button>
  );
}
