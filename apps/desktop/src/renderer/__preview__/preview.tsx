import { createRoot } from "react-dom/client";
import "../globals.css";
import InsightCard from "../components/dashboard/InsightCard";
import InsightPairFrame from "../components/dashboard/InsightPairFrame";
import LiftableCard from "../components/dashboard/LiftableCard";
import fixture from "./fixture.json";
import { runPricedIn } from "../../shared/propagation-progress";

/** Scratch harness: renders the second-order card against the local fixture. */
const params = new URLSearchParams(location.search);
const state = params.get("state") ?? "open";
const empty = state === "empty";
/** Surfacing on, a run present, but nothing left unpriced. */
const quiet = state === "quiet";
/** The real (non-synthetic) NVDA export-controls run from the local store. */
const useReal = state === "real" || state === "gated";
/** Surfacing off with runs in the store — what the app looks like while the
 *  Phase B flag is down. The headline rests; the field still draws. */
const gated = state === "gated";

/** The exact list the app's own store would hand the card. */
const realRuns: any[] = (fixture as any).realRuns;
// The fixture predates `priced_in`, which main computes when it projects a
// list item — recompute it here or the field renders every day as neutral.
const realList: any[] = ((fixture as any).realList as any[]).map((item) => {
  const full = realRuns.find((r) => r.run_id === item.run_id);
  return { ...item, priced_in: full ? runPricedIn(full.targets) : null };
});
const list = useReal ? realList : [(fixture as any).listItem];
const runById = (id: string) =>
  useReal ? realRuns.find((r) => r.run_id === id) : (fixture as any).run;

const quietRun = (r: any) => ({
  ...r,
  targets: r.targets.map((t: any) =>
    t.pricing?.status === "open" || t.pricing?.status === "partial"
      ? { ...t, pricing: { ...t.pricing, status: "priced" } }
      : t,
  ),
  summary: { ...r.summary, open: 0, partial: 0 },
});

