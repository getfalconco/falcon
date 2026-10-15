import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { X } from "lucide-react";
import StockIcon from "@/components/stock/StockIcon";
import { cn } from "@/lib/utils";
import { useI18n, type TFunction } from "@/lib/i18n";
import { agoLabel } from "@/lib/dashboard-dates";
import { eventTypeLabel } from "@/lib/event-type-labels";
import { openStock } from "@/lib/stock-open";
import { readNewsRead } from "@/lib/privacy-prefs";
import {
  articleRequest,
  panelRead,
  panelTitles,
  sourceName,
  storyNames,
  type ReadingLookup,
  type ServerReading,
} from "@/lib/news-article";
import type { NewsFeedArticle } from "../../../shared/news-feed";
import type { NewsAnalysis, NewsAnalysisResult, NewsArticleBody } from "../../../shared/news-article";
import type { ClassifierDirection, ClassifierMateriality } from "../../../shared/classifier-types";

/**
 * A news story, opened from the News card: Falcon's headline (with the
 * publisher's own title under it, labelled as the source's), where and when
 * it ran, the names it touches, the article itself, and what Falcon makes of it.
 *
 * Built like the settings and plans panels (portal, blurred backdrop, a
 * rounded glass panel that fades in, Esc / X / backdrop to close), sized to
 * sit inside the smallest window with the text scrolling inside it.
 *
 * Everything is asked of the main process: the article text (it fetches the
 * publisher's page, never this renderer), the server classifier's verdict,
 * and, only when the server has no reading at all, Falcon's own short read.
 * When the verdict lookup fails (the engine out of reach) the server may still
 * have one, so the panel shows the feed's reading if there is one and
 * otherwise says the server reading is unavailable, with Falcon's read made
 * only when the reader asks for it: a failed lookup never buys a second read.
 */

const PANEL_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: [0.33, 1, 0.68, 1] },
} as const;

const LABEL = "select-none font-sans text-[10.5px] font-medium tracking-[0.08em] text-[#9CA3AF]";
const CARD =
  "rounded-2xl border border-white/60 bg-white/40 px-5 py-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04]";
const CHIP = "inline-flex items-center rounded-full bg-black/[0.04] px-2 py-0.5 text-[11px] font-medium text-[#4b5563]";
const PILL =
  "app-no-drag btn-quiet inline-flex items-center gap-1.5 rounded-full border border-white/60 bg-white/55 px-3.5 py-1.5 text-[12.5px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors hover:bg-white/75";

type BodyState = { state: "loading" } | { state: "ready"; body: NewsArticleBody } | { state: "failed" };
type ReadState =
  | { state: "idle" }
  | { state: "off" }
  | { state: "loading" }
  | { state: "ready"; analysis: NewsAnalysis }
  | { state: "failed"; reason: Extract<NewsAnalysisResult, { ok: false }>["reason"] };

function capitalize(text: string, locale: string): string {
  return text ? text.charAt(0).toLocaleUpperCase(locale) + text.slice(1) : text;
}

function openLink(url: string): void {
  if (url) void window.meridian?.openExternal(url);
}

function TickerChip({ ticker, onOpen }: { ticker: string; onOpen: (ticker: string) => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      onClick={() => onOpen(ticker)}
      aria-label={t("dashboard.newsArticle.openStock", { ticker })}
      className="app-no-drag flex shrink-0 items-center gap-1 rounded-full bg-black/[0.04] py-0.5 pl-0.5 pr-2 text-[11.5px] font-semibold text-[#1d1b1b] transition-colors hover:bg-black/[0.08]"
    >
      <span className="flex h-[18px] w-[18px] items-center justify-center overflow-hidden rounded-full bg-white">
        <StockIcon symbol={ticker} size="sm" className="h-3 w-3 object-contain" />
      </span>
      {ticker}
    </button>
  );
}

const DIRECTION_KEY = {
  positive: "dashboard.newsArticle.direction.positive",
  negative: "dashboard.newsArticle.direction.negative",
  mixed: "dashboard.newsArticle.direction.mixed",
  unclear: "dashboard.newsArticle.direction.unclear",
} as const;

const MATERIALITY_KEY = {
  high: "dashboard.newsArticle.materiality.high",
  standard: "dashboard.newsArticle.materiality.standard",
  low: "dashboard.newsArticle.materiality.low",
} as const;

