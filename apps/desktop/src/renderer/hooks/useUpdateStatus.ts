import { useEffect, useState } from "react";
import type { UpdateStatus } from "../../shared/update-types";

/**
 * The main process's view of whether a newer Falcon exists. Pulls the current
 * value on mount (the check may already have run) and then follows pushes.
 */
export function useUpdateStatus(): UpdateStatus {
  const [status, setStatus] = useState<UpdateStatus>({ kind: "idle" });

  useEffect(() => {
    const bridge = window.meridian;
    if (!bridge?.getUpdateStatus) return;
    let cancelled = false;
    void bridge.getUpdateStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    const unsubscribe = bridge.onUpdateStatus(setStatus);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  return status;
}
