"use client";

import {
  TICKET_HOVER_EASE_CSS,
  TICKET_HOVER_MS,
  TICKET_HOVER_SCALE,
} from "@meridian/ui";
import AdmitOneTicket from "./ui/admit-one-ticket";
import { TIERS } from "./TierTickets";

/**
 * The founding-member ticket shown once someone is on the waitlist — used by
 * the login screen and by the end of the early-access application, so both
 * places show the same card.
 */

export const WAITLIST_TICKET_WIDTH = 400;

// The Turkish blue of the early-access tier, taken straight from that ticket
// so the one someone earns looks like the one they clicked.
const EARLY = TIERS.find((t) => t.key === "early") ?? TIERS[0];

export const BLUE_TEXTURE = EARLY.texture;
export const BLUE_LAYOUT = EARLY.layout;

// The vendored ticket has no font/per-text-color props — target its rows by
// class: the "FALCON EARLY ACCESS" block renders as div.whitespace-pre, the
// "MEMBER #…" footer as div.whitespace-nowrap (the stub also carries
// whitespace-nowrap but is a .grid, hence the :not), and the name is the only
// .font-medium that isn't a .grid.
export const TICKET_MONO_CSS = `
.wl-ticket div.whitespace-pre,
.wl-ticket div.whitespace-nowrap:not(.grid) {
  font-family: var(--font-geist-mono), monospace;
  color: ${EARLY.labelColor};
}
.wl-ticket div.font-medium:not(.grid) {
  color: ${EARLY.nameColor}; /* same as the ADMIT ONE stub ink */
  text-align: left;
}
/* Approved ticket: on hover it glows (cyan) and grows. The grow lives on an
   inner CSS layer so it composes with the framer heartbeat transform instead
   of fighting it. */
.wl-tear-btn {
  transition: filter 300ms ease;
}
.wl-tear-btn:hover {
  filter: brightness(1.1) drop-shadow(0 0 30px rgba(79, 216, 230, 0.45));
}
.wl-tear-inner {
  transition: transform ${TICKET_HOVER_MS}ms ${TICKET_HOVER_EASE_CSS};
}
.wl-tear-btn:hover .wl-tear-inner {
  transform: scale(${TICKET_HOVER_SCALE});
}
/* The vendored TiltCard snaps to the pointer (inline transition: none while
   hovering) — force a soft ease so the follow feels smooth, not stiff. */
.wl-ticket .will-change-transform {
  transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1) !important;
}
/* Typewriter caret for the "Welcome, Name" line. */
.wl-caret {
  animation: wlBlink 1s steps(1) infinite;
}
@keyframes wlBlink {
  50% { opacity: 0; }
}
`;

export function grantedLabel(grantedAt: string | null): string {
  if (!grantedAt) return "2026";
  const d = new Date(grantedAt);
  if (Number.isNaN(d.getTime())) return "2026";
  const month = d.toLocaleString("en-US", { month: "short" });
  return `Granted ${month} ${d.getFullYear()}`;
}

export function memberLabel(memberNumber: number | null): string {
  return memberNumber != null
    ? `#${String(memberNumber).padStart(3, "0")}`
    : "#———";
}

/** Props for the vendored ticket, filled in for a founding member. */
export function waitlistTicketProps({
  fullName,
  memberNumber,
  grantedAt,
  width = WAITLIST_TICKET_WIDTH,
}: {
  fullName: string;
  memberNumber: number | null;
  grantedAt: string | null;
  width?: number;
}) {
  const name = fullName.trim().replace(/\s+/g, " ") || "Member";
  return {
    // The big centre line reads EARLY ACCESS; the member's full name goes on
    // one line in the top-left label block (the vendored ticket renders
    // `presenter`, a newline, then `event` — so the surname row stays empty).
    name: "Early Access",
    presenter: name,
    event: "",
    venue: `Member ${memberLabel(memberNumber)}`,
    dates: grantedLabel(grantedAt),
    stubText: "Admit one",
    watermark: "2026",
    width,
    texture: BLUE_TEXTURE,
    layout: BLUE_LAYOUT,
  };
}

/** The plain (untorn) ticket, with its styling attached. */
export default function WaitlistTicket({
  fullName,
  memberNumber,
  grantedAt,
  width = WAITLIST_TICKET_WIDTH,
  tilt = true,
}: {
  fullName: string;
  memberNumber: number | null;
  grantedAt: string | null;
  width?: number;
  tilt?: boolean;
}) {
  return (
    <div
      className="wl-ticket"
      style={{
        filter: "drop-shadow(0 18px 40px rgba(4, 18, 34, 0.4))",
        fontFamily: "var(--font-geist-sans), sans-serif",
      }}
    >
      <style>{TICKET_MONO_CSS}</style>
      <AdmitOneTicket
        tilt={tilt ? {} : false}
        {...waitlistTicketProps({ fullName, memberNumber, grantedAt, width })}
      />
    </div>
  );
}
