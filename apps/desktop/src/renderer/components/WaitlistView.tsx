import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";
import WindowControls from "@/components/WindowControls";
import WaitlistStatusCard from "@/components/WaitlistStatusCard";
import { readWaitlistEmail } from "@/lib/auth";
import { getMembership, type Membership } from "@/lib/waitlist-api";

export default function WaitlistView() {
  const [membership, setMembership] = useState<Membership | null>(null);
  const [loading, setLoading] = useState(true);
  const email = readWaitlistEmail();

  useEffect(() => {
    let cancelled = false;
    if (!email) {
      setLoading(false);
      return;
    }
    void getMembership(email).then((result) => {
      if (cancelled) return;
      setMembership(result);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [email]);

  return (
    <div className="relative flex h-full flex-col">
      <WindowControls className="absolute right-4 top-[5px] z-50" />
      <div className="app-drag-region absolute left-0 right-[5.5rem] top-0 h-9" aria-hidden />

      <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-8 py-10">
        {loading ? (
          <Loader2 className="h-5 w-5 animate-spin text-black/30" aria-hidden />
        ) : (
          <WaitlistStatusCard
            fullName={membership?.name ?? ""}
            memberNumber={membership?.memberNumber ?? null}
            grantedAt={membership?.grantedAt ?? null}
          />
        )}
      </div>
    </div>
  );
}
