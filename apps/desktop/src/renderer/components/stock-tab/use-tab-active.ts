import { useEffect, useState } from "react";
import { useHomeTabActivity } from "@/lib/home-tab-activity";

/**
 * Whether the Stock tab is the one in front, as state: what polls (the live
 * price, the book's prints) stops while the tab is kept hidden behind
 * another, and starts again with an immediate read when it comes back.
 */
export function useTabActive(): boolean {
  const activity = useHomeTabActivity();
  const [active, setActive] = useState(activity.isActive);
  useEffect(() => {
    setActive(activity.isActive());
    return activity.onChange(setActive);
  }, [activity]);
  return active;
}
