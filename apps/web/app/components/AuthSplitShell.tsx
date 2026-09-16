"use client";

import AnimatedGradientPanel from "./AnimatedGradientPanel";

type Props = {
  children: React.ReactNode;
};

/** Full-viewport split layout matching the desktop app login screen. */
export default function AuthSplitShell({ children }: Props) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-background font-sans">
      <div className="grid h-full w-full grid-cols-[minmax(0,0.82fr)_minmax(0,1.18fr)] overflow-hidden">
        <div className="min-h-0 min-w-0 overflow-hidden">
          <AnimatedGradientPanel />
        </div>
        <div className="relative flex h-full min-h-0 min-w-0 flex-col bg-background">
          {children}
        </div>
      </div>
    </div>
  );
}
