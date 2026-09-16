import ProgressMetricCard, {
  type PeriodOption,
} from "@/components/ui/progress-metric-card";
import { getAnalyticsData } from "@/lib/admin-analytics";
import { formatNumber } from "../../components/overview/helpers";
import AdminPageHeader from "../../components/AdminPageHeader";
import { ADMIN_SHELL } from "../../admin-theme";

export const dynamic = "force-dynamic";

// Series carry one point per day; windows are expressed in trailing days.
const PERIODS: PeriodOption[] = [
  { label: "Past 7 days", points: 7 },
  { label: "Past 14 days", points: 14 },
  { label: "Past 30 days" },
];

export default async function AnalyticsTabPage() {
  const data = await getAnalyticsData({ days: 30 });

  const lastUpdated = new Date(data.generatedAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className={`${ADMIN_SHELL} space-y-6`}>
      <AdminPageHeader
        eyebrow="Growth"
        title="Analytics"
        description={`Growth & engagement · last 30 days · updated ${lastUpdated}`}
      />

      {data.degraded ? (
        <p className="mt-5 rounded-lg border border-amber-200/80 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900">
          Live data is unavailable right now — showing placeholders.
        </p>
      ) : null}

      <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <ProgressMetricCard
          title="Total users"
          total={formatNumber(data.totalUsers)}
          deltaLabel="today"
          accent="sky"
          data={data.usersCumulative}
          periodOptions={PERIODS}
          period="Past 30 days"
          showStats={false}
        />

        <ProgressMetricCard
          title="New signups"
          unit="signups"
          data={data.signupsDaily}
          periodOptions={PERIODS}
          period="Past 30 days"
          defaultView="bars"
        />

        <div className="lg:col-span-2">
          {data.signalsMissingTable ? (
            <p className="mb-3 rounded-lg border border-amber-200/80 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900">
              The <code className="rounded bg-black/[0.04] px-1">second_order_signals</code> table
              does not exist yet, so the opportunities series is empty.
            </p>
          ) : null}
          <ProgressMetricCard
            title="Second-order signals"
            unit="signals"
            accent="violet"
            data={data.opportunitiesDaily}
            periodOptions={PERIODS}
            period="Past 30 days"
            defaultView="bars"
          />
        </div>
      </div>
    </div>
  );
}
