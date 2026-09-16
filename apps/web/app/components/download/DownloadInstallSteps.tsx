import Link from "next/link";
import { DOWNLOAD } from "@/lib/marketing-copy";

const MAC_STEPS = [
  "Download the .dmg file",
  "Open the downloaded file",
  "Drag Falcon to your Applications folder",
  "Open Falcon from Applications",
  "If prompted about an unidentified developer, go to System Settings → Privacy & Security and click Open Anyway",
] as const;

const WINDOWS_STEPS = [
  "Download the .exe installer",
  "Run the downloaded installer",
  "Launch Falcon from the Start menu",
  "If SmartScreen appears, click More info → Run anyway",
] as const;

export default function DownloadInstallSteps() {
  return (
    <section className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center font-serif text-2xl font-normal text-white sm:text-3xl">
          {DOWNLOAD.install.title}
        </h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-[14px] leading-relaxed text-[#505050] sm:text-[15px]">
          {DOWNLOAD.install.subtitle}
        </p>

        <div className="mt-12 grid gap-10 md:grid-cols-2 md:gap-12">
          <InstallColumn
            title="macOS"
            steps={MAC_STEPS}
            downloadHref="#download"
          />
          <InstallColumn
            title="Windows"
            steps={WINDOWS_STEPS}
            downloadHref="#download"
          />
        </div>
      </div>
    </section>
  );
}

function InstallColumn({
  title,
  steps,
  downloadHref,
}: {
  title: string;
  steps: readonly string[];
  downloadHref: string;
}) {
  return (
    <div className="border border-white/[0.08] bg-white/[0.02] p-6 sm:p-8">
      <div className="flex items-center justify-between gap-4">
        <h3 className="text-lg font-medium text-white">{title}</h3>
        <Link
          href={downloadHref}
          className="shrink-0 text-[12px] text-white/60 underline-offset-2 hover:text-white/90 hover:underline"
        >
          Download
        </Link>
      </div>
      <ol className="mt-6 space-y-3">
        {steps.map((step, index) => (
          <li key={step} className="flex gap-3 text-[13px] leading-relaxed text-[#505050]">
            <span className="shrink-0 font-mono text-xs text-white/40">{index + 1}.</span>
            <span>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}
