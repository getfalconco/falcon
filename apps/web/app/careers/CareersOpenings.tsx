"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Briefcase, Clock, FileText, MapPin, X } from "lucide-react";
import AdmitOneTicket from "../components/ui/admit-one-ticket";
import GetStartedButton from "../components/GetStartedButton";
import { TIERS } from "../components/TierTickets";

const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const GEIST = "var(--font-geist-sans), sans-serif";
const MONO = "var(--font-geist-mono), monospace";
const EASE_SOFT = [0.4, 0, 0.2, 1] as const;

const STAFF = TIERS.find((t) => t.key === "staff")!;

const INPUT_CLASS =
  "mt-2 w-full border-0 border-b border-black/20 bg-transparent pb-2 text-[16px] text-[#1d1b1b] outline-none transition-colors placeholder:text-[#a3a39f] focus:border-black/60";
const LABEL_CLASS = "block text-[13px] leading-[18px] text-[#1d1b1b]";

const INTRO_MAX_WORDS = 500;
const CV_MAX_BYTES = 4 * 1024 * 1024;
const CV_ACCEPT = ".pdf,.doc,.docx";

const SOURCE_OPTIONS = [
  "LinkedIn",
  "X / Twitter",
  "Friend or colleague",
  "A Falcon team member referred me",
  "Other",
];

export type Opening = {
  title: string;
  /** Short blurb for the list row. */
  description: string;
  /** The full job description shown on the stage, one entry per paragraph. */
  details: string[];
};

type Step = "role" | "form" | "details" | "source" | "done";

