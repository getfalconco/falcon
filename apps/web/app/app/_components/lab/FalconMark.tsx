import { Sparkles } from "lucide-react";

/**
 * The Falcon AI mark: the AI spark (lucide `Sparkles`), stroked in the text
 * colour so it follows the light and dark themes, at the app's 1.75 stroke.
 * The left rail, the Falcon AI page header and the "Ask Falcon AI" buttons use
 * the same glyph. `FalconBadge` sets it in a small round tile, the assistant's
 * avatar in the chat and on the empty state.
 */

export const ASSISTANT_NAME = "Falcon AI";

export function FalconMark({ size = 16, strokeWidth = 1.75, className = "" }: { size?: number; strokeWidth?: number; className?: string }) {
  return <Sparkles width={size} height={size} strokeWidth={strokeWidth} aria-hidden className={`shrink-0 ${className}`} />;
}

export function FalconBadge({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-flex shrink-0 items-center justify-center rounded-full bg-fore text-surface ${className}`}
      style={{ width: size, height: size }}
    >
      <FalconMark size={Math.round(size * 0.58)} strokeWidth={size >= 32 ? 1.75 : 2} />
    </span>
  );
}
