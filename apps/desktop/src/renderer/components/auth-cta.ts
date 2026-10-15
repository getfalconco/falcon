import { cn } from "@/lib/utils";

/**
 * The one primary button of a sign-in or setup screen (Continue, Save
 * password, Open your desk), enabled or not. The colours are written in the
 * auth screens' own vocabulary, which the `.auth-surface` light remap in
 * globals.css turns into an ink pill; `auth-cta` is the hook the dark theme
 * keys on, since the dark palette would otherwise read `bg-white` as a
 * raised surface and put the live button a step below its disabled one.
 */
export function authCtaClass(active: boolean): string {
  return cn(
    "auth-cta",
    active
      ? "border-white/10 bg-white text-black"
      : "cursor-not-allowed border-white/[0.06] bg-[#2a2a2a] text-[#666666]",
  );
}
