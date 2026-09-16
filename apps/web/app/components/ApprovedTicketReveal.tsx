"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import AdmitOneTicket from "./ui/admit-one-ticket";
import GetStartedButton from "./GetStartedButton";
import {
  TICKET_MONO_CSS,
  WAITLIST_TICKET_WIDTH,
  waitlistTicketProps,
} from "./WaitlistTicket";

const GEIST = "var(--font-geist-sans), sans-serif";
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

// Approved sequence — the ticket sits alone on a bare stage, pulsing like a
// heartbeat until the user clicks it. On click it tears for real: the stub
// rips off the jagged perforation, the big piece re-centers, and only then
// Welcome lands. C_* delays are measured from the click.
const T_TICKET = 0.95;
const TEAR_DUR = 0.75;
const C_CENTER = 0.85;
const C_RISE = 1.15; // the reveal area expands, floating the ticket upward
const C_WELCOME = 1.8;
const C_LINKS = 2.1; // ~300ms after Welcome
const C_CAPTION = 2.25;
// After Welcome settles, wait a beat, then: "Welcome" glides left in one
// smooth move, and once anchored, ", Name" types rightward from a fixed left
// edge (a hidden ghost of the final string keeps the layout stable).
const C_SLIDE = 3.2;
const C_TYPE = 3.75;
const TYPE_SPEED_MS = 75;

// Perforation position of the vendored ticket (562 / 741). The two halves
// split just LEFT of the divider so the dashed line rides away with the stub.
const PERF_PCT = 75.84;
const TEAR_EDGE = PERF_PCT - 0.4;
const MAIN_CLIP = `inset(0 ${100 - TEAR_EDGE}% 0 0)`;
const STUB_CLIP = `inset(0 0 0 ${TEAR_EDGE}%)`;

function AppleLogo() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

function WindowsLogo() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M0 3.45L9.8 2.1v9.5H0V3.45zM10.9 1.95L24 0v11.6H10.9V1.95zM0 12.7h9.8v9.5L0 20.85V12.7zM10.9 12.7H24V24l-13.1-1.85V12.7z" />
    </svg>
  );
}

/**
 * The approved member's ticket: it pulses until clicked, tears along the
 * perforation, and only then does "Welcome, <name>" land above it with the
 * download step below. Shared by the login screen and /early-access so the
 * moment is identical wherever a member meets it.
 */
