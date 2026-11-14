/**
 * F8 `activist_stake` (optional in M1): initial SCHEDULE 13D filings (XML
 * since 2024-12) on US-listed issuers. Code reads the cover (filers, percent
 * of class, event date) and Item 4 (purpose of transaction); Haiku 5.5 sorts
 * the purpose into a closed label set with a verbatim quote. Only activist
 * purposes become events (passive investment, a stake from an IPO or a
 * financing, or plain "investment purposes" boilerplate do not). sign +1,
 * own firm.
 */

import { decodeXml, filingsInWindow, indexPageUrl, parseSecHeader, submissionText } from "../feed/edgar.ts";
import { isListed, loadListings } from "../feed/companies.ts";
import { checkedQuote, clipDoc, structured, UNTRUSTED_NOTE } from "./llm.ts";
import type { Detector, DetectorContext, DetectorEvent } from "./types.ts";
import { displayName, eachLimit, edgarSource, inWindow } from "./util.ts";

export type Schedule13D = {
  issuerCik: string | null;
  issuerName: string;
  securityTitle: string;
  dateOfEvent: string | null;
  reportingPersons: string[];
  /** Highest percent of class on the cover, as written. */
  percentOfClass: string | null;
  purpose: string;
};

function tagText(xml: string, name: string): string | null {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(xml);
  return m ? decodeXml(m[1]!).trim() : null;
}

/** The cover and Item 4 of a SCHEDULE 13D XML (inside a submission text). Pure. */
export function parse13D(body: string): Schedule13D | null {
  const xml = /<edgarSubmission[\s\S]*?<\/edgarSubmission>/.exec(body)?.[0];
  if (!xml) return null;
  const pcts = [...xml.matchAll(/<percentOfClass>([^<]+)<\/percentOfClass>/g)].map((m) => m[1]!.trim());
  const best = pcts.sort((a, b) => Number(b) - Number(a))[0] ?? null;
  return {
    issuerCik: tagText(xml, "issuerCIK")?.replace(/^0+/, "").padStart(10, "0") ?? null,
    issuerName: tagText(xml, "issuerName") ?? "",
    securityTitle: tagText(xml, "securitiesClassTitle") ?? "",
    dateOfEvent: tagText(xml, "dateOfEvent"),
    reportingPersons: [...new Set([...xml.matchAll(/<reportingPersonName>([^<]+)<\/reportingPersonName>/g)].map((m) => decodeXml(m[1]!).trim()))],
    percentOfClass: best,
    purpose: tagText(xml, "transactionPurpose") ?? "",
  };
}

export const PURPOSE_LABELS = ["passive_or_investment_only", "board_representation", "strategy_or_operations_change", "sale_or_merger_push", "capital_return_push", "acquisition_proposal_by_filer", "other"] as const;
const ACTIVIST = new Set(["board_representation", "strategy_or_operations_change", "sale_or_merger_push", "capital_return_push", "acquisition_proposal_by_filer"]);

const LABEL_TEXT: Record<string, string> = {
  board_representation: "seeks board representation",
  strategy_or_operations_change: "plans to push for changes in strategy or operations",
  sale_or_merger_push: "plans to push for a sale or merger",
  capital_return_push: "plans to push for buybacks or dividends",
  acquisition_proposal_by_filer: "proposed to acquire the company",
};

export const PURPOSE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["label", "quote"],
  properties: {
    label: { type: "string", enum: [...PURPOSE_LABELS] },
    quote: { type: "string", description: "One sentence copied word for word from Item 4 that shows the label." },
  },
} as const;

export const PURPOSE_SYSTEM = `You classify Item 4 (purpose of transaction) of an initial SEC Schedule 13D. ${UNTRUSTED_NOTE}

Labels (closed set):
- passive_or_investment_only: acquired for investment; only the standard reservation of rights ("may in the future ... any of the actions in (a)-(j)"); shares received in an IPO, a merger or a financing; officers or directors of the issuer.
- board_representation: the filer seeks, nominated or agreed board seats.
- strategy_or_operations_change: the filer has engaged or intends to engage management about specific changes in strategy, operations, costs or governance.
- sale_or_merger_push: the filer pushes for a sale, merger, spin-off or strategic review.
- capital_return_push: the filer pushes for buybacks, dividends or a recapitalization.
- acquisition_proposal_by_filer: the filer proposed to acquire the issuer or take it private.
- other: anything else.
The standard boilerplate list of possible actions is not activism; a label needs a specific stated intent or action. The quote is one sentence copied word for word.`;

