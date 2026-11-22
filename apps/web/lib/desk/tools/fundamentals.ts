/**
 * `fundamentals(ticker)`: revenue, margins, EPS, shares, cash and debt from
 * the company's own XBRL filings (SEC company facts), and market cap and
 * multiples from Yahoo's last price. Every figure carries its period end.
 *
 * Quarters: 3-month facts as filed, plus quarters derived from year-to-date
 * figures (Q4 = fiscal year less nine months; cash-flow items such as D&A are
 * only filed year to date). Restated figures win (the latest filing for a
 * period). TTM = the last four quarters when they are contiguous, else the
 * last fiscal year. Foreign filers (20-F, IFRS) usually have annual figures
 * only; then TTM is the last fiscal year and quarters are empty.
 */

import type { FieldSource } from "../citations";
import { companyFacts, companyForTicker, type CompanyFacts, type XbrlFact } from "./sec";
import { yahooQuote } from "./yahoo";
import { TtlCache, ToolError, cached, num, nyStamp, round, type DeskToolContext } from "./util";

const DAY = 86_400_000;

export type Period = { start: string; end: string; value: number; filed: string; form: string; derived?: string };
export type Series = { concept: string; unit: string; quarters: Period[]; annual: Period[] };
export type Instant = { concept: string; unit: string; end: string; value: number; filed: string };

const days = (start: string, end: string) => Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
const nextDay = (ymd: string) => new Date(Date.parse(`${ymd}T00:00:00Z`) + DAY).toISOString().slice(0, 10);
const isQuarter = (d: number) => d >= 80 && d <= 100;
const isYear = (d: number) => d >= 350 && d <= 380;

/** One fact per period (start..end): the latest filed wins (restatements). Pure. */
function latestPerPeriod(facts: XbrlFact[]): XbrlFact[] {
  const by = new Map<string, XbrlFact>();
  for (const f of facts) {
    if (!f.start || !f.end || typeof f.val !== "number" || !Number.isFinite(f.val)) continue;
    const k = `${f.start}|${f.end}`;
    const known = by.get(k);
    if (!known || f.filed > known.filed) by.set(k, f);
  }
  return Array.from(by.values());
}

/**
 * Quarters and fiscal years from duration facts: 3-month facts as filed,
 * quarters derived from consecutive year-to-date facts with the same start
 * (Q2 = 6 months - Q1, Q4 = 12 months - 9 months), fiscal years of 350..380
 * days. Oldest first. Pure.
 */
export function durationSeries(facts: XbrlFact[], perShare = false): { quarters: Period[]; annual: Period[] } {
  const all = latestPerPeriod(facts);
  const toPeriod = (f: XbrlFact, derived?: string): Period => ({ start: f.start!, end: f.end, value: f.val, filed: f.filed, form: f.form, ...(derived ? { derived } : {}) });
  const quarters = new Map<string, Period>();
  const annual: Period[] = [];
  for (const f of all) {
    const d = days(f.start!, f.end);
    if (isQuarter(d)) quarters.set(f.end, toPeriod(f));
    else if (isYear(d)) annual.push(toPeriod(f));
  }
  // Year-to-date chains: same start, ends a quarter apart.
  const byStart = new Map<string, XbrlFact[]>();
  for (const f of all) {
    const d = days(f.start!, f.end);
    if (d < 80 || d > 380) continue;
    byStart.set(f.start!, [...(byStart.get(f.start!) ?? []), f]);
  }
  for (const chain of Array.from(byStart.values())) {
    chain.sort((a, b) => (a.end < b.end ? -1 : 1));
    for (let i = 1; i < chain.length; i++) {
      const prev = chain[i - 1]!;
      const cur = chain[i]!;
      const gap = days(nextDay(prev.end), cur.end);
      if (!isQuarter(gap)) continue;
      const known = Array.from(quarters.values()).some((q) => Math.abs(Date.parse(q.end) - Date.parse(cur.end)) <= 3 * DAY);
      if (known) continue;
      const months = Math.round(days(prev.start!, prev.end) / 30.4);
      quarters.set(cur.end, {
        start: nextDay(prev.end),
        end: cur.end,
        value: cur.val - prev.val,
        filed: cur.filed,
        form: cur.form,
        derived: `${Math.round(days(cur.start!, cur.end) / 30.4)} months less ${months} months${perShare ? " (per-share figures do not subtract exactly)" : ""}`,
      });
    }
  }
  const byEnd = (a: Period, b: Period) => (a.end < b.end ? -1 : 1);
  return { quarters: Array.from(quarters.values()).sort(byEnd), annual: annual.sort(byEnd) };
}

