import JobsManager from "../../components/JobsManager";
import AdminPageHeader from "../../components/AdminPageHeader";
import { ADMIN_SHELL } from "../../admin-theme";

export default function AdminJobsPage() {
  return (
    <div className={`${ADMIN_SHELL} space-y-6`}>
      <AdminPageHeader
        eyebrow="Hiring"
        title="Internships"
        description="Three-stage funnel for getfalcon.co/jobs: applications, task scoring, interviews, intern panel."
      />
      <JobsManager />
    </div>
  );
}
