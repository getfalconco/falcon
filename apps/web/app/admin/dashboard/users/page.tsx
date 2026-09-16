import { listInvites, InviteTableMissingError, type Invite } from "@/lib/admin-invites";
import InviteManager from "../../components/InviteManager";
import AdminPageHeader from "../../components/AdminPageHeader";
import { ADMIN_SHELL } from "../../admin-theme";

export const dynamic = "force-dynamic";

export default async function UsersTabPage() {
  let invites: Invite[] = [];
  let missingTable = false;

  try {
    invites = await listInvites();
  } catch (error) {
    if (error instanceof InviteTableMissingError) {
      missingTable = true;
    } else {
      console.error("[admin users] invite load failed", error);
    }
  }

  return (
    <div className={`${ADMIN_SHELL} space-y-6`}>
      <AdminPageHeader
        eyebrow="Access"
        title="Users"
        description="Grant staff, manager, or Talent Manager access (invite link or direct grant)."
      />
      <InviteManager initialInvites={invites} missingTable={missingTable} />
    </div>
  );
}
