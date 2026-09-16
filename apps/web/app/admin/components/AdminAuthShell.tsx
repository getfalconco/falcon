"use client";

import AuthSplitShell from "../../components/AuthSplitShell";
import FullscreenLock from "../../components/FullscreenLock";

type Props = {
  children: React.ReactNode;
};

export default function AdminAuthShell({ children }: Props) {
  return (
    <div className="auth-fullscreen fixed inset-0 z-[100] overflow-hidden">
      <FullscreenLock />
      <AuthSplitShell>{children}</AuthSplitShell>
    </div>
  );
}
