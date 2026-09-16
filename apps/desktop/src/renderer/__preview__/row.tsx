import { createRoot } from "react-dom/client";
import "../globals.css";

/**
 * Scratch harness: the card row exactly as HomePage lays it out —
 * flexible slots, centred, capped at 340px — with stand-in card bodies so
 * only the geometry is under test.
 */
const slots = ["ASSETS", "INSIGHT", "RISK SCORE", "VOLATILITY COMPRESSION"];

/** Stand-in body: the shared glass frame and a heading, nothing else. */
function SlotCard({ title }: { title: string }) {
  return (
    <div className="relative flex h-full min-h-[560px] w-full flex-col rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      <div className="flex items-center justify-between">
        <span className="select-none font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">{title}</span>
      </div>
      <div className="flex-1" />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <div className="min-h-screen bg-[#EAEAE6]">
    <div className="flex items-stretch justify-center gap-4 px-8 pb-12 pt-6" data-testid="row">
      {slots.map((title) => (
        <div key={title} className="w-full min-w-0 max-w-[400px] flex-1 basis-0">
          <SlotCard title={title} />
        </div>
      ))}
    </div>
  </div>,
);