/** Trailing twelve months: the last fiscal year when it ends with the last quarter, else four contiguous quarters, else the last fiscal year. Pure. */
export function ttm(s: { quarters: Period[]; annual: Period[] }): { value: number; periodEnd: string; basis: string } | null {
  const lastQ = s.quarters.at(-1);
  const lastY = s.annual.at(-1);
  if (lastY && (!lastQ || lastY.end >= lastQ.end)) return { value: lastY.value, periodEnd: lastY.end, basis: "fiscal year" };
  const four = s.quarters.slice(-4);
  if (four.length === 4) {
    const span = days(four[0]!.start, four[3]!.end);
    const contiguous = four.every((q, i) => i === 0 || Math.abs(Date.parse(q.start) - Date.parse(nextDay(four[i - 1]!.end))) <= 3 * DAY);
    if (contiguous && isYear(span)) return { value: four.reduce((t, q) => t + q.value, 0), periodEnd: four[3]!.end, basis: "sum of last 4 quarters" };
  }
  if (lastY) return { value: lastY.value, periodEnd: lastY.end, basis: "last fiscal year (no recent quarters)" };
  return null;
}

/* ------------------------------------------------------------------ concepts */

type Taxonomy = "us-gaap" | "ifrs-full";

const CONCEPTS: Record<Taxonomy, Record<string, string[]>> = {
  "us-gaap": {
    revenue: [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "Revenues",
      "SalesRevenueNet",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
      "SalesRevenueGoodsNet",
      "RevenuesNetOfInterestExpense",
    ],
    grossProfit: ["GrossProfit"],
    costOfRevenue: ["CostOfRevenue", "CostOfGoodsAndServicesSold", "CostOfGoodsSold", "CostOfGoodsAndServiceExcludingDepreciationDepletionAndAmortization"],
    operatingIncome: ["OperatingIncomeLoss"],
    netIncome: ["NetIncomeLoss", "NetIncomeLossAvailableToCommonStockholdersBasic", "ProfitLoss"],
    epsDiluted: ["EarningsPerShareDiluted", "EarningsPerShareBasicAndDiluted"],
    epsBasic: ["EarningsPerShareBasic"],
    da: ["DepreciationDepletionAndAmortization", "DepreciationAmortizationAndAccretionNet", "DepreciationAndAmortization", "Depreciation"],
    dilutedShares: ["WeightedAverageNumberOfDilutedSharesOutstanding"],
    cash: ["CashAndCashEquivalentsAtCarryingValue", "CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents", "Cash"],
    shortTermInvestments: ["MarketableSecuritiesCurrent", "ShortTermInvestments", "AvailableForSaleSecuritiesDebtSecuritiesCurrent", "AvailableForSaleSecuritiesDebtSecurities"],
    debtTotal: ["LongTermDebt", "DebtAndCapitalLeaseObligations"],
    debtNoncurrent: ["LongTermDebtNoncurrent"],
    debtCurrent: ["LongTermDebtCurrent", "DebtCurrent"],
    shortDebt: ["CommercialPaper", "ShortTermBorrowings"],
  },
  "ifrs-full": {
    revenue: ["Revenue", "RevenueFromContractsWithCustomers"],
    grossProfit: ["GrossProfit"],
    costOfRevenue: ["CostOfSales"],
    operatingIncome: ["ProfitLossFromOperatingActivities"],
    netIncome: ["ProfitLossAttributableToOwnersOfParent", "ProfitLoss"],
    epsDiluted: ["DilutedEarningsLossPerShare"],
    epsBasic: ["BasicEarningsLossPerShare"],
    da: ["DepreciationAndAmortisationExpense", "DepreciationAmortisationAndImpairmentLossReversalOfImpairmentLossRecognisedInProfitOrLoss"],
    dilutedShares: ["AdjustedWeightedAverageShares"],
    cash: ["CashAndCashEquivalents"],
    shortTermInvestments: ["CurrentInvestments"],
    debtTotal: ["Borrowings"],
    debtNoncurrent: ["NoncurrentPortionOfNoncurrentBorrowings", "LongtermBorrowings"],
    debtCurrent: ["CurrentBorrowingsAndCurrentPortionOfNoncurrentBorrowings", "ShorttermBorrowings"],
    shortDebt: [],
  },
};

