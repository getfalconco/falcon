import { Minus, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n";

type Props = {
  className?: string;
};

export default function WindowControls({ className }: Props) {
  const t = useT();
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
        aria-label={t("window.minimize")}
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>
      <button
        type="button"
        onClick={() => window.meridian?.toggleMaximize()}
        className="flex h-7 w-7 items-center justify-center text-fg-faint transition hover:bg-black/[0.05] hover:text-fg-muted"
        aria-label={t("window.maximize")}
      >
        <Square className="h-3 w-3" strokeWidth={2.5} />
      </button>
      <button
        type="button"
        onClick={() => window.meridian?.close()}
        className="flex h-7 w-7 items-center justify-center text-fg-faint transition hover:bg-white/[0.08] hover:text-ink"
        aria-label={t("window.close")}
      >
        <X className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>
    </div>
  );
}
