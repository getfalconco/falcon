import { redirect } from "next/navigation";
import { getAdminSession } from "@/lib/admin-session";

export default async function AdminPage() {
  const session = await getAdminSession();
  if (session?.access === "talent_manager") redirect("/admin/dashboard/jobs");
  if (session) redirect("/admin/dashboard");
  redirect("/login?next=/admin/dashboard");
}
