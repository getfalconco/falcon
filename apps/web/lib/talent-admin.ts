import type { SupabaseClient } from "@supabase/supabase-js";

/** After product sign-in, open Internships-only admin cookie if eligible. */
export async function tryOpenTalentAdminSession(
  client: SupabaseClient,
): Promise<boolean> {
  const { data } = await client.auth.getSession();
  const token = data.session?.access_token;
  if (!token) return false;

  const res = await fetch("/api/admin/talent-session", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.ok;
}
