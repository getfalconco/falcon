import type { Metadata } from "next";
import { getInvite, type InviteRole, type InviteStatus } from "@/lib/admin-invites";
import InviteClaimView from "@/app/components/InviteClaimView";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Your invitation — Falcon",
  robots: { index: false, follow: false },
};

export default async function InvitePage({ params }: { params: { token: string } }) {
  let status: InviteStatus | "invalid" = "invalid";
  let role: InviteRole | null = null;

  try {
    const invite = await getInvite(params.token);
    if (invite) {
      status = invite.status;
      role = invite.role;
    }
  } catch (error) {
    // Missing table / unreachable Supabase → treat as an invalid link.
    console.error("[invite page] token lookup failed", error);
  }

  return <InviteClaimView token={params.token} status={status} role={role} />;
}
