"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { AUTH } from "@/lib/marketing-copy";
import Navbar from "./Navbar";
import GetStartedButton from "./GetStartedButton";
import AnimatedGradientPanel from "./AnimatedGradientPanel";
import AdmitOneTicket from "./ui/admit-one-ticket";
import ApprovedTicketReveal from "./ApprovedTicketReveal";
import {
  TICKET_MONO_CSS,
  WAITLIST_TICKET_WIDTH as TICKET_WIDTH,
  waitlistTicketProps,
} from "./WaitlistTicket";

const GEIST = "var(--font-geist-sans), sans-serif";

// Choreographed reveal timings (seconds): panel expands, then the headline,
// then the ticket, then navbar + footer link — staggered, ease-out.
const EASE_OUT = [0.16, 1, 0.3, 1] as const;
const T_PANEL = 0.6;
const T_HEADING = 0.55;
const T_TICKET = 0.95;
const T_COPY = 1.25;
const T_CHROME = 1.5;
// How long after the tear the login screen's own chrome fades back in.
const C_CHROME = 2.7;

// Split ratio of the login screen (grid 0.82fr / 1.18fr): the white panel
// starts where the right column sits, then expands leftward over the shader.
const PANEL_LEFT = "41%";


type Membership = {
  name: string | null;
  memberNumber: number | null;
  grantedAt: string | null;
  approved: boolean;
};

export default function WaitlistView({
  email,
  onBack,
}: {
  email?: string;
  onBack: () => void;
}) {
  const [membership, setMembership] = useState<Membership | null>(null);
  // Approved flow: the tear waits for a click on the pulsing ticket.
  const [torn, setTorn] = useState(false);

  useEffect(() => {
    if (!email) return;
    let stale = false;
    (async () => {
      try {
        const res = await fetch(`/api/waitlist?email=${encodeURIComponent(email)}`);
        if (!res.ok) return;
        const data = (await res.json()) as { found?: boolean } & Membership;
        if (!stale && data.found) {
          setMembership({
            name: data.name ?? null,
            memberNumber: data.memberNumber ?? null,
            grantedAt: data.grantedAt ?? null,
            approved: data.approved === true,
          });
        }
      } catch {
        // Ticket falls back to placeholders — never block the screen.
      }
    })();
    return () => {
      stale = true;
    };
  }, [email]);

  const fullName = membership?.name ?? (email ? email.split("@")[0] : "Member");
  const approved = membership?.approved === true;

  const ticketProps = waitlistTicketProps({
    fullName,
    memberNumber: membership?.memberNumber ?? null,
    grantedAt: membership?.grantedAt ?? null,
  });

  return (
    <div className="absolute inset-0 overflow-hidden bg-[#fdfdfd] font-sans">
      <style>{TICKET_MONO_CSS}</style>

      {/* Shader panel stays underneath; the white panel slides over it. */}
      <div className="absolute inset-y-0 left-0 overflow-hidden" style={{ width: PANEL_LEFT }}>
        <AnimatedGradientPanel />
      </div>

      {/* a. Right white panel expands leftward to fill the screen. */}
      <motion.div
        initial={{ x: PANEL_LEFT }}
        animate={{ x: 0 }}
        transition={{ duration: T_PANEL, ease: EASE_OUT }}
        className="absolute inset-0 bg-[#fdfdfd]"
      >
        {/* d. Navbar fades in last (in the approved sequence: after Welcome,
            i.e. only once the ticket has been torn). */}
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: approved && !torn ? 0 : 1 }}
          transition={{
            delay: approved ? (torn ? C_CHROME : 0) : T_CHROME,
            duration: 0.5,
            ease: EASE_OUT,
          }}
        >
          <Navbar />
        </motion.div>

        <div className="flex h-full flex-col">
          <div className="flex flex-1 flex-col items-center justify-center px-8">
            <div className="w-full max-w-[460px] text-center">
              {approved ? (
                /* Approved: a bare stage — no text anywhere. The ticket sits
                   alone pulsing like a heartbeat; a click tears it: the stub
                   rips off, the big piece re-centers and STAYS, Welcome lands
                   ABOVE the ticket and the download CTA below it. */
                <ApprovedTicketReveal
                  fullName={fullName}
                  memberNumber={membership?.memberNumber ?? null}
                  grantedAt={membership?.grantedAt ?? null}
                  onTornChange={setTorn}
                />
              ) : (
                <>
                  {/* b. Headline fades in. */}
                  <motion.h1
                    initial={{ opacity: 0, y: 14 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: T_HEADING, duration: 0.5, ease: EASE_OUT }}
                    className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-[#1d1b1b]"
                  >
                    {AUTH.waitlist.title}
                  </motion.h1>

                  {/* c. Ticket rises in with the user's name. */}
                  <motion.div
                    initial={{ opacity: 0, y: 26, scale: 0.95 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    transition={{ delay: T_TICKET, duration: 0.55, ease: EASE_OUT }}
                    className="wl-ticket mt-8 flex justify-center"
                    style={{
                      filter: "drop-shadow(0 18px 40px rgba(4, 18, 34, 0.4))",
                      fontFamily: GEIST,
                    }}
                  >
                    <AdmitOneTicket tilt={{}} {...ticketProps} />
                  </motion.div>

                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: T_COPY, duration: 0.5, ease: EASE_OUT }}
                  >
                    <p
                      className="mt-8 text-sm leading-relaxed text-[#767676]"
                      style={{ fontFamily: GEIST }}
                    >
                      {AUTH.waitlist.body}
                    </p>
                    <p
                      className="mt-3 text-sm leading-relaxed text-[#9a9a9a]"
                      style={{ fontFamily: GEIST }}
                    >
                      {AUTH.waitlist.approved}
                    </p>
                  </motion.div>
                </>
              )}
            </div>
          </div>

          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: approved && !torn ? 0 : 1 }}
            transition={{
              delay: approved ? (torn ? C_CHROME : 0) : T_CHROME,
              duration: 0.5,
              ease: EASE_OUT,
            }}
            className="shrink-0 pb-8 text-center"
          >
            <button
              type="button"
              onClick={onBack}
              className="text-[13px] text-[#767676] underline-offset-4 transition hover:text-[#1d1b1b] hover:underline"
            >
              Already approved? Sign in
            </button>
          </motion.div>
        </div>
      </motion.div>

    </div>
  );
}
