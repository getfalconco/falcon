import type { Agent, AgentChannel, AgentLine, AgentReport } from "../../../shared/agent-types";

/**
 * Where an agent's report goes once it is written. One implementation per
 * `AgentChannel`; the engine calls every channel the agent lists and records
 * each outcome on the timeline. A channel never throws: a notification that
 * cannot be shown must not cost the reader the report, which is already
 * stored by the time delivery runs.
 */

export type Delivery = {
  agent: Agent;
  report: AgentReport;
  /** Notification title: the agent's name. */
  title: string;
  /** One line: the headline. */
  body: string;
};

export type DeliveryResult = {
  channel: AgentChannel;
  status: "shown" | "held" | "off" | "unsupported" | "queued" | "failed";
  /** One line for the timeline. */
  note: string;
  /** `note` as a code, for the reader's language (see `AgentLine`). */
  line?: AgentLine;
};

export interface DeliveryChannel {
  readonly channel: AgentChannel;
  deliver(delivery: Delivery): DeliveryResult;
}

/** The notification text for a report: title is the agent, body the headline. */
export function deliveryFor(agent: Agent, report: AgentReport): Delivery {
  const body = report.headline.length > 180 ? `${report.headline.slice(0, 177).trimEnd()}...` : report.headline;
  return { agent, report, title: agent.name, body };
}
