import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import AddAssetModal from "@/components/dashboard/AddAssetModal";
import { useDemoMode } from "@/lib/demo-mode";
import { createPaperAccount, hasPaperAccount, subscribePaperAccount } from "@/lib/paper-account";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/utils";

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
 * The empty state both portfolio cards share: one line saying what is missing, and the
 * button that fixes it. The button opens the same add-asset flow the app has always had
 * — a Falcon paper account, or a brokerage.
 */
export default function ConnectPortfolioEmpty({
  line,
  onColor = false,
}: {
  line: string;
  /** Drawn on a card with a colour of its own (the Net Worth card's blue): white type, a white button. */
  onColor?: boolean;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative flex h-full min-h-0 w-full flex-col items-center justify-center overflow-hidden">
      <p
        className={cn(
          "relative max-w-[280px] text-center text-[13px] font-normal leading-snug",
          onColor ? "text-[rgba(255,255,255,0.7)]" : "text-[rgb(161,161,161)]",
        )}
      >
        {line}
      </p>
      <button
        type="button"
        data-no-lift
        onClick={() => setOpen(true)}
        className={cn(
          "app-no-drag relative mt-4 flex items-center rounded-lg px-[18px] py-[9px] text-[13px] font-normal not-italic leading-[20px] transition-colors duration-150",
          onColor
            ? "bg-[rgb(255,255,255)] text-[rgb(10,12,48)] hover:bg-[rgba(255,255,255,0.88)]"
            : "bg-[#1d1b1b] text-[rgb(231,231,231)] hover:bg-black active:bg-black",
        )}
      >
        {t("dashboard.connect.button")}
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
