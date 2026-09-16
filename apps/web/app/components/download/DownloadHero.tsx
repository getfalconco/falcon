"use client";

import { PlatformDownloadButtons } from "@meridian/ui";
import { DOWNLOAD } from "@/lib/marketing-copy";

type Props = {
  macUrl: string;
  windowsUrl: string;
};

export default function DownloadHero({ macUrl, windowsUrl }: Props) {
  return (
    <section className="flex min-h-[calc(100vh-7rem)] flex-col items-center justify-center px-5 pb-24 pt-8 text-center sm:px-8">
      <h1 className="font-serif text-[3.5rem] font-normal leading-[1.06] tracking-[0.01em] text-white sm:text-[5rem] md:text-[6rem] lg:text-[6.75rem]">
        Falcon for Desktop
      </h1>

      <p className="mt-5 max-w-xl text-[14px] leading-relaxed text-[#505050] sm:mt-6 sm:text-[15px]">
        {DOWNLOAD.hero.subtitle}
      </p>

      <div id="download" className="mt-8 scroll-mt-32">
        <PlatformDownloadButtons
          macUrl={macUrl}
          windowsUrl={windowsUrl}
          variant="marketing"
          appearance="hero"
          layout="row"
          className="items-center"
        />
      </div>
    </section>
  );
}