const CURRENCY = /^[A-Z]{3}$/;
const PER_SHARE = /^[A-Z]{3}\/shares$/;

function pickUnit(units: Record<string, XbrlFact[]>, kind: "money" | "perShare" | "shares"): string | null {
  const keys = Object.keys(units).filter((u) => (kind === "money" ? CURRENCY.test(u) : kind === "perShare" ? PER_SHARE.test(u) : u === "shares"));
  if (!keys.length) return null;
  // The unit with the most recent fact (a foreign filer's USD convenience figures can stop early); USD on a tie.
  const usd = (u: string) => u === "USD" || u === "USD/shares";
  return keys.sort((a, b) => latestEnd(units[b]!).localeCompare(latestEnd(units[a]!)) || Number(usd(b)) - Number(usd(a)))[0]!;
}

const latestEnd = (facts: XbrlFact[]) => facts.reduce((m, f) => (f.end > m ? f.end : m), "");

/** Of the candidate concepts, the duration series whose data is most recent (ties: the order given). Pure. */
export function bestSeries(facts: CompanyFacts["facts"], taxonomy: Taxonomy, names: string[], kind: "money" | "perShare" | "shares"): Series | null {
  let best: Series | null = null;
  let bestEnd = "";
  for (const concept of names) {
    const units = facts[taxonomy]?.[concept]?.units;
    if (!units) continue;
    const unit = pickUnit(units, kind);
    if (!unit) continue;
    const s = durationSeries(units[unit]!, kind === "perShare");
    const end = [s.quarters.at(-1)?.end ?? "", s.annual.at(-1)?.end ?? ""].sort().at(-1)!;
    if (end && end > bestEnd) {
      best = { concept, unit, ...s };
      bestEnd = end;
    }
  }
  return best;
}

/** The latest balance-sheet value among the candidate concepts. Pure. */
export function latestInstant(facts: CompanyFacts["facts"], taxonomy: Taxonomy, names: string[]): Instant | null {
  let best: Instant | null = null;
  for (const concept of names) {
    const units = facts[taxonomy]?.[concept]?.units;
    if (!units) continue;
    const unit = pickUnit(units, "money");
    if (!unit) continue;
    for (const f of units[unit]!) {
      if (f.start || typeof f.val !== "number") continue;
      if (!best || f.end > best.end || (f.end === best.end && f.filed > best.filed && best.concept === concept)) best = { concept, unit, end: f.end, value: f.val, filed: f.filed };
    }
  }
  return best;
}

/** Cover-page shares outstanding: every class on the latest date of the latest filing, summed. Pure. */
export function coverShares(facts: CompanyFacts["facts"]): { shares: number; asOf: string; classes: number } | null {
  const rows = facts.dei?.EntityCommonStockSharesOutstanding?.units?.shares;
  if (!rows?.length) return null;
  const latestFiled = rows.reduce((m, f) => (f.filed > m ? f.filed : m), "");
  const inFiling = rows.filter((f) => f.filed === latestFiled);
  const end = inFiling.reduce((m, f) => (f.end > m ? f.end : m), "");
  const same = inFiling.filter((f) => f.end === end);
  const values = Array.from(new Set(same.map((f) => `${f.accn}|${f.val}`))).map((k) => Number(k.split("|")[1]));
  return { shares: values.reduce((t, v) => t + v, 0), asOf: end, classes: values.length };
}

/* ------------------------------------------------------------------ assembled */

export type Derived = ReturnType<typeof deriveFundamentals>;

const money = (p: Period) => ({ periodEnd: p.end, value: p.value, ...(p.derived ? { derived: p.derived } : {}) });
const ratio = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || !b ? null : round((a / b) * 100, 1));

