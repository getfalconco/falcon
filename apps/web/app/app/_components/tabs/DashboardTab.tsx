"use client";

import { useEffect, useMemo, useState } from "react";
import { Clock } from "lucide-react";
import { NOTHING_CLEARED, anyClearsBar, cardStrength, type RippleCard } from "@falcon/ripple";
import { fetchOptionsEarnings, type OptionsEarningsRelease } from "@/lib/options-api";
import { attentionSentence, earningsSoon } from "@/lib/workspace/attention";
import { buildTodaySummary, mixByType, touchesPortfolio } from "@/lib/workspace/feed";
import { greeting } from "@/lib/workspace/greeting";
import { readProfile } from "@/lib/account/profile";
import { useAuthUser } from "@/lib/account/profile-client";
import { marketStatus, type MarketStatus } from "@/lib/workspace/market-status";
import { useWorkspace } from "../context";
import { NetRing, SERIF, feedEmpty } from "../parts";
import { HowToReadButton, todaySentence } from "../explain";
import { StartWithWhatYouOwn } from "./OwnCard";
import { MarketStrip } from "./MarketStrip";
import { PositionsCard } from "./PositionsCard";

/** True when the feed is in and no card clears the publishing bar (only Watch-tier cards, or none). */
export function useNothingCleared(): boolean {
  const { feed, feedStatus } = useWorkspace();
  return feedStatus === "ready" && !anyClearsBar(feed?.cards ?? []);
}

export function useToday() {
  const { feed, portfolio } = useWorkspace();
  return useMemo(() => buildTodaySummary(feed, portfolio.map((f) => f.ticker)), [feed, portfolio]);
}

/** The empty "Hitting your portfolio" title; says so when only Watching cards touch the portfolio. */
export function usePortfolioEmptyTitle(): string {
  const { feed, feedStatus, portfolio, portfolioSet } = useWorkspace();
  const nothingCleared = useNothingCleared();
  const watching = useMemo(
    () => (feed?.cards ?? []).filter((c) => touchesPortfolio(c, portfolioSet) && cardStrength(c).level === "watching").length,
    [feed, portfolioSet],
  );
  if (!portfolio.length) return feedEmpty(feedStatus, "Your portfolio is empty");
  if (watching) {
    return feedEmpty(
      feedStatus,
      `Nothing backed by evidence touches your portfolio. ${watching === 1 ? "1 Sighting under Watching does" : `${watching} Sightings under Watching do`}.`,
    );
  }
  return feedEmpty(feedStatus, nothingCleared ? NOTHING_CLEARED : "Nothing is hitting your portfolio");
}

/** Rows in a "Latest sightings" list. */
export const LATEST_ROWS = 10;

/** The newest cards, all strength levels mixed, no one event type over half of them while others exist. */
export function latestMix(cards: readonly RippleCard[], rows: number): RippleCard[] {
  return mixByType(cards, rows).slice(0, rows);
}

/** Titles of the Today sections that list only cards backed by evidence (no Watching cards). */
export const EVIDENCE_TITLES = {
  portfolio: "Hitting your portfolio, backed by evidence",
  opportunities: "Opportunities, backed by evidence",
} as const;

function longDate(iso: string) {
  const d = new Date(`${iso}T12:00:00`);
  return d.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
}

/** The ring, today's one-sentence summary and the date: the top of Today. */
export function TodayHeader({ compact = false }: { compact?: boolean }) {
  const summary = useToday();
  const { feed, feedStatus, portfolioSet } = useWorkspace();
  const sentence = useMemo(() => todaySentence(feed?.cards ?? [], portfolioSet), [feed, portfolioSet]);
  const why = feedStatus === "ready" ? sentence : feedStatus === "loading" ? "Loading today's sightings." : "Today's sightings are not in yet.";
  return (
    <div className={`flex items-center ${compact ? "flex-col gap-5 text-center" : "gap-7"}`}>
      <NetRing value={summary.metric.value} size={compact ? 168 : 148} label={summary.metric.label} />
      <div className="min-w-0">
        <p className="text-fs-12 text-faint">{longDate(summary.date)}</p>
        <div className={`mt-1 flex items-center gap-2.5 ${compact ? "justify-center" : ""}`}>
          <h1 className="text-fs-26 leading-fs-34 text-fore" style={{ fontFamily: SERIF }}>
            Today
          </h1>
          <HowToReadButton />
        </div>
        <p className="mt-2 max-w-[440px] text-fs-14 leading-fs-21 text-fore-4">{why}</p>
      </div>
    </div>
  );
}

/**
 * The names the greeting needs from Supabase user_metadata: the one the member
 * asked to be called (Settings > Account) and their full name. Null while
 * loading; follows auth events, so a name saved in Settings shows at once.
 */
function useGreetingNames(): { full: string; preferred: string } | null {
  const user = useAuthUser();
  if (user === undefined) return null;
  const p = readProfile(user?.user_metadata);
  return { full: p.fullName, preferred: p.preferredName };
}

