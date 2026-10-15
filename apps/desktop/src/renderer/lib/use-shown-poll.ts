import { useEffect, useRef } from "react";
import { useHomeTabActivity } from "./home-tab-activity";

/**
 * Runs `run` now and every `intervalMs`, but only while the home tab it is
 * drawn in is in front and the window is shown: a tab mounted ahead of time
 * behind another (HomeTabPanels' idle prefetch) asks for nothing until it is
 * first opened. Coming back to the front, or the window being shown again,
 * runs it at once; `run` is expected to skip what is still fresh.
 *
 * `key` restarts the cycle (the names asked for changed); an empty key runs
 * nothing. With `immediate: false` the first run waits one interval (the
 * caller has just read).
 *
 * `freshForMs`: for a `run` that reads whatever it is asked, a run less
 * than this long after the last one is skipped, so flipping tabs or showing
 * the window again does not read again what was just read. Half the
 * interval is the usual choice: the interval's own ticks always pass it.
 */
export function useShownPoll(
  key: string,
  run: () => void,
  intervalMs: number,
  { immediate = true, freshForMs = 0 }: { immediate?: boolean; freshForMs?: number } = {},
): void {
  const activity = useHomeTabActivity();
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!key) return;
    const hasDocument = typeof document !== "undefined";
    const shown = () => activity.isActive() && (!hasDocument || document.visibilityState !== "hidden");
    let lastRunAt = immediate ? Number.NEGATIVE_INFINITY : Date.now();
    const tick = () => {
      if (!shown()) return;
      if (freshForMs > 0 && Date.now() - lastRunAt < freshForMs) return;
      lastRunAt = Date.now();
      latest.current();
    };
    if (immediate) tick();
    const timer = setInterval(tick, intervalMs);
    const off = activity.onChange((active) => {
      if (active) tick();
    });
    const onVisibility = () => tick();
    if (hasDocument) document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clearInterval(timer);
      off();
      if (hasDocument) document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [key, activity, intervalMs, immediate, freshForMs]);
}
