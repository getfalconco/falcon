"use client";

import { motion } from "framer-motion";
import AdmitOneTicket from "./ui/admit-one-ticket";
import type { InviteRole } from "@/lib/admin-invites";
import { TIERS, TIER_CSS } from "./TierTickets";

const GEIST = "var(--font-geist-sans), sans-serif";
const EASE_OUT = [0.16, 1, 0.3, 1] as const;

// Ticket geometry (mirrors the waitlist reveal).
const TICKET_WIDTH = 400;
const PERF_PCT = 75.84; // perforation position of the vendored ticket
const TEAR_EDGE = PERF_PCT - 0.4;
const MAIN_CLIP = `inset(0 ${100 - TEAR_EDGE}% 0 0)`;
const STUB_CLIP = `inset(0 0 0 ${TEAR_EDGE}%)`;
const CENTER_SHIFT = ((100 - TEAR_EDGE) / 2 / 100) * TICKET_WIDTH;

// Reveal timings (seconds), measured from the tear click.
const TEAR_DUR = 0.75;
const C_CENTER = 0.85;
const C_RISE = 1.15;
const C_WELCOME = 1.8;
const C_LINKS = 2.15;

function grantedLabel(): string {
  const d = new Date();
  const month = d.toLocaleString("en-US", { month: "short" });
  return `Granted ${month} ${d.getFullYear()}`;
}

export default function TicketRevealStage({
  role,
  name,
  torn,
  onTear,
}: {
  role: InviteRole;
  name: string;
  torn: boolean;
  onTear: () => void;
}) {
  const tier = TIERS.find((t) => t.key === role) ?? TIERS[0];
  const parts = name.trim().split(/\s+/);
  const firstName = parts[0] || "Member";
  const lastName = parts.slice(1).join(" ");

  const ticketProps = {
    name: tier.name,
    // One line: presenter carries the whole name, the surname row stays empty.
    presenter: [firstName, lastName].filter(Boolean).join(" "),
    event: "",
    venue: `${tier.label} access`,
    dates: grantedLabel(),
    stubText: "Admit one",
    watermark: "2026",
    width: TICKET_WIDTH,
    texture: tier.texture,
    layout: tier.layout,
  } as const;

  return (
    <div className={`tk-${role} relative mx-auto`} style={{ width: TICKET_WIDTH }}>
      <style>{TIER_CSS}</style>

      {/* Welcome, above the ticket — collapsed until the tear. */}
      <motion.div
        initial={{ height: 0 }}
        animate={torn ? { height: "auto" } : { height: 0 }}
        transition={torn ? { delay: C_RISE, duration: 0.6, ease: EASE_OUT } : { duration: 0 }}
        className="overflow-hidden"
      >
        <motion.h1
          initial={{ opacity: 0, y: 14 }}
          animate={torn ? { opacity: 1, y: 0 } : { opacity: 0, y: 14 }}
          transition={torn ? { delay: C_WELCOME, duration: 0.6, ease: EASE_OUT } : { duration: 0 }}
          className="mb-10 whitespace-nowrap text-center font-serif text-[3rem] font-normal leading-none tracking-[0.01em] text-[#1d1b1b]"
        >
          Welcome, {firstName}
        </motion.h1>
      </motion.div>

      {/* Entrance: the ticket rises in, then pulses until torn. */}
      <motion.div
        initial={{ opacity: 0, y: 26, scale: 0.95 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ delay: 0.2, duration: 0.55, ease: EASE_OUT }}
        className="wl-ticket"
        style={{ filter: "drop-shadow(0 18px 40px rgba(4, 18, 34, 0.4))", fontFamily: GEIST }}
      >
        <motion.div
          role="button"
          tabIndex={0}
          aria-label="Tear your ticket"
          onClick={onTear}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              onTear();
            }
          }}
          animate={torn ? { scale: 1 } : { scale: [1, 1.035, 1, 1.018, 1] }}
          transition={
            torn
              ? { duration: 0.2 }
              : {
                  delay: 0.9,
                  duration: 1.35,
                  times: [0, 0.14, 0.28, 0.42, 1],
                  repeat: Infinity,
                  ease: "easeInOut",
                }
          }
          className={`relative outline-none ${torn ? "pointer-events-none" : "cursor-pointer"}`}
          style={{ width: TICKET_WIDTH, aspectRatio: "741 / 425" }}
        >
          <div className="relative h-full w-full">
            {/* Main piece: recoils on tear, then slides to the visual centre. */}
            <motion.div
              className="absolute inset-0"
              animate={torn ? { x: CENTER_SHIFT } : { x: 0 }}
              transition={torn ? { delay: C_CENTER, duration: 0.6, ease: EASE_OUT } : { duration: 0 }}
            >
              <motion.div
                className="h-full w-full"
                animate={torn ? { rotate: [0, -1.6, 0.9, 0], x: [0, -5, 3, 0] } : { rotate: 0, x: 0 }}
                transition={torn ? { delay: 0.12, duration: 0.55, ease: "easeOut" } : { duration: 0 }}
                style={{ clipPath: MAIN_CLIP }}
              >
                <AdmitOneTicket tilt={false} {...ticketProps} />
              </motion.div>
            </motion.div>

            {/* Stub piece: tears off along the perforation and falls away. */}
            <motion.div
              className="pointer-events-none absolute inset-0"
              style={{ clipPath: STUB_CLIP, transformOrigin: "76% 100%" }}
              initial={{ x: 0, y: 0, rotate: 0, opacity: 1 }}
              animate={torn ? { x: 72, y: 44, rotate: 22, opacity: 0 } : { x: 0, y: 0, rotate: 0, opacity: 1 }}
              transition={torn ? { duration: TEAR_DUR, ease: [0.5, 0, 0.85, 0.4] } : { duration: 0 }}
            >
              <AdmitOneTicket tilt={false} {...ticketProps} />
            </motion.div>
          </div>
        </motion.div>
      </motion.div>

      {/* Below the ticket: the download CTA, revealed after the tear. */}
      <motion.div
        initial={{ height: 0 }}
        animate={torn ? { height: "auto" } : { height: 0 }}
        transition={torn ? { delay: C_RISE, duration: 0.6, ease: EASE_OUT } : { duration: 0 }}
        className="overflow-hidden"
      >
        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={torn ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
          transition={torn ? { delay: C_LINKS, duration: 0.5, ease: EASE_OUT } : { duration: 0 }}
          className="mt-10 text-center text-sm text-[#767676]"
          style={{ fontFamily: GEIST }}
        >
          {role === "talent_manager"
            ? "Your Talent Manager access is active. Open Internships to manage the hiring funnel."
            : `Your ${tier.label.toLowerCase()} access is active. Download the app to get started.`}
        </motion.p>
        <motion.div
          initial={{ opacity: 0, y: 10 }}
          animate={torn ? { opacity: 1, y: 0 } : { opacity: 0, y: 10 }}
          transition={torn ? { delay: C_LINKS + 0.15, duration: 0.5, ease: EASE_OUT } : { duration: 0 }}
          className="mt-5 flex justify-center"
        >
          <a
            href={role === "talent_manager" ? "/admin/dashboard/jobs" : "/early-access"}
            className="inline-flex h-[45px] items-center justify-center rounded-full bg-[#1d1b1b] px-7 text-sm font-medium text-white transition hover:bg-black"
            style={{ fontFamily: GEIST }}
          >
            {role === "talent_manager" ? "Open Internships" : "Download"}
          </a>
        </motion.div>
      </motion.div>
    </div>
  );
}
