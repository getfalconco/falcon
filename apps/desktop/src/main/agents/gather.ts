import type { Agent, AgentSource } from "../../shared/agent-types";
import type { AgentEngineState } from "./store";
import { focusText, type AgentDataSources, type NewsItem, type QuoteRead } from "./sources";
import { linkedLead, tierRelation } from "./linked";
import { changesFacts, changesLead, readUrl } from "./filing-changes";
import { matchesKeywords, type TriggerEvent } from "./triggers";
import { DAY_MS, nyYmd } from "./time";

/**
 * Everything a write-up may draw on, read once when an event fires.
 *
 * `facts` are lines this code writes from provider data (a quote, a Form 4's
 * fields); `documents` are texts quoted as they came (a press release); both
 * are what the model sees and nothing else. `corpus` is the same material as
 * one string, which the grounding check matches every figure against.
 *
 * A read that fails is said in the facts ("Consensus estimates were not
 * available."), never papered over.
 */

export type ReportMaterial = {
  /**
   * Paragraphs written here from the graph and the filings, printed above the
   * model's summary as they are (a linked report's link and evidence). The
   * model is shown them and told not to repeat them.
   */
  lead?: string;
  facts: string[];
  documents: Array<{ title: string; url?: string; text: string }>;
  sources: AgentSource[];
  corpus: string;
};

/** Words a results release uses for the numbers readers ask about. */
const RESULTS_TERMS = ["revenue", "margin", "guidance", "outlook", "per share", "eps", "net income", "operating income", "quarter", "segment", "data center", "cash flow"];

