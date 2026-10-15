import type { CorporateCalendarRaw } from "../../shared/briefing-types";
import {
  isYmd,
  type CalendarCorporateEvent,
  type CalendarSector,
  type CorporateDetailCode,
  type CorporatePart,
} from "../../shared/calendar-events";
import { MONTH_ABBR } from "../../shared/calendar-view";

/**
 * Calendar tab: the corporate calendar of the names a reader holds or
 * follows, across every date the provider knows.
 *
 * The briefing reads the same provider calendar for held names, but keeps
 * only the next ten sessions of it, because that is what a morning handover
 * is about. A calendar shows weeks, so this reads the whole answer: the next
 * earnings date (or the provider's estimated window for it), the next
 * ex-dividend and payment dates, and the distributions and splits of the last
 * three months from the price history. It reads through the briefing's own
 * corporate-actions cache, so a name the briefing already asked about costs
 * nothing, and a new one is read once and then kept for most of a day.
 *
 * Electron-free: the two readers are injected.
 */

export type CorporateCalendarDeps = {
  corporate: (symbol: string) => Promise<CorporateCalendarRaw>;
  sector: (symbol: string) => Promise<CalendarSector | null>;
  /** How many names are read at once. The provider's crumb handshake is fragile; a few at a time is plenty. */
  concurrency?: number;
};

export type CorporateCalendarOutcome = {
  events: CalendarCorporateEvent[];
  sectors: Record<string, CalendarSector | null>;
  unavailable: string[];
};

function usd(amount: number): string {
  // Fund distributions are declared to four decimals; trailing zeros past the cents are noise.
  return `$${amount.toFixed(4).replace(/0{1,2}$/, "")}`;
}

/** "Oct 28": a calendar date, spelled without asking Intl for a zone. */
function shortDate(ymd: string): string {
  const [, m, d] = ymd.split("-").map(Number);
  return `${MONTH_ABBR[m - 1]} ${d}`;
}

