"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import { EASE_CSS } from "./tokens";
import { PlatformDownloadButtons } from "./PlatformDownloadButtons";

type DownloadCtx = { open: () => void; close: () => void };

const DownloadContext = createContext<DownloadCtx | null>(null);

export function useDownload() {
  const ctx = useContext(DownloadContext);
  if (!ctx) {
    throw new Error("useDownload must be used within a DownloadProvider");
  }
  return ctx;
}

export function DownloadProvider({
  children,
  macUrl = "",
  windowsUrl = "",
}: {
  children: ReactNode;
  macUrl?: string;
  windowsUrl?: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    if (!isOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [isOpen, close]);

  return (
    <DownloadContext.Provider value={{ open, close }}>
      {children}
      <DownloadModal isOpen={isOpen} onClose={close} macUrl={macUrl} windowsUrl={windowsUrl} />
    </DownloadContext.Provider>
  );
}

const ANIM_MS = 420;

function DownloadModal({
  isOpen,
  onClose,
  macUrl,
  windowsUrl,
}: {
  isOpen: boolean;
  onClose: () => void;
  macUrl: string;
  windowsUrl: string;
}) {
  // `mounted` controls presence; `active` drives the CSS transitions.
  // We keep the blurred layer at opacity 1 the whole time and transition the
  // blur value itself — Chromium suppresses backdrop-filter while an element
  // (or any ancestor) has opacity < 1, which is what caused the sudden pop.
  const [mounted, setMounted] = useState(false);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (isOpen) setMounted(true);
  }, [isOpen]);

  useEffect(() => {
    if (!mounted || !isOpen) return;
    // Two frames so the browser paints the un-blurred state before ramping up.
    let r2 = 0;
    const r1 = requestAnimationFrame(() => {
      r2 = requestAnimationFrame(() => setActive(true));
    });
    return () => {
      cancelAnimationFrame(r1);
      cancelAnimationFrame(r2);
    };
  }, [mounted, isOpen]);

  useEffect(() => {
    if (isOpen || !mounted) return;
    setActive(false);
    const t = setTimeout(() => setMounted(false), ANIM_MS);
    return () => clearTimeout(t);
  }, [isOpen, mounted]);

  if (!mounted) return null;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center px-5">
      <div
        className="absolute inset-0"
        onClick={onClose}
        aria-hidden
        style={{
          transitionProperty:
            "background-color, backdrop-filter, -webkit-backdrop-filter",
          transitionDuration: `${ANIM_MS}ms`,
          transitionTimingFunction: EASE_CSS,
          backgroundColor: active ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0)",
          backdropFilter: active ? "blur(8px)" : "blur(0px)",
          WebkitBackdropFilter: active ? "blur(8px)" : "blur(0px)",
        }}
      />

      <div
        role="dialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-sm rounded-3xl border border-[#E5E5E5] bg-white p-8 text-center shadow-card"
        style={{
          transitionProperty: "opacity, transform",
          transitionDuration: "320ms",
          transitionTimingFunction: EASE_CSS,
          opacity: active ? 1 : 0,
          transform: active
            ? "scale(1) translateY(0)"
            : "scale(0.96) translateY(10px)",
        }}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-full text-neutral-400 transition hover:bg-neutral-100 hover:text-ink"
        >
          <X className="h-4 w-4" />
        </button>

        <h2 className="text-balance text-xl font-semibold tracking-tight text-ink">
          Get Falcon for desktop
        </h2>
        <p className="mt-2 text-sm text-neutral-500">
          Choose your platform to download
        </p>

        <div className="mt-7">
          <PlatformDownloadButtons macUrl={macUrl} windowsUrl={windowsUrl} variant="modal" />
        </div>
      </div>
    </div>
  );
}
