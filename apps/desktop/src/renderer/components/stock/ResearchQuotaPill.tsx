import { useEffect, useMemo, useState } from "react";

/**
 * How much research this account has left, and when the next one unlocks.
 *
 * Deliberately not a sentence. "You can research one company every 5 hours" is
 * a rule the reader has to hold and apply; a used/limit pair with a countdown
 * is the same fact already applied to them. It only earns its place when it
 * says something the Begin button does not — so at full quota it is two dots
 * and a number, and it only grows a countdown once a slot is actually spent.
 */

export type ResearchQuota = {
  limit: number;
  used: number;
  remaining: number;
  resetAt: string | null;
  allowed: boolean;
};

/** mm:ss under an hour, h:mm above — the shortest form that stays unambiguous. */
export function formatCountdown(msRemaining: number): string {
  const total = Math.max(0, Math.ceil(msRemaining / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export default function ResearchQuotaPill({
  quota,
  className = "",
}: {
  quota: ResearchQuota | null;
  className?: string;
}) {
  const resetMs = useMemo(
    () => (quota?.resetAt ? Date.parse(quota.resetAt) : null),
    [quota?.resetAt],
  );
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    // Only tick while there is something counting down — a timer running behind
    // a full quota is a re-render every second for a number that never changes.
    if (resetMs == null || resetMs <= Date.now()) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [resetMs]);

  if (!quota) return null;

  const remainingMs = resetMs != null ? resetMs - now : 0;
  const counting = resetMs != null && remainingMs > 0;
  const exhausted = quota.remaining <= 0;

  return (
    <div
      className={`flex items-center gap-2 text-[11px] tabular-nums text-fg-faint ${className}`}
      title={`${quota.used} of ${quota.limit} research runs used${
        counting ? ` · next unlocks in ${formatCountdown(remainingMs)}` : ""
      }`}
    >
      <span className="flex items-center gap-1" aria-hidden>
        {Array.from({ length: quota.limit }, (_, i) => (
          <span
            key={i}
            className={`h-1.5 w-1.5 rounded-full ${
              i < quota.used ? "bg-fg-faint/40" : "bg-emerald-500/70"
            }`}
          />
        ))}
      </span>
      <span>
        {quota.remaining}/{quota.limit}
      </span>
      {counting ? (
        <>
          <span className="text-fg-faint/50">·</span>
          <span className={exhausted ? "text-amber-600" : ""}>{formatCountdown(remainingMs)}</span>
        </>
      ) : null}
      {/* The pill is decorative to a screen reader; the sentence lives here. */}
      <span className="sr-only">
        {quota.remaining} of {quota.limit} research runs remaining
        {counting ? `, next available in ${formatCountdown(remainingMs)}` : ""}
      </span>
    </div>
  );
}
