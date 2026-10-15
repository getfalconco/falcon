import { useEffect, useState } from "react";
import { isStaffAccount } from "../../shared/staff";
import { supabase } from "./supabase";

/**
 * Whether the signed-in account is Falcon staff, for hiding or disabling the
 * controls that change the shared engine for every account (classifier
 * switches, the risk card flag, the run-now buttons). The engine refuses
 * those to non-staff regardless; this only keeps the app from offering a
 * control that cannot work. False until the session is read, so a control is
 * never briefly live for a member.
 */
export function useIsStaff(): boolean {
  const [staff, setStaff] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    let alive = true;
    void supabase.auth.getSession().then(
      ({ data }) => alive && setStaff(isStaffAccount(data.session?.user?.app_metadata)),
      () => alive && setStaff(false),
    );
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (alive) setStaff(isStaffAccount(session?.user?.app_metadata));
    });
    return () => {
      alive = false;
      subscription.unsubscribe();
    };
  }, []);

  return staff;
}
