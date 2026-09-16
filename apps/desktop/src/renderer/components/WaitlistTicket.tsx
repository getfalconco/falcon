import AdmitOneTicket, {
  TICKET_TEXTURE,
  TICKET_LAYOUT,
} from "@/components/ui/admit-one-ticket";

/**
 * Founding-member ticket shown to a user on the waitlist — the same generative
 * ticket the marketing site uses. The Turkish-blue "early access" tier styling
 * is inlined here (the site pulls it from its TIERS table).
 */

export const WAITLIST_TICKET_WIDTH = 300;

const BASE_LAYOUT = { ...TICKET_LAYOUT, nameTop: 220 / 741 };

const BLUE_TEXTURE = {
  ...TICKET_TEXTURE,
  colorBack: "#05262f",
  colorFront: "#0f7d92",
  colorHighlight: "#4fd8e6",
};
const BLUE_LAYOUT = { ...BASE_LAYOUT, inkColor: "#c2eff5", watermarkColor: "#0d4a58" };
const LABEL_COLOR = "#5aa3b2";
const NAME_COLOR = "#c2eff5";

// The vendored ticket has no font/per-text-color props — target its rows by
// class (mono labels + left-aligned name).
const TICKET_MONO_CSS = `
.wl-ticket div.whitespace-pre,
.wl-ticket div.whitespace-nowrap:not(.grid) {
  font-family: var(--font-geist-mono), monospace;
  color: ${LABEL_COLOR};
}
.wl-ticket div.font-medium:not(.grid) {
  color: ${NAME_COLOR};
  text-align: left;
}
.wl-ticket .will-change-transform {
  transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1) !important;
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
  return memberNumber != null ? `#${String(memberNumber).padStart(3, "0")}` : "#———";
}

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
