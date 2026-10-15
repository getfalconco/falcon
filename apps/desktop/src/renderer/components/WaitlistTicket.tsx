import AdmitOneTicket, {
  TICKET_TEXTURE,
  TICKET_LAYOUT,
} from "@/components/ui/admit-one-ticket";
import { getLanguage, upperIn, useLanguage, type LanguageCode } from "@/lib/i18n";
import { translate } from "@/lib/i18n/translate";

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

/**
 * "Granted Oct 2026", in the language given (the app's, when none is): the
 * month and year come from Intl, so each language orders and abbreviates
 * them its own way ("Eki 2026", "2026年10月").
 */
export function grantedLabel(grantedAt: string | null, language: LanguageCode = getLanguage()): string {
  if (!grantedAt) return "2026";
  const d = new Date(grantedAt);
  if (Number.isNaN(d.getTime())) return "2026";
  const date = new Intl.DateTimeFormat(language, { month: "short", year: "numeric" }).format(d);
  return translate(language, "auth.ticket.granted", { date });
}

/** "#007"; dots stand in until a number is assigned (no dashes, by house rule). */
export function memberLabel(memberNumber: number | null): string {
  return memberNumber != null ? `#${String(memberNumber).padStart(3, "0")}` : "#···";
}

export function waitlistTicketProps({
  fullName,
  memberNumber,
  grantedAt,
  width = WAITLIST_TICKET_WIDTH,
  language = getLanguage(),
}: {
  fullName: string;
  memberNumber: number | null;
  grantedAt: string | null;
  width?: number;
  language?: LanguageCode;
}) {
  const t = (key: Parameters<typeof translate>[1], vars?: Parameters<typeof translate>[2]) =>
    translate(language, key, vars);
  const name = fullName.trim().replace(/\s+/g, " ") || t("auth.ticket.memberName");
  return {
    // The ticket uppercases its name in JS, by the root rule; cased here first, the language's own way ("ERKEN ERİŞİM").
    name: upperIn(t("auth.ticket.tier"), language),
    presenter: name,
    event: "",
    venue: t("auth.ticket.member", { number: memberLabel(memberNumber) }),
    dates: grantedLabel(grantedAt, language),
    stubText: t("auth.ticket.admit"),
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
  const language = useLanguage();
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
        {...waitlistTicketProps({ fullName, memberNumber, grantedAt, width, language })}
      />
    </div>
  );
}
