"use client";

import { useState } from "react";
import { STARTERS, type StrategySpecV2 } from "@falcon/backtest";
import type { Answer, Question } from "@falcon/backtest/ai";
import { retryableTurn, sendTurn, type Conversation as Conv, type SavedStrategy } from "@/lib/workspace/strategies";

const BTN =
  "inline-flex h-7 items-center rounded-md border border-line/10 bg-surface px-2.5 text-fs-12 text-fore-4 outline-none transition-colors hover:border-line/25 hover:text-fore focus-visible:border-line/45 disabled:opacity-40";

export type TurnApply = {
  conversation: Conv;
  spec?: StrategySpecV2;
  text?: string;
};

export type StrategyChat = ReturnType<typeof useStrategyChat>;

/**
 * Describe a strategy in plain words; the assistant asks up to 3 questions
 * (tap an answer or type one) or compiles the rules. Once there is a spec,
 * the same box edits it by chat, and every edit is a new version. The
 * composer at the bottom of Strategy Lab sends through `send`.
 */
export function useStrategyChat(s: SavedStrategy, onApply: (a: TurnApply) => void) {
  const conv = s.conversation;
  const hasSpec = s.origin.kind !== "blank" || s.versions.length > 1 || s.confirmed;
  const [busy, setBusy] = useState(false);
  /** Change requests sent in this visit; the saved conversation keeps only the description and answers. */
  const [edits, setEdits] = useState<string[]>([]);
  /** The last turn when it failed in a way worth sending again (a slow or busy assistant). */
  const [failed, setFailed] = useState<{ next: Conv; edit: string | null } | null>(null);

  const turn = async (next: Conv, edit: string | null) => {
    setBusy(true);
    setFailed(null);
    const r = await sendTurn({
      intent: next.intent,
      answers: next.answers,
      questionsAsked: next.questionsAsked,
      edit: edit ? { request: edit, current: s.spec } : null,
    });
    setBusy(false);
    if (r.kind === "questions") {
      onApply({ conversation: { ...next, pending: r.questions, questionsAsked: next.questionsAsked + r.questions.length, assumptions: r.assumptions, note: null } });
    } else if (r.kind === "spec") {
      onApply({
        conversation: { ...next, pending: null, assumptions: r.assumptions, notExpressible: r.notExpressible, note: null },
        spec: r.spec,
        text: next.intent,
      });
    } else if (r.kind === "not_a_strategy") {
      onApply({ conversation: { ...next, pending: null, note: { tone: "quiet", text: r.message }, notExpressible: r.notExpressible } });
    } else {
      const issues = r.issues?.length ? ` ${r.issues.slice(0, 2).map((i) => i.message).join(" ")}` : "";
      if (retryableTurn(r.reason)) setFailed({ next, edit });
      onApply({ conversation: { ...next, pending: next.pending, note: { tone: "error", text: `${r.message}${issues}` } } });
    }
  };

  /** Sends a description or a change request; false when nothing was sent. */
  const send = (raw: string): boolean => {
    const t = raw.trim();
    if (!t || busy || conv.pending?.length) return false;
    if (hasSpec && s.spec) {
      setEdits((e) => [...e, t]);
      void turn({ ...conv, note: null }, t);
    } else {
      void turn({ intent: t, answers: [], questionsAsked: 0, pending: null, assumptions: [], notExpressible: [], note: null }, null);
    }
    return true;
  };

  const answerAll = (qs: Question[], picks: Record<string, { a: string; typed: boolean }>) => {
    const answers: Answer[] = [...conv.answers, ...qs.map((q) => ({ q: q.text, a: picks[q.id]?.a ?? q.options[q.defaultIndex] ?? "", typed: picks[q.id]?.typed ?? false }))];
    void turn({ ...conv, answers, pending: null, note: null }, null);
  };

  /** Clears this visit's change requests, the last note and open questions; the description and rules stay. */
  const clear = () => {
    setEdits([]);
    setFailed(null);
    if (conv.note || conv.pending) onApply({ conversation: { ...conv, note: null, pending: null } });
  };

  /** Sends the failed turn again, unchanged; null when there is nothing to retry. */
  const retry = failed && !busy ? () => void turn(failed.next, failed.edit) : null;

  return { busy, hasSpec, edits, send, answerAll, clear, retry, waiting: Boolean(conv.pending?.length), canClear: edits.length > 0 || Boolean(conv.note || conv.pending) };
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-well px-3.5 py-2 text-fs-14 leading-fs-21 text-fore">{children}</p>
    </div>
  );
}

export function AssistantLabel({ children = "Falcon" }: { children?: React.ReactNode }) {
  return <span className="text-fs-12 font-medium text-quiet-2">{children}</span>;
}

