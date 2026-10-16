/**
 * "Today" for a stock moving unusually: how large the session's move is
 * against the stock's own ordinary day, and what is on record since the
 * close before it. Nothing here says why a stock moved: the lines list what
 * was filed, reported and published in the window, each with its source,
 * and leave the reading to the reader.
 *
 *   usual day        the sample standard deviation of the stock's daily
 *                    moves beyond the market over the last 60 closed
 *                    sessions before the move (at least 40)
 *   beyond market    move - beta x SPY's move, the same session; beta is
 *                    the OLS slope of the stock's daily returns on SPY's
 *                    over the last 250 sessions (1 with fewer than 60), the
 *                    read-through event study's own definition
 *   unusual          |beyond market| >= 2 x the usual day
 *   window           from the close of the session before the move
 *                    (holidays and early closes included) to the answer
 *
 * In the window: the company's own SEC filings (8-K with its items, Form 4,
 * Schedule 13D / 13G, periodic reports and the rest by form), the companies
 * its filings link it to that reported or filed an 8-K, the material news
 * the news feed shows for it (Falcon's own headline), its competitors that
 * moved the same way the same session, and the market and sector fund for
 * context.
 *
 * Pure: no fs, no network, no clock.
 */

import { normalizeTicker } from "./calendar-events";
import { addTradingDays } from "./calendar-types";
import { nyWallMs, nyYmdOf, sessionOf } from "./earnings-time";
import { dailyReturns, mean, stdev, PEER_MOVE_Z, type Bar } from "./peer-dynamics";

export type { Bar };

export const MARKET_SYMBOL = "SPY";
export const NORMAL_SESSIONS = 60;
export const NORMAL_MIN_SESSIONS = 40;
export const BETA_SESSIONS = 250;
export const BETA_MIN_SESSIONS = 60;
/** The move beyond the market, in usual days, from which the session counts as unusual. */
export const UNUSUAL_RATIO = 2;
/** A competitor with no year of closes counts as moving the same way from this move on. */
export const PEER_FALLBACK_MOVE = 0.01;
export const MAX_NEWS = 5;
export const MAX_LINKED = 6;
export const MAX_PEERS_SHOWN = 4;
export const MAX_INSIDER_LINES = 3;

/** The Select Sector SPDR fund for each sector name the sector cache keeps. */
export const SECTOR_FUNDS: Readonly<Record<string, string>> = {
  Technology: "XLK",
  Financials: "XLF",
  Energy: "XLE",
  Healthcare: "XLV",
  "Consumer Discretionary": "XLY",
  "Consumer Staples": "XLP",
  Industrials: "XLI",
  Materials: "XLB",
  Utilities: "XLU",
  "Real Estate": "XLRE",
  "Communication Services": "XLC",
};

