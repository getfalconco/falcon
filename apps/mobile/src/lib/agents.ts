import { requireSupabase } from "@/lib/supabase";

/**
 * Tracking agents live in `public.tracking_agents`, whose RLS scopes every
 * operation to `auth.uid() = user_id` — so the mobile client can do full CRUD
 * with the anon key and the signed-in user's JWT. Shape mirrors
 * apps/desktop/src/shared/tracking-agent.ts.
 *
 * PLATFORM-ONLY: desktop.
 * Reason: agent chat / tracking timeline live in Electron userData and have
 * no server-backed API yet — mobile detail stays pause/resume/delete + brief.
 */

export type AgentStatus = "active" | "paused" | "triggered";
export type AgentFrequency = "daily" | "weekly";

export type TrackingAgent = {
  id: string;
  user_id: string;
  name: string;
  watch_condition: string;
  check_frequency: AgentFrequency;
  signal_id: string | null;
  tickers: string[];
  metrics: string[];
  goal: string | null;
  source_headline: string | null;
  company_name: string | null;
  status: AgentStatus;
  created_at: string;
  last_checked_at: string | null;
};

const AGENT_COLUMNS =
  "id,user_id,name,watch_condition,check_frequency,signal_id,tickers,metrics,goal," +
  "source_headline,company_name,status,created_at,last_checked_at";

export async function listAgents(): Promise<TrackingAgent[]> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("tracking_agents")
    .select(AGENT_COLUMNS)
    .order("created_at", { ascending: false });

  if (error) throw new Error(error.message);
  return (data ?? []) as unknown as TrackingAgent[];
}

export async function getAgent(id: string): Promise<TrackingAgent | null> {
  const client = requireSupabase();
  const { data, error } = await client
    .from("tracking_agents")
    .select(AGENT_COLUMNS)
    .eq("id", id)
    .maybeSingle();

  if (error) throw new Error(error.message);
  return (data as unknown as TrackingAgent) ?? null;
}

export type CreateAgentInput = {
  name: string;
  watchCondition: string;
  checkFrequency: AgentFrequency;
  tickers: string[];
  metrics?: string[];
  goal?: string | null;
  signalId?: string | null;
  sourceHeadline?: string | null;
  companyName?: string | null;
};

export async function createAgent(input: CreateAgentInput): Promise<TrackingAgent> {
  const client = requireSupabase();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) throw new Error("Sign in to create an agent.");

  const { data, error } = await client
    .from("tracking_agents")
    .insert({
      user_id: user.id,
      name: input.name.trim(),
      watch_condition: input.watchCondition.trim(),
      check_frequency: input.checkFrequency,
      signal_id: input.signalId ?? null,
      tickers: input.tickers.map((t) => t.toUpperCase()),
      metrics: input.metrics ?? [],
      goal: input.goal ?? null,
      source_headline: input.sourceHeadline ?? null,
      company_name: input.companyName ?? null,
      status: "active",
      last_checked_at: null,
    })
    .select(AGENT_COLUMNS)
    .single();

  if (error) throw new Error(error.message);
  return data as unknown as TrackingAgent;
}

export async function setAgentStatus(
  id: string,
  status: Extract<AgentStatus, "active" | "paused">,
): Promise<void> {
  const client = requireSupabase();
  const { error } = await client
    .from("tracking_agents")
    .update({ status })
    .eq("id", id);

  if (error) throw new Error(error.message);
}

export async function deleteAgent(id: string): Promise<void> {
  const client = requireSupabase();
  const { error } = await client.from("tracking_agents").delete().eq("id", id);
  if (error) throw new Error(error.message);
}
