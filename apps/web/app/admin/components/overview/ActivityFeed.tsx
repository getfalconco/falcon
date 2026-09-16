import { UserPlus, ClipboardList, Radio } from "lucide-react";
import type { ActivityEvent, ActivityEventType } from "@/lib/admin-overview";
import { CARD, formatRelativeTime } from "./helpers";

const META: Record<
  ActivityEventType,
  { icon: typeof UserPlus; tone: string; verb: string }
> = {
  signup: { icon: UserPlus, tone: "text-emerald-700", verb: "New user" },
  waitlist: { icon: ClipboardList, tone: "text-amber-700", verb: "Joined waitlist" },
  signal: { icon: Radio, tone: "text-sky-700", verb: "Signal generated" },
};

export default function ActivityFeed({ events }: { events: ActivityEvent[] }) {
  return (
    <section className={`${CARD} flex h-full flex-col overflow-hidden`}>
      <div className="flex items-center justify-between border-b border-black/[0.06] px-4 py-3">
        <h2 className="text-[13px] font-medium text-[#1d1b1b]">Recent activity</h2>
        <span className="text-[11px] text-[#9a9a9a]">Last {events.length}</span>
      </div>

      {events.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-4 py-12 text-[12px] text-[#9a9a9a]">
          No activity yet.
        </div>
      ) : (
        <ul className="divide-y divide-black/[0.05]">
          {events.map((event) => {
            const meta = META[event.type];
            const Icon = meta.icon;
            return (
              <li key={event.id} className="flex items-center gap-3 px-4 py-2.5">
                <span className="grid h-7 w-7 shrink-0 place-items-center rounded-md border border-black/[0.08] bg-[#fbfbf9]">
                  <Icon className={`h-3.5 w-3.5 ${meta.tone}`} strokeWidth={1.75} />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] leading-tight text-[#1d1b1b]">{event.text}</p>
                  <p className="text-[11px] leading-tight text-[#9a9a9a]">{meta.verb}</p>
                </div>
                <span className="shrink-0 text-[11px] tabular-nums text-[#9a9a9a]">
                  {formatRelativeTime(event.ts)}
                </span>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