export default function ApprovedTicketReveal({
  fullName,
  memberNumber,
  grantedAt,
  width = WAITLIST_TICKET_WIDTH,
  onTornChange,
}: {
  fullName: string;
  memberNumber: number | null;
  grantedAt: string | null;
  width?: number;
  /** Lets the host fade its own chrome in once the ticket is torn. */
  onTornChange?: (torn: boolean) => void;
}) {
  const TICKET_WIDTH = width;
  // The main piece's visual centre sits left of the container centre — slide
  // it right by half the stub width to recentre.
  const CENTER_SHIFT = ((100 - TEAR_EDGE) / 2 / 100) * TICKET_WIDTH;

  const [torn, setTorn] = useState(false);
  const [showPicker, setShowPicker] = useState(false);
  const [typed, setTyped] = useState("");
  const [slid, setSlid] = useState(false);
  const [shiftX, setShiftX] = useState(0);
  const ghostFullRef = useRef<HTMLSpanElement>(null);
  const ghostWelcomeRef = useRef<HTMLSpanElement>(null);

  const firstName = fullName.trim().split(/\s+/)[0] || "Member";
  const typeSuffix = `, ${firstName}`;
  const typingDone = typed.length >= typeSuffix.length;

  const ticketProps = waitlistTicketProps({
    fullName,
    memberNumber,
    grantedAt,
    width: TICKET_WIDTH,
  });

  useEffect(() => {
    onTornChange?.(torn);
  }, [torn, onTornChange]);

  // Measure how far left "Welcome" must travel: half the width the typed
  // suffix will occupy, taken from the hidden ghost of the final string.
  useLayoutEffect(() => {
    const full = ghostFullRef.current;
    const welcome = ghostWelcomeRef.current;
    if (full && welcome) {
      setShiftX((full.offsetWidth - welcome.offsetWidth) / 2);
    }
  }, [typeSuffix]);

  // Slide first…
  useEffect(() => {
    if (!torn) {
      setSlid(false);
      return;
    }
    const timer = setTimeout(() => setSlid(true), C_SLIDE * 1000);
    return () => clearTimeout(timer);
  }, [torn]);

  // …then type ", Name" char by char from the fixed left edge.
  useEffect(() => {
    if (!torn) {
      setTyped("");
      return;
    }
    let interval: ReturnType<typeof setInterval> | undefined;
    const timer = setTimeout(() => {
      let i = 0;
      interval = setInterval(() => {
        i += 1;
        setTyped(typeSuffix.slice(0, i));
        if (i >= typeSuffix.length && interval) clearInterval(interval);
      }, TYPE_SPEED_MS);
    }, C_TYPE * 1000);
    return () => {
      clearTimeout(timer);
      if (interval) clearInterval(interval);
    };
  }, [torn, typeSuffix]);

  return (
    <>
      <style>{TICKET_MONO_CSS}</style>
                <div className="relative mx-auto" style={{ width: TICKET_WIDTH }}>
                  {/* Welcome area above the ticket — collapsed until the tear
                      so the ticket starts dead-centre. */}
                  <motion.div
                    initial={{ height: 0 }}
                    animate={torn ? { height: "auto" } : { height: 0 }}
                    transition={
                      torn
                        ? { delay: C_RISE, duration: 0.6, ease: EASE_OUT }
                        : { duration: 0 }
                    }
                    className="overflow-hidden"
                  >
                    <motion.h1
                      initial={{ opacity: 0, y: 14, scale: 0.96 }}
                      animate={
                        torn
                          ? { opacity: 1, y: 0, scale: 1 }
                          : { opacity: 0, y: 14, scale: 0.96 }
                      }
                      transition={
                        torn
                          ? { delay: C_WELCOME, duration: 0.65, ease: EASE_OUT }
                          : { duration: 0 }
                      }
                      className="mb-10 flex justify-center whitespace-nowrap font-serif text-[3.25rem] font-normal leading-none tracking-[0.01em] text-[#1d1b1b]"
                    >
                      <span className="relative inline-block">
                        {/* Hidden ghost of the final string keeps the width
                            (and the flex centring) stable while typing. */}
                        <span ref={ghostFullRef} className="invisible" aria-hidden>
                          <span ref={ghostWelcomeRef}>Welcome</span>
                          {typeSuffix}
                        </span>
                        {/* Visible text: starts centred (offset right by half
                            the suffix width), glides left, then types from a
                            fixed left edge. */}
                        <motion.span
                          className="absolute inset-y-0 left-0"
                          initial={false}
                          animate={{ x: slid ? 0 : shiftX }}
                          transition={
                            slid
                              ? { duration: 0.5, ease: EASE_OUT }
                              : { duration: 0 }
                          }
                        >
                          Welcome
                          {typed}
                          {typed.length > 0 && !typingDone ? (
                            <span className="wl-caret" aria-hidden>
                              |
                            </span>
                          ) : null}
                        </motion.span>
                      </span>
                    </motion.h1>
                  </motion.div>

                  {/* Entrance: the ticket rises in, alone. */}
                  <motion.div
                    initial={{ opacity: 0, y: 26, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ delay: T_TICKET, duration: 0.55, ease: EASE_OUT }}
                    className="wl-ticket"
                    style={{
                      filter: "drop-shadow(0 18px 40px rgba(4, 18, 34, 0.4))",
                      fontFamily: GEIST,
                    }}
                  >
                    {/* Heartbeat: a soft lub-dub pulse until the click. */}
                      <motion.div
                        role="button"
                        tabIndex={0}
                        aria-label="Tear your ticket"
                        onClick={() => setTorn(true)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setTorn(true);
                          }
                        }}
                        animate={torn ? { scale: 1 } : { scale: [1, 1.035, 1, 1.018, 1] }}
                        transition={
                          torn
                            ? { duration: 0.2 }
                            : {
                                delay: T_TICKET + 0.7,
                                duration: 1.35,
                                times: [0, 0.14, 0.28, 0.42, 1],
                                repeat: Infinity,
                                ease: "easeInOut",
                              }
                        }
                        className={`wl-tear-btn relative outline-none ${torn ? "pointer-events-none" : "cursor-pointer"}`}
                        style={{ width: TICKET_WIDTH, aspectRatio: "741 / 425" }}
                      >
                        <div className="wl-tear-inner relative h-full w-full">
                        {/* Main piece: recoils as the stub rips, then slides to
                            the visual centre. */}
                        <motion.div
                          className="absolute inset-0"
                          animate={torn ? { x: CENTER_SHIFT } : { x: 0 }}
                          transition={
                            torn
                              ? { delay: C_CENTER, duration: 0.6, ease: EASE_OUT }
                              : { duration: 0 }
                          }
                        >
                          <motion.div
                            className="h-full w-full"
                            animate={
                              torn
                                ? { rotate: [0, -1.6, 0.9, 0], x: [0, -5, 3, 0] }
                                : { rotate: 0, x: 0 }
                            }
                            transition={
                              torn
                                ? { delay: 0.12, duration: 0.55, ease: "easeOut" }
                                : { duration: 0 }
                            }
                            style={{ clipPath: MAIN_CLIP }}
                          >
                            <AdmitOneTicket tilt={false} {...ticketProps} />
                          </motion.div>
                        </motion.div>

                        {/* Stub piece: tears off along the perforation and
                            falls away (the original simple tear). */}
                        <motion.div
                          className="pointer-events-none absolute inset-0"
                          style={{
                            clipPath: STUB_CLIP,
                            transformOrigin: "76% 100%",
                          }}
                          initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
                          animate={
                            torn
                              ? { x: 72, y: 44, rotate: 22, opacity: 0 }
                              : { x: 0, y: 0, rotate: 0, opacity: 1 }
                          }
                          transition={
                            torn
                              ? { duration: TEAR_DUR, ease: [0.5, 0, 0.85, 0.4] }
                              : { duration: 0 }
                          }
                        >
                          <AdmitOneTicket tilt={false} {...ticketProps} />
                        </motion.div>
                        </div>
                      </motion.div>
                  </motion.div>

                  {/* The reveal area is collapsed until the tear, so the
                      ticket starts dead-centre and floats upward as this
                      expands. */}
                  <motion.div
                    initial={{ height: 0 }}
                    animate={torn ? { height: "auto" } : { height: 0 }}
                    transition={
                      torn
                        ? { delay: C_RISE, duration: 0.6, ease: EASE_OUT }
                        : { duration: 0 }
                    }
                    className="overflow-hidden"
                  >
                  {/* Below the ticket: the download CTA. */}
                  <motion.p
                    initial={{ opacity: 0, y: 10 }}
                    animate={torn ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
                    transition={
                      torn
                        ? { delay: C_LINKS, duration: 0.5, ease: EASE_OUT }
                        : { duration: 0 }
                    }
                    className="mt-10 text-center text-sm text-[#767676]"
                    style={{ fontFamily: GEIST }}
                  >
                    Download the app to get started
                  </motion.p>

                  <motion.div
                    initial={{ opacity: 0, y: 10 }}
                    animate={torn ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
                    transition={
                      torn
                        ? { delay: C_CAPTION, duration: 0.5, ease: EASE_OUT }
                        : { duration: 0 }
                    }
                    className="mt-5 flex justify-center"
                  >
                    <GetStartedButton
                      label="Download"
                      onClick={() => setShowPicker(true)}
                      className="h-[45px] w-[220px] pl-4 pr-3.5"
                    />
                  </motion.div>
                  </motion.div>
                </div>

      {/* Platform picker — opened by the Download button. Actual download
          wiring comes later. */}
      {showPicker && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.2 }}
          className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-6"
          onClick={() => setShowPicker(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            transition={{ duration: 0.25, ease: EASE_OUT }}
            className="w-full max-w-sm rounded-2xl border border-black/10 bg-[#fdfdfd] p-7 text-center shadow-2xl"
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-label="Choose your platform"
          >
            <h2 className="font-serif text-xl font-normal text-[#1d1b1b]">
              Choose your platform
            </h2>
            <p
              className="mt-2 text-sm text-[#9a9a9a]"
              style={{ fontFamily: GEIST }}
            >
              Falcon runs as a native desktop app.
            </p>

            <div className="mt-6 space-y-3" style={{ fontFamily: GEIST }}>
              <button
                type="button"
                onClick={() => setShowPicker(false)}
                className="flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-black/15 bg-[#fdfdfd] text-sm text-[#1d1b1b] transition hover:border-black/30 hover:bg-[#f5f4f1]"
              >
                <AppleLogo />
                Download for Mac
              </button>
              <button
                type="button"
                onClick={() => setShowPicker(false)}
                className="flex h-11 w-full items-center justify-center gap-2.5 rounded-lg border border-black/15 bg-[#fdfdfd] text-sm text-[#1d1b1b] transition hover:border-black/30 hover:bg-[#f5f4f1]"
              >
                <WindowsLogo />
                Download for Windows
              </button>
            </div>

            <button
              type="button"
              onClick={() => setShowPicker(false)}
              className="mt-5 text-xs text-[#9a9a9a] transition hover:text-[#555555]"
              style={{ fontFamily: GEIST }}
            >
              Cancel
            </button>
          </motion.div>
        </motion.div>
      )}
    </>
  );
}
