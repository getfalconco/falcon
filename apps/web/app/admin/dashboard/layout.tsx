import { redirect } from "next/navigation";
import Link from "next/link";
import { getAdminSession } from "@/lib/admin-session";
import AdminSidebar from "../components/AdminSidebar";
import AdminMobileNav from "../components/AdminMobileNav";
import TalentScopeGuard from "../components/TalentScopeGuard";
import { ADMIN_BG, ADMIN_MONO, ADMIN_TEXT } from "../admin-theme";

export const dynamic = "force-dynamic";

export default async function AdminDashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await getAdminSession();
  if (!session) redirect("/login?next=/admin/dashboard");

  return (
    <div className={`flex min-h-screen ${ADMIN_BG} ${ADMIN_TEXT}`}>
      <AdminSidebar adminEmail={session.email} access={session.access} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-11 shrink-0 items-center justify-end border-b border-black/[0.06] bg-[#fdfdfd]/90 px-4 backdrop-blur-sm sm:px-6">
          <Link
            href="/"
            className="text-[11px] text-[#9a9a9a] transition hover:text-[#1d1b1b]"
            style={{ fontFamily: ADMIN_MONO }}
          >
            getfalcon.co
          </Link>
        </header>
        <AdminMobileNav access={session.access} />
        <main className="min-w-0 flex-1">
          <TalentScopeGuard access={session.access}>{children}</TalentScopeGuard>
        </main>
      </div>
    </div>
  );
}
