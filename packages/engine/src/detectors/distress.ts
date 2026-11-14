/**
 * F6 distress, own firm (design 3.2):
 *
 *   - `distress_nt`: NT 10-K / NT 10-Q / NT 20-F (Form 12b-25) of US-listed
 *     filers. Code reads Part III (why the report is late) and Part IV(3)
 *     (whether a significant change in results is expected, with the
 *     narrative). No LLM. sign -1.
 *   - `restatement_402`: 8-K item 4.02 (non-reliance on previously issued
 *     financial statements) of US-listed filers. Haiku 5.5 reads the scope:
 *     whether revenue is restated, which periods, and why, each with a
 *     verbatim quote. sign -1.
 */

import { htmlToText, sentences } from "../text.ts";
import { filingsInWindow, indexPageUrl, parseSecHeader, parseSubmissionDocuments, submissionText } from "../feed/edgar.ts";
import { isListed, loadListings } from "../feed/companies.ts";
import { eightKsFiled, eightKText, resolveAcceptance } from "../feed/eightk.ts";
import { checkedQuote, clipDoc, numbersNotIn, structured, UNTRUSTED_NOTE } from "./llm.ts";
import type { Detector, DetectorContext, DetectorEvent } from "./types.ts";
import { displayName, edgarSource, inWindow } from "./util.ts";
import { quoteInDocument } from "../text.ts";

export const NT_FORMS = ["NT 10-K", "NT 10-Q", "NT 20-F"];

export type NtNotice = {
  /** The late report: "10-K", "10-Q", "20-F". */
  subjectForm: string;
  /** Part III narrative without the form's instruction line. */
  reason: string;
  /** One to three sentences of it, verbatim. */
  reasonQuote: string | null;
  /** Part IV(3): true when "Yes" is ticked, false for "No", null when unreadable. */
  significantChange: boolean | null;
  /** The explanation under Part IV(3), when given. */
  changeNarrative: string | null;
  changeQuote: string | null;
};

const CHECKED = String.raw`(?:☒|☑|✓|✔|■|þ|ý|\[\s*[xX✓✔]\s*\]|\(\s*[xX]\s*\)|\b[xX]\b)`;
const UNCHECKED = String.raw`(?:☐|□|¨|o\b|\[\s*\]|\(\s*\))`;

/** Which of "Yes" / "No" is ticked in a short span of form text. Pure. */
export function tickedYesNo(span: string): boolean | null {
  const s = span.replace(/\s+/g, " ");
  const tests: Array<[RegExp, boolean]> = [
    [new RegExp(`${CHECKED}\\s*Yes\\s*${UNCHECKED}\\s*No`), true],
    [new RegExp(`${UNCHECKED}\\s*Yes\\s*${CHECKED}\\s*No`), false],
    [new RegExp(`Yes\\s*${CHECKED}\\s*No\\s*${UNCHECKED}`), true],
    [new RegExp(`Yes\\s*${UNCHECKED}\\s*No\\s*${CHECKED}`), false],
  ];
  for (const [re, v] of tests) if (re.test(s)) return v;
  return null;
}

/** First sentences of a narrative, verbatim, up to about `max` characters. Pure. */
export function leadQuote(text: string, max = 420): string | null {
  const ss = sentences(text.replace(/\n/g, " ")).filter((s) => s.length > 20);
  if (ss.length === 0) return null;
  let out = "";
  for (const s of ss) {
    if (out && out.length + s.length + 1 > max) break;
    out = out ? `${out} ${s}` : s;
    if (out.length >= 160) break;
  }
  if (out.length > max + 200) {
    const cut = out.slice(0, max);
    out = cut.slice(0, cut.lastIndexOf(" "));
  }
  return out;
}

const BOILERPLATE = /without unreasonable (?:effort|expense)|could not be (?:timely )?filed|within the prescribed/i;
const SAYS_WHY = /\b(because|due to|as a result|in order to|requires?|needs?|pending|until|delay(?:ed)?|restat\w+|impairment|auditor|bankruptcy|chapter 11)\b/i;

