"use client";

import type { ReactNode } from "react";
import { cn } from "./lib/utils";
import { TextureButton } from "./TextureButton";

export type PlatformDownloadButtonsProps = {
  macUrl: string;
  windowsUrl: string;
  variant?: "modal" | "marketing";
  appearance?: "default" | "hero";
  className?: string;
  layout?: "column" | "row";
};

export function PlatformDownloadButtons({
  macUrl,
  windowsUrl,
  variant = "modal",
  appearance = "default",
  className,
  layout = "column",
}: PlatformDownloadButtonsProps) {
  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div
        className={cn(
          "flex gap-3",
          layout === "column" ? "flex-col" : "flex-col sm:flex-row sm:justify-center",
        )}
      >
        <PlatformButton
          href={macUrl}
          label="Download for macOS"
          variant={variant}
          appearance={appearance}
          tone="primary"
        >
          {appearance === "hero" ? "Download for Mac" : (
            <>
              <AppleIcon />
              Download for Mac
            </>
          )}
        </PlatformButton>
        <PlatformButton
          href={windowsUrl}
          label="Download for Windows"
          variant={variant}
          appearance={appearance}
          tone="secondary"
        >
          {appearance === "hero" ? "Download for Windows" : (
            <>
              <WindowsIcon />
              Download for Windows
            </>
          )}
        </PlatformButton>
      </div>
    </div>
  );
}

function PlatformButton({
  href,
  label,
  variant,
  appearance,
  tone,
  children,
}: {
  href: string;
  label: string;
  variant: "modal" | "marketing";
  appearance: "default" | "hero";
  tone: "primary" | "secondary";
  children: ReactNode;
}) {
  if (variant === "marketing") {
    return (
      <button
        type="button"
        aria-label={label}
        onClick={() => {
          if (href) window.open(href, "_blank", "noopener,noreferrer");
        }}
        className={cn(
          "inline-flex min-w-[9.5rem] cursor-pointer items-center justify-center px-6 py-2.5 text-[13px] transition",
          appearance === "hero" && tone === "primary" && "bg-white text-[#090909] hover:bg-white/90",
          appearance === "hero" && tone === "secondary" && [
            "border border-white/25 bg-transparent text-white hover:border-white/40 hover:bg-white/[0.04]",
          ],
          appearance === "default" && "gap-2 bg-white text-[#090909] hover:bg-white/90",
        )}
      >
        {children}
      </button>
    );
  }

  return (
    <TextureButton
      type="button"
      aria-label={label}
      variant="primary"
      size="lg"
      className="w-full cursor-pointer"
      onClick={() => {
        if (href) window.open(href, "_blank", "noopener,noreferrer");
      }}
    >
      {children}
    </TextureButton>
  );
}

function AppleIcon() {
  return (
    <svg viewBox="0 0 384 512" aria-hidden className="h-5 w-5" fill="currentColor">
      <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zM262.1 104.5c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
    </svg>
  );
}

function WindowsIcon() {
  return (
    <svg viewBox="0 0 448 512" aria-hidden className="h-5 w-5" fill="currentColor">
      <path d="M0 93.7l183.6-25.3v177.4H0V93.7zm0 324.6l183.6 25.3V268.4H0v149.9zm203.8 28L448 480V268.4H203.8v177.9zm0-380.6v180.1H448V32L203.8 65.7z" />
    </svg>
  );
}
