import type { LucideIcon } from "lucide-react";
import {
  BarChart3,
  GitBranch,
  LayoutDashboard,
  MessageSquare,
  Radar,
  RefreshCw,
  Search,
  Sparkles,
} from "lucide-react";
import { DOWNLOAD } from "@/lib/marketing-copy";

const ICONS: LucideIcon[] = [
  Radar,
  Sparkles,
  BarChart3,
  MessageSquare,
  GitBranch,
  Search,
  LayoutDashboard,
  RefreshCw,
];

export default function DownloadCapabilityGrid() {
  const { title, subtitle, capabilities } = DOWNLOAD.capabilityGrid;

  return (
    <section className="border-t border-white/[0.08] px-5 py-12 sm:px-8 sm:py-16">
      <div className="mx-auto max-w-5xl">
        <h2 className="text-center font-serif text-2xl font-normal text-white sm:text-3xl">{title}</h2>
        <p className="mx-auto mt-4 max-w-2xl text-center text-[14px] leading-relaxed text-[#505050] sm:text-[15px]">
          {subtitle}
        </p>

        <ul className="mt-12 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
          {capabilities.map(({ label, caption }, index) => {
            const Icon = ICONS[index]!;
            return (
              <li
                key={label}
                className="flex flex-col items-center gap-2 border border-white/[0.08] bg-white/[0.02] px-4 py-6 text-center"
              >
                <Icon className="h-5 w-5 text-white/70" strokeWidth={1.5} aria-hidden />
                <span className="text-[13px] text-white/80">{label}</span>
                <span className="text-[11px] leading-snug text-[#505050]">{caption}</span>
              </li>
            );
          })}
        </ul>
      </div>
    </section>
  );
}
