import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Plus, type LucideIcon } from "lucide-react";
import AddAssetModal from "@/components/dashboard/AddAssetModal";
import { useDemoMode } from "@/lib/demo-mode";
import { createPaperAccount, hasPaperAccount, subscribePaperAccount } from "@/lib/paper-account";

/**
 * Is there anything to show? A Falcon paper account (or demo mode standing in
 * for one), or a brokerage linked through SnapTrade. Until one of those
 * exists, a card full of zeros and empty column heads says nothing — the
 * cards show the way in instead.
 */
export function usePortfolioConnected(): boolean {
  const demo = useDemoMode();
  const [paper, setPaper] = useState<boolean>(() => hasPaperAccount());
  const [broker, setBroker] = useState(false);

  useEffect(() => subscribePaperAccount(() => setPaper(hasPaperAccount())), []);
  useEffect(() => {
    let cancelled = false;
    void window.meridian
      ?.getBrokerageNetWorth?.()
      .then((res) => {
        if (!cancelled && res?.ok && res.networth.connected && res.networth.accounts.length > 0) {
          setBroker(true);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  return demo != null || paper || broker;
}

/**
 * The empty state both portfolio cards share: a large grey glyph sunk into
 * the card's surface, one line saying what is missing, and the button that
 * fixes it. The button opens the same add-asset flow the app has always had
 * — a Falcon paper account, or a brokerage.
 */
export default function ConnectPortfolioEmpty({
  Icon,
  line,
}: {
  /** The glyph behind the text — the card's own subject, drawn large and faint. */
  Icon: LucideIcon;
  line: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col items-center justify-center overflow-hidden">
      <Icon
        aria-hidden
        strokeWidth={1}
        className="pointer-events-none absolute left-1/2 top-1/2 h-[min(70%,260px)] w-auto -translate-x-1/2 -translate-y-1/2 text-[#1d1b1b]/[0.06]"
      />
      <p className="relative max-w-[280px] text-center text-[13px] font-normal leading-snug text-[#6b7280]">
        {line}
      </p>
      <button
        type="button"
        data-no-lift
        onClick={() => setOpen(true)}
        className="app-no-drag relative mt-4 flex items-center gap-1.5 rounded-lg bg-[#1d1b1b] px-4 py-2 text-[12.5px] font-normal text-white transition-colors duration-150 hover:bg-black active:bg-black"
      >
        <Plus className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        Connect your portfolio
      </button>

      {open
        ? createPortal(
            <AddAssetModal
              onClose={() => setOpen(false)}
              onCreatePaperAccount={(balance) => {
                createPaperAccount(balance);
                setOpen(false);
              }}
            />,
            document.body,
          )
        : null}
    </div>
  );
}
