"use client";

import { useState } from "react";
import { STARTERS, type StrategySpecV2 } from "@falcon/backtest";
import type { Answer, Question } from "@falcon/backtest/ai";
import { sendTurn, type Conversation as Conv, type SavedStrategy } from "@/lib/workspace/strategies";

const BTN =
  "inline-flex h-7 items-center rounded-md border border-black/10 bg-white px-2.5 text-[12px] text-[#4b4b48] outline-none transition-colors hover:border-black/25 hover:text-[#1d1b1b] focus-visible:border-black/45 disabled:opacity-40";

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

  const turn = async (next: Conv, edit: string | null) => {
    setBusy(true);
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
    if (conv.note || conv.pending) onApply({ conversation: { ...conv, note: null, pending: null } });
  };

  return { busy, hasSpec, edits, send, answerAll, clear, waiting: Boolean(conv.pending?.length), canClear: edits.length > 0 || Boolean(conv.note || conv.pending) };
}

function UserBubble({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex justify-end">
      <p className="max-w-[85%] whitespace-pre-wrap rounded-2xl bg-[#f4f4f2] px-3.5 py-2 text-[14px] leading-[21px] text-[#1d1b1b]">{children}</p>
    </div>
  );
}

export function AssistantLabel({ children = "Falcon" }: { children?: React.ReactNode }) {
  return <span className="text-[12px] font-medium text-[#8a8a85]">{children}</span>;
}

/** The conversation as a thread: the description, questions and answers, change requests, notes. */
export function ConversationThread({ s, chat, onStarter }: { s: SavedStrategy; chat: StrategyChat; onStarter: (id: string) => void }) {
  const conv = s.conversation;
  const [typed, setTyped] = useState<Record<string, string>>({});

  if (!conv.intent && !chat.hasSpec && !chat.busy && !conv.note) {
    return (
      <div className="flex flex-col items-center px-4 py-10 text-center">
        <p className="max-w-[380px] text-[14px] leading-[21px] text-[#767676]">
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
            <p className="text-[14px] leading-[21px] text-[#3d3b3a]">{a.q}</p>
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
          <p role="status" className="text-[13.5px] text-[#767676]">
            Reading the description and checking the formula. This takes a few seconds.
          </p>
        </div>
      ) : null}
      {conv.note ? (
        <div className="flex flex-col gap-1">
          <AssistantLabel />
          <p role="status" className={`text-[13.5px] leading-[20px] ${conv.note.tone === "error" ? "text-[#b3432f]" : "text-[#4b4b48]"}`}>
            {conv.note.text}
          </p>
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
          <legend className="text-[13px] leading-[19px] text-[#1d1b1b]">{q.text}</legend>
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
                  className={`inline-flex min-h-7 items-center rounded-md border px-2.5 py-1 text-left text-[12px] outline-none transition-colors focus-visible:border-black/45 ${
                    on ? "border-black/30 bg-black/[0.05] text-[#1d1b1b]" : "border-black/10 bg-white text-[#4b4b48] hover:border-black/25"
                  }`}
                >
                  {o}
                  {i === q.defaultIndex ? <span className="ml-1.5 text-[11px] text-[#9a9a9a]">default</span> : null}
                </button>
              );
            })}
          </div>
          <input
            aria-label={`Type your own answer to: ${q.text}`}
            value={typed[q.id] ?? ""}
            onChange={(e) => setTyped({ ...typed, [q.id]: e.target.value })}
            placeholder="Or type an answer (tickers, a period, a number)"
            className="h-8 rounded-md border border-black/10 bg-white px-2.5 text-[12.5px] text-[#1d1b1b] outline-none placeholder:text-[#b0b0ab] hover:border-black/25 focus:border-black/45"
          />
        </fieldset>
      ))}
      <div>
        <button
          type="button"
          disabled={busy}
          onClick={() => onDone(finalPicks())}
          className="inline-flex h-8 items-center rounded-lg bg-[#1c1917] px-3.5 text-[12.5px] text-[rgb(231,231,231)] outline-none transition-colors hover:bg-[#0f0d0b] focus-visible:ring-2 focus-visible:ring-black/30 disabled:opacity-40"
        >
          {busy ? "Reading" : "Continue"}
        </button>
      </div>
    </div>
  );
}
