import { motion } from "framer-motion";
import WaitlistTicket, { WAITLIST_TICKET_WIDTH } from "@/components/WaitlistTicket";

const GEIST = "var(--font-geist-sans), sans-serif";
const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

const WAITLIST_COPY = {
  title: "You're on the waitlist",
  body: "We're not open to everyone yet. Access is going out slowly, to traders who want depth over noise.",
  approved:
    "Once you're approved, we'll let you know by email and phone, and walk you through setting up your desk.",
};

/** "You're on the waitlist" card with the founding-member ticket. */
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
  animate?: boolean;
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
        className="font-serif text-[1.5rem] font-normal leading-[1.25] tracking-[0.01em] text-[#1d1b1b]"
        style={{ fontFamily: SERIF }}
      >
        {WAITLIST_COPY.title}
      </motion.h1>

      <motion.div
        {...(animate
          ? {
              initial: { opacity: 0, y: 26, scale: 0.95 },
              animate: { opacity: 1, y: 0, scale: 1 },
              transition: { delay: 0.5, duration: 0.55, ease: EASE_OUT },
            }
          : {})}
        className="mt-6 flex justify-center"
      >
        <WaitlistTicket
          fullName={fullName}
          memberNumber={memberNumber}
          grantedAt={grantedAt}
          width={width}
        />
      </motion.div>

      <motion.div {...rise(0.85)}>
        <p className="mt-6 text-[13px] leading-relaxed text-[#767676]" style={{ fontFamily: GEIST }}>
          {WAITLIST_COPY.body}
        </p>
        <p className="mt-2.5 text-[13px] leading-relaxed text-[#9a9a9a]" style={{ fontFamily: GEIST }}>
          {WAITLIST_COPY.approved}
        </p>
        {children}
      </motion.div>
    </div>
  );
}
