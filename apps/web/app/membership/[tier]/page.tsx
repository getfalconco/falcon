"use client";

import { useEffect } from "react";
import Link from "next/link";
import { notFound, useParams } from "next/navigation";
import Navbar from "../../components/Navbar";
import GetStartedButton from "../../components/GetStartedButton";
import {
  TIERS,
  TIER_CSS,
  FEATURES,
  monthlyPrice,
} from "../../components/TierTickets";
import AdmitOneTicket from "../../components/ui/admit-one-ticket";

const HEADING_FONT = "var(--font-libre-baskerville), Georgia, serif";
const GEIST = "var(--font-geist-sans), sans-serif";

export default function PlanPage() {
  const params = useParams<{ tier: string }>();
  const tier = TIERS.find((t) => t.key === params.tier);

  // Remember the chosen plan for the signup flow that follows.
  useEffect(() => {
    if (tier) sessionStorage.setItem("falcon-selected-plan", tier.key);
  }, [tier]);

  if (!tier) notFound();

  return (
    <div className="min-h-screen bg-[#fdfdfd] text-[#111111]">
      <Navbar />
      <style>{TIER_CSS}</style>

      <div className="mx-auto max-w-3xl px-6 pb-24 pt-[9rem] text-center">
        <h1
          style={{
            fontFamily: HEADING_FONT,
            fontWeight: 400,
            fontSize: "48px",
            lineHeight: "52px",
            color: "rgb(29, 27, 27)",
          }}
        >
          {tier.label}
        </h1>
        <p className="mt-3 text-[15px] text-[#767676]" style={{ fontFamily: GEIST }}>
          Available at{" "}
          <span className="font-medium text-[#1d1b1b]">{monthlyPrice(tier)}</span>
        </p>

        <div className={`tk-${tier.key} mt-12 flex justify-center`}>
          <div style={{ filter: "drop-shadow(0 5px 12px rgba(8, 12, 18, 0.3))" }}>
            <AdmitOneTicket
              tilt={{}}
              name={tier.name}
              presenter="John"
              event="Doe"
              venue="Member #001"
              dates="Granted Aug 2026"
              stubText="Admit one"
              watermark="2026"
              width={400}
              texture={tier.texture}
              layout={tier.layout}
            />
          </div>
        </div>

        {/* What this plan includes. */}
        <ul className="mx-auto mt-12 w-full max-w-sm space-y-3.5 text-left">
          {FEATURES.map((f) => {
            const v = f.values[tier.key] ?? false;
            const off = v === false;
            return (
              <li
                key={f.label}
                className="flex items-baseline justify-between gap-4 text-[14px]"
                style={{ fontFamily: GEIST }}
              >
                <span className={off ? "text-[#c6c6c3]" : "text-[#5f5f5c]"}>
                  {f.label}
                </span>
                <span
                  className={
                    off
                      ? "text-[#c6c6c3]"
                      : "whitespace-nowrap font-medium text-[#1d1b1b]"
                  }
                >
                  {v === true ? "✓" : v === false ? "—" : v}
                </span>
              </li>
            );
          })}
        </ul>

        <div className="mt-12 flex justify-center">
          <GetStartedButton label={`Continue with ${tier.label}`} href="/login" />
        </div>

        <Link
          href="/membership"
          className="mt-8 inline-block text-xs uppercase tracking-[0.18em] text-[#9a9a9a] transition-colors hover:text-[#555555]"
          style={{ fontFamily: "var(--font-geist-mono), monospace" }}
        >
          ← All plans
        </Link>
      </div>
    </div>
  );
}
