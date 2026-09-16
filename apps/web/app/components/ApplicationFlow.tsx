"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import {
  APPLICATION_QUESTIONS,
  type ApplicationAnswers,
} from "@/lib/application-questions";
import { WAITLIST_TICKET_WIDTH } from "./WaitlistTicket";
import WaitlistStatusCard from "./WaitlistStatusCard";

const GEIST = "var(--font-geist-sans), sans-serif";
const MONO = "var(--font-geist-mono), monospace";
const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const EASE_SOFT = [0.4, 0, 0.2, 1] as const;
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

export type ApplicationCredentials = {
  fullName: string;
  email: string;
  phone: string;
  password: string;
};

/**
 * The early-access questionnaire: one question per screen, sliding upward as
 * the applicant moves through it. Submitting creates the waitlist entry — this
 * is the point where the account (and its verification email) exists.
 */
export default function ApplicationFlow({
  credentials,
  onClose,
}: {
  credentials: ApplicationCredentials;
  onClose: () => void;
}) {
  const [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState<ApplicationAnswers>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [memberNumber, setMemberNumber] = useState<number | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // The ticket is a fixed-width canvas, so shrink it on narrow phones.
  const [ticketWidth, setTicketWidth] = useState(WAITLIST_TICKET_WIDTH);
  useEffect(() => {
    const fit = () =>
      setTicketWidth(Math.min(WAITLIST_TICKET_WIDTH, window.innerWidth - 56));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  const question = APPLICATION_QUESTIONS[index];
  const total = APPLICATION_QUESTIONS.length;
  const last = index === total - 1;
  const value = answers[question.id] ?? "";
  const otherKey = `${question.id}Other` as const;
  const needsOther =
    question.kind === "choice" &&
    question.revealsTextOn !== undefined &&
    value === question.revealsTextOn;
  const answered =
    question.kind === "text"
      ? value.trim().length >= 3
      : value !== "" && (!needsOther || (answers[otherKey] ?? "").trim().length >= 2);

  const set = (patch: ApplicationAnswers) =>
    setAnswers((prev) => ({ ...prev, ...patch }));

  useEffect(() => {
    if (question.kind === "text") textRef.current?.focus();
  }, [index, question.kind]);

  // The rule under a text answer sits right beneath what's been written, so a
  // one-line answer doesn't leave three lines of empty paper under it.
  useEffect(() => {
    const el = textRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [index, value]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: credentials.fullName,
          email: credentials.email,
          password: credentials.password,
          phone: credentials.phone,
          application: { ...answers, submittedAt: new Date().toISOString() },
        }),
      });
      const data = (await res.json()) as {
        ok?: boolean;
        error?: string;
        memberNumber?: number | null;
      };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Something went wrong. Please try again.");
      }
      setMemberNumber(data.memberNumber ?? null);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [answers, credentials]);

  const advance = useCallback(() => {
    if (!answered || submitting) return;
    if (last) void submit();
    else setIndex((i) => i + 1);
  }, [answered, last, submit, submitting]);

  // Enter moves on — except in the textarea, where it types a newline.
  useEffect(() => {
    if (done) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter") return;
      const inTextarea = (e.target as HTMLElement)?.tagName === "TEXTAREA";
      if (inTextarea && !e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      advance();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [advance, done]);

  return (
    <motion.div
      className="fixed inset-0 z-[60] overflow-y-auto bg-[#fdfdfd]"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.35, ease: EASE_SOFT }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="fixed left-8 top-8 z-10 flex h-9 w-9 items-center justify-center rounded-full text-[#8a8a8a] transition-colors hover:bg-black/[0.05] hover:text-[#1d1b1b]"
      >
        <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
      </button>

      <div className="mx-auto flex min-h-full w-full max-w-[680px] flex-col justify-center px-6 py-20">
        {done ? (
          <WaitlistStatusCard
            fullName={credentials.fullName}
            memberNumber={memberNumber}
            grantedAt={new Date().toISOString()}
            width={ticketWidth}
          >
            <button
              type="button"
              onClick={onClose}
              className="mx-auto mt-10 flex h-[45px] w-[220px] items-center justify-center rounded-lg bg-[#1c1917] text-[13px] text-[rgb(231,231,231)] transition-colors hover:bg-[#0f0d0b]"
              style={{ fontFamily: GEIST }}
            >
              Done
            </button>
          </WaitlistStatusCard>
        ) : (
          <>
            {/* Progress: a hairline that fills as the questions go by. */}
            <div className="mb-12">
              <div className="h-px w-full bg-black/10">
                <motion.div
                  className="h-px bg-[#1d1b1b]"
                  animate={{ width: `${((index + 1) / total) * 100}%` }}
                  transition={{ duration: 0.5, ease: EASE_SOFT }}
                />
              </div>
              <p
                className="mt-3 text-[11px] uppercase tracking-[0.2em] text-[#1d1b1b]/35"
                style={{ fontFamily: MONO }}
              >
                {index + 1} of {total}
              </p>
            </div>

            <AnimatePresence mode="wait">
              <motion.div
                key={question.id}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -24 }}
                transition={{ duration: 0.4, ease: EASE_SOFT }}
              >
                <h2
                  className="text-[30px] leading-[38px]"
                  style={{
                    fontFamily: SERIF,
                    fontWeight: 400,
                    color: "rgb(29, 27, 27)",
                  }}
                >
                  {question.prompt}
                </h2>

                {question.kind === "choice" ? (
                  <div className="mt-8 space-y-2.5">
                    {question.options.map((option) => {
                      const active = value === option.value;
                      return (
                        <button
                          key={option.value}
                          type="button"
                          onClick={() => set({ [question.id]: option.value })}
                          className={`block w-full rounded-xl border px-5 py-3.5 text-left text-[15px] transition-colors ${
                            active
                              ? "border-black/70 bg-black/[0.035] text-[#1d1b1b]"
                              : "border-black/[0.12] text-[#4b4b48] hover:border-black/30"
                          }`}
                          style={{ fontFamily: GEIST }}
                        >
                          {option.label}
                        </button>
                      );
                    })}

                    {needsOther ? (
                      <motion.input
                        type="text"
                        autoFocus
                        placeholder="Tell us in a few words"
                        value={answers[otherKey] ?? ""}
                        onChange={(e) => set({ [otherKey]: e.target.value })}
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        transition={{ duration: 0.3, ease: EASE_SOFT }}
                        className="mt-4 w-full border-0 border-b border-black/20 bg-transparent pb-2 text-[16px] text-[#1d1b1b] outline-none transition-colors placeholder:text-[#a3a39f] focus:border-black/60"
                        style={{ fontFamily: GEIST }}
                      />
                    ) : null}
                  </div>
                ) : (
                  <textarea
                    ref={textRef}
                    rows={1}
                    placeholder={question.placeholder}
                    value={value}
                    onChange={(e) => set({ [question.id]: e.target.value })}
                    className="mt-8 w-full resize-none overflow-hidden border-0 border-b border-black/20 bg-transparent pb-2 text-[16px] leading-[28px] text-[#1d1b1b] outline-none transition-colors placeholder:text-[#a3a39f] focus:border-black/60"
                    style={{ fontFamily: GEIST }}
                  />
                )}
              </motion.div>
            </AnimatePresence>

            {error ? (
              <p
                className="mt-6 text-[13px] leading-[20px] text-[#b3453f]"
                style={{ fontFamily: GEIST }}
              >
                {error}
              </p>
            ) : null}

            <div className="mt-10 flex flex-col items-start gap-4">
              <button
                type="button"
                disabled={!answered || submitting}
                onClick={advance}
                className={`flex h-[45px] w-[260px] items-center justify-center rounded-lg text-[13px] transition-colors ${
                  answered && !submitting
                    ? "bg-[#1c1917] text-[rgb(231,231,231)] hover:bg-[#0f0d0b]"
                    : "cursor-not-allowed bg-[#eceae7] text-[#9a9a9a]"
                }`}
                style={{ fontFamily: GEIST }}
              >
                {submitting
                  ? "Submitting…"
                  : last
                    ? "Submit application"
                    : "Continue"}
              </button>

              <button
                type="button"
                onClick={() => setIndex((i) => Math.max(0, i - 1))}
                aria-hidden={index === 0}
                tabIndex={index === 0 ? -1 : 0}
                className={`text-xs uppercase tracking-[0.18em] text-[#9a9a9a] transition-opacity hover:text-[#1d1b1b] ${
                  index === 0 ? "pointer-events-none opacity-0" : "opacity-100"
                }`}
                style={{ fontFamily: MONO }}
              >
                &larr; Back
              </button>
            </div>
          </>
        )}
      </div>
    </motion.div>
  );
}
