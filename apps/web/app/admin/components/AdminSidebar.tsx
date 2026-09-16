"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  ClipboardList,
  Users,
  Radio,
  Activity,
  BarChart3,
  LineChart,
  Settings,
  LogOut,
  Briefcase,
  Wallet,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { AdminAccess } from "@/lib/admin-session";
import BrandMark from "../../components/BrandMark";
import { ADMIN_MONO, ADMIN_SERIF } from "../admin-theme";

type NavItem = {
  label: string;
  href: string;
  icon: typeof LayoutDashboard;
};

const FOUNDER_NAV: NavItem[] = [
  { label: "Overview", href: "/admin/dashboard", icon: LayoutDashboard },
  { label: "Waitlist", href: "/admin/dashboard/waitlist", icon: ClipboardList },
  { label: "Users", href: "/admin/dashboard/users", icon: Users },
  { label: "Internships", href: "/admin/dashboard/jobs", icon: Briefcase },
  { label: "Signals", href: "/admin/dashboard/signals", icon: Radio },
  { label: "Live paper", href: "/admin/dashboard/competition", icon: LineChart },
  { label: "Engine health", href: "/admin/dashboard/engine-health", icon: Activity },
  { label: "API usage", href: "/admin/dashboard/api-usage", icon: Wallet },
  { label: "Analytics", href: "/admin/dashboard/analytics", icon: BarChart3 },
  { label: "Settings", href: "/admin/dashboard/settings", icon: Settings },
];

const TALENT_NAV: NavItem[] = [
  { label: "Internships", href: "/admin/dashboard/jobs", icon: Briefcase },
];

export default function AdminSidebar({
  adminEmail,
  access = "founder",
}: {
  adminEmail: string;
  access?: AdminAccess;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const nav = access === "talent_manager" ? TALENT_NAV : FOUNDER_NAV;
  const brand = access === "talent_manager" ? "Talent Ops" : "Falcon Admin";

  async function handleLogout() {
    await fetch("/api/admin/logout", { method: "POST" });
    const next =
      access === "talent_manager"
        ? "/login?next=/admin/dashboard/jobs"
        : "/login?next=/admin/dashboard";
    router.replace(next);
    router.refresh();
  }

  return (
    <aside className="sticky top-0 hidden h-screen w-[240px] shrink-0 flex-col border-r border-black/10 bg-white lg:flex">
      <div className="flex h-14 items-center gap-2.5 border-b border-black/[0.06] px-5">
        <Link href="/" aria-label="Falcon home" className="shrink-0">
          <BrandMark size={28} />
        </Link>
        <span
          className="text-[15px] tracking-tight text-[#1d1b1b]"
          style={{ fontFamily: ADMIN_SERIF, fontWeight: 400 }}
        >
          {brand}
        </span>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        <ul className="space-y-0.5">
          {nav.map((item) => {
            const active =
              item.href === "/admin/dashboard"
                ? pathname === item.href
                : pathname.startsWith(item.href);
            const Icon = item.icon;
            return (
              <li key={item.href}>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] transition-colors",
                    active
                      ? "bg-[#1c1917] text-white"
                      : "text-[#6b7280] hover:bg-black/[0.04] hover:text-[#1d1b1b]",
                  )}
                >
                  <Icon className="h-[15px] w-[15px]" strokeWidth={1.75} />
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </nav>

      <div className="border-t border-black/[0.06] p-3">
        <div
          className="truncate px-2.5 pb-2 text-[11px] text-[#9a9a9a]"
          style={{ fontFamily: ADMIN_MONO }}
          title={adminEmail}
        >
          {adminEmail}
        </div>
        <button
          type="button"
          onClick={() => void handleLogout()}
          className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] text-[#6b7280] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
        >
          <LogOut className="h-[15px] w-[15px]" strokeWidth={1.75} />
          Sign out
        </button>
      </div>
    </aside>
  );
}
