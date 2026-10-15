import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown, Copy, MoreVertical, Search, X } from "lucide-react";
import StockIcon from "@/components/stock/StockIcon";
import { readPaperAccount, subscribePaperAccount } from "@/lib/paper-account";
import { cn } from "@/lib/utils";
import { DROPDOWN_FADE } from "@/lib/dropdown-motion";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { agoLabel } from "@/lib/dashboard-dates";
import { eventTypeLabel } from "@/lib/event-type-labels";
import { useNewsFeed } from "@/lib/news-feed-store";
import NewsArticleModal from "./NewsArticleModal";
import type { NewsFeedArticle } from "../../../shared/news-feed";

/**
 * The news card: what the engine's poll has read, newest first — headline,
 * source, how long ago, and the names the story touches.
 *
 * The feed is the server's. The desktop never asks a news provider for it;
 * `news:feed` is answered by the always-on engine from the same poll that
 * mints events, so every install reads one feed and nobody spends the quota
 * twice. The card reads it through a shared store that outlives the card and
 * keeps itself fresh while the app is open (news-feed-store.ts), so coming
 * back to the dashboard shows the list at once instead of loading it again.
 *
 * Three scopes, one at a time: the whole market, one sector (the sectors are
 * whatever the feed's names belong to — the engine's company table, not a
 * list kept here), or the reader's own positions. A search runs across
 * whichever scope is on.
 */

type Scope = "market" | "sector" | "positions";

const SCOPES: Array<{ key: Scope; label: MessageKey }> = [
  { key: "market", label: "dashboard.news.scope.market" },
  { key: "sector", label: "dashboard.news.scope.sector" },
  { key: "positions", label: "dashboard.news.scope.positions" },
];

/** Names shown per story before the rest fold into "+n". */
const TICKERS_SHOWN = 4;

/** Names on a story, the one the classifier says it moves first. */
function namesOf(a: NewsFeedArticle): string[] {
  const out: string[] = [];
  const affected = a.event?.affected_ticker?.trim().toUpperCase();
  if (affected) out.push(affected);
  for (const t of a.tickers) if (!out.includes(t)) out.push(t);
  return out;
}

