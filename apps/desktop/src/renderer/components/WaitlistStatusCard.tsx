import { motion } from "framer-motion";
import WaitlistTicket, { WAITLIST_TICKET_WIDTH } from "@/components/WaitlistTicket";
import { useT } from "@/lib/i18n";

const GEIST = "var(--font-geist-sans), sans-serif";
const SERIF = "var(--font-libre-baskerville), Georgia, serif";
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

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
  const t = useT();
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
        className="font-serif text-[1.5rem] font-normal leading-[1.25] tracking-[0.01em] text-content-primary"
        style={{ fontFamily: SERIF }}
      >
        {t("auth.waitlist.title")}
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
        <p className="mt-6 text-balance text-[13px] leading-relaxed text-content-secondary [word-break:auto-phrase]" style={{ fontFamily: GEIST }}>
          {t("auth.waitlist.body")}
        </p>
        <p className="mt-2.5 text-balance text-[13px] leading-relaxed text-content-tertiary [word-break:auto-phrase]" style={{ fontFamily: GEIST }}>
          {t("auth.waitlist.approved")}
        </p>
        {children}
      </motion.div>
    </div>
  );
}