/**
 * The Part III sentences that say why: the form's stock sentence ("unable
 * without unreasonable effort or expense ...") is skipped when it gives no
 * cause and a later sentence does. Verbatim. Pure.
 */
export function reasonQuote(reason: string): string | null {
  const ss = sentences(reason.replace(/\n/g, " ")).filter((s) => s.length > 20);
  const start = ss.findIndex((s) => !BOILERPLATE.test(s) || SAYS_WHY.test(s));
  return leadQuote(ss.slice(start >= 0 ? start : 0).join(" "));
}

/** Part III and Part IV(3) of a Form 12b-25 in plain text. Pure. */
export function parseNtNotice(text: string, form: string): NtNotice {
  const subjectForm = form.replace(/^NT\s+/, "").replace(/\/A$/, "");
  const t = text.replace(/\r/g, "");
  const p3 = /PART\s+III\b[\s\S]*?NARRATIVE/i.exec(t);
  const p4 = /PART\s+IV\b[\s\S]{0,40}?OTHER\s+INFORMATION/i.exec(t);
  let reason = p3 ? t.slice(p3.index + p3[0].length, p4 && p4.index > p3.index ? p4.index : undefined) : "";
  // Drop the form's own instruction ("State below in reasonable detail ... prescribed period.").
  reason = reason.replace(/^[\s\S]*?(prescribed (?:due date|time )?period|could not be filed within the prescribed[^.]*)\.?\s*/i, "");
  reason = reason.replace(/\(Attach extra sheets if needed\.?\)/i, "").trim();
  let significantChange: boolean | null = null;
  let changeNarrative: string | null = null;
  if (p4) {
    const part4 = t.slice(p4.index);
    const q3 = /\(3\)[\s\S]*?significant change in results of operations[\s\S]*?portion thereof\??/i.exec(part4);
    if (q3) {
      const after = part4.slice(q3.index + q3[0].length);
      significantChange = tickedYesNo(after.slice(0, 120));
      const narrStart = /cannot be made\.?/i.exec(after);
      if (narrStart) {
        let narr = after.slice(narrStart.index + narrStart[0].length);
        const end = /\(Name of Registrant|\n\s*SIGNATURES?\b|has caused this notification/i.exec(narr);
        if (end) narr = narr.slice(0, end.index);
        // The registrant's name line just before "(Name of Registrant ...)".
        const lines = narr.trim().split("\n");
        if (end && /\(Name of Registrant/i.test(end[0]) && lines.length > 1) lines.pop();
        narr = lines.join("\n").trim();
        // A "No" answer has no narrative; what follows is boilerplate (forward-looking notes).
        if (significantChange !== false && narr.length > 40 && !/^(n\/?a|not applicable|none)\.?$/i.test(narr)) changeNarrative = narr;
      }
    }
  }
  return {
    subjectForm,
    reason,
    reasonQuote: reasonQuote(reason),
    significantChange,
    changeNarrative,
    changeQuote: changeNarrative ? leadQuote(changeNarrative, 360) : null,
  };
}

export function ntEvent(args: {
  accession: string;
  form: string;
  cik: string;
  ticker: string | null;
  companyName: string;
  acceptedAt: string;
  indexUrl: string;
  notice: NtNotice;
  docText: string;
}): DetectorEvent {
  const { notice: n } = args;
  const company = displayName(args.companyName);
  const quotes = [n.reasonQuote, n.changeQuote].filter((q): q is string => !!q && quoteInDocument(q, args.docText));
  const summary = [`${company} told the SEC it will not file its ${n.subjectForm} on time (Form 12b-25).`];
  if (n.reasonQuote) summary.push(`Reason given: "${n.reasonQuote}"`);
  if (n.significantChange === true) summary.push(n.changeQuote ? `It expects a significant change in results from the prior-year period: "${n.changeQuote}"` : "It expects a significant change in results from the prior-year period.");
  return {
    id: `distress_nt-${args.accession}`,
    eventType: "distress_nt",
    family: "F6",
    cik: args.cik,
    ticker: args.ticker,
    companyName: company,
    acceptedAt: args.acceptedAt,
    accession: args.accession,
    form: args.form,
    items: [],
    title: `${company} filed a late-filing notice for its ${n.subjectForm}`,
    summary,
    sign: -1,
    magnitude: null,
    facts: {
      lateReport: n.subjectForm,
      reason: n.reasonQuote,
      significantChangeExpected: n.significantChange,
      changeNarrative: n.changeQuote,
    },
    sources: [edgarSource(`${args.form}: ${company}`, args.indexUrl, args.acceptedAt)],
    quotes,
    propagates: "own",
    watchOnlyReasons: n.reasonQuote ? [] : ["late-filing reason not readable"],
  };
}

export function distressNtDetector(): Detector {
  return {
    eventTypes: ["distress_nt"],
    async detect(ctx: DetectorContext): Promise<DetectorEvent[]> {
      const listings = await loadListings();
      const { filings } = await filingsInWindow(NT_FORMS, ctx.since, ctx.until, ctx.log);
      const out: DetectorEvent[] = [];
      let unlisted = 0;
      for (const f of filings) {
        const listing = f.ciks.map((c) => listings.byCik.get(c)).find((l) => isListed(l));
        if (!listing) {
          unlisted++;
          continue;
        }
        try {
          const txt = await submissionText(f);
          const h = parseSecHeader(txt);
          const acceptedAt = h.acceptedAt ?? f.acceptedAt;
          if (!inWindow(acceptedAt, ctx.since, ctx.until)) continue;
          const doc = parseSubmissionDocuments(txt).find((d) => /^NT /.test(d.type)) ?? parseSubmissionDocuments(txt)[0];
          if (!doc) continue;
          const text = htmlToText(doc.body);
          out.push(
            ntEvent({
              accession: f.accession,
              form: f.form,
              cik: listing.cik,
              ticker: listing.ticker,
              companyName: listing.name,
              acceptedAt: acceptedAt!,
              indexUrl: indexPageUrl(listing.cik, f.accession),
              notice: parseNtNotice(text, f.form),
              docText: text,
            }),
          );
        } catch (err) {
          ctx.log(`distress_nt: ${f.accession} unreadable (${(err as Error).message.split("\n")[0]})`);
        }
      }
      ctx.log(`distress_nt: ${filings.length} NT filings, ${unlisted} not US-listed, ${out.length} events`);
      return out;
    },
  };
}

export const RESTATEMENT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["is_non_reliance", "revenue_restated", "periods", "reason", "quote_scope", "quote_reason"],
  properties: {
    is_non_reliance: { type: "boolean", description: "True when the filing says previously issued financial statements should no longer be relied upon." },
    revenue_restated: { type: "string", enum: ["yes", "no", "unclear"], description: "Whether the error affects reported revenue." },
    periods: { type: "string", description: "The periods that can no longer be relied on, as the filing names them." },
    reason: { type: "string", description: "The error in at most 25 words, using the filing's words." },
    quote_scope: { type: "string", description: "Verbatim sentence from the filing naming the periods and statements affected." },
    quote_reason: { type: "string", description: "Verbatim sentence from the filing describing the error (for revenue, the one that says so)." },
  },
} as const;

export const RESTATEMENT_SYSTEM = `You read SEC Form 8-K Item 4.02 filings (non-reliance on previously issued financial statements) and report their scope as structured data. ${UNTRUSTED_NOTE}

Rules:
- Quotes must be copied word for word from the filing, one sentence each, no edits.
- revenue_restated is "yes" only when the filing says the error affects revenue (net sales, revenue recognition). "no" when it names another line (expenses, warrants, leases, taxes, classification) and not revenue. "unclear" otherwise.
- Do not add numbers, dates or periods that the filing does not state.`;

export function restatementDetector(): Detector {
  return {
    eventTypes: ["restatement_402"],
    async detect(ctx: DetectorContext): Promise<DetectorEvent[]> {
      const listings = await loadListings();
      const all = await eightKsFiled(ctx.since, ctx.until, ctx.log);
      const routed = all.filter((k) => k.items.includes("4.02"));
      const out: DetectorEvent[] = [];
      let backlog = 0;
      for (const k0 of routed) {
        const listing = k0.ciks.map((c) => listings.byCik.get(c)).find((l) => isListed(l));
        if (!listing) continue;
        try {
          const k = await resolveAcceptance(k0);
          if (!inWindow(k.acceptedAt, ctx.since, ctx.until)) continue;
          const text = await eightKText(k, { exhibits: true });
          const doc = text.main || text.exhibits99;
          const company = displayName(listing.name);
          const answer = (await structured(
            { system: RESTATEMENT_SYSTEM, user: `Company: ${company}\n<filing>\n${clipDoc(doc, 40_000)}\n</filing>`, schema: RESTATEMENT_SCHEMA as unknown as Record<string, unknown>, maxTokens: 800 },
            ctx.llmBudgetUsd,
            ctx.log,
            `restatement ${k.accession}`,
          )) as Record<string, unknown> | null;
          if (answer === null) backlog++;
          const ev = restatementEvent({ k: { ...k, acceptedAt: k.acceptedAt! }, ticker: listing.ticker, cik: listing.cik, company, doc, answer });
          if (ev) out.push(ev);
        } catch (err) {
          ctx.log(`restatement_402: ${k0.accession} unreadable (${(err as Error).message.split("\n")[0]})`);
        }
      }
      ctx.log(`restatement_402: ${routed.length} 8-Ks with item 4.02, ${out.length} events${backlog ? `, ${backlog} not read by the model (no key or budget spent)` : ""}`);
      return out;
    },
  };
}

/** The 4.02 event from the model's reading, checked against the filing. Pure. */
export function restatementEvent(args: { k: { accession: string; form: string; items: string[]; acceptedAt: string; indexUrl: string }; ticker: string; cik: string; company: string; doc: string; answer: Record<string, unknown> | null }): DetectorEvent | null {
  const { k, company, doc, answer } = args;
  if (answer && answer.is_non_reliance === false) return null;
  const scopeQ = checkedQuote(answer?.quote_scope, doc);
  const reasonQ = checkedQuote(answer?.quote_reason, doc);
  const watch: string[] = [];
  if (!answer) watch.push("scope not read (LLM unavailable or budget spent)");
  else if (!scopeQ && !reasonQ) watch.push("model quotes not found in the filing");
  let revenue = answer && typeof answer.revenue_restated === "string" ? (answer.revenue_restated as string) : "unclear";
  const periods = typeof answer?.periods === "string" ? (answer.periods as string) : null;
  const reason = typeof answer?.reason === "string" ? (answer.reason as string) : null;
  // Facts written by the model may not carry numbers the filing does not hold.
  const facts = [periods, reason].filter((x): x is string => !!x);
  if (facts.some((f) => numbersNotIn(f, doc).length > 0)) {
    watch.push("model facts carry numbers not in the filing");
    revenue = "unclear";
  }
  if (revenue === "yes" && !reasonQ) revenue = "unclear";
  const summary = [`${company} said previously issued financial statements should no longer be relied upon (8-K Item 4.02).`];
  if (scopeQ) summary.push(`"${scopeQ}"`);
  if (reasonQ && reasonQ !== scopeQ) summary.push(`"${reasonQ}"`);
  return {
    id: `restatement_402-${k.accession}`,
    eventType: "restatement_402",
    family: "F6",
    cik: args.cik,
    ticker: args.ticker,
    companyName: company,
    acceptedAt: k.acceptedAt,
    accession: k.accession,
    form: k.form,
    items: k.items,
    title: revenue === "yes" ? `${company} said past financial statements cannot be relied on, including revenue` : `${company} said past financial statements cannot be relied on`,
    summary,
    sign: -1,
    magnitude: null,
    facts: { revenueRestated: revenue, periods: watch.length ? null : periods, reason: watch.length ? null : reason },
    sources: [edgarSource(`8-K Item 4.02: ${company}`, k.indexUrl, k.acceptedAt)],
    quotes: [scopeQ, reasonQ].filter((q): q is string => !!q),
    propagates: "own",
    watchOnlyReasons: watch,
  };
}
