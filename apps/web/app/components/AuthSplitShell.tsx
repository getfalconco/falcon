"use client";

import GlassPanel from "./GlassPanel";

type Props = {
  children: React.ReactNode;
};

/**
 * Full-viewport auth layout: the form on the left, the homepage's fluted glass
 * on the right as an inset, rounded slab. Below lg the glass shrinks to a short
 * band above the form.
 */
export default function AuthSplitShell({ children }: Props) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-background font-sans">
      <div className="flex h-full w-full flex-col lg:grid lg:grid-cols-2">
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto bg-background lg:order-1">
          {children}
        </div>
        <div className="order-first shrink-0 p-3 lg:order-2 lg:h-full lg:min-h-0 lg:p-4 lg:pl-0">
          <GlassPanel className="h-24 w-full lg:h-full" />
        </div>
      </div>
    </div>
  );
}