function ratioPart(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

function positive(n: unknown): number | null {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : null;
}

type DetailPart = CorporatePart<CorporateDetailCode>;

/**
 * One name's provider answer as calendar events. Pure, so the wording and the
 * de-duplication can be tested without a provider.
 *
 * Each row carries its English (`title`, `detail`) and the same wording as
 * codes with their values (`words`), which the renderer words in the reader's
 * language; dates and amounts travel raw so they are formatted there too.
 */
export function corporateEventsOf(raw: CorporateCalendarRaw): CalendarCorporateEvent[] {
  const ticker = raw.symbol;
  const out = new Map<string, CalendarCorporateEvent>();

  // Earnings: the provider gives one date, or two when it only knows a
  // window. A window is one event on its first day that names the last.
  const dates = (Array.isArray(raw.earnings_dates) ? raw.earnings_dates : []).filter(isYmd).sort();
  if (dates.length > 0) {
    const first = dates[0];
    const last = dates[dates.length - 1];
    const estimated = raw.earnings_estimated !== false;
    const detail =
      last !== first
        ? `The data provider gives a window from ${shortDate(first)} to ${shortDate(last)}; the company has not announced the day.`
        : estimated
          ? "Date estimated by the data provider; the company has not confirmed it."
          : "Date from the data provider. The hour is not given.";
    const detailPart: DetailPart =
      last !== first
        ? { code: "earningsWindow", params: { from: first, to: last } }
        : { code: estimated ? "earningsEstimated" : "earningsDated" };
    out.set(`earn:${ticker}:${first}`, {
      id: `earn:${ticker}:${first}`,
      kind: "earnings",
      ticker,
      date: first,
      title: `${ticker} earnings report`,
      detail,
      estimated: estimated || last !== first,
      words: { title: { code: "earnings", params: { ticker } }, detail: [detailPart] },
    });
  }

  const rate = positive(raw.dividend_rate);
  if (isYmd(raw.ex_dividend_date)) {
    const date = raw.ex_dividend_date;
    out.set(`div:${ticker}:${date}`, {
      id: `div:${ticker}:${date}`,
      kind: "ex_dividend",
      ticker,
      date,
      title: `${ticker} ex-dividend date`,
      detail:
        rate === null
          ? "Shares held before this date carry the payment."
          : `Indicated annual rate ${usd(rate)} per share. Shares held before this date carry the payment.`,
      estimated: false,
      words: {
        title: { code: "exDividend", params: { ticker } },
        detail: rate === null ? [{ code: "heldBefore" }] : [{ code: "indicatedRate", params: { amount: rate } }, { code: "heldBefore" }],
      },
    });
  }

  if (isYmd(raw.dividend_date)) {
    const date = raw.dividend_date;
    out.set(`pay:${ticker}:${date}`, {
      id: `pay:${ticker}:${date}`,
      kind: "dividend_payment",
      ticker,
      date,
      title: `${ticker} dividend payment`,
      detail: "The payment date the provider lists for the current dividend.",
      estimated: false,
      words: { title: { code: "dividendPayment", params: { ticker } }, detail: [{ code: "payment" }] },
    });
  }

  // The price history: what actually went ex and split. Where the calendar
  // had the same ex-date, the calendar's row stays and only gains the amount.
  for (const paid of Array.isArray(raw.recent_dividends) ? raw.recent_dividends : []) {
    if (!paid || !isYmd(paid.date)) continue;
    const amount = positive(paid.amount);
    const id = `div:${ticker}:${paid.date}`;
    const known = out.get(id);
    const perShare = amount === null ? "A distribution" : `${usd(amount)} per share`;
    const merged = Boolean(known) && amount !== null;
    const detailParts: DetailPart[] = merged
      ? [{ code: "perShare", params: { amount: amount! } }, ...(known?.words?.detail ?? [])]
      : amount === null
        ? [{ code: "distributionWentEx" }]
        : [{ code: "wentEx", params: { amount } }];
    out.set(id, {
      id,
      kind: "ex_dividend",
      ticker,
      date: paid.date,
      title: `${ticker} ex-dividend date`,
      detail: merged ? `${perShare}. ${known?.detail ?? ""}`.trim() : `${perShare} went ex-dividend, read from the price history.`,
      estimated: false,
      words: { title: { code: "exDividend", params: { ticker } }, detail: detailParts },
    });
  }

  for (const split of Array.isArray(raw.recent_splits) ? raw.recent_splits : []) {
    if (!split || !isYmd(split.date)) continue;
    const num = positive(split.numerator);
    const den = positive(split.denominator);
    if (num === null || den === null) continue;
    out.set(`split:${ticker}:${split.date}`, {
      id: `split:${ticker}:${split.date}`,
      kind: "split",
      ticker,
      date: split.date,
      title: `${ticker} ${ratioPart(num)}-for-${ratioPart(den)} ${num < den ? "reverse split" : "split"}`,
      detail: "Price history from before this date is on the old share count.",
      estimated: false,
      words: {
        title: { code: num < den ? "reverseSplit" : "split", params: { ticker, num: Number(ratioPart(num)), den: Number(ratioPart(den)) } },
        detail: [{ code: "splitHistory" }],
      },
    });
  }

  return [...out.values()];
}

/** Runs `task` over `items`, at most `limit` at a time, in order of the list. */
async function pool<T>(items: readonly T[], limit: number, task: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      await task(item);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
}

/**
 * Every name's events and sector. A name whose calendar cannot be read is
 * listed in `unavailable` and the rest stand; a sector that cannot be read is
 * simply null (the event is filed as unclassified, which is honest).
 */
export async function buildCorporateCalendar(symbols: readonly string[], deps: CorporateCalendarDeps): Promise<CorporateCalendarOutcome> {
  const events: CalendarCorporateEvent[] = [];
  const sectors: Record<string, CalendarSector | null> = {};
  const unavailable: string[] = [];

  await pool(symbols, deps.concurrency ?? 3, async (symbol) => {
    const [raw, sector] = await Promise.allSettled([deps.corporate(symbol), deps.sector(symbol)]);
    sectors[symbol] = sector.status === "fulfilled" ? sector.value : null;
    if (raw.status === "fulfilled") events.push(...corporateEventsOf({ ...raw.value, symbol }));
    else unavailable.push(symbol);
  });

  events.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker) || a.id.localeCompare(b.id));
  return { events, sectors, unavailable: unavailable.sort() };
}