function DirectionChip({ direction, t }: { direction: ClassifierDirection; t: TFunction }) {
  return (
    <span
      className={cn(
        CHIP,
        direction === "positive" && "text-[#16A34A]",
        direction === "negative" && "text-[#DC2626]",
      )}
    >
      {t(DIRECTION_KEY[direction])}
    </span>
  );
}

function MaterialityChip({ materiality, t }: { materiality: ClassifierMateriality; t: TFunction }) {
  return <span className={CHIP}>{t(MATERIALITY_KEY[materiality])}</span>;
}

/** The server's reading: the classifier's verdict, or the feed's material event. */
function ServerRead({ reading, onOpenStock }: { reading: NonNullable<ServerReading>; onOpenStock: (t: string) => void }) {
  const { t, locale, language } = useI18n();
  const english = language.startsWith("en");

  if (reading.kind === "feed") {
    const e = reading.event;
    const direction: ClassifierDirection = e.direction;
    return (
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className={CHIP}>{t("dashboard.newsArticle.material")}</span>
          <span className={CHIP}>{capitalize(eventTypeLabel(e.event_type, t), locale)}</span>
        </div>
        {e.affected_ticker ? (
          <div className="flex flex-wrap items-center gap-2">
            <TickerChip ticker={e.affected_ticker.toUpperCase()} onOpen={onOpenStock} />
            <span className="text-[13px] leading-snug text-[#1d1b1b]">
              {t("dashboard.newsArticle.relevance.direct", { ticker: e.affected_ticker.toUpperCase() })}
            </span>
            <DirectionChip direction={direction} t={t} />
          </div>
        ) : null}
        <p className="text-[11px] text-[#9CA3AF]">{t("dashboard.newsArticle.server.foot")}</p>
      </div>
    );
  }

  const { verdict, related, unrelated } = reading;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
        <span className={CHIP}>{capitalize(eventTypeLabel(verdict.event_type, t), locale)}</span>
        {english && verdict.event_label ? (
          <span className="text-[13px] leading-snug text-[#4b5563]">{verdict.event_label}</span>
        ) : null}
      </div>
      {related.length > 0 ? (
        <ul className="space-y-2.5">
          {related.map((v) => (
            <li key={v.ticker} className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
              <TickerChip ticker={v.ticker} onOpen={onOpenStock} />
              <span className="text-[13px] leading-snug text-[#1d1b1b]">
                {t(v.relevance === "direct" ? "dashboard.newsArticle.relevance.direct" : "dashboard.newsArticle.relevance.indirect", {
                  ticker: v.ticker,
                })}
              </span>
              <MaterialityChip materiality={v.materiality} t={t} />
              <DirectionChip direction={v.direction} t={t} />
            </li>
          ))}
        </ul>
      ) : null}
      {unrelated.length > 0 ? (
        <p className="text-[12px] leading-snug text-[#6b7280]">
          {t("dashboard.newsArticle.relevance.none", { tickers: unrelated.join(", ") })}
        </p>
      ) : null}
      <p className="text-[11px] text-[#9CA3AF]">{t("dashboard.newsArticle.server.foot")}</p>
    </div>
  );
}

/** The verdict lookup failed and the feed has no reading: say so, and offer Falcon's read by hand. */
function ServerUnavailable({ onRead }: { onRead: () => void }) {
  const { t } = useI18n();
  // Settings, Privacy, "Falcon's read on news": off, there is nothing to offer.
  const allowed = readNewsRead();
  return (
    <div className="flex flex-wrap items-center gap-3">
      <p className="text-[12.5px] leading-snug text-[#6b7280]">
        {t("dashboard.newsArticle.read.serverUnavailable")}
        {allowed ? "" : ` ${t("dashboard.newsArticle.read.off")}`}
      </p>
      {allowed ? (
        <button type="button" onClick={onRead} className={PILL}>
          {t("dashboard.newsArticle.read.getRead")}
        </button>
      ) : null}
    </div>
  );
}

