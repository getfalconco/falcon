import { ADMIN_SHELL } from "../../admin-theme";
import AdminPageHeader from "../../components/AdminPageHeader";
import WaitlistManager from "../../components/WaitlistManager";

export default function WaitlistTabPage() {
  return (
    <div className={`${ADMIN_SHELL} space-y-6`}>
      <AdminPageHeader
        eyebrow="Access"
        title="Waitlist"
        description="Review and approve early-access applicants."
      />
      <WaitlistManager />
    </div>
  );
}