/** Everything the tool reports from company facts, without the price. Pure. */
export function deriveFundamentals(cf: CompanyFacts) {
  const facts = cf.facts;
  const tryTax = (tax: Taxonomy) => bestSeries(facts, tax, CONCEPTS[tax].revenue!, "money");
  let taxonomy: Taxonomy = "us-gaap";
  let revenue = tryTax("us-gaap");
  const ifrs = tryTax("ifrs-full");
  const end = (s: Series | null) => [s?.quarters.at(-1)?.end ?? "", s?.annual.at(-1)?.end ?? ""].sort().at(-1) ?? "";
  if (ifrs && end(ifrs) > end(revenue)) {
    revenue = ifrs;
    taxonomy = "ifrs-full";
  }
  const c = CONCEPTS[taxonomy];
  const series = (key: string, kind: "money" | "perShare" | "shares" = "money") => bestSeries(facts, taxonomy, c[key] ?? [], kind);
  const grossDirect = series("grossProfit");
  const cost = series("costOfRevenue");
  const operating = series("operatingIncome");
  const net = series("netIncome");
  const epsD = series("epsDiluted", "perShare") ?? series("epsBasic", "perShare");
  const da = series("da");
  const dil = series("dilutedShares", "shares");

  const revTtm = revenue ? ttm(revenue) : null;
  const at = (s: Series | null, periodEnd: string | undefined, basis: "q" | "y") => {
    if (!s || !periodEnd) return null;
    const list = basis === "q" ? s.quarters : s.annual;
    return list.find((p) => Math.abs(Date.parse(p.end) - Date.parse(periodEnd)) <= 3 * DAY)?.value ?? null;
  };
  // TTM of another series, only when it covers the same period as revenue's.
  const ttmAligned = (s: Series | null) => {
    if (!s || !revTtm) return null;
    const t = ttm(s);
    return t && Math.abs(Date.parse(t.periodEnd) - Date.parse(revTtm.periodEnd)) <= 3 * DAY ? t.value : null;
  };
  const grossTtm = ttmAligned(grossDirect) ?? (revTtm && ttmAligned(cost) !== null ? revTtm.value - ttmAligned(cost)! : null);
  const lastQ = revenue?.quarters.at(-1);
  const lastY = revenue?.annual.at(-1);
  const grossAt = (end: string | undefined, b: "q" | "y", rev: number | undefined) =>
    at(grossDirect, end, b) ?? (rev !== undefined && at(cost, end, b) !== null ? rev - at(cost, end, b)! : null);
  const margins = (label: string, rev: number | undefined, gross: number | null, op: number | null, ni: number | null) =>
    rev ? { period: label, grossPct: ratio(gross, rev), operatingPct: ratio(op, rev), netPct: ratio(ni, rev) } : null;

  const unit = revenue?.unit ?? "USD";
  const epsTtm = epsD ? ttm(epsD) : null;
  const opTtm = ttmAligned(operating);
  const daTtm = ttmAligned(da);
  const cash = latestInstant(facts, taxonomy, c.cash ?? []);
  const sti = latestInstant(facts, taxonomy, c.shortTermInvestments ?? []);
  const onDate = (i: Instant | null) => (i && cash && Math.abs(Date.parse(i.end) - Date.parse(cash.end)) <= 3 * DAY ? i.value : null);
  const total = onDate(latestInstant(facts, taxonomy, c.debtTotal ?? []));
  const nonCurrent = onDate(latestInstant(facts, taxonomy, c.debtNoncurrent ?? []));
  const current = onDate(latestInstant(facts, taxonomy, c.debtCurrent ?? []));
  const shortDebt = (c.shortDebt ?? []).reduce((t, name) => t + (onDate(latestInstant(facts, taxonomy, [name])) ?? 0), 0);
  const longDebt = total ?? (nonCurrent !== null || current !== null ? (nonCurrent ?? 0) + (current ?? 0) : null);
  const debt = longDebt !== null || shortDebt ? (longDebt ?? 0) + shortDebt : null;
  const filedAll = [revenue, operating, net, epsD].flatMap((s) => [...(s?.quarters ?? []), ...(s?.annual ?? [])]);
  const newest = filedAll.reduce<Period | null>((m, p) => (!m || p.filed > m.filed ? p : m), null);

  return {
    company: cf.entityName,
    taxonomy,
    currency: unit,
    latestFiling: newest ? { form: newest.form, filed: newest.filed } : null,
    revenue: revenue
      ? {
          concept: revenue.concept,
          ttm: revTtm,
          lastQuarters: revenue.quarters.slice(-4).map(money),
          lastFiscalYears: revenue.annual.slice(-4).map(money),
        }
      : null,
    grossProfitTtm: grossTtm,
    operatingIncomeTtm: opTtm,
    netIncomeTtm: ttmAligned(net),
    margins: {
      ttm: revTtm ? margins(`TTM to ${revTtm.periodEnd}`, revTtm.value, grossTtm, opTtm, ttmAligned(net)) : null,
      lastQuarter: lastQ ? margins(`quarter to ${lastQ.end}`, lastQ.value, grossAt(lastQ.end, "q", lastQ.value), at(operating, lastQ.end, "q"), at(net, lastQ.end, "q")) : null,
      lastFiscalYear: lastY ? margins(`fiscal year to ${lastY.end}`, lastY.value, grossAt(lastY.end, "y", lastY.value), at(operating, lastY.end, "y"), at(net, lastY.end, "y")) : null,
    },
    eps: epsD
      ? {
          concept: epsD.concept,
          unit: epsD.unit,
          ttm: epsTtm ? { value: round(epsTtm.value, 2), periodEnd: epsTtm.periodEnd, basis: epsTtm.basis } : null,
          lastQuarters: epsD.quarters.slice(-4).map((p) => ({ ...money(p), value: round(p.value, 2) })),
          lastFiscalYear: epsD.annual.at(-1) ? { periodEnd: epsD.annual.at(-1)!.end, value: epsD.annual.at(-1)!.value } : null,
        }
      : null,
    ebitdaTtm: opTtm !== null && daTtm !== null ? { value: opTtm + daTtm, basis: "operating income + depreciation & amortization (cash-flow statement)" } : null,
    shares: {
      outstanding: coverShares(facts),
      dilutedWeightedLastQuarter: dil?.quarters.at(-1) ? { periodEnd: dil.quarters.at(-1)!.end, value: dil.quarters.at(-1)!.value } : null,
    },
    balance: cash
      ? {
          asOf: cash.end,
          cashAndEquivalents: cash.value,
          shortTermInvestments: onDate(sti),
          totalDebt: debt,
          debtNote: "Debt = long-term debt including current maturities, plus commercial paper and short-term borrowings when filed; leases excluded.",
        }
      : null,
  };
}

