import { Minus, X } from "lucide-react";

/**
 * Windows and Linux chrome. macOS keeps its native traffic lights (the main
 * process insets them), so this renders on those platforms only.
 */
export default function WindowControls() {
  const platform = window.falconInstaller?.platform;
  if (platform === "darwin") return null;

  return (
    <div className="app-no-drag pointer-events-auto relative z-50 flex items-center gap-1">
      <button
        type="button"
        onClick={() => window.falconInstaller?.minimize()}
        className="flex h-7 w-7 items-center justify-center rounded-md text-black/30 transition hover:bg-black/[0.05] hover:text-black/70"
        aria-label="Minimize"
      >
        <Minus className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>
      <button
        type="button"
        onClick={() => window.falconInstaller?.close()}
        className="flex h-7 w-7 items-center justify-center rounded-md text-black/30 transition hover:bg-black/[0.05] hover:text-black/70"
        aria-label="Close"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>
    </div>
  );
}
