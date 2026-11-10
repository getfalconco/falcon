import type { ReactNode } from "react";

/** Native: the app fills the real screen. The web build uses PhoneFrame.web.tsx. */
export default function PhoneFrame({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