export default function NewsCard({
  onDuplicate,
  onRemove,
}: {
  /** Three-dot menu: open a copy of this card on the dashboard. */
  onDuplicate?: () => void;
  /** Three-dot menu: take this card off the dashboard. */
  onRemove?: () => void;
}) {
  const { t, locale } = useI18n();
  // The feed lives in a module-level store, not in this component: the
  // dashboard unmounts on every tab switch and every trip into a stock, and
  // the card used to come back to "loading" and a fresh request each time.
  // Now it shows what the store holds at once and the store asks again only
  // when that is older than its freshness window (see news-feed-store.ts). A
  // failed read keeps the last good list and says so quietly underneath.
  const feed = useNewsFeed();
  // The story open in the article panel, if any.
  const [openArticle, setOpenArticle] = useState<NewsFeedArticle | null>(null);
  const closeArticle = useCallback(() => setOpenArticle(null), []);
  const articles = useMemo(() => feed.value ?? [], [feed.value]);
  const error = feed.error;
  const loaded = feed.settled;
  const [now, setNow] = useState(() => Date.now());

  // "12m ago" has to keep counting between reads, and jumps on a new one.
  useEffect(() => {
    setNow(Date.now());
    const tick = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(tick);
  }, [feed.fetchedAt]);

  // The reader's names, for the Positions scope — demo book included, the way
  // every other card reads it.
  const [held, setHeld] = useState<string[]>(() => Object.keys(readPaperAccount().positions));
  useEffect(
    () => subscribePaperAccount(() => setHeld(Object.keys(readPaperAccount().positions))),
    [],
  );

  const [scope, setScope] = useState<Scope>("market");
  const [sector, setSector] = useState<string | null>(null);
  const [sectorOpen, setSectorOpen] = useState(false);
  const sectorRef = useRef<HTMLDivElement>(null);

  const sectors = useMemo(() => {
    const seen = new Set<string>();
    for (const a of articles) for (const s of a.sectors) seen.add(s);
    return [...seen].sort((a, b) => a.localeCompare(b));
  }, [articles]);

  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const searchInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  // The three-dot menu, and the sector list: each closes on a press anywhere
  // else, or on Escape. Listeners exist only while something is open.
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menuOpen && !sectorOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenuOpen(false);
      if (!sectorRef.current?.contains(e.target as Node)) setSectorOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setMenuOpen(false);
      setSectorOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, sectorOpen]);

  const shown = useMemo(() => {
    const heldSet = new Set(held.map((t) => t.toUpperCase()));
    const needle = query.trim().toLowerCase();
    return articles.filter((a) => {
      if (scope === "positions" && !namesOf(a).some((t) => heldSet.has(t))) return false;
      if (scope === "sector" && sector && !a.sectors.includes(sector)) return false;
      if (!needle) return true;
      return (
        a.headline.toLowerCase().includes(needle) ||
        a.source.toLowerCase().includes(needle) ||
        a.summary.toLowerCase().includes(needle) ||
        namesOf(a).some((t) => t.toLowerCase().includes(needle))
      );
    });
  }, [articles, scope, sector, held, query]);

  // A failed read with no reason of its own is kept as "", and said here.
  const errorText = error === "" ? t("dashboard.news.noAnswer") : error;
  const empty = (() => {
    if (!loaded) return t("dashboard.news.loading");
    if (errorText && articles.length === 0) return t("dashboard.news.outOfReach", { error: errorText });
    if (articles.length === 0) return t("dashboard.news.nothingYet");
    if (shown.length > 0) return null;
    if (query.trim()) return t("dashboard.news.noMatch");
    if (scope === "positions") {
      return held.length === 0 ? t("dashboard.news.noPositions") : t("dashboard.news.nothingOnNames");
    }
    if (scope === "sector") return sector ? t("dashboard.news.nothingInSector", { sector }) : t("dashboard.news.pickSector");
    return null;
  })();

  return (
    <div className="grid h-full w-full grid-cols-[minmax(0,1fr)] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden rounded-3xl border border-white/60 bg-white/40 p-5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150">
      {/* Header — the label every card carries, and on the right the search
          pill and the three-dot menu, in the same places the Positions card
          keeps them. */}
      <div className="flex shrink-0 items-center justify-between">
        <span className="select-none font-sans text-[11px] font-medium tracking-[0.04em] text-[#9CA3AF]">
          {t("dashboard.news.label")}
        </span>
        <div className="flex items-center gap-3">
          <motion.div
            data-no-lift
            initial={false}
            animate={{
              width: searchOpen ? 176 : 16,
              backgroundColor: searchOpen ? "rgba(255,255,255,0.55)" : "rgba(255,255,255,0)",
              borderColor: searchOpen ? "rgba(255,255,255,0.6)" : "rgba(255,255,255,0)",
              boxShadow: searchOpen
                ? "inset 0 1px 0 rgba(255,255,255,0.7), 0 0 0 1px rgba(0,0,0,0.04)"
                : "inset 0 0 0 rgba(255,255,255,0), 0 0 0 0 rgba(0,0,0,0)",
            }}
            transition={{ type: "spring", stiffness: 420, damping: 34 }}
            className={cn(
              "flex h-7 items-center overflow-hidden rounded-full border",
              searchOpen ? "-my-1.5 pl-2 pr-2.5 backdrop-blur-xl backdrop-saturate-150" : "-my-1.5",
            )}
          >
            <button
              type="button"
              aria-label={searchOpen ? t("dashboard.card.closeSearch") : t("dashboard.news.search")}
              aria-expanded={searchOpen}
              onClick={() => {
                if (searchOpen) {
                  setQuery("");
                  setSearchOpen(false);
                } else {
                  setSearchOpen(true);
                }
              }}
              className={cn(
                "app-no-drag flex shrink-0 items-center transition-colors hover:text-[#1d1b1b]",
                searchOpen ? "text-[#1d1b1b]" : "text-[#4b5563]",
              )}
            >
              <Search className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
            <input
              ref={searchInputRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                }
              }}
              onBlur={() => {
                if (!query.trim()) setSearchOpen(false);
              }}
              placeholder={t("dashboard.news.search")}
              aria-label={t("dashboard.news.search")}
              tabIndex={searchOpen ? 0 : -1}
              className={cn(
                "app-no-drag ml-2 w-full min-w-0 bg-transparent text-[12.5px] text-[#1d1b1b] outline-none placeholder:text-[#9CA3AF]",
                !searchOpen && "pointer-events-none opacity-0",
              )}
            />
          </motion.div>

          <div ref={menuRef} data-no-lift className="relative flex -mr-[10px]">
            <button
              type="button"
              aria-label={t("dashboard.card.menu")}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((v) => !v)}
              className={cn(
                "app-no-drag transition-colors hover:text-[#1d1b1b]",
                menuOpen ? "text-[#1d1b1b]" : "text-[#4b5563]",
              )}
            >
              <MoreVertical className="h-4 w-4" strokeWidth={1.75} aria-hidden />
            </button>
            <AnimatePresence>
            {menuOpen ? (
              <motion.div
                {...DROPDOWN_FADE}
                role="menu"
                aria-label={t("dashboard.card.actions")}
                className="app-no-drag absolute right-0 top-full z-50 mt-2 w-48 rounded-2xl border border-white/60 bg-white p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.06]"
              >
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onDuplicate?.();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium text-[#1d1b1b] transition-colors hover:bg-black/[0.05]"
                >
                  <Copy className="h-[15px] w-[15px] text-[#4b5563]" strokeWidth={1.75} aria-hidden />
                  {t("dashboard.card.duplicate")}
                </button>
                <div aria-hidden className="mx-2 my-1 h-px bg-black/[0.06]" />
                <button
                  role="menuitem"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    onRemove?.();
                  }}
                  className="flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-[13px] font-medium text-[#DC2626] transition-colors hover:bg-[#DC2626]/[0.06]"
                >
                  <X className="h-[15px] w-[15px]" strokeWidth={2} aria-hidden />
                  {t("dashboard.card.delete")}
                </button>
              </motion.div>
            ) : null}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* Scope — three words, the one in force underlined the way the chart's
          timeframes are. Sector opens a list of what the feed actually holds. */}
      <div className="mt-4 flex shrink-0 items-center gap-5">
        {SCOPES.map((s) => {
          const on = scope === s.key;
          if (s.key === "sector") {
            return (
              <div key={s.key} ref={sectorRef} data-no-lift className="relative">
                <button
                  type="button"
                  aria-haspopup="listbox"
                  aria-expanded={sectorOpen}
                  onClick={() => {
                    setScope("sector");
                    setSectorOpen((v) => !v);
                  }}
                  className={cn(
                    "app-no-drag relative flex items-center gap-1 pb-1 text-[12.5px] transition-colors",
                    on ? "text-[#1d1b1b]" : "text-[#9CA3AF] hover:text-[#6b7280]",
                  )}
                >
                  {on && sector ? sector : t(s.label)}
                  <ChevronDown className="h-3 w-3" strokeWidth={2} aria-hidden />
                  {on ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-[#1d1b1b]" /> : null}
                </button>
                <AnimatePresence>
                  {sectorOpen ? (
                    <motion.div
                      role="listbox"
                      aria-label={t("dashboard.news.scope.sector")}
                      {...DROPDOWN_FADE}
                      className="scrollbar-meridian app-no-drag absolute left-0 top-full z-50 mt-2 max-h-56 w-52 overflow-y-auto rounded-2xl border border-white/60 bg-white p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_18px_44px_rgba(0,0,0,0.14)] ring-1 ring-black/[0.06]"
                    >
                      {sectors.length === 0 ? (
                        <p className="px-3 py-2 text-[12px] text-[#9CA3AF]">{t("dashboard.news.noSectors")}</p>
                      ) : (
                        sectors.map((name) => {
                          const picked = sector === name;
                          return (
                            <button
                              key={name}
                              role="option"
                              aria-selected={picked}
                              type="button"
                              onClick={() => {
                                setSector(name);
                                setSectorOpen(false);
                              }}
                              className="flex w-full items-center justify-between gap-2 rounded-xl px-3 py-1.5 text-left text-[12.5px] text-[#1d1b1b] transition-colors hover:bg-black/[0.05]"
                            >
                              <span className="truncate">{name}</span>
                              {picked ? <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2} aria-hidden /> : null}
                            </button>
                          );
                        })
                      )}
                    </motion.div>
                  ) : null}
                </AnimatePresence>
              </div>
            );
          }
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={on}
              onClick={() => setScope(s.key)}
              className={cn(
                "app-no-drag relative pb-1 text-[12.5px] transition-colors",
                on ? "text-[#1d1b1b]" : "text-[#9CA3AF] hover:text-[#6b7280]",
              )}
            >
              {t(s.label)}
              {on ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-px bg-[#1d1b1b]" /> : null}
            </button>
          );
        })}
        {errorText && articles.length > 0 ? (
          <span className="ml-auto truncate text-[10.5px] text-[#9CA3AF]" title={errorText}>
            {t("dashboard.news.lastReadFailed")}
          </span>
        ) : null}
      </div>

      {/* The stories. Scrolls in its own row; the card's height is the
          reader's, and the list takes what is left of it. */}
      <div
        data-no-lift
        style={{ touchAction: "pan-y" }}
        className="scrollbar-meridian app-no-drag mt-3 min-h-0 overflow-y-auto overscroll-contain pr-1 will-change-transform"
      >
        {empty ? (
          <p className="py-2 text-[12.5px] leading-relaxed text-[#9CA3AF]">{empty}</p>
        ) : (
          <ul className="flex flex-col">
            {shown.map((a) => {
              const names = namesOf(a);
              const extra = names.length - TICKERS_SHOWN;
              const dir = a.event?.material ? a.event.direction : null;
              return (
                <li key={a.id} className="border-b-[0.5px] border-black/[0.06] last:border-b-0">
                  <button
                    type="button"
                    onClick={() => setOpenArticle(a)}
                    className="app-no-drag group block w-full py-2.5 text-left"
                  >
                  <p className="line-clamp-2 text-[13px] font-medium leading-snug text-[#1d1b1b] underline-offset-[3px] group-hover:underline">
                    {a.headline}
                  </p>
                  <div className="mt-1 flex items-center gap-1.5 text-[11px] text-[#9CA3AF]">
                    {a.source ? <span className="truncate">{a.source}</span> : null}
                    {a.source ? <span aria-hidden>·</span> : null}
                    <span className="shrink-0 tabular-nums">{agoLabel(a.datetime, now, locale, t("dashboard.news.justNow"))}</span>
                    {dir === "positive" || dir === "negative" ? (
                      <>
                        <span aria-hidden>·</span>
                        <span
                          className={cn(
                            "shrink-0 font-medium",
                            dir === "positive" ? "text-[#16A34A]" : "text-[#DC2626]",
                          )}
                        >
                          {a.event ? eventTypeLabel(a.event.event_type, t) : null}
                        </span>
                      </>
                    ) : null}
                  </div>
                  {names.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      {names.slice(0, TICKERS_SHOWN).map((t) => (
                        <span
                          key={t}
                          className="flex items-center gap-1 rounded-full bg-black/[0.04] py-0.5 pl-0.5 pr-2 text-[11px] font-semibold text-[#1d1b1b]"
                        >
                          <span className="flex h-4 w-4 items-center justify-center overflow-hidden rounded-full bg-white">
                            <StockIcon symbol={t} size="sm" className="h-3 w-3 object-contain" />
                          </span>
                          {t}
                        </span>
                      ))}
                      {extra > 0 ? (
                        <span className="text-[11px] text-[#9CA3AF]">+{extra}</span>
                      ) : null}
                    </div>
                  ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <NewsArticleModal article={openArticle} onClose={closeArticle} />
    </div>
  );
}
