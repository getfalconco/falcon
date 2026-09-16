"use client";

import ScrollReveal from "../ScrollReveal";
import { Keyboard } from "@/components/ui/keyboard";
import { KEYBOARD_SPACE_GRAY } from "@/lib/download-theme";
import { DOWNLOAD } from "@/lib/marketing-copy";

const SEARCH_SHORTCUT_KEYS = ["ShiftLeft", "AltLeft", "KeyK"];

function NativePerformanceVisual() {
  return (
    <div
      className="relative flex aspect-square w-full max-w-[280px] items-center justify-center overflow-hidden rounded-sm"
      style={{
        background: KEYBOARD_SPACE_GRAY.chassisGradient,
        boxShadow: KEYBOARD_SPACE_GRAY.chassisShadow,
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "linear-gradient(rgba(0,0,0,0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(0,0,0,0.08) 1px, transparent 1px)",
          backgroundSize: "20px 20px",
        }}
      />
      <svg
        viewBox="0 0 384 512"
        aria-hidden
        className="relative h-16 w-16"
        fill={KEYBOARD_SPACE_GRAY.appleMark}
      >
        <path d="M318.7 268.7c-.2-36.7 16.4-64.4 50-84.8-18.8-26.9-47.2-41.7-84.7-44.6-35.5-2.8-74.3 20.7-88.5 20.7-15 0-49.4-19.7-76.4-19.7C63.3 141.2 4 184.8 4 273.5q0 39.3 14.4 81.2c12.8 36.7 59 126.7 107.2 125.2 25.2-.6 43-17.9 75.8-17.9 31.8 0 48.3 17.9 76.4 17.9 48.6-.7 90.4-82.5 102.6-119.3-65.2-30.7-61.7-90-61.7-91.9zM262.1 104.5c27.3-32.4 24.8-61.9 24-72.5-24.1 1.4-52 16.4-67.9 34.9-17.5 19.8-27.8 44.3-25.6 71.9 26.1 2 49.9-11.4 69.5-34.3z" />
      </svg>
    </div>
  );
}

function FeatureBlock({
  title,
  body,
  visual,
}: {
  title: string;
  body: React.ReactNode;
  visual: React.ReactNode;
}) {
  return (
    <ScrollReveal as="article" className="flex flex-col gap-8">
      <div>
        <h2 className="font-serif text-2xl font-normal text-white sm:text-3xl">{title}</h2>
        <div className="mt-4 max-w-md text-[14px] leading-relaxed text-[#505050] sm:text-[15px]">
          {body}
        </div>
      </div>
      <div className="flex justify-center md:justify-start">{visual}</div>
    </ScrollReveal>
  );
}

export default function DownloadFeatureSections() {
  return (
    <section className="border-t border-white/[0.08] px-5 py-8 sm:px-8">
      <div className="mx-auto max-w-6xl py-8 sm:py-12">
        <div className="grid gap-16 md:grid-cols-2 md:gap-12 lg:gap-16">
          <FeatureBlock
            title={DOWNLOAD.features[0]!.title}
            body={DOWNLOAD.features[0]!.body}
            visual={<NativePerformanceVisual />}
          />

          <FeatureBlock
            title={DOWNLOAD.features[1]!.title}
            body={
              <>
                Press <kbd className="text-white/70">⇧</kbd> <kbd className="text-white/70">⌥</kbd>{" "}
                <kbd className="text-white/70">K</kbd> {DOWNLOAD.features[1]!.body}
              </>
            }
            visual={
              <div className="w-full overflow-hidden rounded-xl border border-white/[0.08] bg-[#090909] px-2 py-6 sm:px-4">
                <Keyboard highlightedKeys={SEARCH_SHORTCUT_KEYS} />
              </div>
            }
          />
        </div>

        <ScrollReveal
          as="article"
          delay={0.05}
          className="mx-auto mt-20 max-w-2xl text-center sm:mt-24"
        >
          <h2 className="font-serif text-2xl font-normal text-white sm:text-3xl">
            {DOWNLOAD.features[2]!.title}
          </h2>
          <p className="mx-auto mt-4 text-[14px] leading-relaxed text-[#505050] sm:text-[15px]">
            {DOWNLOAD.features[2]!.body}
          </p>
        </ScrollReveal>
      </div>
    </section>
  );
}
