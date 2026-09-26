import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The two shapes every settings pane is built from: a titled section, and a
 * row inside it — what the setting is on the left, the control that changes
 * it on the right, with a hairline between one row and the next.
 */

export function SettingsSection({
  title,
  children,
  className,
}: {
  title: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("pb-6", className)}>
      <h2 className="text-[15px] font-medium text-[#1d1b1b]">{title}</h2>
      <div className="mt-1">{children}</div>
    </section>
  );
}

export function SettingsRow({
  label,
  description,
  children,
  className,
}: {
  label: string;
  /** One line under the label, for a setting whose name is not enough. */
  description?: string;
  /** The control. Sits at the right, whatever its width. */
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-center justify-between gap-6 border-b border-black/[0.06] py-4", className)}>
      <div className="min-w-0">
        <div className="text-[13.5px] font-normal text-[#1d1b1b]">{label}</div>
        {description ? (
          <p className="mt-1 text-[12.5px] font-normal leading-snug text-[#6b7280]">{description}</p>
        ) : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}