/** The viewer's local hour, read on the client only and re-checked at every minute boundary; null before mount. */
function useLocalHour(): number | null {
  const [hour, setHour] = useState<number | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = new Date();
      setHour(now.getHours());
      timer = setTimeout(tick, 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()) + 50);
    };
    tick();
    return () => clearTimeout(timer);
  }, []);
  return hour;
}

/** "Morning, Kuzey": held back until both the hour and the name are known, so no wrong greeting flashes. */
export function DashboardGreeting() {
  const hour = useLocalHour();
  const names = useGreetingNames();
  const ready = hour !== null && names !== null;
  return (
    <h1 className="pl-1.5 text-left text-fs-26 leading-fs-34 text-fore" style={{ fontFamily: SERIF }} aria-hidden={!ready || undefined}>
      {ready && names ? greeting(hour, names.full, names.preferred) : "\u00a0"}
    </h1>
  );
}

/** The clock and the NYSE session state, on the client only; re-read every 30 s and at each open or close. Null before mount. */
function useMarketClock(): { now: number; status: MarketStatus } | null {
  const [clock, setClock] = useState<{ now: number; status: MarketStatus } | null>(null);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = Date.now();
      const status = marketStatus(now);
      setClock({ now, status });
      timer = setTimeout(tick, Math.max(1_000, Math.min(30_000, status.nextChangeMs - now + 50)));
    };
    tick();
    return () => clearTimeout(timer);
  }, []);
  return clock;
}

const EARNINGS_REFRESH_MS = 30 * 60_000;

/** The stored pre-earnings straddles (/api/options?earnings=1); null until the first answer, [] on any error. */
function useStoredEarnings(): OptionsEarningsRelease[] | null {
  const [releases, setReleases] = useState<OptionsEarningsRelease[] | null>(null);
  useEffect(() => {
    let live = true;
    const load = () =>
      void fetchOptionsEarnings().then((r) => {
        if (live) setReleases(r.releases);
      });
    load();
    const timer = setInterval(load, EARNINGS_REFRESH_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, []);
  return releases;
}

/** "US market opens in 3h 24m": a muted pill; its height is held before mount. */
function MarketChip({ status }: { status: MarketStatus | null }) {
  return (
    <span
      className="inline-flex h-6 items-center gap-1.5 rounded-full bg-line/[0.06] px-2.5 text-fs-12 leading-none tabular-nums text-fore-4"
      title={status ? `NYSE regular session, 9:30 to ${status.earlyClose ? "13:00 (early close today)" : "16:00"} New York time` : undefined}
      aria-hidden={!status || undefined}
    >
      {status?.state === "open" ? (
        // Live: a green dot with a soft pulse while the session runs.
        <span className="relative flex h-2 w-2 shrink-0" aria-hidden>
          <span className="absolute inline-flex h-full w-full rounded-full bg-up opacity-60 motion-safe:animate-ping" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-up" />
        </span>
      ) : (
        <Clock width={12} height={12} strokeWidth={2} className="shrink-0 text-quiet" aria-hidden />
      )}
      {status ? status.label : <span className="invisible">US market opens in 0h 00m</span>}
    </span>
  );
}

/** The market chip and one sentence on what needs attention, under the greeting and on its left edge. */
function DashboardBrief() {
  const { feedStatus, portfolio, portfolioSet, sample, userId } = useWorkspace();
  const summary = useToday();
  const clock = useMarketClock();
  const stored = useStoredEarnings();
  const soon = useMemo(() => (stored && clock ? earningsSoon(stored, portfolioSet, clock.now) : null), [stored, clock, portfolioSet]);
  const line = attentionSentence({
    feedStatus,
    portfolioCount: portfolio.length,
    decisions: summary.portfolio.length,
    earnings: soon,
    preview: userId === "preview",
    sample,
  });
  return (
    <div className="flex flex-col items-start gap-3 pl-1.5">
      <MarketChip status={clock?.status ?? null} />
      {/* Loading holds one line so nothing jumps; an empty portfolio shows no sentence. */}
      {line.kind === "none" ? null : (
        <p className="max-w-[640px] text-fs-16 leading-fs-24 text-fore-4" aria-live="polite" aria-hidden={line.kind === "loading" || undefined}>
          {line.kind === "text" ? line.text : "\u00a0"}
        </p>
      )}
    </div>
  );
}

export function DashboardTab() {
  return (
    // The greeting lives in the card's top row (Workspace passes it to CardHeader as `lead`); the brief sits under it.
    <div className="flex w-full flex-col gap-5 px-5 pb-5">
      {/* A soft fade under the greeting row, so content scrolling up under it dissolves instead of cutting off. */}
      <div aria-hidden className="pointer-events-none sticky top-0 z-10 -mx-5 -mb-5 h-5 bg-gradient-to-b from-surface to-surface/0" />
      <DashboardBrief />
      {/* The market strip sits right under the setup card, and stays when the card is gone. */}
      <div className="flex flex-col gap-3">
        <StartWithWhatYouOwn />
        <MarketStrip />
        <PositionsCard />
      </div>
    </div>
  );
}
