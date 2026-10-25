import { Check } from "lucide-react";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { authCtaClass } from "@/components/auth-cta";

export const onboardingInputClass =
  "app-no-drag w-full border-b border-white/15 bg-transparent px-0 py-2.5 text-sm text-white outline-none transition placeholder:text-content-secondary focus:border-white/40";

export const onboardingTextareaClass = cn(onboardingInputClass, "min-h-[4.5rem] resize-none");

export function OnboardingShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-1 flex-col items-center justify-center px-8">
        <div className="w-full max-w-[420px]">{children}</div>
      </div>
    </div>
  );
}

export function OnboardingProgress({ index, total }: { index: number; total: number }) {
  // Right-aligned so it never collides with the back button on the left.
  return (
    <p className="app-no-drag pointer-events-none absolute right-8 top-16 text-[10px] uppercase tracking-[0.14em] text-white/25">
      {index} / {total}
    </p>
  );
}

type ContinueButtonProps = {
  disabled?: boolean;
  loading?: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className?: string;
};

export function OnboardingContinueButton({
  disabled,
  loading,
  onClick,
  children,
  className,
}: ContinueButtonProps) {
  const active = !disabled && !loading;
  return (
    <button
      type="button"
      disabled={!active}
      onClick={onClick}
      className={cn(
        "app-no-drag mt-8 flex h-11 w-full items-center justify-center gap-2 border text-sm font-medium transition",
        authCtaClass(active),
        className,
      )}
    >
      {children}
    </button>
  );
}

export function OnboardingSkipLink({
  onClick,
  className,
  children,
}: {
  onClick: () => void;
  className?: string;
  children?: React.ReactNode;
}) {
  const t = useT();
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "app-no-drag mt-3 w-full text-center text-xs text-white/35 transition hover:text-white/60",
        className,
      )}
    >
      {children ?? t("auth.onboarding.skip")}
    </button>
  );
}

type OptionButtonProps = {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
  subtitle?: React.ReactNode;
  /** A toggle in a set (the desk's cards) rather than one answer of several: it shows a check and says it is pressed. */
  toggle?: boolean;
  disabled?: boolean;
};

export function OnboardingOptionButton({
  selected,
  onClick,
  children,
  subtitle,
  toggle = false,
  disabled = false,
}: OptionButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={toggle ? selected : undefined}
      className={cn(
        "app-no-drag flex w-full items-center gap-3 border px-4 py-3.5 text-left text-sm transition disabled:cursor-not-allowed disabled:opacity-60",
        selected
          ? "border-white/25 bg-white/[0.06] text-white"
          : "border-white/10 bg-transparent text-white/70 hover:border-white/20 hover:text-white",
      )}
    >
      <span className="min-w-0 flex-1">
        <span className="block">{children}</span>
        {subtitle ? <span className="mt-0.5 block text-xs text-white/40">{subtitle}</span> : null}
      </span>
      {toggle ? (
        <span
          aria-hidden
          className={cn(
            "flex h-4 w-4 shrink-0 items-center justify-center border transition",
            selected ? "border-white/40 text-white" : "border-white/15 text-transparent",
          )}
        >
          <Check className="h-3 w-3" strokeWidth={2.25} />
        </span>
      ) : null}
    </button>
  );
}
