import { useEffect, useState } from "react";
import type { InstallProgress } from "../../shared/install-types";

const IDLE: InstallProgress = { phase: "idle", value: null, label: "Falcon-Setup.exe" };

/**
 * Follows the real run in the main process: pulls the current state on mount
 * (the download may already be under way) and then follows what it pushes.
 */
export function useInstallProgress(): {
  value: number | null;
  label: string;
  done: boolean;
  failed: boolean;
  error?: string;
} {
  const [progress, setProgress] = useState<InstallProgress>(IDLE);

  useEffect(() => {
    const bridge = window.falconInstaller;
    if (!bridge) return;
    let cancelled = false;
    void bridge.getInstallProgress().then((p) => {
      if (!cancelled) setProgress(p);
    });
    const unsubscribe = bridge.onInstallProgress(setProgress);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return {
    value: progress.value,
    label: progress.label || IDLE.label,
    done: progress.phase === "done",
    failed: progress.phase === "failed",
    error: progress.error,
  };
}
