import { supabase } from "@/lib/supabase";
import type { BrokerageAccount, BrokerageNetWorth } from "../../shared/snaptrade";

export async function getAccessToken(): Promise<string | undefined> {
  const { data } = (await supabase?.auth.getSession()) ?? { data: { session: null } };
  return data.session?.access_token;
}

function parseAccounts(value: unknown): BrokerageAccount[] {
  if (!Array.isArray(value)) return [];
  const accounts: BrokerageAccount[] = [];
  for (const row of value) {
    if (!row || typeof row !== "object") continue;
    const a = row as Record<string, unknown>;
    const totalValue = Number(a.totalValue);
    accounts.push({
      id: String(a.id ?? ""),
      name: String(a.name ?? "Account"),
      institution: String(a.institution ?? ""),
      totalValue: Number.isFinite(totalValue) ? totalValue : null,
      authorizationId: typeof a.authorizationId === "string" ? a.authorizationId : null,
    });
  }
  return accounts;
}

/** Cloud snapshot of live brokerages — same row mobile reads. */
export async function fetchBrokerLinkSnapshot(): Promise<BrokerageNetWorth | null> {
  if (!supabase) return null;
  try {
    const { data: auth } = await supabase.auth.getSession();
    if (!auth.session) return null;

    const { data, error } = await supabase
      .from("broker_links")
      .select("connected,total,accounts")
      .eq("user_id", auth.session.user.id)
      .maybeSingle();
    if (error || !data) return null;

    const total = Number(data.total);
    const accounts = parseAccounts(data.accounts);
    return {
      connected: Boolean(data.connected) || accounts.length > 0,
      total: Number.isFinite(total) ? total : 0,
      accounts,
    };
  } catch {
    return null;
  }
}
