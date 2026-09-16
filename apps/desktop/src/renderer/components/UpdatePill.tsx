import logoWhite from "@/assets/brand/logo-white.png";
import { useUpdateStatus } from "@/hooks/useUpdateStatus";

/**
 * Bottom-left notice that a newer Falcon exists, wearing the dashboard's glass
 * card so it reads as part of the surface rather than an overlay.
 *
 * On Windows the update is already downloaded, so the card is a button: click,
 * restart, done. On an unsigned macOS build nothing can be installed
 * automatically, so it states that and stays put.
 */

/** Same recipe the dashboard cards use, at the scale of a small control. */
const GLASS =
  "flex items-center gap-3 rounded-2xl border border-white/60 bg-white/55 py-2.5 pl-2.5 pr-4 " +
  "shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_16px_40px_rgba(0,0,0,0.10)] " +
  "ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150";

function Mark({ dot }: { dot: boolean }) {
  return (
    <span className="relative shrink-0">
      <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#1d1b1b]">
        <img src={logoWhite} alt="" className="h-[18px] w-[18px]" draggable={false} />
      </span>
      {/* Quiet "this is new" marker — a filled dot, no glow. */}
      {dot ? (
        <span className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full border-2 border-white bg-[#189E9A]" />
      ) : null}
    </span>
  );
}

export default function UpdatePill({ className = "" }: { className?: string }) {
  const status = useUpdateStatus();
  if (status.kind === "idle") return null;

  if (status.kind === "ready") {
    return (
      <button
        type="button"
        onClick={() => void window.meridian?.installUpdate()}
        className={`app-no-drag select-none text-left transition-colors hover:bg-white/75 ${GLASS} ${className}`}
      >
        <Mark dot />
        <span className="flex flex-col leading-tight">
          <span className="text-[12.5px] font-medium text-[#1d1b1b]">Update available</span>
          <span className="mt-0.5 text-[11px] text-[#6b7280]">
            {status.version} · Click to restart
          </span>
        </span>
      </button>
    );
  }

  return (
    <div className={`app-no-drag select-none ${GLASS} ${className}`}>
      <Mark dot={false} />
      <span className="flex flex-col leading-tight">
        <span className="text-[12.5px] font-medium text-[#1d1b1b]">Auto update unavailable</span>
        <span className="mt-0.5 text-[11px] text-[#6b7280]">
          {status.version} · Contact developer
        </span>
      </span>
    </div>
  );
}
