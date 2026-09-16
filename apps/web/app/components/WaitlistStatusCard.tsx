"use client";

import { motion } from "framer-motion";
import { AUTH } from "@/lib/marketing-copy";
import WaitlistTicket, { WAITLIST_TICKET_WIDTH } from "./WaitlistTicket";

const GEIST = "var(--font-geist-sans), sans-serif";
const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

/**
 * "You're on the waitlist": the card the login screen shows a member, reused
 * wherever someone lands on their own membership — at the end of the
 * application and on /early-access when they're already signed in.
 */
export default function WaitlistStatusCard({
  fullName,
  memberNumber,
  grantedAt,
  width = WAITLIST_TICKET_WIDTH,
  animate = true,
  children,
}: {
  fullName: string;
  memberNumber: number | null;
  grantedAt: string | null;
  width?: number;
  /** Off when the card is already part of another entrance. */
  animate?: boolean;
  /** Anything that belongs under the copy (a button, a link). */
  children?: React.ReactNode;
}) {
  const rise = (delay: number) =>
    animate
      ? {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { delay, duration: 0.5, ease: EASE_OUT },
        }
      : {};

  return (
    <div className="mx-auto w-full max-w-[460px] text-center">
      <motion.h1
        {...rise(0.15)}
        className="font-serif text-[2rem] font-normal leading-[1.25] tracking-[0.01em] text-[#1d1b1b]"
        style={{ fontFamily: SERIF }}
      >
        {AUTH.waitlist.title}
      </motion.h1>

      <motion.div
        {...(animate
          ? {
              initial: { opacity: 0, y: 26, scale: 0.95 },
              animate: { opacity: 1, y: 0, scale: 1 },
              transition: { delay: 0.5, duration: 0.55, ease: EASE_OUT },
            }
          : {})}
        className="mt-8 flex justify-center"
      >
        <WaitlistTicket
          fullName={fullName}
          memberNumber={memberNumber}
          grantedAt={grantedAt}
          width={width}
        />
      </motion.div>

      <motion.div {...rise(0.85)}>
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
        {children}
      </motion.div>
    </div>
  );
}