export function sectorFund(sector: string | null | undefined): string | null {
  return sector ? (SECTOR_FUNDS[sector] ?? null) : null;
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type OwnFilingItem =
  | {
      kind: "current";
      /** "8-K", "8-K/A", "6-K". */
      form: string;
      /** 8-K item codes, the exhibits item (9.01) left out. */
      items: string[];
      at: string | null;
      url: string;
    }
  | {
      kind: "insider";
      name: string;
      role: string;
      /** P is an open market purchase, S an open market sale. */
      code: "P" | "S";
      value: number | null;
      plan: boolean;
      at: string | null;
      url: string;
    }
  | {
      /** Form 4s with no open market trade on record here (grants, exercises, or not yet read). */
      kind: "insider_other";
      count: number;
      at: string | null;
      url: string;
    }
  | {
      kind: "schedule";
      /** "13D" or "13G". */
      schedule: "13D" | "13G";
      amendment: boolean;
      at: string | null;
      url: string;
    }
  | {
      /** 10-Q, 10-K, 20-F, 40-F, and their amendments. */
      kind: "periodic";
      form: string;
      at: string | null;
      url: string;
    }
  | {
      /** Every other form, one line: "S-3, 424B5". */
      kind: "other";
      forms: string[];
      count: number;
      at: string | null;
      url: string;
    };

export type LinkedItem = {
  ticker: string;
  name: string | null;
  /** supplier, customer, partner, competitor, dependency, as the filing puts it. */
  category: string;
  /** The ticker whose filing names the other. */
  namedBy: string;
  /** The filing that carries the link. */
  linkUrl: string | null;
  /** "report": results on record in the window; "filing": an 8-K without item 2.02. */
  event: "report" | "filing";
  items: string[];
  at: string | null;
  /** The 8-K on SEC.gov, when it is on record here. */
  url: string | null;
};

export type TodayNews = { title: string; url: string; source: string | null; at: string };

export type PeerToday = { ticker: string; move: number };

export type MoveFigure = { symbol: string; move: number };

export type TodayDegraded = "sec" | "links" | "news" | "peers";

export type StockToday = {
  ticker: string;
  /** The session the move belongs to, and the one before it (YYYY-MM-DD, New York). */
  day: string;
  previousDay: string;
  /** The window's start: the previous session's close, ISO. */
  since: string;
  /** When the answer was built, ISO. */
  asOf: string;
  /** The stock's move over the session, close to close or to the latest regular print (signed fraction). */
  move: number;
  market: MoveFigure;
  sector: MoveFigure | null;
  beta: number;
  /** The usual day: standard deviation of daily moves beyond the market. */
  sigma: number;
  sessions: number;
  abnormal: number;
  /** |abnormal| / sigma. */
  ratio: number;
  unusual: boolean;
  filings: OwnFilingItem[];
  linked: LinkedItem[];
  news: TodayNews[];
  /** Competitors that moved the same way the same session, the largest first. */
  peers: PeerToday[];
  /** Competitors whose move was read. */
  peersRead: number;
  degraded: TodayDegraded[];
};

export type StockTodayResult = { ok: true; today: StockToday | null } | { ok: false; error: "invalid_request" | "unavailable" };

/** The dashboard's read: the held names moving unusually, each with what is on record. */
export type TodayMovesResult = { ok: true; unusual: StockToday[] } | { ok: false; error: "invalid_request" | "unavailable" };

export const TODAY_MOVES_CAP = 60;

/** The dashboard's request: held tickers, cleaned, de-duplicated and capped; null when it is not a list. */
export function parseTodayMovesRequest(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > 500) return null;
  const out: string[] = [];
  for (const item of raw) {
    const t = normalizeTicker(item);
    if (t && !out.includes(t)) out.push(t);
    if (out.length >= TODAY_MOVES_CAP) break;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The usual day
// ---------------------------------------------------------------------------

export type NormalDay = { beta: number; sigma: number; sessions: number };

function olsSlope(y: readonly number[], x: readonly number[]): number | null {
  if (y.length !== x.length || y.length < 2) return null;
  const mx = mean(x);
  const my = mean(y);
  let num = 0;
  let den = 0;
  for (let i = 0; i < x.length; i++) {
    num += (x[i]! - mx) * (y[i]! - my);
    den += (x[i]! - mx) ** 2;
  }
  return den === 0 ? null : num / den;
}

/**
 * The stock's usual day before `before` (that session and later left out):
 * its beta to the market and the standard deviation of its daily moves
 * beyond it. Null with fewer than NORMAL_MIN_SESSIONS shared sessions.
 */
export function normalDay(stock: readonly Bar[], market: readonly Bar[], before: string): NormalDay | null {
  const m = new Map(dailyReturns(market).map((x) => [x.d, x.r] as const));
  const pairs: Array<{ r: number; m: number }> = [];
  for (const x of dailyReturns(stock)) {
    if (x.d >= before) continue;
    const mr = m.get(x.d);
    if (mr === undefined) continue;
    pairs.push({ r: x.r, m: mr });
  }
  const betaWindow = pairs.slice(-BETA_SESSIONS);
  const slope = betaWindow.length >= BETA_MIN_SESSIONS ? olsSlope(betaWindow.map((p) => p.r), betaWindow.map((p) => p.m)) : null;
  const beta = slope !== null && Number.isFinite(slope) ? slope : 1;
  const normal = pairs.slice(-NORMAL_SESSIONS).map((p) => p.r - beta * p.m);
  if (normal.length < NORMAL_MIN_SESSIONS) return null;
  const sigma = stdev(normal);
  if (sigma === null || !(sigma > 0)) return null;
  return { beta, sigma, sessions: normal.length };
}

/** The close of `day` against the close of `previousDay`, from bars; null when either is missing. */
export function barMove(bars: readonly Bar[], day: string, previousDay: string): number | null {
  const a = bars.find((b) => b.d === previousDay)?.c;
  const b = bars.find((x) => x.d === day)?.c;
  return a && b && a > 0 ? b / a - 1 : null;
}

export function moveCheck(move: number, marketMove: number, normal: NormalDay): { abnormal: number; ratio: number; unusual: boolean } {
  const abnormal = move - normal.beta * marketMove;
  const ratio = Math.abs(abnormal) / normal.sigma;
  return { abnormal, ratio, unusual: ratio >= UNUSUAL_RATIO };
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

export type SessionFrame = {
  /** The session the move belongs to. */
  day: string;
  previousDay: string;
  /** The previous session's close, epoch ms: where the window opens. */
  sinceMs: number;
  /**
   * True from the open of `day` on: the latest regular print against the
   * previous close is the move. Before the open (or on a day the market does
   * not open) the move is the last session's, read from closed bars.
   */
  live: boolean;
};

/** Which session "today" means at `nowMs`, on the engine's session clock (holidays, early closes). */
export function sessionFrame(nowMs: number): SessionFrame {
  const today = nyYmdOf(nowMs);
  const s = sessionOf(today);
  const live = s !== null && nowMs >= s.openMs;
  const day = live ? today : addTradingDays(today, -1);
  const previousDay = addTradingDays(day, -1);
  const sinceMs = sessionOf(previousDay)?.closeMs ?? nyWallMs(previousDay, 16, 0);
  return { day, previousDay, sinceMs, live };
}

/** A filing as the EDGAR index lists it, its acceptance instant already read. */
export type FilingLike = {
  form: string;
  accession: string;
  filedAt: string;
  /** The acceptance instant, epoch ms; null when the index gives none. */
  acceptedMs: number | null;
  items: readonly string[];
  url: string;
};

export type Form4Read = { name: string; role: string; code: "P" | "S"; value: number | null; plan: boolean };

export type Window = {
  sinceMs: number;
  untilMs: number;
  /** The session before the move (the window opens at its close). */
  previousDay: string;
  /** New York's date at `untilMs`. */
  untilDay: string;
};

/** In the window: by the acceptance instant, or, without one, filed after the previous session's day. */
export function inWindow(f: Pick<FilingLike, "acceptedMs" | "filedAt">, w: Window): boolean {
  if (f.acceptedMs !== null) return f.acceptedMs >= w.sinceMs && f.acceptedMs <= w.untilMs;
  return f.filedAt > w.previousDay;
}

const CURRENT = /^(8-K|6-K)(\/A)?$/i;
const FORM4 = /^4(\/A)?$/;
const SCHEDULE = /^(?:SC |SCHEDULE )13([DG])(\/A)?$/i;
const PERIODIC = /^(10-Q|10-K|20-F|40-F)(\/A)?$/i;
/** Paperwork that says nothing about the day: structured note supplements, letters, fund holdings, notices of exempt offerings. */
const QUIET = /^(424B2|FWP|CORRESP|UPLOAD|13F-HR|13F-NT|D|D\/A|EFFECT|ABS-15G|S-8|S-8 POS|11-K|SD)(\/A)?$/i;

const iso = (ms: number | null) => (ms === null ? null : new Date(ms).toISOString());

/** The company's own filings in the window, newest first; Form 4s without a trade on record and the rest by form are folded into one line each. */
export function ownFilings(filings: readonly FilingLike[], w: Window, form4: (accession: string) => Form4Read | null | undefined): OwnFilingItem[] {
  const list = filings.filter((f) => inWindow(f, w)).sort((a, b) => (b.acceptedMs ?? 0) - (a.acceptedMs ?? 0) || b.filedAt.localeCompare(a.filedAt));
  const out: OwnFilingItem[] = [];
  const otherForm4: FilingLike[] = [];
  const other: FilingLike[] = [];
  let insiders = 0;
  for (const f of list) {
    const form = f.form.trim();
    if (CURRENT.test(form)) {
      out.push({ kind: "current", form: form.toUpperCase(), items: f.items.filter((i) => i !== "9.01"), at: iso(f.acceptedMs), url: f.url });
    } else if (FORM4.test(form)) {
      const read = form4(f.accession);
      if (read && insiders < MAX_INSIDER_LINES) {
        insiders++;
        out.push({ kind: "insider", name: read.name, role: read.role, code: read.code, value: read.value, plan: read.plan, at: iso(f.acceptedMs), url: f.url });
      } else otherForm4.push(f);
    } else if (SCHEDULE.test(form)) {
      const m = SCHEDULE.exec(form)!;
      out.push({ kind: "schedule", schedule: m[1]!.toUpperCase() === "D" ? "13D" : "13G", amendment: !!m[2], at: iso(f.acceptedMs), url: f.url });
    } else if (PERIODIC.test(form)) {
      out.push({ kind: "periodic", form: form.toUpperCase(), at: iso(f.acceptedMs), url: f.url });
    } else if (!QUIET.test(form)) other.push(f);
  }
  if (otherForm4.length > 0) {
    out.push({ kind: "insider_other", count: otherForm4.length, at: iso(otherForm4[0]!.acceptedMs), url: otherForm4[0]!.url });
  }
  if (other.length > 0) {
    const forms = [...new Set(other.map((f) => f.form.trim().toUpperCase()))];
    out.push({ kind: "other", forms, count: other.length, at: iso(other[0]!.acceptedMs), url: other[0]!.url });
  }
  return out;
}

/** A filing-graph link of the stock (graph-links `linksAround`), strongest first. */
export type LinkLike = { ticker: string; name: string | null; category: string; direction: "names" | "named"; filingUrl: string | null };

/** A read-through radar row reduced to what the window needs. */
export type RadarLike = { counterparty: string; kind: "upcoming" | "recent" | "later"; date: string | null; time: string; releasedMs: number | null };

/**
 * Whether a radar row's report (one on record: "recent") fell in the window:
 * by its release instant, or by its date and hour (after the close on the
 * previous session's day, or any hour on a later day).
 */
export function reportInWindow(r: RadarLike, w: Window): boolean {
  if (r.kind !== "recent" || !r.date) return false;
  if (r.releasedMs !== null) return r.releasedMs >= w.sinceMs && r.releasedMs <= w.untilMs;
  if (r.date > w.previousDay) return r.date <= w.untilDay;
  return r.date === w.previousDay && r.time === "amc";
}

/**
 * The linked companies that reported (the radar's record, or an 8-K with
 * item 2.02) or filed an 8-K in the window, in the links' order (strongest
 * first). `filingsOf` is what is on record here for a company, null when
 * nothing is.
 */
export function linkedItems(
  stock: string,
  links: readonly LinkLike[],
  filingsOf: (ticker: string) => readonly FilingLike[] | null,
  radar: readonly RadarLike[],
  w: Window,
): LinkedItem[] {
  const reported = new Set(radar.filter((r) => reportInWindow(r, w)).map((r) => r.counterparty.toUpperCase()));
  const out: LinkedItem[] = [];
  for (const l of links) {
    if (out.length >= MAX_LINKED) break;
    const ticker = l.ticker.toUpperCase();
    const eightKs = (filingsOf(ticker) ?? []).filter((f) => CURRENT.test(f.form.trim()) && inWindow(f, w)).sort((a, b) => (b.acceptedMs ?? 0) - (a.acceptedMs ?? 0));
    const release = eightKs.find((f) => f.items.includes("2.02"));
    const base = { ticker, name: l.name, category: l.category, namedBy: l.direction === "names" ? stock.toUpperCase() : ticker, linkUrl: l.filingUrl };
    if (release || reported.has(ticker)) {
      out.push({ ...base, event: "report", items: release ? release.items.filter((i) => i !== "9.01") : [], at: iso(release?.acceptedMs ?? null), url: release?.url ?? null });
      continue;
    }
    const latest = eightKs[0];
    if (latest) out.push({ ...base, event: "filing", items: latest.items.filter((i) => i !== "9.01"), at: iso(latest.acceptedMs), url: latest.url });
  }
  return out;
}

/** A story the news feed shows as material, with the names it is material for (agents/sources `materialFromFeed`). */
export type MaterialLike = { title: string; url: string; source?: string; publishedAt?: string; tickers: readonly string[] };

export function newsItems(stories: readonly MaterialLike[], ticker: string, w: Window): TodayNews[] {
  const self = ticker.toUpperCase();
  const seen = new Set<string>();
  const out: TodayNews[] = [];
  // Newest first, so a story carried twice keeps its latest telling.
  const ordered = [...stories].sort((a, b) => (Date.parse(b.publishedAt ?? "") || 0) - (Date.parse(a.publishedAt ?? "") || 0));
  for (const s of ordered) {
    const at = s.publishedAt ? Date.parse(s.publishedAt) : NaN;
    if (!Number.isFinite(at) || at < w.sinceMs || at > w.untilMs) continue;
    if (!s.tickers.some((t) => t.toUpperCase() === self)) continue;
    const title = s.title.trim();
    const key = title.toLowerCase();
    if (!title || seen.has(key)) continue;
    seen.add(key);
    out.push({ title, url: s.url, source: s.source?.trim() || null, at: new Date(at).toISOString() });
  }
  return out.sort((a, b) => b.at.localeCompare(a.at)).slice(0, MAX_NEWS);
}

/**
 * The competitors that moved the stock's way the same session, the largest
 * first: one of their own standard deviations or more (peer-dynamics
 * PEER_MOVE_Z), or PEER_FALLBACK_MOVE when their year of closes is not on
 * record.
 */
export function peersSameWay(stockMove: number, peers: ReadonlyArray<{ ticker: string; move: number | null; sigma: number | null }>): PeerToday[] {
  if (stockMove === 0) return [];
  return peers
    .filter((p): p is { ticker: string; move: number; sigma: number | null } => p.move !== null && Number.isFinite(p.move))
    .filter((p) => Math.sign(p.move) === Math.sign(stockMove) && Math.abs(p.move) >= (p.sigma !== null && p.sigma > 0 ? PEER_MOVE_Z * p.sigma : PEER_FALLBACK_MOVE))
    .sort((a, b) => Math.abs(b.move) - Math.abs(a.move))
    .map((p) => ({ ticker: p.ticker, move: p.move }));
}

// ---------------------------------------------------------------------------
// The lines
// ---------------------------------------------------------------------------

/** A link the views open: a web address, nothing else (no file:, no javascript:). */
export function webUrl(url: string | null | undefined): string | null {
  if (typeof url !== "string") return null;
  const u = url.trim();
  return /^https?:\/\/[^\s]+$/i.test(u) ? u : null;
}

/** The message keys the lines use (renderer/lib/i18n/messages/areas/today.ts). */
export const ITEM_KEYS: Readonly<Record<string, string>> = {
  "1.01": "today.item.1_01",
  "1.02": "today.item.1_02",
  "1.05": "today.item.1_05",
  "2.01": "today.item.2_01",
  "2.02": "today.item.2_02",
  "2.03": "today.item.2_03",
  "2.05": "today.item.2_05",
  "2.06": "today.item.2_06",
  "3.01": "today.item.3_01",
  "3.02": "today.item.3_02",
  "4.01": "today.item.4_01",
  "4.02": "today.item.4_02",
  "5.01": "today.item.5_01",
  "5.02": "today.item.5_02",
  "5.03": "today.item.5_03",
  "5.07": "today.item.5_07",
  "7.01": "today.item.7_01",
  "8.01": "today.item.8_01",
};

export type TodayFormat = {
  t: (key: string, params?: Record<string, string | number>) => string;
  /** A signed move: "+4.1%". */
  move: (fraction: number) => string;
  /** An unsigned share: "2.3%". */
  share: (fraction: number) => string;
  /** "3.4". */
  ratio: (value: number) => string;
  money: (usd: number) => string;
  /** "Thursday" for a YYYY-MM-DD. */
  weekday: (ymd: string) => string;
  /** "16:05" New York for an ISO instant; "Wed 16:05" with `withDay`. */
  time: (isoAt: string, withDay: boolean) => string;
  list: (parts: readonly string[]) => string;
  /** One or other, as the language counts. */
  plural: (count: number) => "one" | "other";
};

export type TodayLine = {
  group: "own" | "linked" | "news" | "peers";
  text: string;
  /** Where it is on the web. */
  url: string | null;
  /** The source's name for the link: "SEC", a publisher. */
  source: string;
  /** New York time of the record, when it has one. */
  time: string | null;
  /** The record came after the session's close: after the move the headline measures. */
  afterClose: boolean;
};

export type TodayView = {
  headline: string;
  context: string;
  since: string;
  lines: TodayLine[];
  /** Set when nothing but competitors (or nothing at all) is on record. */
  empty: string | null;
  /** The sources that could not be read this time, when any. */
  note: string | null;
};

function addDays(ymd: string, n: number): string {
  return new Date(Date.parse(`${ymd}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/** "today", "yesterday" or the weekday for the session; `today` is New York's date now. */
export function whenOf(day: string, today: string, f: TodayFormat): string {
  if (day === today) return f.t("today.when.today");
  if (day === addDays(today, -1)) return f.t("today.when.yesterday");
  return f.t("today.when.day", { day: f.weekday(day) });
}

function itemsText(items: readonly string[], f: TodayFormat): string {
  return f.list(items.map((code) => (ITEM_KEYS[code] ? f.t(ITEM_KEYS[code]!, { code }) : f.t("today.item.other", { code }))));
}

function ownLine(i: OwnFilingItem, f: TodayFormat): string {
  switch (i.kind) {
    case "current":
      return i.items.length > 0 ? f.t("today.own.current", { form: i.form, items: itemsText(i.items, f) }) : f.t("today.own.currentBare", { form: i.form });
    case "insider": {
      const what = f.t(i.code === "S" ? "today.own.insider.sale" : "today.own.insider.purchase");
      const base =
        i.value !== null
          ? f.t("today.own.insider", { name: i.name, role: i.role || f.t("today.own.insider.noRole"), what, value: f.money(i.value) })
          : f.t("today.own.insiderNoValue", { name: i.name, role: i.role || f.t("today.own.insider.noRole"), what });
      return i.plan ? `${base} ${f.t("today.own.insider.plan")}` : base;
    }
    case "insider_other":
      return f.t(f.plural(i.count) === "one" ? "today.own.form4.one" : "today.own.form4.other", { count: i.count });
    case "schedule":
      return f.t(i.amendment ? "today.own.scheduleAmended" : "today.own.schedule", { schedule: i.schedule });
    case "periodic":
      return f.t("today.own.periodic", { form: i.form });
    case "other":
      return f.t("today.own.other", { forms: f.list(i.forms) });
  }
}

const CATEGORY_KEYS: Readonly<Record<string, string>> = {
  supplier: "today.relation.supplier",
  customer: "today.relation.customer",
  partner: "today.relation.partner",
  competitor: "today.relation.competitor",
  dependency: "today.relation.dependency",
};

function linkedLine(i: LinkedItem, f: TodayFormat): string {
  const relation = f.t(CATEGORY_KEYS[i.category] ?? "today.relation.related");
  const link = f.t("today.linked.namedIn", { relation, filer: i.namedBy });
  if (i.event === "report") return f.t("today.linked.report", { ticker: i.ticker, link });
  return i.items.length > 0
    ? f.t("today.linked.filing", { ticker: i.ticker, items: itemsText(i.items, f), link })
    : f.t("today.linked.filingBare", { ticker: i.ticker, link });
}

/** Everything the section and the dashboard line say, in the reader's language. */
export function todayView(d: StockToday, today: string, f: TodayFormat): TodayView {
  const when = whenOf(d.day, today, f);
  const headline = f.t("today.headline", { ticker: d.ticker, move: f.move(d.move), when, ratio: f.ratio(d.ratio) });
  const context = [
    f.t("today.context.beyond", { abnormal: f.move(d.abnormal), sigma: f.share(d.sigma), sessions: d.sessions }),
    d.sector
      ? f.t("today.context.marketSector", { market: d.market.symbol, marketMove: f.move(d.market.move), sector: d.sector.symbol, sectorMove: f.move(d.sector.move) })
      : f.t("today.context.market", { market: d.market.symbol, marketMove: f.move(d.market.move) }),
  ].join(" ");
  const since = d.previousDay === addDays(today, -1) ? f.t("today.since.yesterday") : f.t("today.since.day", { day: f.weekday(d.previousDay) });

  const sec = f.t("today.source.sec");
  // A record from after the session's close came after the move the headline measures: its time says so.
  const closeMs = sessionOf(d.day)?.closeMs ?? null;
  const timeOf = (at: string | null): Pick<TodayLine, "time" | "afterClose"> => {
    const ms = at ? Date.parse(at) : NaN;
    if (!at || !Number.isFinite(ms)) return { time: null, afterClose: false };
    return { time: f.time(at, nyYmdOf(ms) !== d.day), afterClose: closeMs !== null && ms >= closeMs };
  };
  const lines: TodayLine[] = [
    ...d.filings.map((i): TodayLine => ({ group: "own", text: ownLine(i, f), url: i.url, source: sec, ...timeOf(i.at) })),
    ...d.linked.map(
      (i): TodayLine => ({
        group: "linked",
        text: linkedLine(i, f),
        url: i.url ?? i.linkUrl,
        source: sec,
        ...timeOf(i.at),
      }),
    ),
    ...d.news.map((n): TodayLine => ({ group: "news", text: n.title, url: n.url, source: n.source ?? f.t("today.source.news"), ...timeOf(n.at) })),
  ];
  if (d.peers.length > 0) {
    const shown = d.peers.slice(0, MAX_PEERS_SHOWN).map((p) => `${p.ticker} ${f.move(p.move)}`);
    lines.push({
      group: "peers",
      text: f.t("today.peers", { moves: f.list(shown), when, count: d.peers.length, total: d.peersRead }),
      url: null,
      source: "",
      time: null,
      afterClose: false,
    });
  }
  const recorded = d.filings.length + d.linked.length + d.news.length;
  // "None on record" only when the company's filings and its news were both read.
  const complete = !d.degraded.includes("sec") && !d.degraded.includes("news");
  const empty = recorded > 0 ? null : f.t(complete ? "today.empty.since" : "today.empty.partial", { since });
  const note = d.degraded.length > 0 ? f.t("today.degraded", { sources: f.list(d.degraded.map((k) => f.t(`today.degraded.${k}`))) }) : null;
  return { headline, context, since, lines, empty, note };
}

/** The dashboard's one line: the move, then how many records the window holds. */
export function todaySummary(d: StockToday, today: string, f: TodayFormat): string {
  const when = whenOf(d.day, today, f);
  const head = f.t("today.headline", { ticker: d.ticker, move: f.move(d.move), when, ratio: f.ratio(d.ratio) });
  const filings = d.filings.length + d.linked.length;
  const since = d.previousDay === addDays(today, -1) ? f.t("today.since.yesterday") : f.t("today.since.day", { day: f.weekday(d.previousDay) });
  if (filings + d.news.length === 0) {
    const complete = !d.degraded.includes("sec") && !d.degraded.includes("news");
    return `${head} ${f.t(complete ? "today.empty.since" : "today.empty.partial", { since })}`;
  }
  return `${head} ${f.t("today.summary", { since, filings, news: d.news.length })}`;
}
