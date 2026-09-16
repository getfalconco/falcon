import { getOverviewData } from "@/lib/admin-overview";
import MetricCard from "../components/overview/MetricCard";
import ActivityFeed from "../components/overview/ActivityFeed";
import EngineHealthCard from "../components/overview/EngineHealthCard";
import Sparkline from "../components/overview/Sparkline";
import TimeRangeSelect from "../components/overview/TimeRangeSelect";
import AdminPageHeader from "../components/AdminPageHeader";
import { ADMIN_SHELL } from "../admin-theme";
import { formatNumber } from "../components/overview/helpers";

export const dynamic = "force-dynamic";

export default async function OverviewPage() {
  const data = await getOverviewData();
  const { metrics } = data;

  const lastUpdated = new Date(data.generatedAt).toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
  });

  return (
    <div className={`${ADMIN_SHELL} space-y-6`}>
      <AdminPageHeader
        eyebrow="Dashboard"
        title="Overview"
        description={`Last updated ${lastUpdated}`}
        actions={<TimeRangeSelect />}
      />

      {data.degraded ? (
        <p className="rounded-xl border border-amber-200/80 bg-amber-50 px-4 py-2.5 text-[12px] text-amber-900">
          Live data is unavailable right now — showing placeholders.
        </p>
      ) : null}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <MetricCard
          label="Total users"
          value={formatNumber(metrics.totalUsers)}
          change={metrics.totalUsersChange}
          subtitle="vs. last week"
          href="/admin/dashboard/users"
        />
        <MetricCard
          label="Waitlist pending"
          value={formatNumber(metrics.waitlistPending)}
          subtitle={metrics.waitlistTodayLabel}
          href="/admin/dashboard/waitlist"
        />
        <MetricCard
          label="Weekly active"
          value={formatNumber(metrics.weeklyActive)}
          subtitle={metrics.retentionLabel ?? "active in last 7d"}
          href="/admin/dashboard/analytics"
        />
        <MetricCard
          label="Engine cost / mo"
          notTracked={metrics.engineCostLabel === null}
          value={metrics.engineCostLabel ?? undefined}
          href="/admin/dashboard/engine-health"
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <ActivityFeed events={data.activity} />
        </div>
        <div className="flex flex-col gap-3">
          <EngineHealthCard engine={data.engine} />
          <Sparkline points={data.sparkline} />
        </div>
      </div>
    </div>
  );
}
