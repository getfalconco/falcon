import { createRoot } from "react-dom/client";
import "../globals.css";
import DashboardCta from "../components/dashboard/DashboardCta";
import { DASHBOARD_CONFIG } from "../lib/dashboard-config";

/**
 * Scratch harness: the three dashboard CTA shapes, rendered under whichever
 * state the query asks for, so the switch can be checked both ways.
 */
if (new URLSearchParams(location.search).get("ctas") === "on") {
  DASHBOARD_CONFIG.dashboardCtasEnabled = true;
}

(window as any).__clicks = 0;
const count = () => ((window as any).__clicks += 1);

createRoot(document.getElementById("root")!).render(
  <div className="flex min-h-screen items-center justify-center bg-[#EAEAE6] p-10">
    <div className="w-[340px] shrink-0 space-y-3 rounded-3xl border border-white/60 bg-white/40 p-5">
      <div className="flex items-stretch gap-2">
        <DashboardCta
          onClick={count}
          className="glass-cta flex-1 py-2 text-center font-sans text-[12.5px] font-medium"
          disabledClassName="border-white/10 bg-[#1d1b1b]/40 text-white/75 shadow-none ring-black/[0.02]"
        >
          View Details
        </DashboardCta>
        <DashboardCta
          onClick={count}
          ariaLabel="Next propagation"
          className="glass-cta flex w-[42px] shrink-0 items-center justify-center"
          disabledClassName="border-white/10 bg-[#1d1b1b]/40 text-white/75 shadow-none ring-black/[0.02]"
        >
          →
        </DashboardCta>
      </div>
      <DashboardCta
        onClick={count}
        className="flex items-center gap-0.5 text-[12px] text-[#9CA3AF] transition-colors hover:text-[#1d1b1b]"
      >
        See all
      </DashboardCta>
    </div>
  </div>,
);
