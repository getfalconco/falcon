"use client";

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";
import type { AdminAccess } from "@/lib/admin-session";

const JOBS_PREFIX = "/admin/dashboard/jobs";

export default function TalentScopeGuard({
  access,
  children,
}: {
  access: AdminAccess;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();

  useEffect(() => {
    if (access !== "talent_manager") return;
    if (pathname.startsWith(JOBS_PREFIX)) return;
    router.replace(JOBS_PREFIX);
  }, [access, pathname, router]);

  if (access === "talent_manager" && !pathname.startsWith(JOBS_PREFIX)) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-[13px] text-[#9a9a9a]">
        Opening Internships…
      </div>
    );
  }

  return <>{children}</>;
}