const factsCache = new TtlCache<Promise<Derived>>(6 * 3_600_000, 50);

/** Adds the price-based figures. Pure. */
export function withValuation(d: Derived, quote: { price: number | null; currency: string | null; time: number | null; yahooMarketCap: number | null }) {
  const notes: string[] = [];
  const { price } = quote;
  let marketCap: { value: number; basis: string } | null = null;
  const foreign = d.taxonomy === "ifrs-full" || /^(20-F|40-F)/.test(d.latestFiling?.form ?? "");
  const sameCurrency = !quote.currency || quote.currency === d.currency;
  if (foreign) {
    // Per-share figures are per ordinary share; a US listing is often an ADR worth several of them.
    if (quote.yahooMarketCap !== null) marketCap = { value: quote.yahooMarketCap, basis: "Yahoo market cap" };
    notes.push("Foreign filer: EPS and shares are per ordinary share and a US-listed ADR can represent several, so P/E, P/S and EV/EBITDA are not computed here.");
    return { price, priceTime: quote.time !== null ? nyStamp(quote.time * 1000) : null, marketCap, enterpriseValue: null, peTtm: null, priceToSalesTtm: null, evToEbitdaTtm: null, notes };
  }
  if (price !== null && d.shares.outstanding) {
    marketCap = { value: Math.round(price * d.shares.outstanding.shares), basis: `price x cover-page shares outstanding as of ${d.shares.outstanding.asOf}${d.shares.outstanding.classes > 1 ? ` (${d.shares.outstanding.classes} share classes summed)` : ""}` };
  } else if (quote.yahooMarketCap !== null) {
    marketCap = { value: quote.yahooMarketCap, basis: "Yahoo market cap" };
  }
  let pe: number | null = null;
  let ps: number | null = null;
  let evEbitda: number | null = null;
  let ev: number | null = null;
  if (!sameCurrency) notes.push(`Financials are in ${d.currency} and the price in ${quote.currency}; multiples not computed.`);
  else {
    const eps = d.eps?.ttm?.value ?? null;
    if (price !== null && eps !== null) {
      if (eps > 0) pe = round(price / eps, 1);
      else notes.push("P/E not meaningful: TTM EPS is zero or negative.");
    }
    const rev = d.revenue?.ttm?.value ?? null;
    if (marketCap && rev && rev > 0) ps = round(marketCap.value / rev, 2);
    if (marketCap && d.balance) {
      ev = Math.round(marketCap.value + (d.balance.totalDebt ?? 0) - d.balance.cashAndEquivalents - (d.balance.shortTermInvestments ?? 0));
      const e = d.ebitdaTtm?.value ?? null;
      if (e !== null && e > 0) evEbitda = round(ev / e, 1);
      else if (e !== null) notes.push("EV/EBITDA not meaningful: TTM EBITDA is zero or negative.");
      else notes.push("EV/EBITDA not computed: depreciation & amortization not found in the filings for the same period.");
    }
  }
  return {
    price,
    priceTime: quote.time !== null ? nyStamp(quote.time * 1000) : null,
    marketCap,
    enterpriseValue: ev !== null ? { value: ev, basis: "market cap + total debt - cash and short-term investments" } : null,
    peTtm: pe,
    priceToSalesTtm: ps,
    evToEbitdaTtm: evEbitda,
    ...(notes.length ? { notes } : {}),
  };
}

