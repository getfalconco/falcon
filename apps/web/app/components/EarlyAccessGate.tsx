"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchOwnMembership,
  readWaitlistCard,
  readWaitlistEmail,
  readWaitlistFlag,
  setWaitlistEmail,
  setWaitlistFlag,
  type WaitlistCard,
} from "@/lib/auth";
import { createBrowserSupabase } from "@/lib/supabase";
import EarlyAccessApply from "./EarlyAccessApply";
import ApprovedTicketReveal from "./ApprovedTicketReveal";
import { WAITLIST_TICKET_WIDTH } from "./WaitlistTicket";
import WaitlistStatusCard from "./WaitlistStatusCard";

const GEIST = "var(--font-geist-sans), sans-serif";

type Membership = WaitlistCard;

/**
 * Early-access entry point. If the visitor is signed in and already a member,
 * it shows their membership status straight away; otherwise it shows the
 * application, with an "Already applied? Check your status" link into login.
 */
export default function EarlyAccessGate(props: {
  stageHeading: string;
  stageParagraphs: string[];
  stageStep2: { intro: string; paragraphs: string[] };
}) {
  const [state, setState] = useState<"loading" | "guest" | "member">("loading");
  const [membership, setMembership] = useState<Membership | null>(null);
  const [email, setEmail] = useState<string>("");

  // The ticket is a fixed-width canvas, so clamp it on narrow phones.
  const [ticketWidth, setTicketWidth] = useState(WAITLIST_TICKET_WIDTH);
  useEffect(() => {
    const fit = () =>
      setTicketWidth(Math.min(WAITLIST_TICKET_WIDTH, window.innerWidth - 56));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  // TEMPORARY: paired with the log-out button on the approved screen. Clears
  // both ways of being recognised here — the Supabase session and the stored
  // waitlist identity — then reloads into the guest view.
  const signOut = async () => {
    try {
      await createBrowserSupabase().auth.signOut();
    } catch {
      // Not signed in through Supabase (waitlist members never are).
    }
    setWaitlistFlag(false);
    setWaitlistEmail(null);
    window.location.reload();
  };

  // The status layer covers the page, so the pitch behind it shouldn't scroll.
  useEffect(() => {
    if (state !== "member") return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [state]);

  useEffect(() => {
    let stale = false;
    (async () => {
      try {
        // Two ways to be "signed in" here. Approved members keep a Supabase
        // session, so their ticket is asked for with their own token.
        // Waitlist members don't: auth signs them straight back out and
        // leaves the flag, the email and the ticket it read with their
        // session just before. Nothing is ever looked up by email.
        let em: string | null = null;
        let card: Membership | null = null;
        try {
          const supabase = createBrowserSupabase();
          const {
            data: { session },
          } = await supabase.auth.getSession();
          if (session) {
            em = session.user?.email ?? null;
            card = await fetchOwnMembership(session.access_token);
          }
        } catch {
          // Supabase not configured: fall through to the stored ticket.
        }
        if (!card && readWaitlistFlag()) {
          const stored = readWaitlistEmail();
          const storedCard = readWaitlistCard(stored);
          if (stored && storedCard) {
            em = stored;
            card = storedCard;
          }
        }
        if (stale) return;

        if (em && card) {
          setMembership(card);
          setEmail(em);
          setState("member");
        } else {
          // No ticket we can vouch for: show the application, with the
          // "Check your status" link into sign-in.
          setState("guest");
        }
      } catch {
        if (!stale) setState("guest");
      }
    })();
    return () => {
      stale = true;
    };
  }, []);

  if (state === "member" && membership) {
    const fullName = membership.name?.trim() || email.split("@")[0] || "Member";

    // A member has nothing to read on this page, so their status takes the
    // whole screen instead of sitting in the pitch's right-hand column. The
    // navbar (z-50) stays above it so they can still navigate away.
    const fullScreen = (children: React.ReactNode) => (
      <div className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-[#fdfdfd] px-6 py-24">
        {children}
      </div>
    );

    // Approved: no preamble — the same reveal the login screen gives them.
    // The ticket pulses, tears, and only then does Welcome land above it.
    if (membership.approved) {
      return fullScreen(
        <>
          <ApprovedTicketReveal
            fullName={fullName}
            memberNumber={membership.memberNumber}
            grantedAt={membership.grantedAt}
            width={ticketWidth}
          />
          {/* TEMPORARY: a way back out while this screen is being worked on. */}
          <button
            type="button"
            onClick={() => void signOut()}
            className="absolute bottom-8 left-1/2 -translate-x-1/2 text-xs uppercase tracking-[0.18em] text-[#9a9a9a] transition-colors hover:text-[#1d1b1b]"
            style={{ fontFamily: "var(--font-geist-mono), monospace" }}
          >
            Log out
          </button>
        </>,
      );
    }

    // Waiting: the same card the login screen shows.
    return fullScreen(
      <WaitlistStatusCard
        fullName={fullName}
        memberNumber={membership.memberNumber}
        grantedAt={membership.grantedAt}
        width={ticketWidth}
      />,
    );
  }

  return (
    <div className="flex flex-col items-center">
      <EarlyAccessApply
        stageHeading={props.stageHeading}
        stageParagraphs={props.stageParagraphs}
        stageStep2={props.stageStep2}
      />
      {state === "guest" ? (
        <p className="mt-3 text-center text-[13px] text-[#767676]" style={{ fontFamily: GEIST }}>
          Already applied?{" "}
          <Link
            href="/login?next=/early-access"
            className="text-[#1d1b1b] underline decoration-black/20 underline-offset-4 transition-colors hover:decoration-black/60"
          >
            Check your status
          </Link>
        </p>
      ) : null}
    </div>
  );
}
