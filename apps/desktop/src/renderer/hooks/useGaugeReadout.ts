import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GaugeContext, GaugeReadout, GaugeSurface } from "../../shared/gauge-types";

/**
 * One Gauge readout for (ticker, context) from the main-process host
 * (compute-on-read, 60s memo there). Re-fetches when the inputs change and
 * every `refreshMs`; `refresh(true)` bypasses the memo.
 */
export type GaugeReadoutState = {
  readout: GaugeReadout | null;
  errors: string[];
  loading: boolean;
  error: string | null;
  memoHit: boolean;
  refresh: (fresh?: boolean) => Promise<void>;
};

export function useGaugeReadout(ticker: string | null, context: GaugeContext | null, surface: GaugeSurface, refreshMs = 60_000): GaugeReadoutState {
  const [readout, setReadout] = useState<GaugeReadout | null>(null);
  const [errors, setErrors] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [memoHit, setMemoHit] = useState(false);
  const seq = useRef(0);

  const contextKey = useMemo(() => (context ? JSON.stringify(context) : ""), [context]);

  const refresh = useCallback(
    async (fresh = false) => {
      const bridge = window.meridian;
      if (!ticker || !bridge?.getGaugeReadout) return;
      const my = ++seq.current;
      setLoading(true);
      try {
        const res = await bridge.getGaugeReadout({ ticker, context: contextKey ? (JSON.parse(contextKey) as GaugeContext) : null, surface, fresh });
        if (my !== seq.current) return;
        if (res.ok) {
          setReadout(res.readout);
          setErrors(res.errors);
          setMemoHit(res.memo_hit);
          setError(null);
        } else {
          setError(res.error);
        }
      } catch (err) {
        if (my === seq.current) setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [ticker, contextKey, surface],
  );

  useEffect(() => {
    setReadout(null);
    setError(null);
    void refresh();
    if (refreshMs <= 0) return;
    const id = window.setInterval(() => void refresh(), refreshMs);
    return () => window.clearInterval(id);
  }, [refresh, refreshMs]);

  return { readout, errors, loading, error, memoHit, refresh };
}