export function activistDetector(): Detector {
  return {
    eventTypes: ["activist_stake"],
    async detect(ctx: DetectorContext): Promise<DetectorEvent[]> {
      const listings = await loadListings();
      const { filings } = await filingsInWindow(["SCHEDULE 13D"], ctx.since, ctx.until, ctx.log);
      const out: DetectorEvent[] = [];
      const counts = { unlisted: 0, passive: 0, backlog: 0 };
      await eachLimit(filings, 4, async (f) => {
        try {
          const txt = await submissionText(f);
          const h = parseSecHeader(txt);
          const acceptedAt = h.acceptedAt ?? f.acceptedAt;
          if (!inWindow(acceptedAt, ctx.since, ctx.until)) return;
          const d = parse13D(txt);
          const issuerCik = d?.issuerCik ?? h.filerCik;
          const listing = issuerCik ? listings.byCik.get(issuerCik) : undefined;
          if (!d || !listing || !isListed(listing)) {
            counts.unlisted++;
            return;
          }
          if (d.purpose.length < 40) {
            counts.passive++;
            return;
          }
          const answer = (await structured(
            { system: PURPOSE_SYSTEM, user: `Issuer: ${d.issuerName}\nFilers: ${d.reportingPersons.slice(0, 5).join("; ")}\n<filing>\n${clipDoc(d.purpose, 20_000)}\n</filing>`, schema: PURPOSE_SCHEMA as unknown as Record<string, unknown>, maxTokens: 600 },
            ctx.llmBudgetUsd,
            ctx.log,
            `13D ${f.accession}`,
          )) as { label?: string; quote?: string } | null;
          if (!answer) {
            counts.backlog++;
            return;
          }
          const quote = checkedQuote(answer.quote, d.purpose);
          if (!answer.label || !ACTIVIST.has(answer.label) || !quote) {
            counts.passive++;
            return;
          }
          const company = displayName(listing.name);
          const filer = d.reportingPersons[0] ?? "A holder";
          const pct = d.percentOfClass ? ` ${d.percentOfClass}%` : "";
          out.push({
            id: `activist_stake-${f.accession}`,
            eventType: "activist_stake",
            family: "F8",
            cik: listing.cik,
            ticker: listing.ticker,
            companyName: company,
            acceptedAt: acceptedAt!,
            accession: f.accession,
            form: "SCHEDULE 13D",
            items: [],
            title: `${filer} disclosed a${pct} stake in ${company} and ${LABEL_TEXT[answer.label]}`,
            summary: [`${d.reportingPersons.slice(0, 3).join(", ")}${d.reportingPersons.length > 3 ? " and others" : ""} filed an initial Schedule 13D on ${company}${d.percentOfClass ? ` reporting ${d.percentOfClass}% of the ${d.securityTitle || "class"}` : ""}.`, `"${quote}"`],
            sign: 1,
            magnitude: null,
            facts: { filers: d.reportingPersons.join("; "), percentOfClass: d.percentOfClass ? Number(d.percentOfClass) : null, dateOfEvent: d.dateOfEvent, purposeLabel: answer.label },
            sources: [edgarSource(`Schedule 13D: ${company}`, indexPageUrl(listing.cik, f.accession), acceptedAt)],
            quotes: [quote],
            propagates: "own",
            watchOnlyReasons: [],
          });
        } catch (err) {
          ctx.log(`activist: ${f.accession} unreadable (${(err as Error).message.split("\n")[0]})`);
        }
      });
      ctx.log(`activist: ${filings.length} initial 13Ds, ${counts.unlisted} not on a US-listed issuer, ${counts.passive} passive or no quote, ${counts.backlog} not read by the model, ${out.length} events`);
      return out;
    },
  };
}