/** Falcon's read: made on demand, when the server has none or the reader asks. */
function FalconRead({
  read,
  source,
  onRetry,
  onOpenStock,
}: {
  read: ReadState;
  source: string;
  onRetry: () => void;
  onOpenStock: (t: string) => void;
}) {
  const { t, language } = useI18n();

  if (read.state === "idle" || read.state === "loading") {
    return (
      <div aria-busy="true">
        <p className="text-[12.5px] text-[#9CA3AF]">{t("dashboard.newsArticle.read.loading")}</p>
        <div aria-hidden className="mt-3 space-y-2">
          <div className="h-2.5 w-[92%] animate-pulse rounded-full bg-black/[0.05]" />
          <div className="h-2.5 w-[78%] animate-pulse rounded-full bg-black/[0.05]" />
          <div className="h-2.5 w-[60%] animate-pulse rounded-full bg-black/[0.05]" />
        </div>
      </div>
    );
  }

  if (read.state === "off") {
    return <p className="text-[12.5px] leading-snug text-[#6b7280]">{t("dashboard.newsArticle.read.off")}</p>;
  }

  if (read.state === "failed") {
    const message =
      read.reason === "thin"
        ? t("dashboard.newsArticle.read.thin")
        : read.reason === "unavailable"
          ? t("dashboard.newsArticle.read.unavailable")
          : read.reason === "busy"
            ? t("dashboard.newsArticle.read.busy")
            : t("dashboard.newsArticle.read.failed");
    const retry = read.reason === "failed" || read.reason === "busy";
    return (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-[12.5px] leading-snug text-[#6b7280]">{message}</p>
        {retry ? (
          <button type="button" onClick={onRetry} className={PILL}>
            {t("dashboard.newsArticle.read.retry")}
          </button>
        ) : null}
      </div>
    );
  }

  const { analysis } = read;
  const untranslated =
    !language.startsWith("en") &&
    (analysis.summary.some((l) => l.untranslated) || analysis.companies.some((c) => c.untranslated));
  const foot =
    analysis.basis === "article"
      ? t("dashboard.newsArticle.read.footArticle", { source })
      : t("dashboard.newsArticle.read.footSummary", { source });
  return (
    <div className="space-y-3">
      <p className="select-text text-[13.5px] leading-[1.6] text-[#1d1b1b]">
        {analysis.summary.map((l) => l.text).join(" ")}
      </p>
      {analysis.companies.length > 0 ? (
        <ul className="space-y-2.5">
          {analysis.companies.map((c) => (
            <li key={c.ticker} className="flex items-start gap-2.5">
              <TickerChip ticker={c.ticker} onOpen={onOpenStock} />
              <span className="select-text pt-px text-[13px] leading-[1.55] text-[#1d1b1b]/90">{c.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="text-[11px] leading-snug text-[#9CA3AF]">
        {foot}
        {analysis.graphEdges > 0 ? ` ${t("dashboard.newsArticle.read.footGraph")}` : ""}
        {untranslated ? ` ${t("dashboard.newsArticle.read.englishNote")}` : ""}
      </p>
    </div>
  );
}

function ArticleText({ body, source, onRead }: { body: BodyState; source: string; onRead: () => void }) {
  const { t } = useI18n();
  if (body.state === "loading") {
    return (
      <div aria-busy="true">
        <p className="text-[12.5px] text-[#9CA3AF]">{t("dashboard.newsArticle.loading")}</p>
        <div aria-hidden className="mt-3 space-y-2">
          {[96, 100, 88, 94, 70].map((w, i) => (
            <div key={i} className="h-2.5 animate-pulse rounded-full bg-black/[0.05]" style={{ width: `${w}%` }} />
          ))}
        </div>
      </div>
    );
  }

  const b = body.state === "ready" ? body.body : null;
  const status = b?.status ?? "error";
  const notice =
    status === "paywall"
      ? t("dashboard.newsArticle.paywall", { source })
      : status === "blocked"
        ? t("dashboard.newsArticle.blocked", { source })
        : status === "empty"
          ? t("dashboard.newsArticle.empty")
          : status === "error"
            ? t("dashboard.newsArticle.error")
            : status === "summary"
              ? t("dashboard.newsArticle.summaryOnly")
              : null;
  const paragraphs = b?.paragraphs ?? [];
  const summaryOnly = status !== "full" && paragraphs.length > 0;

  return (
    <div>
      {notice ? (
        <p className="mb-3 text-[12.5px] leading-snug text-[#6b7280]">
          {notice}
          {summaryOnly && status !== "summary" ? ` ${t("dashboard.newsArticle.summaryOnly")}` : ""}
        </p>
      ) : null}
      {paragraphs.length > 0 ? (
        <div className="max-w-[64ch] space-y-3.5">
          {paragraphs.map((p, i) => (
            <p key={i} className="select-text text-[14px] leading-[1.7] text-[#1d1b1b]/90">
              {p}
            </p>
          ))}
        </div>
      ) : null}
      {b?.truncated ? (
        <p className="mt-3 text-[12.5px] text-[#6b7280]">{t("dashboard.newsArticle.continues", { source })}</p>
      ) : null}
      <button type="button" onClick={onRead} className={cn(PILL, "mt-5")}>
        {source ? t("dashboard.newsArticle.readAt", { source }) : t("dashboard.newsArticle.readOriginal")}
      </button>
    </div>
  );
}

function ArticlePanel({ article, onClose }: { article: NewsFeedArticle; onClose: () => void }) {
  const { t, locale, language } = useI18n();
  const request = useMemo(() => articleRequest(article), [article]);
  // Falcon's headline is the title; what the publisher called it sits under
  // it, quietly, so the reader can still see what the source said.
  const { title, sourceTitle } = useMemo(() => panelTitles(article), [article]);
  const names = useMemo(() => storyNames(article), [article]);
  const closeRef = useRef<HTMLButtonElement>(null);

  const [body, setBody] = useState<BodyState>({ state: "loading" });
  const [reading, setReading] = useState<ReadingLookup>({ state: "loading" });
  const [read, setRead] = useState<ReadState>({ state: "idle" });
  const [attempt, setAttempt] = useState(0);
  /** The reader pressed "Get Falcon's read" after a failed verdict lookup. */
  const [manual, setManual] = useState(false);

  const source = sourceName(article.source, body.state === "ready" && body.body.finalUrl ? body.body.finalUrl : article.url);
  const readUrl = body.state === "ready" && body.body.finalUrl ? body.body.finalUrl : article.url;

  useEffect(() => {
    let alive = true;
    setBody({ state: "loading" });
    const get = window.meridian?.getNewsArticle;
    if (typeof get !== "function") {
      setBody({ state: "failed" });
      return;
    }
    get(request)
      .then((res) => {
        if (alive) setBody(res?.ok ? { state: "ready", body: res.body } : { state: "failed" });
      })
      .catch(() => {
        if (alive) setBody({ state: "failed" });
      });
    return () => {
      alive = false;
    };
  }, [request]);

  useEffect(() => {
    let alive = true;
    setReading({ state: "loading" });
    setManual(false);
    const get = window.meridian?.getNewsArticleReading;
    if (typeof get !== "function") {
      setReading({ state: "failed" });
      return;
    }
    get(request)
      .then((res) => {
        if (alive) setReading(res?.ok ? { state: "ready", verdict: res.verdict } : { state: "failed" });
      })
      .catch(() => {
        if (alive) setReading({ state: "failed" });
      });
    return () => {
      alive = false;
    };
  }, [request]);

  // "No verdict" (the lookup answered) asks for Falcon's read on its own. A
  // failed lookup does not: the server may have analysed the story already,
  // so the feed's reading stands if there is one, and otherwise the read is
  // made only when the reader asks for it.
  const panel = panelRead(reading, article);
  const trigger: "auto" | "manual" | null =
    panel.kind === "falcon" ? "auto" : panel.kind === "unavailable" && manual ? "manual" : null;

  useEffect(() => {
    if (!trigger) return;
    // Settings, Privacy, "Falcon's read on news": off, the article never goes to the model.
    if (!readNewsRead()) {
      setRead({ state: "off" });
      return;
    }
    let alive = true;
    setRead({ state: "loading" });
    const analyze = window.meridian?.analyzeNewsArticle;
    if (typeof analyze !== "function") {
      setRead({ state: "failed", reason: "unavailable" });
      return;
    }
    analyze({ ...request, language, trigger })
      .then((res) => {
        if (!alive) return;
        // Main found the lookup failing too and made no model call: the
        // panel shows the unavailable state and its button instead.
        if (!res?.ok && res?.reason === "lookup_failed") {
          setRead({ state: "idle" });
          setReading({ state: "failed" });
          return;
        }
        setRead(res?.ok ? { state: "ready", analysis: res.analysis } : { state: "failed", reason: res?.reason ?? "failed" });
      })
      .catch(() => {
        if (alive) setRead({ state: "failed", reason: "failed" });
      });
    return () => {
      alive = false;
    };
  }, [trigger, request, language, attempt]);

  useEffect(() => {
    const focus = window.setTimeout(() => closeRef.current?.focus(), 180);
    return () => window.clearTimeout(focus);
  }, []);

  const onOpenStock = (ticker: string) => {
    onClose();
    openStock(ticker);
  };

  const published = useMemo(() => {
    const d = new Date(article.datetime * 1000);
    if (Number.isNaN(d.getTime())) return "";
    try {
      return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(d);
    } catch {
      return d.toLocaleString();
    }
  }, [article.datetime, locale]);

  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={t("dashboard.newsArticle.label")}
      className="app-no-drag relative flex h-[min(620px,86vh)] w-[min(780px,88vw)] flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150"
      {...PANEL_FADE}
    >
      {/* The panel covers the window's own drag strip, so its top edge drags instead. */}
      <div className="app-drag-region absolute inset-x-0 top-0 h-11" aria-hidden />
      <div className="scrollbar-meridian min-h-0 flex-1 overflow-y-auto overscroll-contain px-9 pb-8 pt-11">
        <div className="flex flex-wrap items-center gap-1.5 pr-8 text-[11.5px] text-[#9CA3AF]">
          {source ? <span className="truncate font-medium text-[#6b7280]">{source}</span> : null}
          {source ? <span aria-hidden>·</span> : null}
          <span className="shrink-0 tabular-nums">{agoLabel(article.datetime, Date.now(), locale, t("dashboard.news.justNow"))}</span>
          {published ? (
            <>
              <span aria-hidden>·</span>
              <span className="shrink-0 tabular-nums">{published}</span>
            </>
          ) : null}
        </div>

        <h2 className="mt-2 select-text pr-6 text-[21px] font-medium leading-[1.3] tracking-[-0.01em] text-[#1d1b1b]">
          {title}
        </h2>
        {sourceTitle ? (
          <p className="mt-1.5 select-text pr-6 text-[12px] leading-snug text-[#9CA3AF]">
            {t("dashboard.newsArticle.sourceTitle", { title: sourceTitle })}
          </p>
        ) : null}

        {names.length > 0 ? (
          <div className="mt-3 flex flex-wrap items-center gap-1.5">
            {names.map((n) => (
              <TickerChip key={n} ticker={n} onOpen={onOpenStock} />
            ))}
          </div>
        ) : null}

        <section className={cn(CARD, "mt-5")}>
          <div className={cn(LABEL, "mb-2.5")}>{t("dashboard.newsArticle.readHeading")}</div>
          {panel.kind === "pending" ? (
            <div aria-busy="true" className="space-y-2">
              <div className="h-2.5 w-[70%] animate-pulse rounded-full bg-black/[0.05]" />
              <div className="h-2.5 w-[50%] animate-pulse rounded-full bg-black/[0.05]" />
            </div>
          ) : panel.kind === "server" ? (
            <ServerRead reading={panel.reading} onOpenStock={onOpenStock} />
          ) : panel.kind === "unavailable" && !manual ? (
            <ServerUnavailable onRead={() => setManual(true)} />
          ) : (
            <FalconRead read={read} source={source} onRetry={() => setAttempt((n) => n + 1)} onOpenStock={onOpenStock} />
          )}
        </section>

        <section className="mt-6">
          <div className={cn(LABEL, "mb-3")}>{t("dashboard.newsArticle.articleHeading")}</div>
          <ArticleText body={body} source={source} onRead={() => openLink(readUrl)} />
        </section>
      </div>
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label={t("dashboard.newsArticle.close")}
        className="app-no-drag absolute right-4 top-4 rounded-lg p-1.5 text-[#6b7280] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
      >
        <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
      </button>
    </motion.div>
  );
}

export default function NewsArticleModal({
  article,
  onClose,
}: {
  /** The story to show; null closes the panel. */
  article: NewsFeedArticle | null;
  onClose: () => void;
}) {
  const open = article !== null;

  // Esc closes, before anything behind the panel hears it, and the page
  // behind never scrolls under it.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {article ? (
        // React bubbles events out of a portal into the card that opened it;
        // `data-no-lift` keeps a press in here from lifting that card.
        <motion.div key={`news-${article.id}`} data-no-lift className="fixed inset-0 z-[90] flex items-center justify-center">
          <motion.div
            className="app-no-drag absolute inset-0 bg-black/10"
            style={{ backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.33, 1, 0.68, 1] }}
            onClick={onClose}
          />
          <ArticlePanel article={article} onClose={onClose} />
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