function wordCount(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

/**
 * The openings list plus the role stage an Apply click opens into — the same
 * frosted focus stage as the early-access ticket, with the Staff ticket on
 * top. Apply walks through the account-style form, a "how did you find this
 * job" screen, and lands on the existing application pipeline.
 */
export default function CareersOpenings({
  openings,
  tags,
}: {
  openings: Opening[];
  tags: string[];
}) {
  const [selected, setSelected] = useState<Opening | null>(null);
  const [step, setStep] = useState<Step>("role");

  // Form state.
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [linkedin, setLinkedin] = useState("");
  const [intro, setIntro] = useState("");
  const [cvFile, setCvFile] = useState<File | null>(null);
  const [cvError, setCvError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [source, setSource] = useState("");
  const [referral, setReferral] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // The ticket is a fixed-width canvas, so clamp it on narrow phones.
  const [ticketWidth, setTicketWidth] = useState(460);
  useEffect(() => {
    const fit = () => setTicketWidth(Math.min(460, window.innerWidth - 48));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // The stage covers the page, so the list behind it shouldn't scroll.
  useEffect(() => {
    if (!selected) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [selected]);

  const close = useCallback(() => {
    setSelected(null);
    setStep("role");
    setFullName("");
    setEmail("");
    setLinkedin("");
    setIntro("");
    setCvFile(null);
    setCvError(null);
    setSource("");
    setReferral("");
    setError(null);
  }, []);

  const introWords = wordCount(intro);
  const nameValid = fullName.trim().length >= 2;
  const emailValid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
  const introValid = intro.trim().length > 0 && introWords <= INTRO_MAX_WORDS;
  const contactValid = nameValid && emailValid;

  const takeFile = (file: File | undefined | null) => {
    setCvError(null);
    if (!file) return;
    const name = file.name.toLowerCase();
    if (![".pdf", ".doc", ".docx"].some((ext) => name.endsWith(ext))) {
      setCvError("PDF or Word documents only.");
      return;
    }
    if (file.size > CV_MAX_BYTES) {
      setCvError("That file is over 4MB.");
      return;
    }
    setCvFile(file);
  };

  const submit = useCallback(async () => {
    if (!selected || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const body = new FormData();
      body.set("role", selected.title);
      body.set("fullName", fullName.trim());
      body.set("email", email.trim());
      body.set("linkedin", linkedin.trim());
      body.set("introduction", intro.trim());
      body.set("source", source);
      body.set("referral", referral.trim());
      if (cvFile) body.set("cv", cvFile);
      const res = await fetch("/api/careers/apply", { method: "POST", body });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        throw new Error(data.error ?? "Something went wrong. Please try again.");
      }
      setStep("done");
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Something went wrong. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }, [selected, submitting, fullName, email, linkedin, intro, source, referral, cvFile]);

  return (
    <>
      {/* Openings: rows between dashed rules, same language as the FAQ. */}
      <ul className="mt-16 border-t border-dashed border-black/[0.14]">
        {openings.map((job) => (
          <li
            key={job.title}
            className="flex flex-col gap-6 border-b border-dashed border-black/[0.14] py-8 sm:flex-row sm:items-center sm:justify-between sm:gap-10"
          >
            <div className="max-w-2xl">
              <h2
                className="text-[18px] leading-[26px] text-[#1d1b1b]"
                style={{ fontFamily: GEIST, fontWeight: 500 }}
              >
                {job.title}
              </h2>
              <p
                className="mt-2 text-[15px] leading-[23px]"
                style={{ fontFamily: GEIST, color: "rgb(120, 120, 120)" }}
              >
                {job.description}
              </p>
              <div className="mt-4 flex gap-2">
                {tags.map((tag) => (
                  <span
                    key={tag}
                    className="rounded-full border border-black/[0.12] px-2.5 py-1 text-[11px] uppercase tracking-[0.08em] text-[#9a9a9a]"
                    style={{ fontFamily: MONO }}
                  >
                    {tag}
                  </span>
                ))}
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSelected(job)}
              className="inline-flex h-[40px] shrink-0 items-center justify-center rounded-lg bg-[#1c1917] px-6 text-[13px] text-[rgb(231,231,231)] transition-colors hover:bg-[#0f0d0b]"
              style={{ fontFamily: GEIST }}
            >
              Apply
            </button>
          </li>
        ))}
      </ul>

      {/* Role stage: a direct copy of the early-access focus stage. */}
      <AnimatePresence>
        {selected ? (
          <motion.div key="stage" className="fixed inset-0 z-50 overflow-y-auto">
            {/* Frosted wash on its own layer, like the tier stage. */}
            <motion.div
              className="absolute inset-0 bg-[#fdfdfd]/50 backdrop-blur-xl backdrop-saturate-150"
              aria-hidden
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: EASE_SOFT }}
            />

            <motion.button
              type="button"
              onClick={close}
              aria-label="Close"
              className="fixed left-8 top-8 z-10 flex h-9 w-9 items-center justify-center rounded-full text-[#8a8a8a] transition-colors hover:bg-black/[0.05] hover:text-[#1d1b1b]"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0, transition: { duration: 0.2 } }}
              transition={{ delay: 0.4, duration: 0.3, ease: EASE_SOFT }}
            >
              <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
            </motion.button>

            <div className="relative flex min-h-full flex-col items-center justify-center px-6 py-12">
              <motion.div
                className="relative"
                style={{ filter: "drop-shadow(0 12px 30px rgba(8, 12, 18, 0.3))" }}
                initial={{ opacity: 0, y: 22, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, transition: { duration: 0.2 } }}
                transition={{ duration: 0.45, ease: EASE_SOFT }}
              >
                <AdmitOneTicket
                  tilt={{}}
                  name={STAFF.name}
                  presenter="John Doe"
                  event=""
                  venue="Member #001"
                  dates="Granted Aug 2026"
                  stubText="Admit one"
                  watermark="2026"
                  width={ticketWidth}
                  texture={STAFF.texture}
                  layout={STAFF.layout}
                />
              </motion.div>

              <motion.div
                className="-ml-10 mt-3 w-full max-w-[680px] pl-10 pt-6 text-left"
                initial={{ opacity: 0, y: 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, transition: { duration: 0.2 } }}
                transition={{ delay: 0.38, duration: 0.45, ease: EASE_SOFT }}
              >
                <AnimatePresence mode="wait">
                  {step === "role" ? (
                    <motion.div
                      key="role"
                      initial={{ opacity: 0, y: 24 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -24 }}
                      transition={{ duration: 0.4, ease: EASE_SOFT }}
                    >
                      <h2
                        className="relative text-[30px] leading-[36px]"
                        style={{ fontFamily: SERIF, fontWeight: 400, color: "rgb(29, 27, 27)" }}
                      >
                        <span
                          aria-hidden
                          className="pointer-events-none absolute -left-10 select-none"
                          style={{ top: "-0.18em", fontSize: "2.4em", lineHeight: 1 }}
                        >
                          &ldquo;
                        </span>
                        {selected.title}
                      </h2>
                      <div className="mt-6 space-y-5">
                        {selected.details.map((text) => (
                          <p
                            key={text.slice(0, 28)}
                            className="text-[15px] leading-[26px] text-[#4b4b48]"
                            style={{ fontFamily: GEIST }}
                          >
                            {text}
                          </p>
                        ))}
                      </div>
                      <div className="mt-14 flex justify-center">
                        <GetStartedButton
                          label="Apply"
                          onClick={() => setStep("form")}
                          className="h-[45px] w-[260px] pl-4 pr-3.5"
                        />
                      </div>
                    </motion.div>
                  ) : step === "form" ? (
                    <motion.div
                      key="form"
                      initial={{ opacity: 0, y: 24 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -24 }}
                      transition={{ duration: 0.4, ease: EASE_SOFT }}
                    >
                      <h2
                        className="text-[26px] leading-[32px]"
                        style={{ fontFamily: SERIF, fontWeight: 400, color: "rgb(29, 27, 27)" }}
                      >
                        Apply for this role
                      </h2>
                      {/* Role meta line, like a job board listing. */}
                      <div
                        className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[#767676]"
                        style={{ fontFamily: GEIST }}
                      >
                        <span className="flex items-center gap-1.5">
                          <Briefcase className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                          {selected.title}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                          Remote
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                          7 days ago
                        </span>
                      </div>

                      <div className="mt-8 space-y-5">
                        <label className="block">
                          <span className={LABEL_CLASS} style={{ fontFamily: GEIST }}>
                            Full name
                          </span>
                          <input
                            type="text"
                            autoComplete="name"
                            placeholder="Jane Doe"
                            value={fullName}
                            onChange={(e) => setFullName(e.target.value)}
                            className={INPUT_CLASS}
                            style={{ fontFamily: GEIST }}
                          />
                        </label>

                        <label className="block">
                          <span className={LABEL_CLASS} style={{ fontFamily: GEIST }}>
                            Email
                          </span>
                          <input
                            type="email"
                            autoComplete="email"
                            placeholder="jane@example.com"
                            value={email}
                            onChange={(e) => setEmail(e.target.value)}
                            className={INPUT_CLASS}
                            style={{ fontFamily: GEIST }}
                          />
                        </label>

                        <label className="block">
                          <span className={LABEL_CLASS} style={{ fontFamily: GEIST }}>
                            LinkedIn
                          </span>
                          <input
                            type="url"
                            placeholder="linkedin.com/in/janedoe"
                            value={linkedin}
                            onChange={(e) => setLinkedin(e.target.value)}
                            className={INPUT_CLASS}
                            style={{ fontFamily: GEIST }}
                          />
                        </label>

                      </div>

                      <div className="mt-10 flex flex-col items-center gap-4">
                        <button
                          type="button"
                          disabled={!contactValid}
                          onClick={() => setStep("details")}
                          className={`flex h-[45px] w-[260px] items-center justify-center rounded-lg text-[13px] transition-colors ${
                            contactValid
                              ? "bg-[#1c1917] text-[rgb(231,231,231)] hover:bg-[#0f0d0b]"
                              : "cursor-not-allowed bg-[#eceae7] text-[#9a9a9a]"
                          }`}
                          style={{ fontFamily: GEIST }}
                        >
                          Continue
                        </button>
                        <button
                          type="button"
                          onClick={() => setStep("role")}
                          className="text-xs uppercase tracking-[0.18em] text-[#9a9a9a] transition-colors hover:text-[#1d1b1b]"
                          style={{ fontFamily: MONO }}
                        >
                          Back
                        </button>
                      </div>
                    </motion.div>
                  ) : step === "details" ? (
                    <motion.div
                      key="details"
                      initial={{ opacity: 0, y: 24 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -24 }}
                      transition={{ duration: 0.4, ease: EASE_SOFT }}
                    >
                      <h2
                        className="text-[26px] leading-[32px]"
                        style={{ fontFamily: SERIF, fontWeight: 400, color: "rgb(29, 27, 27)" }}
                      >
                        Apply for this role
                      </h2>
                      <div
                        className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[13px] text-[#767676]"
                        style={{ fontFamily: GEIST }}
                      >
                        <span className="flex items-center gap-1.5">
                          <Briefcase className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                          {selected.title}
                        </span>
                        <span className="flex items-center gap-1.5">
                          <MapPin className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                          Remote
                        </span>
                        <span className="flex items-center gap-1.5">
                          <Clock className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden />
                          7 days ago
                        </span>
                      </div>

                      <div className="mt-8 space-y-5">
                        <label className="block">
                          <span className="flex items-baseline justify-between">
                            <span className={LABEL_CLASS} style={{ fontFamily: GEIST }}>
                              Introduction
                            </span>
                            <span
                              className={`text-[11px] ${
                                introWords > INTRO_MAX_WORDS ? "text-[#b3402e]" : "text-[#9a9a9a]"
                              }`}
                              style={{ fontFamily: MONO }}
                            >
                              {introWords} / {INTRO_MAX_WORDS} words
                            </span>
                          </span>
                          <textarea
                            rows={4}
                            placeholder="Tell us who you are and why this role."
                            value={intro}
                            onChange={(e) => setIntro(e.target.value)}
                            className={`${INPUT_CLASS} resize-none leading-[26px]`}
                            style={{ fontFamily: GEIST }}
                          />
                        </label>

                        {/* CV drop zone. */}
                        <div>
                          <span className={LABEL_CLASS} style={{ fontFamily: GEIST }}>
                            CV or Resume
                          </span>
                          <button
                            type="button"
                            onClick={() => fileInputRef.current?.click()}
                            onDragOver={(e) => {
                              e.preventDefault();
                              setDragOver(true);
                            }}
                            onDragLeave={() => setDragOver(false)}
                            onDrop={(e) => {
                              e.preventDefault();
                              setDragOver(false);
                              takeFile(e.dataTransfer.files?.[0]);
                            }}
                            className={`mt-2 flex w-full flex-col items-center justify-center rounded-xl border border-dashed px-6 py-8 text-center transition-colors ${
                              dragOver
                                ? "border-black/60 bg-black/[0.03]"
                                : "border-black/20 hover:border-black/40"
                            }`}
                          >
                            {cvFile ? (
                              <span
                                className="flex items-center gap-2 text-[14px] text-[#1d1b1b]"
                                style={{ fontFamily: GEIST }}
                              >
                                <FileText className="h-4 w-4" strokeWidth={1.75} aria-hidden />
                                {cvFile.name}
                                <span className="text-[#9a9a9a]">
                                  ({(cvFile.size / (1024 * 1024)).toFixed(1)}MB)
                                </span>
                              </span>
                            ) : (
                              <>
                                <span
                                  className="text-[14px] text-[#4b4b48]"
                                  style={{ fontFamily: GEIST }}
                                >
                                  Drag and drop a CV or resume
                                </span>
                                <span
                                  className="mt-1 text-[12px] text-[#9a9a9a]"
                                  style={{ fontFamily: GEIST }}
                                >
                                  PDF or Word, 4MB max
                                </span>
                              </>
                            )}
                          </button>
                          <input
                            ref={fileInputRef}
                            type="file"
                            accept={CV_ACCEPT}
                            className="hidden"
                            onChange={(e) => {
                              takeFile(e.target.files?.[0]);
                              e.target.value = "";
                            }}
                          />
                          {cvError ? (
                            <p
                              className="mt-2 text-[13px] text-[#b3402e]"
                              style={{ fontFamily: GEIST }}
                            >
                              {cvError}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <div className="mt-10 flex flex-col items-center gap-4">
                        <button
                          type="button"
                          disabled={!introValid}
                          onClick={() => setStep("source")}
                          className={`flex h-[45px] w-[260px] items-center justify-center rounded-lg text-[13px] transition-colors ${
                            introValid
                              ? "bg-[#1c1917] text-[rgb(231,231,231)] hover:bg-[#0f0d0b]"
                              : "cursor-not-allowed bg-[#eceae7] text-[#9a9a9a]"
                          }`}
                          style={{ fontFamily: GEIST }}
                        >
                          Continue
                        </button>
                        <button
                          type="button"
                          onClick={() => setStep("form")}
                          className="text-xs uppercase tracking-[0.18em] text-[#9a9a9a] transition-colors hover:text-[#1d1b1b]"
                          style={{ fontFamily: MONO }}
                        >
                          Back
                        </button>
                      </div>
                    </motion.div>
                  ) : step === "source" ? (
                    <motion.div
                      key="source"
                      initial={{ opacity: 0, y: 24 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -24 }}
                      transition={{ duration: 0.4, ease: EASE_SOFT }}
                    >
                      <h2
                        className="text-[26px] leading-[32px]"
                        style={{ fontFamily: SERIF, fontWeight: 400, color: "rgb(29, 27, 27)" }}
                      >
                        How did you find this job?
                      </h2>
                      <p
                        className="mt-2 text-[14px] leading-[22px] text-[#767676]"
                        style={{ fontFamily: GEIST }}
                      >
                        Let us know how you found this role and whether anyone from
                        our team referred you to this role.
                      </p>

                      <div className="mt-8 space-y-2.5">
                        {SOURCE_OPTIONS.map((option) => {
                          const active = source === option;
                          return (
                            <button
                              key={option}
                              type="button"
                              onClick={() => setSource(option)}
                              className={`block w-full rounded-xl border px-5 py-3.5 text-left text-[15px] transition-colors ${
                                active
                                  ? "border-black/70 bg-black/[0.035] text-[#1d1b1b]"
                                  : "border-black/[0.12] text-[#4b4b48] hover:border-black/30"
                              }`}
                              style={{ fontFamily: GEIST }}
                            >
                              {option}
                            </button>
                          );
                        })}

                        {source === "A Falcon team member referred me" ||
                        source === "Other" ? (
                          <motion.input
                            type="text"
                            autoFocus
                            placeholder={
                              source === "Other"
                                ? "Tell us in a few words"
                                : "Who referred you?"
                            }
                            value={referral}
                            onChange={(e) => setReferral(e.target.value)}
                            initial={{ opacity: 0, height: 0 }}
                            animate={{ opacity: 1, height: "auto" }}
                            transition={{ duration: 0.3, ease: EASE_SOFT }}
                            className="mt-4 w-full border-0 border-b border-black/20 bg-transparent pb-2 text-[16px] text-[#1d1b1b] outline-none transition-colors placeholder:text-[#a3a39f] focus:border-black/60"
                            style={{ fontFamily: GEIST }}
                          />
                        ) : null}
                      </div>

                      {error ? (
                        <p
                          className="mt-6 text-[13px] text-[#b3402e]"
                          style={{ fontFamily: GEIST }}
                        >
                          {error}
                        </p>
                      ) : null}

                      <div className="mt-10 flex flex-col items-center gap-4">
                        <button
                          type="button"
                          disabled={!source || submitting}
                          onClick={() => void submit()}
                          className={`flex h-[45px] w-[260px] items-center justify-center rounded-lg text-[13px] transition-colors ${
                            source && !submitting
                              ? "bg-[#1c1917] text-[rgb(231,231,231)] hover:bg-[#0f0d0b]"
                              : "cursor-not-allowed bg-[#eceae7] text-[#9a9a9a]"
                          }`}
                          style={{ fontFamily: GEIST }}
                        >
                          {submitting ? "Submitting…" : "Submit application"}
                        </button>
                        <button
                          type="button"
                          onClick={() => setStep("details")}
                          className="text-xs uppercase tracking-[0.18em] text-[#9a9a9a] transition-colors hover:text-[#1d1b1b]"
                          style={{ fontFamily: MONO }}
                        >
                          Back
                        </button>
                      </div>
                    </motion.div>
                  ) : (
                    <motion.div
                      key="done"
                      className="text-center"
                      initial={{ opacity: 0, y: 24 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -24 }}
                      transition={{ duration: 0.4, ease: EASE_SOFT }}
                    >
                      <h2
                        className="text-[30px] leading-[38px]"
                        style={{ fontFamily: SERIF, fontWeight: 400, color: "rgb(29, 27, 27)" }}
                      >
                        Application received.
                      </h2>
                      <p
                        className="mx-auto mt-4 max-w-md text-[15px] leading-[24px] text-[#767676]"
                        style={{ fontFamily: GEIST }}
                      >
                        Thanks for applying for the {selected.title} role. We read
                        every application and will get back to you by email.
                      </p>
                      <button
                        type="button"
                        onClick={close}
                        className="mx-auto mt-10 flex h-[45px] w-[220px] items-center justify-center rounded-lg bg-[#1c1917] text-[13px] text-[rgb(231,231,231)] transition-colors hover:bg-[#0f0d0b]"
                        style={{ fontFamily: GEIST }}
                      >
                        Done
                      </button>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </>
  );
}
