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
 */
export function useShownPoll(key: string, run: () => void, intervalMs: number, { immediate = true }: { immediate?: boolean } = {}): void {
  const activity = useHomeTabActivity();
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!key) return;
    const hasDocument = typeof document !== "undefined";
    const shown = () => activity.isActive() && (!hasDocument || document.visibilityState !== "hidden");
    const tick = () => {
      if (shown()) latest.current();
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
  }, [key, activity, intervalMs, immediate]);
}
