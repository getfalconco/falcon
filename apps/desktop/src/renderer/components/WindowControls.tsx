import { Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";

type Props = {
  className?: string;
};

export default function WindowControls({ className }: Props) {
  return (
    <div
      className={cn(
        "relative z-50 flex items-center gap-1 app-no-drag pointer-events-auto",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => window.meridian?.minimize()}
        className="flex h-7 w-7 items-center justify-center text-fg-faint transition hover:bg-black/[0.05] hover:text-fg-muted"
        aria-label="Minimize"
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>
      <button
        type="button"
        onClick={() => window.meridian?.toggleMaximize()}
        className="flex h-7 w-7 items-center justify-center text-fg-faint transition hover:bg-black/[0.05] hover:text-fg-muted"
        aria-label="Maximize"
      >
        <Square className="h-3 w-3" strokeWidth={2.5} />
      </button>
      <button
        type="button"
        onClick={() => window.meridian?.close()}
        className="flex h-7 w-7 items-center justify-center text-fg-faint transition hover:bg-white/[0.08] hover:text-ink"
        aria-label="Close"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>
    </div>
  );
}
