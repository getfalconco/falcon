import type { DigestEntry, DigestFile } from "../store";
import type { Delivery, DeliveryChannel, DeliveryResult } from "./types";

/**
 * The daily digest: a report on this channel sends no notification of its
 * own. It is held in the account's digest file (`digest.json`, see store.ts),
 * and once a day, at `DIGEST_TIME` local, the engine sends one notification
 * for everything held from before that time (`digestDue`). The report itself
 * is in the app from the moment it is written, as every report is.
 */

/** When the digest goes out, local wall-clock time. */
export const DIGEST_TIME = "08:00";

export type DigestChannelDeps = {
  append: (entry: DigestEntry) => void;
  newId: () => string;
  now?: () => Date;
};

export function createDigestChannel(deps: DigestChannelDeps): DeliveryChannel {
  const now = deps.now ?? (() => new Date());
  return {
    channel: "digest",
    deliver(d: Delivery): DeliveryResult {
      try {
        deps.append({ id: deps.newId(), at: now().toISOString(), agentId: d.agent.id, reportId: d.report.id, title: d.title, body: d.body });
        return { channel: "digest", status: "queued", note: `Held for the daily digest (${DIGEST_TIME}).`, line: { code: "delivery.digestQueued", params: { time: DIGEST_TIME } } };
      } catch {
        return { channel: "digest", status: "failed", note: "The report could not be held for the daily digest.", line: { code: "delivery.digestFailed" } };
      }
    },
  };
}

/** The local calendar day of an instant, YYYY-MM-DD. */
export function localYmd(at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}`;
}

/**
 * What the digest sends now, if anything: the entries held from before
 * today's digest time, once today's time has come and today's digest has not
 * gone out yet. A report that lands after the time waits for tomorrow's.
 */
export function digestDue(file: DigestFile, now: Date, time = DIGEST_TIME): DigestEntry[] {
  if (file.entries.length === 0) return [];
  const today = localYmd(now);
  if (file.lastSentDay === today) return [];
  const [hh, mm] = time.split(":").map(Number);
  const due = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hh, mm, 0, 0).getTime();
  if (now.getTime() < due) return [];
  return file.entries.filter((e) => Date.parse(e.at) < due);
}