function fmtPct(n: number): string {
  return `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
}

function quoteFact(q: QuoteRead): string {
  const parts = [`${q.symbol} last ${q.price} (${q.session} session, as of ${q.asOf})`, `${fmtPct(q.changePct)} against the previous close`];
  if (q.previousClose !== null) parts.push(`previous close ${q.previousClose}`);
  if (q.regularChangePct !== null && q.session !== "regular") parts.push(`regular session ${fmtPct(q.regularChangePct)}`);
  return `${parts.join(", ")}.`;
}

function newsLine(n: NewsItem): string {
  return `${n.publishedAt ? `${n.publishedAt.slice(0, 16).replace("T", " ")} UTC` : "undated"}, ${n.source ?? "news"}: ${n.title}`;
}

function newsSource(n: NewsItem): AgentSource {
  return { title: n.title, url: n.url, publishedAt: n.publishedAt };
}

export async function gatherMaterial(
  event: TriggerEvent,
  agent: Agent,
  state: AgentEngineState,
  sources: AgentDataSources,
  now: Date,
): Promise<ReportMaterial> {
  const facts: string[] = [`Event: ${event.title}`, `Checked at ${now.toISOString()}.`];
  let lead: string | undefined;
  const documents: ReportMaterial["documents"] = [];
  const out: AgentSource[] = [];
  const ticker = event.ticker ?? agent.ticker;
  const terms = [...RESULTS_TERMS, ...agent.metrics.map((m) => m.label)];

  const tryRead = async <T>(what: string, read: () => Promise<T>): Promise<T | null> => {
    try {
      return await read();
    } catch {
      facts.push(`${what} could not be read.`);
      return null;
    }
  };

  const addQuote = async (symbol: string) => {
    const q = await tryRead(`The ${symbol} quote`, () => sources.quote(symbol));
    if (q) {
      facts.push(quoteFact(q));
      out.push({ title: `${symbol} quote, Yahoo Finance`, publishedAt: q.asOf });
    }
  };

  const addNews = (items: NewsItem[], label: string) => {
    if (items.length === 0) return;
    documents.push({ title: label, text: items.map(newsLine).join("\n") });
    for (const n of items) out.push(newsSource(n));
  };

  const addFilingDocs = async (maxEach: number) => {
    for (const f of (event.filings ?? []).slice(0, 3)) {
      const doc = await tryRead(`The ${f.form} filed ${f.filedAt}`, () => sources.filingText(f));
      out.push({ title: `${ticker ?? ""} ${f.form} filed ${f.filedAt}`.trim(), url: doc?.url ?? f.url, publishedAt: f.acceptedAt ?? f.filedAt });
      if (doc && doc.text) documents.push({ title: `${f.form} filed ${f.filedAt}`, url: doc.url, text: focusText(doc.text, terms, maxEach) });
    }
  };

  switch (event.kind) {
    case "earnings": {
      await addFilingDocs(28_000);
      if (ticker) {
        const pre = state.consensus?.[ticker];
        if (pre && now.getTime() - Date.parse(pre.readAt) < 10 * DAY_MS) {
          facts.push(`Consensus read before the release (${pre.readAt.slice(0, 10)}), Yahoo Finance:`, ...pre.lines);
          out.push({ title: "Analyst estimates, Yahoo Finance", publishedAt: pre.readAt });
        }
        const fresh = await tryRead("Consensus estimates", () => sources.consensus(ticker));
        if (fresh) {
          facts.push("Consensus read now, Yahoo Finance:", ...fresh.lines);
          if (!pre) out.push({ title: "Analyst estimates, Yahoo Finance", publishedAt: fresh.readAt });
        } else if (!pre) {
          facts.push("Consensus estimates were not available.");
        }
        await addQuote(ticker);
        const news = await tryRead("Company news", () => sources.news(ticker));
        const recent = (event.news ?? news ?? []).filter((n) => !n.publishedAt || Date.parse(n.publishedAt) > now.getTime() - 3 * DAY_MS);
        addNews(recent.slice(0, 8), `${ticker} headlines`);
      }
      break;
    }
    case "filing": {
      for (const x of event.insiderTxns ?? []) {
        const t = x.txn;
        facts.push(
          `Form 4 filed ${x.filing.filedAt}: ${t.insiderName} (${t.role}), transaction code ${t.code}` +
            `${t.direction ? `, ${t.direction}` : ""}${t.shares !== null ? `, ${t.shares} shares` : ""}` +
            `${t.price !== null ? ` at ${t.price}` : ""}${t.value !== null ? `, value ${t.value}` : ""}` +
            `${t.date ? `, traded ${t.date}` : ""}${t.plan10b51 ? ", under a 10b5-1 plan" : ""}.`,
        );
      }
      if (!event.insiderTxns || event.insiderTxns.length === 0) await addFilingDocs(event.filings && event.filings.length > 1 ? 9_000 : 20_000);
      else for (const f of event.filings ?? []) out.push({ title: `${ticker ?? ""} Form 4 filed ${f.filedAt}`.trim(), url: f.url, publishedAt: f.acceptedAt ?? f.filedAt });
      if (ticker) await addQuote(ticker);
      break;
    }
    case "price_move": {
      if (ticker) {
        await addQuote(ticker);
        const closes = await tryRead("Recent closes", () => sources.dailyCloses(ticker));
        if (closes && closes.length > 0) {
          facts.push(`Recent ${ticker} closes: ${closes.slice(-6).map((c) => `${c.date} ${c.close.toFixed(2)}`).join(", ")}.`);
        }
        const news = await tryRead("Company news", () => sources.news(ticker));
        addNews((news ?? []).filter((n) => !n.publishedAt || Date.parse(n.publishedAt) > now.getTime() - 2 * DAY_MS).slice(0, 8), `${ticker} headlines from the last 2 days`);
      }
      break;
    }
    case "news": {
      addNews(event.news ?? [], "New headlines");
      if (ticker) await addQuote(ticker);
      break;
    }
    case "macro": {
      const e = event.macro;
      if (e) facts.push(`Release: ${e.title}${e.period ? `, period ${e.period}` : ""}, scheduled ${e.date}${e.timeEt ? ` ${e.timeEt} ET` : ""} (curated calendar).`);
      if (!event.news || event.news.length === 0) facts.push("No coverage of the release was found in the market headlines yet.");
      addNews(event.news ?? [], "Market headlines since the release");
      await addQuote("SPY");
      await addQuote("TLT");
      break;
    }
    case "linked": {
      const hits = event.linked ?? [];
      const holding = event.ticker ?? agent.ticker ?? "";
      // The measured reaction only matters for a results release, and costs a radar read.
      const rt = hits.some((h) => h.kind === "earnings") && holding
        ? ((await tryRead("The read-through history", () => sources.readthrough(holding))) ?? [])
        : [];
      lead = linkedLead(hits, holding, rt);
      for (const p of lead.split(/\n{2,}/)) facts.push(p);
      for (const h of hits) {
        const c = h.company;
        facts.push(
          `Link: ${c.ticker} is ${tierRelation(c, holding)} (graph tier ${c.tierMeasured === false ? "unrated, ranked as important" : c.tier}${c.sharePct !== null ? `, disclosed share ${c.sharePct}%` : ", no share disclosed"}), from ${c.namedBy}'s ${c.form ?? "annual report"}${c.filingDate ? ` filed ${c.filingDate}` : ""}.`,
        );
        if (c.sourceUrl) out.push({ title: `${c.namedBy} ${c.form ?? "annual report"}${c.filingDate ? ` filed ${c.filingDate}` : ""}`, url: c.sourceUrl, publishedAt: c.filingDate ?? undefined });
      }
      const filingHits = hits.filter((h) => h.filing);
      for (const h of filingHits.slice(0, 3)) {
        const f = h.filing!;
        const doc = await tryRead(`The ${h.company.ticker} ${f.form} filed ${f.filedAt}`, () => sources.filingText(f));
        out.push({ title: `${h.company.ticker} ${f.form} filed ${f.filedAt}`, url: doc?.url ?? f.url, publishedAt: f.acceptedAt ?? f.filedAt });
        if (doc && doc.text) {
          documents.push({ title: `${h.company.ticker} ${f.form} filed ${f.filedAt}`, url: doc.url, text: focusText(doc.text, terms, filingHits.length > 1 ? 8_000 : 16_000) });
        }
      }
      addNews(hits.flatMap((h) => (h.news ? [h.news] : [])), "Material stories on the linked companies");
      for (const t of [...new Set(hits.map((h) => h.company.ticker))].slice(0, 3)) await addQuote(t);
      if (holding) await addQuote(holding);
      break;
    }
    case "filing_changes": {
      const fc = event.changes;
      if (fc && ticker) {
        lead = changesLead(fc.hits, ticker, fc.answer);
        for (const p of lead.split(/\n{2,}/)) facts.push(p);
        facts.push(...changesFacts(fc.hits, fc.answer));
        for (const h of fc.hits) {
          const f = h.filing;
          out.push({ title: `${ticker} ${f.form} filed ${f.filedAt}`, url: readUrl(h), publishedAt: f.acceptedAt ?? f.filedAt });
        }
        // The report each change is measured against.
        const bases = [fc.answer.previous, fc.hits.some((h) => h.firing.some((i) => i.kind === "quarter_risk_new")) ? fc.answer.latest : null];
        for (const b of bases) if (b) out.push({ title: `${ticker} ${b.form} filed ${b.filedAt}`, url: b.sectionUrl ?? b.url, publishedAt: b.filedAt });
        // The periodic report's own text around the changes, for what they are about.
        const periodic = fc.hits.filter((h) => /^(10-K|10-Q|20-F)/i.test(h.filing.form)).slice(0, 2);
        for (const h of periodic) {
          const f = h.filing;
          const doc = await tryRead(`The ${f.form} filed ${f.filedAt}`, () => sources.filingText(f));
          const words = h.firing.flatMap((i) => [i.text ?? "", i.name ?? ""]).filter((w) => w.length >= 6).map((w) => w.slice(0, 60));
          const changeTerms = [...words, "material weakness", "going concern", "independent registered public accounting firm", "sole source", "single source", "% of"];
          if (doc && doc.text) documents.push({ title: `${f.form} filed ${f.filedAt}`, url: doc.url, text: focusText(doc.text, changeTerms, periodic.length > 1 ? 7_000 : 12_000) });
        }
      }
      if (ticker) await addQuote(ticker);
      break;
    }
    case "schedule": {
      if (ticker) {
        await addQuote(ticker);
        const closes = await tryRead("Recent closes", () => sources.dailyCloses(ticker));
        if (closes && closes.length >= 6) {
          const end = closes[closes.length - 1]!;
          const base = closes[closes.length - 6]!;
          facts.push(`${ticker} over 5 sessions: ${base.date} ${base.close.toFixed(2)} to ${end.date} ${end.close.toFixed(2)}.`);
        }
        const since = Date.parse(agent.lastFiredAt ?? "") || now.getTime() - 7 * DAY_MS;
        const news = await tryRead("Company news", () => sources.news(ticker));
        addNews((news ?? []).filter((n) => !n.publishedAt || Date.parse(n.publishedAt) > since).slice(0, 8), `${ticker} headlines since the last digest`);
        const filings = await tryRead("SEC filings", () => sources.filings(ticker));
        const recentFilings = (filings ?? []).filter((f) => f.filedAt >= nyYmd(new Date(now.getTime() - 7 * DAY_MS))).slice(0, 8);
        if (recentFilings.length > 0) {
          facts.push(`SEC filings in the last 7 days: ${recentFilings.map((f) => `${f.form} (${f.filedAt})`).join(", ")}.`);
          for (const f of recentFilings.slice(0, 3)) out.push({ title: `${ticker} ${f.form} filed ${f.filedAt}`, url: f.url, publishedAt: f.filedAt });
        } else if (filings) {
          facts.push("No SEC filings in the last 7 days.");
        }
        const next = state.earnings?.[ticker];
        if (next) facts.push(`Next earnings date on the provider calendar: ${next.date}${next.estimated ? " (estimated)" : ""}.`);
      } else {
        // No company: the market's headlines, narrowed to the agent's topic when it has one.
        const topic = event.trigger.kind === "schedule" ? (event.trigger.keywords ?? []) : [];
        const news = await tryRead("Market headlines", () => sources.marketNews(new Date(now.getTime() - DAY_MS).toISOString()));
        if (topic.length > 0) {
          const matching = (news ?? []).filter((n) => matchesKeywords(n.title, topic));
          if (news && matching.length === 0) facts.push(`No market headline in the last day mentions ${topic.join(", ")}.`);
          addNews(matching.slice(0, 10), `Market headlines from the last day that mention ${topic.join(", ")}`);
        } else {
          addNews((news ?? []).slice(0, 10), "Market headlines from the last day");
        }
        await addQuote("SPY");
      }
      break;
    }
  }

  const corpus = [...facts, ...documents.map((d) => `${d.title}\n${d.text}`), ...out.map((s) => s.title)].join("\n");
  // One entry per url (or title), in the order they were read.
  const seen = new Set<string>();
  const unique = out.filter((s) => {
    const key = s.url ?? s.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return { ...(lead ? { lead } : {}), facts, documents, sources: unique.slice(0, 20), corpus };
}
