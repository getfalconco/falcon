"use client";

import TierTickets from "../components/TierTickets";

const MONO = "var(--font-geist-mono), monospace";

export default function TicketTestPage() {
  return (
    <div className="min-h-screen bg-[#fdfdfd] px-6 py-20 text-[#111111]">
      <p
        className="text-center text-[11px] uppercase tracking-[0.28em] text-[#9a9a9a]"
        style={{ fontFamily: MONO }}
      >
        Ticket variants — test
      </p>
      <div className="mt-12">
        <TierTickets firstName="Kuzey" lastName="Kovalak" />
      </div>
    </div>
  );
}
