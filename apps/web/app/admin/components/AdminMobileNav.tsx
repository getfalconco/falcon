"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import type { AdminAccess } from "@/lib/admin-session";
import { ADMIN_MONO } from "../admin-theme";

const FOUNDER_LINKS = [
  { label: "Overview", href: "/admin/dashboard" },
  { label: "Waitlist", href: "/admin/dashboard/waitlist" },
  { label: "Users", href: "/admin/dashboard/users" },
  { label: "Internships", href: "/admin/dashboard/jobs" },
  { label: "Signals", href: "/admin/dashboard/signals" },
  { label: "Live paper", href: "/admin/dashboard/competition" },
  { label: "Engine", href: "/admin/dashboard/engine-health" },
  { label: "Analytics", href: "/admin/dashboard/analytics" },
  { label: "Settings", href: "/admin/dashboard/settings" },
];

const TALENT_LINKS = [{ label: "Internships", href: "/admin/dashboard/jobs" }];

export default function AdminMobileNav({ access }: { access: AdminAccess }) {
  const pathname = usePathname();
  const links = access === "talent_manager" ? TALENT_LINKS : FOUNDER_LINKS;

  return (
    <nav className="flex gap-1 overflow-x-auto border-b border-black/[0.06] bg-white px-3 py-2 lg:hidden">
      {links.map((item) => {
        const active =
          item.href === "/admin/dashboard"
            ? pathname === item.href
            : pathname.startsWith(item.href);
        return (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "shrink-0 rounded-lg px-2.5 py-1.5 text-[12px] transition",
              active
                ? "bg-[#1c1917] text-white"
                : "text-[#6b7280] hover:bg-black/[0.04] hover:text-[#1d1b1b]",
            )}
            style={{ fontFamily: ADMIN_MONO }}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}