(window as any).meridian = {
  listPropagationRuns: async () => ({ ok: true, runs: empty ? [] : list }),
  getPropagationStatus: async () => ({
    ok: true,
    status: { surfacing_enabled: !empty && !gated, metrics: {} },
  }),
  explainSelection: async (req: { selection: string; context?: string; ticker?: string }) => {
    // Deterministic stand-in for the model, with a visible delay so the
    // spinner state is exercised.
    await new Promise((r) => setTimeout(r, 700));
    if (/fail/i.test(req.selection)) return { ok: false, error: "no model configured" };
    const words = req.selection.trim().split(/\s+/).length;
    const kind = words <= 4 ? "term" : "passage";
    return {
      ok: true,
      cached: false,
      gloss: {
        kind,
        term: req.selection.trim(),
        english:
          kind === "term"
            ? "In markets, this is the rule change that removes a workaround exporters had been using, so shipments that were still getting through stop."
            : "The passage says Washington is reviewing whether to close the workaround that still lets these chips reach China.",
        in_context: kind === "term" ? `Here it is what would stop ${req.ticker ?? "the company"}'s remaining China revenue.` : "",
        finance_specific: true,
      },
    };
  },
  translateGloss: async (_req: { term: string; english: string }) => {
    await new Promise((r) => setTimeout(r, 600));
    return {
      ok: true,
      cached: false,
      turkish: "Piyasa dilinde bu, ihracatcilarin kullandigi bosluklari kapatan kural degisikligi.",
    };
  },
  getPropagationPairHistory: async ({ root, target }: { root: string; target: string }) => {
    await new Promise((r) => setTimeout(r, 400));
    const outcomes = ["hit", "hit", "partial", "miss", "open", "hit", "expired", "miss", "hit"];
    const events = outcomes.map((outcome, i) => ({
      run_id: `demo-${target}-${i}`,
      event_label: ["guides above consensus", "export restrictions", "supply agreement", "outlook cut"][i % 4],
      event_type: ["guidance", "regulatory_decision", "supply_chain", "guidance"][i % 4],
      event_direction: i % 3 === 0 ? "negative" : "positive",
      event_materiality: i % 4 === 0 ? "high" : "standard",
      event_ts: new Date(Date.now() - (i + 1) * 9 * 24 * 3600 * 1000).toISOString(),
      produced_at: new Date(Date.now() - (i + 1) * 9 * 24 * 3600 * 1000).toISOString(),
      expected_direction: "negative",
      transmission_tier: "strong",
      mechanism: "wafer and packaging bookings",
      pricing_status: outcome === "hit" ? "priced" : outcome === "miss" ? "contradicted" : outcome === "partial" ? "partial" : outcome === "expired" ? "stale" : "open",
      outcome,
      expected_pct: 0.03 + (i % 3) * 0.012,
      realized_pct: (outcome === "miss" ? 1 : -1) * (0.02 + (i % 4) * 0.008),
      ratio: outcome === "open" ? null : 0.6 + (i % 5) * 0.12,
      sessions_elapsed: 3 + i,
      progress: outcome === "open" ? 0 : outcome === "partial" ? 0.5 : 1,
    }));
    const hits = outcomes.filter((o) => o === "hit").length;
    const partials = outcomes.filter((o) => o === "partial").length;
    const misses = outcomes.filter((o) => o === "miss").length;
    return {
      ok: true,
      history: {
        root, target,
        label: target === "TSM" ? "Taiwan Semiconductor Manufacturing" : target,
        role: "supplier", tier: "important", mechanism: "wafer and packaging bookings",
        events,
        hits, partials, misses,
        open: outcomes.filter((o) => o === "open").length,
        expired: outcomes.filter((o) => o === "expired").length,
        hit_rate: (hits + partials) / (hits + partials + misses),
        avg_expected_pct: 0.038, avg_realized_pct: 0.027, avg_ratio: 0.71,
      },
    };
  },
  askInsightChat: async (req: any) => {
    (window as any).__lastChatRequest = req;
    await new Promise((r) => setTimeout(r, 600));
    const question = req.turns[req.turns.length - 1].text;
    if (/fail/i.test(question)) return { ok: false, error: "no model configured" };
    return {
      ok: true,
      reply:
        `Answering "${question}" against ${req.names.length} names the event reaches. ` +
        "The channel is Nvidia's own deployment footprint, so the read holds only while the joint " +
        "products keep shipping into racks Nvidia has already sold.",
    };
  },
  getPairExplanation: async (req: any) => {
    // Left on the window so a headless check can read what the frame sent.
    (window as any).__lastPairRequest = req;
    await new Promise((r) => setTimeout(r, 700));
    return {
      ok: true,
      source: "model",
      explanation: {
        run_id: req.run_id,
        target: req.target_ticker,
        headline: req.headline,
        outlook: {
          direction: "down",
          magnitude: "1-2%",
          horizon: "the next 2-3 sessions",
          conviction: "low",
          call: "Down 1-2% over the next few sessions, on a thin record.",
        },
        why: `${req.target_ticker} sits directly under ${req.root_ticker} in the accelerator supply chain: its wafer starts and advanced packaging bookings are set months ahead against ${req.root_ticker}'s own China-bound volumes.`,
        precedent: "Across nine calls on this pair the direction was right seven times, but the size landed at roughly 0.7 of what was expected — the name absorbs the shock more slowly than the root does.",
        this_time: "A rule that names one vendor rather than a performance threshold would keep the hit contained to the affected lines, so expect the lower half of the usual 3-4% band.",
        watch: [
          "Order-cut language in the next monthly revenue release",
          "Any CoWoS capacity reallocation announced to other customers",
          "A performance-threshold rewrite would widen this well past one vendor",
        ],
        model: "claude-opus-5",
        generated_at: new Date().toISOString(),
      },
    };
  },
  getInsightExplanation: async (req: any) => {
    await new Promise((r) => setTimeout(r, 900));
    return {
      ok: true,
      source: "model",
      explanation: {
        run_id: req.run_id,
        headline: req.headline,
        summary:
          "Washington is reviewing whether to close workarounds that let Nvidia keep selling downgraded AI accelerators into China. That would cut off a revenue channel Nvidia built specifically to stay inside the existing rules, and the demand hit runs back through its foundry and packaging supply chain.",
        points: [
          "TSM feels it through order cuts on Nvidia wafer and CoWoS bookings",
          "INTC exposure runs through joint product work, not direct China chip sales",
          "Watch the published rule text: a performance-threshold rewrite hits every vendor alike",
        ],
        model: "claude-opus-5",
        generated_at: new Date().toISOString(),
      },
    };
  },
  getPropagationRun: async (id: string) => {
    const r = runById(id);
    return r ? { ok: true, run: quiet ? quietRun(r) : r } : { ok: false };
  },
};

/** ?pair=TSM mounts the pair frame on its own — the panel's own transition
 *  needs a compositing tab, which a headless check does not have. */
const pairTicker = params.get("pair");

if (pairTicker) {
  createRoot(document.getElementById("root")!).render(
    <div className="min-h-screen bg-[#EAEAE6] p-10">
      <div className="mx-auto h-[70vh] w-[560px] rounded-3xl border border-white/60 bg-white/40 p-6">
        <InsightPairFrame
          rootTicker="NVDA"
          subject={{ ticker: pairTicker.toUpperCase(), label: "Taiwan Semiconductor Manufacturing", role: "supplier", tier: "important" }}
          request={{
            run_id: "demo-run",
            headline: "NVDA U.S. export controls on Nvidia chips to China",
            root_ticker: "NVDA",
            target_ticker: pairTicker.toUpperCase(),
          }}
          onBack={() => ((window as any).__wentBack = true)}
        />
      </div>
    </div>,
  );
} else {
createRoot(document.getElementById("root")!).render(
  <div className="flex min-h-screen items-center justify-center bg-[#EAEAE6] p-10">
    <div className="w-[380px] shrink-0">
      {/* ?lift=1 mirrors the dashboard, where every card is liftable. */}
      {params.get("lift") === "1" ? (
        <LiftableCard onLift={() => ((window as any).__lifted = true)}>
          <InsightCard />
        </LiftableCard>
      ) : (
        <InsightCard />
      )}
    </div>
  </div>,
);
}
