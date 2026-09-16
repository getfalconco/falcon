"use client";

import { useEffect, useState } from "react";

const GEIST = "var(--font-geist-sans), sans-serif";

type Target = "mac" | "win" | "win-arm";

function AppleMark() {
  return (
    <svg className="h-4 w-4" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M17.05 20.28c-.98.95-2.05.88-3.08.4-1.09-.5-2.08-.48-3.24 0-1.44.62-2.2.44-3.06-.4C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09zM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25z" />
    </svg>
  );
}

function WindowsMark() {
  return (
    <svg className="h-[15px] w-[15px]" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M0 3.45L9.8 2.1v9.5H0V3.45zM10.9 1.95L24 0v11.6H10.9V1.95zM0 12.7h9.8v9.5L0 20.85V12.7zM10.9 12.7H24V24l-13.1-1.85V12.7z" />
    </svg>
  );
}

const TARGETS: { id: Target; label: string; href: string; mark: () => JSX.Element }[] = [
  { id: "mac", label: "macOS", href: "#", mark: AppleMark },
  { id: "win", label: "Windows", href: "#", mark: WindowsMark },
  { id: "win-arm", label: "Windows (arm64)", href: "#", mark: WindowsMark },
];

/**
 * Works out which build the visitor most likely wants. Client hints give the
 * platform and, on Windows, the CPU architecture; the user agent is the
 * fallback. Returns null when there is no good guess.
 */
async function detectTarget(): Promise<Target | null> {
  if (typeof navigator === "undefined") return null;

  const uaData = (
    navigator as Navigator & {
      userAgentData?: {
        platform?: string;
        getHighEntropyValues?: (hints: string[]) => Promise<{ architecture?: string }>;
      };
    }
  ).userAgentData;

  const platform = (uaData?.platform ?? navigator.platform ?? "").toLowerCase();
  const ua = navigator.userAgent.toLowerCase();

  if (platform.includes("mac") || ua.includes("mac os")) return "mac";

  if (platform.includes("win") || ua.includes("windows")) {
    try {
      const hints = await uaData?.getHighEntropyValues?.(["architecture"]);
      if (hints?.architecture?.toLowerCase().startsWith("arm")) return "win-arm";
    } catch {
      // No client hints — fall through to the user agent.
    }
    if (/\barm64\b|aarch64/.test(ua)) return "win-arm";
    return "win";
  }

  return null;
}

export default function DownloadButtons() {
  const [detected, setDetected] = useState<Target | null>(null);

  useEffect(() => {
    let stale = false;
    detectTarget().then((t) => {
      if (!stale) setDetected(t);
    });
    return () => {
      stale = true;
    };
  }, []);

  return (
    <div className="flex flex-wrap gap-3">
      {TARGETS.map((t) => {
        const primary = t.id === detected;
        const Mark = t.mark;
        return (
          // Muted until the installers exist: still shaped like buttons, but
          // greyed out and inert. The detected build keeps a slightly firmer
          // tone so the hint survives.
          <span
            key={t.id}
            data-target={t.id}
            data-primary={primary ? "true" : "false"}
            aria-disabled="true"
            className={`inline-flex h-[45px] cursor-not-allowed select-none items-center justify-center gap-2.5 rounded-lg px-5 text-[13px] ${
              primary
                ? "bg-[#e8e8e5] text-[#8a8a86]"
                : "border border-black/10 text-[#b0b0ab]"
            }`}
            style={{ fontFamily: GEIST }}
          >
            <Mark />
            {t.label}
          </span>
        );
      })}
    </div>
  );
}