/** The conversation as a thread: the description, questions and answers, change requests, notes. */
export function ConversationThread({ s, chat, onStarter }: { s: SavedStrategy; chat: StrategyChat; onStarter: (id: string) => void }) {
  const conv = s.conversation;
  const [typed, setTyped] = useState<Record<string, string>>({});

  if (!conv.intent && !chat.hasSpec && !chat.busy && !conv.note) {
    return (
      <div className="flex flex-col items-center px-4 py-10 text-center">
        <p className="max-w-[380px] text-fs-14 leading-fs-21 text-quiet">
          Describe a strategy in the box below, or start from an example. Falcon writes the rules back in numbered steps; nothing runs until you confirm them.
        </p>
        <div className="mt-4 flex max-w-[460px] flex-wrap justify-center gap-1.5">
          {STARTERS.map((t) => (
            <button key={t.id} type="button" onClick={() => onStarter(t.id)} className={BTN} title={t.text}>
              {t.spec.name}
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {conv.intent ? <UserBubble>{conv.intent}</UserBubble> : null}
      {conv.answers.map((a, i) => (
        <div key={`${a.q}-${i}`} className="flex flex-col gap-2">
          <div className="flex flex-col gap-1">
            <AssistantLabel />
            <p className="text-fs-14 leading-fs-21 text-fore-3">{a.q}</p>
          </div>
          <UserBubble>{a.a}</UserBubble>
        </div>
      ))}
      {chat.edits.map((e, i) => (
        <UserBubble key={`${e}-${i}`}>{e}</UserBubble>
      ))}
      {conv.pending?.length ? (
        <div className="flex flex-col gap-2">
          <AssistantLabel />
          <Questions questions={conv.pending} busy={chat.busy} typed={typed} setTyped={setTyped} onDone={(picks) => chat.answerAll(conv.pending!, picks)} />
        </div>
      ) : null}
      {chat.busy ? (
        <div className="flex flex-col gap-1">
          <AssistantLabel />
          <p role="status" className="text-fs-13.5 text-quiet">
            Reading the description and checking the formula. This usually takes 5 to 20 seconds.
          </p>
        </div>
      ) : null}
      {conv.note ? (
        <div className="flex flex-col gap-1">
          <AssistantLabel />
          <p role="status" className={`text-fs-13.5 leading-fs-20 ${conv.note.tone === "error" ? "text-down" : "text-fore-4"}`}>
            {conv.note.text}
          </p>
          {conv.note.tone === "error" && chat.retry ? (
            <div>
              <button type="button" onClick={chat.retry} className={BTN}>
                Try again
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Questions({
  questions,
  busy,
  typed,
  setTyped,
  onDone,
}: {
  questions: Question[];
  busy: boolean;
  typed: Record<string, string>;
  setTyped: (t: Record<string, string>) => void;
  onDone: (picks: Record<string, { a: string; typed: boolean }>) => void;
}) {
  const [picks, setPicks] = useState<Record<string, number>>(() => Object.fromEntries(questions.map((q) => [q.id, q.defaultIndex])));
  const finalPicks = () =>
    Object.fromEntries(
      questions.map((q) => {
        const t = typed[q.id]?.trim();
        return [q.id, t ? { a: t, typed: true } : { a: q.options[picks[q.id] ?? q.defaultIndex] ?? "", typed: false }];
      }),
    );
  return (
    <div className="flex flex-col gap-4">
      {questions.map((q) => (
        <fieldset key={q.id} className="flex flex-col gap-1.5">
          <legend className="text-fs-13 leading-fs-19 text-fore">{q.text}</legend>
          <div className="mt-1 flex flex-wrap gap-1.5" role="radiogroup">
            {q.options.map((o, i) => {
              const on = !typed[q.id]?.trim() && (picks[q.id] ?? q.defaultIndex) === i;
              return (
                <button
                  key={o}
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => {
                    setPicks({ ...picks, [q.id]: i });
                    setTyped({ ...typed, [q.id]: "" });
                  }}
                  className={`inline-flex min-h-7 items-center rounded-md border px-2.5 py-1 text-left text-fs-12 outline-none transition-colors focus-visible:border-line/45 ${
                    on ? "border-line/30 bg-line/[0.05] text-fore" : "border-line/10 bg-surface text-fore-4 hover:border-line/25"
                  }`}
                >
                  {o}
                  {i === q.defaultIndex ? <span className="ml-1.5 text-fs-11 text-faint">default</span> : null}
                </button>
              );
            })}
          </div>
          <input
            aria-label={`Type your own answer to: ${q.text}`}
            value={typed[q.id] ?? ""}
            onChange={(e) => setTyped({ ...typed, [q.id]: e.target.value })}
            placeholder="Or type an answer (tickers, a period, a number)"
            className="h-8 rounded-md border border-line/10 bg-surface px-2.5 text-fs-12.5 text-fore outline-none placeholder:text-faint-2 hover:border-line/25 focus:border-line/45"
          />
        </fieldset>
      ))}
      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDone(finalPicks())}
          className="inline-flex h-8 items-center rounded-lg bg-solid px-3.5 text-fs-12.5 text-solid-ink outline-none transition-colors hover:bg-solid-hover focus-visible:ring-2 focus-visible:ring-line/30 disabled:opacity-40"
        >
          {busy ? "Reading" : "Continue"}
        </button>
      </div>
    </div>
  );
}