/**
 * Where the price-based figures come from (citations.ts FieldSource): the price is Yahoo's, the market cap Yahoo's
 * or Yahoo's price times the SEC cover-page shares, and the multiples combine it with SEC XBRL figures. Everything
 * else in the answer is SEC XBRL company facts (the result's own source). Pure.
 */
export function valuationSources(symbol: string, v: { marketCap: { basis: string } | null }): FieldSource[] {
  const url = `https://finance.yahoo.com/quote/${encodeURIComponent(symbol)}`;
  const capYahoo = v.marketCap?.basis === "Yahoo market cap";
  const cap = capYahoo ? "Yahoo Finance's market cap" : "Yahoo Finance's price x SEC cover-page shares outstanding";
  return [
    { covers: ["valuation.price", "valuation.priceTime"], label: "Yahoo Finance quote (last price)", url },
    capYahoo
      ? { covers: ["valuation.marketCap"], label: "Yahoo Finance quote (market cap)", url }
      : { covers: ["valuation.marketCap"], label: "Computed by Falcon from Yahoo Finance's last price and the SEC XBRL cover-page shares outstanding" },
    { covers: ["valuation.peTtm"], label: "Computed by Falcon from Yahoo Finance's last price and SEC XBRL TTM diluted EPS" },
    { covers: ["valuation.priceToSalesTtm"], label: `Computed by Falcon from the market cap (${cap}) and SEC XBRL TTM revenue` },
    { covers: ["valuation.enterpriseValue", "valuation.evToEbitdaTtm"], label: `Computed by Falcon from the market cap (${cap}) and SEC XBRL debt, cash and EBITDA` },
  ];
}

export async function fundamentalsTool(symbol: string, _ctx: DeskToolContext, signal: AbortSignal) {
  const company = await companyForTicker(symbol, signal);
  if (!company) throw new ToolError(`${symbol} is not in SEC's list of registrants (ETFs, funds and some foreign listings are not). No XBRL fundamentals.`);
  const [derived, q] = await Promise.all([
    cached(factsCache, company.cik, async () => deriveFundamentals(await companyFacts(company.cik, signal))),
    yahooQuote(symbol, signal).catch(() => null),
  ]);
  if (!derived.revenue && !derived.eps) throw new ToolError(`SEC has no usable XBRL income-statement data for ${symbol}.`);
  const valuation = withValuation(derived, {
    price: num(q?.regularMarketPrice),
    currency: typeof q?.currency === "string" ? q.currency : null,
    time: num(q?.regularMarketTime),
    yahooMarketCap: num(q?.marketCap),
  });
  return {
    ticker: symbol,
    cik: company.cik,
    ...derived,
    valuation,
    units: `Money in ${derived.currency} as filed (not millions); EPS in ${derived.eps?.unit ?? "currency/share"}; shares in shares. Margins in percent.`,
    source: `SEC XBRL company facts (${derived.taxonomy}); the valuation block (price, market cap, multiples) uses Yahoo Finance's last price`,
    sources: valuationSources(symbol, valuation),
  };
}
