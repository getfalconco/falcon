"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Live paper book — pull the ledger without a full browser reload. */
export default function LiveRefresh({ seconds = 30 }: { seconds?: number }) {
  const router = useRouter();
  useEffect(() => {
    const id = window.setInterval(() => router.refresh(), seconds * 1000);
    return () => window.clearInterval(id);
  }, [router, seconds]);
  return null;
}
