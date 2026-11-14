"use client";

import { useState } from "react";
import { STARTERS, type StrategySpecV2 } from "@falcon/backtest";
import type { Answer, Question } from "@falcon/backtest/ai";
import { sendTurn, type Conversation as Conv, type SavedStrategy } from "@/lib/workspace/strategies";
import { Panel, SectionTitle } from "../parts";

const BTN =
  "inline-flex h-7 items-center rounded-md border border-black/10 bg-white px-2.5 text-[12px] text-[#4b4b48] outline-none transition-colors hover:border-black/25 hover:text-[#1d1b1b] focus-visible:border-black/45 disabled:opacity-40";

export type TurnApply = {
  conversation: Conv;
  spec?: StrategySpecV2;
  text?: string;
};

/**
 * Describe a strategy in plain words; the assistant asks up to 3 questions
 * (tap an answer or type one) or compiles the rules. Once there is a spec,
 * the same box edits it by chat, and every edit is a new version.
 */
export function Conversation({
  s,
  onApply,
  onStarter,
}: {
  s: SavedStrategy;
  onApply: (a: TurnApply) => void;
  onStarter: (id: string) => void;
}) {
  const conv = s.conversation;
  const hasSpec = s.origin.kind !== "blank" || s.versions.length > 1 || s.confirmed;
  const [text, setText] = useState("");
  const [typed, setTyped] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);

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

  const submit = () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    if (hasSpec && s.spec) {
      void turn({ ...conv, note: null }, t);
    } else {
      void turn({ intent: t, answers: [], questionsAsked: 0, pending: null, assumptions: [], notExpressible: [], note: null }, null);
    }
  };

  const answerAll = (qs: Question[], picks: Record<string, { a: string; typed: boolean }>) => {
    const answers: Answer[] = [...conv.answers, ...qs.map((q) => ({ q: q.text, a: picks[q.id]?.a ?? q.options[q.defaultIndex] ?? "", typed: picks[q.id]?.typed ?? false }))];
    void turn({ ...conv, answers, pending: null, note: null }, null);
  };

  return (
    <section>
      <SectionTitle>{hasSpec ? "Change by chat" : "Describe a strategy"}</SectionTitle>
      <Panel className="mt-2 px-4 py-3">
        {conv.intent ? (
          <div className="mb-3 flex flex-col gap-1.5 border-b border-black/[0.06] pb-3">
            <p className="text-[13px] leading-[19px] text-[#1d1b1b]">{conv.intent}</p>
            {conv.answers.map((a, i) => (
              <p key={`${a.q}-${i}`} className="text-[12px] leading-[18px] text-[#767676]">
                {a.q} <span className="text-[#1d1b1b]">{a.a}</span>
              </p>
            ))}
          </div>
        ) : null}

        {conv.pending?.length ? (
          <Questions questions={conv.pending} busy={busy} typed={typed} setTyped={setTyped} onDone={(picks) => answerAll(conv.pending!, picks)} />
        ) : (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submit();
            }}
            className="flex items-start gap-2"
          >
            <textarea
              aria-label={hasSpec ? "Describe a change to the rules" : "Describe a strategy in plain English"}
              value={text}
              rows={2}
              maxLength={4000}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submit();
                }
              }}
              placeholder={
                hasSpec
                  ? "For example: use a 150-day average instead, or add a 10% trailing stop"
                  : "For example: hold QQQ when its 2-day RSI is below 10 and it is above its 200-day average, exit after 5 days"
              }
              className="min-h-[44px] flex-1 resize-y rounded-md border border-black/10 bg-white px-3 py-2 text-[13px] leading-[19px] text-[#1d1b1b] outline-none transition-colors placeholder:text-[#b0b0ab] hover:border-black/25 focus:border-black/45"
            />
            <button
              type="submit"
              disabled={busy || !text.trim()}
              className="inline-flex h-[44px] shrink-0 items-center rounded-md border border-black/10 px-3.5 text-[12.5px] text-[#1d1b1b] outline-none transition-colors hover:bg-[#efefec] focus-visible:border-black/40 disabled:opacity-40"
            >
              {busy ? "Reading" : hasSpec ? "Update rules" : "Write rules"}
            </button>
          </form>
        )}
        {busy ? (
          <p role="status" className="mt-2 text-[12px] text-[#767676]">
            Reading the description and checking the formula. This takes a few seconds.
          </p>
        ) : null}
        {conv.note ? (
          <p role="status" className={`mt-2 text-[12px] leading-[18px] ${conv.note.tone === "error" ? "text-[#b3432f]" : "text-[#4b4b48]"}`}>
            {conv.note.text}
          </p>
        ) : null}

        {!hasSpec ? (
          <div className="mt-3 border-t border-black/[0.06] pt-3">
            <span className="text-[12px] text-[#9a9a9a]">Start from</span>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {STARTERS.map((t) => (
                <button key={t.id} type="button" onClick={() => onStarter(t.id)} className={BTN} title={t.text}>
                  {t.spec.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </Panel>
    </section>
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
