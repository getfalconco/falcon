import { requireSupabase } from "@/lib/supabase";
import type { Step1Result } from "../../shared/step1-research";

type JobRow = {
  id: string;
  ticker: string | null;
  status: string;
  error: string | null;
  result: unknown;
  created_at: string;
};

function isStep1Result(value: unknown): value is Step1Result {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return typeof row.ticker === "string" && Array.isArray(row.validated);
}

export async function fetchLatestSharedStep1(ticker: string): Promise<Step1Result | null> {
  const client = requireSupabase();
  const symbol = ticker.trim().toUpperCase();
  const { data, error } = await client
    .from("research_jobs")
    .select("id,ticker,status,error,result,created_at")
    .eq("kind", "step1")
    .eq("ticker", symbol)
    .eq("status", "done")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error || !data) return null;
  const row = data as JobRow;
  return isStep1Result(row.result) ? row.result : null;
}

export async function saveSharedStep1(result: Step1Result): Promise<void> {
  const client = requireSupabase();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return;

  const { error } = await client.from("research_jobs").insert({
    user_id: user.id,
    kind: "step1",
    ticker: result.ticker.toUpperCase(),
    status: "done",
    stage: "done",
    result,
  });
  if (error) {
    console.warn("[step1] could not save shared job:", error.message);
  }
}

export async function getAccessToken(): Promise<string | undefined> {
  const client = requireSupabase();
  const {
    data: { session },
  } = await client.auth.getSession();
  return session?.access_token;
}
