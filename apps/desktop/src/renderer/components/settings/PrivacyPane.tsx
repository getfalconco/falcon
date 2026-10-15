import { Fragment, useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { motion } from "framer-motion";
import { ArrowLeft, ChevronRight, ExternalLink } from "lucide-react";
import type { User } from "@supabase/supabase-js";
import type { LocalDataCategory, PrivacySummary } from "../../../shared/privacy-types";
import { formatBytes, summarizeBrowserStorage, type BrowserStorageSummary } from "@/lib/browser-storage";
import { gatherRendererExport } from "@/lib/privacy-data";
import {
  clearRecentStockSearches,
  getRecentStockSearches,
  subscribeRecentStockSearches,
} from "@/lib/recent-stock-search";
import { readNewsRead, readRememberSearches, writeNewsRead, writeRememberSearches } from "@/lib/privacy-prefs";
import { useReducedMotionPref } from "@/lib/motion";
import { openLegal } from "@/lib/legal-links";
import { useI18n, type MessageKey, type TFunction } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { SettingsRow, SettingsSection } from "./SettingsRow";
import { Switch } from "./controls";
import { BUTTON, DANGER_BUTTON, StackedRow, StatusLine, Value, formatCount } from "./pane-kit";
import { listText, pluralKey } from "./i18n-helpers";

/**
 * Privacy: what Falcon keeps and where it goes, counted from this machine
 * rather than promised. The data folder is walked in the main process
 * (main/privacy), the app's browser storage here. The list of who receives
 * what was checked against the code that sends it; the hosts in it are read
 * from this install's own configuration.
 *
 * The pane opens on a short overview: two rows that push a detail page inside
 * the pane (what is stored where, and who receives what), the preferences
 * that change what leaves the machine, and the reader's data with an action
 * on each row. Every row's action works; a row whose action this window
 * cannot take (no Settings host to jump with) is left out.
 *
 * There is no telemetry toggle because there is no telemetry: the app ships no
 * analytics, usage tracking or crash reporting SDK.
 */

type Load<T> = { state: "loading" } | { state: "ready"; value: T } | { state: "error"; error: string };

/** The pane's three pages: the overview, and the two it pushes. */
type Page = "main" | "protect" | "use";

/** The home tabs the Your data rows lead to. */
export type PrivacyTab = "agents" | "calendar";

/**
 * The words for each folder main reports, by the category's stable key.
 * Main still sends English words; they are the fallback for a key added
 * there before it has a translation here. A category whose name says what
 * it holds has no line under it; the ones that do say something the name
 * cannot (what of yours is in it, who shares it, how long it stays).
 */
const CATEGORY_KEYS: Readonly<Record<string, { label: MessageKey; description?: MessageKey }>> = {
  snaptrade: { label: "settings.privacy.cat.snaptrade", description: "settings.privacy.cat.snaptradeDescription" },
  account: { label: "settings.privacy.cat.account", description: "settings.privacy.cat.accountDescription" },
  engines: { label: "settings.privacy.cat.engines", description: "settings.privacy.cat.enginesDescription" },
  profile: { label: "settings.privacy.cat.profile" },
  portfolio: { label: "settings.privacy.cat.portfolio", description: "settings.privacy.cat.portfolioDescription" },
  research: { label: "settings.privacy.cat.research" },
  insight: { label: "settings.privacy.cat.insight", description: "settings.privacy.cat.insightDescription" },
  news: { label: "settings.privacy.cat.news" },
  risk: { label: "settings.privacy.cat.risk", description: "settings.privacy.cat.riskDescription" },
  logs: { label: "settings.privacy.cat.logs", description: "settings.privacy.cat.logsDescription" },
  briefings: { label: "settings.privacy.cat.briefings", description: "settings.privacy.cat.briefingsDescription" },
  "briefing-cache": { label: "settings.privacy.cat.briefingCache" },
  agents: { label: "settings.privacy.cat.agents", description: "settings.privacy.cat.agentsDescription" },
  calendar: { label: "settings.privacy.cat.calendar", description: "settings.privacy.cat.calendarDescription" },
  "calendar-cache": { label: "settings.privacy.cat.calendarCache", description: "settings.privacy.cat.calendarCacheDescription" },
  earnings: { label: "settings.privacy.cat.earnings", description: "settings.privacy.cat.earningsDescription" },
  preferences: { label: "settings.privacy.cat.preferences", description: "settings.privacy.cat.preferencesDescription" },
  other: { label: "settings.privacy.cat.other" },
};

function categoryWords(c: LocalDataCategory, t: TFunction): { label: string; description?: string } {
  const keys = CATEGORY_KEYS[c.key];
  if (!keys) return { label: c.label, description: c.description };
  return { label: t(keys.label), description: keys.description ? t(keys.description) : undefined };
}

function readBrowserStorage(): BrowserStorageSummary | null {
  try {
    return summarizeBrowserStorage(window.localStorage);
  } catch {
    return null;
  }
}

function useFiles(): (n: number) => string {
  const { t, locale } = useI18n();
  return (n) =>
    t(pluralKey(locale, n, "settings.privacy.files.one", "settings.privacy.files.other"), { count: formatCount(n) });
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** Underlined words inside a sentence that open a page or take the reader somewhere. */
function InlineLink({ children, onClick }: { children: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="app-no-drag rounded-sm text-[#4b5563] underline underline-offset-[3px] transition-colors hover:text-[#1d1b1b]"
    >
      {children}
    </button>
  );
}

/** A row that pushes one of the pane's detail pages. */
function NavRow({
  label,
  onOpen,
  buttonRef,
  last = false,
}: {
  label: string;
  onOpen: () => void;
  buttonRef: RefObject<HTMLButtonElement>;
  last?: boolean;
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onOpen}
      className={cn(
        "app-no-drag group flex w-full items-center justify-between gap-6 py-4 text-left",
        last ? "" : "border-b border-black/[0.06]",
      )}
    >
      <span className="text-[13.5px] font-normal text-[#1d1b1b]">{label}</span>
      <ChevronRight
        className="h-4 w-4 shrink-0 text-[#9CA3AF] transition-transform duration-150 group-hover:translate-x-0.5"
        strokeWidth={1.75}
        aria-hidden
      />
    </button>
  );
}

/** A detail page's head: the way back, the page's name, and one line on what it holds. */
function SubPageHead({
  title,
  lead,
  onBack,
  backRef,
}: {
  title: string;
  lead: string;
  onBack: () => void;
  backRef: RefObject<HTMLButtonElement>;
}) {
  const { t } = useI18n();
  return (
    <div className="pb-5">
      <div className="flex items-center gap-1.5">
        <button
          ref={backRef}
          type="button"
          onClick={onBack}
          aria-label={t("settings.privacy.back")}
          title={t("settings.privacy.back")}
          className="app-no-drag -ml-1.5 rounded-lg p-1 text-[#6b7280] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
        >
          <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden />
        </button>
        <h2 className="text-[15px] font-medium text-[#1d1b1b]">{title}</h2>
      </div>
      <p className="mt-2 max-w-[560px] text-[12.5px] font-normal leading-relaxed text-[#6b7280]">{lead}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// How we protect your data: what is stored where
// ---------------------------------------------------------------------------

function OnThisDevice({ summary }: { summary: Load<PrivacySummary> }) {
  const { t } = useI18n();
  const files = useFiles();
  if (summary.state === "loading") {
    return (
      <SettingsRow label={t("settings.privacy.device")}>
        <Value muted>{t("settings.pane.counting")}</Value>
      </SettingsRow>
    );
  }
  if (summary.state === "error") {
    return (
      <SettingsRow label={t("settings.privacy.device")} description={summary.error}>
        <Value muted>{t("settings.pane.unavailable")}</Value>
      </SettingsRow>
    );
  }
  const { root, categories } = summary.value;
  const total = categories.reduce((acc, c) => ({ files: acc.files + c.files, bytes: acc.bytes + c.bytes }), { files: 0, bytes: 0 });
  return (
    <>
      <SettingsRow label={t("settings.privacy.device")} description={<span className="break-all">{root}</span>}>
        <Value>
          {formatBytes(total.bytes)} · {files(total.files)}
        </Value>
      </SettingsRow>
      {categories.map((c) => {
        const { label, description } = categoryWords(c, t);
        return (
          <SettingsRow key={c.key} label={label} description={description} className="pl-4">
            <Value>
              {formatBytes(c.bytes)} · {files(c.files)}
            </Value>
          </SettingsRow>
        );
      })}
    </>
  );
}

function ProtectPage({ summary, storage }: { summary: Load<PrivacySummary>; storage: BrowserStorageSummary | null }) {
  const { t, locale } = useI18n();
  return (
    <>
      <SettingsSection title={t("settings.privacy.stores")}>
        <OnThisDevice summary={summary} />
        <SettingsRow
          label={t("settings.privacy.window")}
          description={t(
            storage && storage.sessionKeys > 0
              ? "settings.privacy.windowDescriptionSession"
              : "settings.privacy.windowDescription",
          )}
          className="border-b-0"
        >
          {storage ? (
            <Value>
              {formatBytes(storage.bytes)} ·{" "}
              {t(pluralKey(locale, storage.keys, "settings.privacy.items.one", "settings.privacy.items.other"), {
                count: formatCount(storage.keys),
              })}
            </Value>
          ) : (
            <Value muted>{t("settings.pane.unavailable")}</Value>
          )}
        </SettingsRow>
      </SettingsSection>

      <SettingsSection title={t("settings.privacy.safeguards")}>
        <StackedRow label={t("settings.privacy.keys")} description={t("settings.privacy.keysDescription")} />
        <StackedRow
          label={t("settings.privacy.to.analytics")}
          description={t("settings.privacy.to.analyticsDescription")}
          last
        />
      </SettingsSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// How we use your data: who receives what
// ---------------------------------------------------------------------------

function UsePage({ summary }: { summary: Load<PrivacySummary> }) {
  const { t } = useI18n();
  const routes = summary.state === "ready" ? summary.value.routes : null;
  const modelHost = routes?.modelHost ?? "api.anthropic.com";
  const newsHost = routes?.newsHost ?? "Finnhub";
  return (
    <div className="pb-6">
      <StackedRow label={t("settings.privacy.to.account")} description={t("settings.privacy.to.accountDescription")} />
      {routes?.engineHost ? (
        <StackedRow
          label={t("settings.privacy.to.engine", { host: routes.engineHost })}
          description={t("settings.privacy.to.engineDescription")}
        />
      ) : null}
      <StackedRow
        label={t("settings.privacy.to.model", { host: modelHost })}
        description={t(routes?.viaWorker ? "settings.privacy.to.modelDescriptionWorker" : "settings.privacy.to.modelDescription")}
      />
      <StackedRow
        label={t("settings.privacy.to.market", { hosts: `${newsHost}, Yahoo Finance, SEC EDGAR, Nasdaq` })}
        description={t("settings.privacy.to.marketDescription")}
      />
      <StackedRow label="SnapTrade" description={t("settings.privacy.to.snaptradeDescription")} />
      <StackedRow label={t("settings.privacy.to.errors")} description={t("settings.privacy.to.errorsDescription")} last />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

function Preferences({ onLearnMore }: { onLearnMore: (page: Exclude<Page, "main">) => void }) {
  const { t } = useI18n();
  const [searches, setSearches] = useState<boolean>(() => readRememberSearches());
  const [newsRead, setNewsRead] = useState<boolean>(() => readNewsRead());
  const learnMore = (page: Exclude<Page, "main">) => (
    <>
      {" "}
      <InlineLink onClick={() => onLearnMore(page)}>{t("settings.privacy.learnMore")}</InlineLink>
    </>
  );
  return (
    <SettingsSection title={t("settings.privacy.prefs")}>
      <SettingsRow
        label={t("settings.privacy.pref.searches")}
        description={
          <>
            {t("settings.privacy.pref.searchesDescription")}
            {learnMore("protect")}
          </>
        }
      >
        <Switch
          label={t("settings.privacy.pref.searches")}
          checked={searches}
          onChange={(next) => {
            setSearches(next);
            writeRememberSearches(next);
            if (!next) clearRecentStockSearches();
          }}
        />
      </SettingsRow>
      <SettingsRow
        label={t("settings.privacy.pref.newsRead")}
        description={
          <>
            {t("settings.privacy.pref.newsReadDescription")}
            {learnMore("use")}
          </>
        }
        className="border-b-0"
      >
        <Switch
          label={t("settings.privacy.pref.newsRead")}
          checked={newsRead}
          onChange={(next) => {
            setNewsRead(next);
            writeNewsRead(next);
          }}
        />
      </SettingsRow>
    </SettingsSection>
  );
}

// ---------------------------------------------------------------------------
// Your data
// ---------------------------------------------------------------------------

type ExportPhase =
  | { kind: "idle" }
  | { kind: "working" }
  | { kind: "saved"; path: string; bytes: number }
  | { kind: "error"; text: string };

function ExportControl({ user }: { user: User | null }) {
  const { t } = useI18n();
  const [phase, setPhase] = useState<ExportPhase>({ kind: "idle" });
  const exportMyData = window.meridian?.exportMyData;

  const run = async () => {
    if (!exportMyData) return;
    setPhase({ kind: "working" });
    try {
      const result = await exportMyData(await gatherRendererExport(user));
      if (result.ok) setPhase({ kind: "saved", path: result.path, bytes: result.bytes });
      else if ("canceled" in result) setPhase({ kind: "idle" });
      else setPhase({ kind: "error", text: result.error });
    } catch (err) {
      setPhase({ kind: "error", text: err instanceof Error ? err.message : t("settings.privacy.export.failed") });
    }
  };

  return (
    <SettingsRow
      label={t("settings.privacy.export.label")}
      description={
        phase.kind === "saved"
          ? t("settings.privacy.export.saved", { size: formatBytes(phase.bytes), path: phase.path })
          : t("settings.privacy.export.description")
      }
    >
      <div className="flex items-center gap-3">
        {phase.kind === "error" ? <StatusLine text={phase.text} error /> : null}
        <button
          type="button"
          className={BUTTON}
          disabled={!exportMyData || phase.kind === "working"}
          onClick={() => void run()}
        >
          {phase.kind === "working" ? t("settings.privacy.export.working") : t("settings.privacy.export.button")}
        </button>
      </div>
    </SettingsRow>
  );
}

/**
 * Two presses, like signing out everywhere: the first shows exactly what will
 * go, the second removes it. It falls back by itself if left alone.
 */
function ClearHistory({
  summary,
  onCleared,
  last,
}: {
  summary: Load<PrivacySummary>;
  onCleared: () => void;
  last: boolean;
}) {
  const { t, locale } = useI18n();
  const [phase, setPhase] = useState<"idle" | "confirm" | "working" | "done" | "error">("idle");
  const [result, setResult] = useState<string>("");
  const [searches, setSearches] = useState(() => getRecentStockSearches().length);
  const clearLocalHistory = window.meridian?.clearLocalHistory;

  // Turning "Remember recent searches" off clears them too; the count follows.
  useEffect(() => subscribeRecentStockSearches(() => setSearches(getRecentStockSearches().length)), []);

  useEffect(() => {
    if (phase !== "confirm" && phase !== "done" && phase !== "error") return;
    const timer = setTimeout(() => setPhase("idle"), phase === "confirm" ? 8000 : 5000);
    return () => clearTimeout(timer);
  }, [phase]);

  const searchesText = (n: number) =>
    t(pluralKey(locale, n, "settings.privacy.clear.searches.one", "settings.privacy.clear.searches.other"), {
      count: formatCount(n),
    });

  const briefings = summary.state === "ready" ? summary.value.clearable : null;
  const nothing = (briefings?.files ?? 0) === 0 && searches === 0;
  const what = [
    briefings && briefings.files > 0
      ? t(
          pluralKey(locale, briefings.files, "settings.privacy.clear.briefings.one", "settings.privacy.clear.briefings.other"),
          { count: formatCount(briefings.files), size: formatBytes(briefings.bytes) },
        )
      : null,
    searches > 0 ? searchesText(searches) : null,
  ].filter((s): s is string => Boolean(s));

  const run = async () => {
    setPhase("working");
    try {
      let removed = 0;
      if (clearLocalHistory) {
        const r = await clearLocalHistory();
        if (!r.ok) throw new Error(r.error);
        removed = r.removed;
      }
      const cleared = searches;
      clearRecentStockSearches();
      setSearches(0);
      const removedBriefings = t(
        pluralKey(locale, removed, "settings.privacy.clear.removedBriefings.one", "settings.privacy.clear.removedBriefings.other"),
        { count: formatCount(removed) },
      );
      // Only what was there: a list that names "0 recent searches" says nothing.
      const items = [removed > 0 || cleared === 0 ? removedBriefings : null, cleared > 0 ? searchesText(cleared) : null];
      setResult(t("settings.privacy.clear.removed", { items: listText(locale, items.filter((s): s is string => Boolean(s))) }));
      setPhase("done");
      onCleared();
    } catch (err) {
      setResult(err instanceof Error ? err.message : t("settings.privacy.clear.failed"));
      setPhase("error");
    }
  };

  return (
    <SettingsRow
      label={t("settings.privacy.clear.label")}
      description={t("settings.privacy.clear.description")}
      className={last ? "border-b-0" : undefined}
    >
      <div className="flex items-center gap-2">
        {phase === "done" ? <StatusLine text={result} /> : null}
        {phase === "error" ? <StatusLine text={result} error /> : null}
        {phase === "confirm" || phase === "working" ? (
          <>
            <StatusLine text={t("settings.privacy.clear.confirm", { items: listText(locale, what) })} />
            <button type="button" className={BUTTON} disabled={phase === "working"} onClick={() => setPhase("idle")}>
              {t("common.cancel")}
            </button>
            <button type="button" className={DANGER_BUTTON} disabled={phase === "working"} onClick={() => void run()}>
              {phase === "working" ? t("settings.pane.clearing") : t("settings.privacy.clear.button")}
            </button>
          </>
        ) : (
          <button
            type="button"
            className={BUTTON}
            disabled={nothing || summary.state === "loading"}
            title={nothing ? t("settings.privacy.clear.nothing") : undefined}
            onClick={() => setPhase("confirm")}
          >
            {nothing && summary.state !== "loading" ? t("settings.privacy.clear.nothing") : t("settings.privacy.clear.button")}
          </button>
        )}
      </div>
    </SettingsRow>
  );
}

/** Opens the data folder in the system's file manager. Shown only where the bridge can. */
function DataFolderRow({ last }: { last: boolean }) {
  const { t } = useI18n();
  const [error, setError] = useState<string | null>(null);
  const reveal = window.meridian?.revealDataFolder;
  if (!reveal) return null;
  return (
    <SettingsRow label={t("settings.privacy.row.folder")} className={last ? "border-b-0" : undefined}>
      <div className="flex items-center gap-3">
        {error ? <StatusLine text={error} error /> : null}
        <button
          type="button"
          className={cn(BUTTON, "inline-flex items-center gap-1.5")}
          onClick={() => {
            setError(null);
            void reveal().then(
              (r) => (r.ok ? undefined : setError(t("settings.pane.openFolderFailed"))),
              () => setError(t("settings.pane.openFolderFailed")),
            );
          }}
        >
          {t("settings.pane.open")}
          <ExternalLink className="h-3.5 w-3.5 text-[#6b7280]" strokeWidth={1.75} aria-hidden />
        </button>
      </div>
    </SettingsRow>
  );
}

/** A row whose button takes the reader to where that data is kept and changed. */
function ManageRow({ label, onManage, last = false }: { label: string; onManage: () => void; last?: boolean }) {
  const { t } = useI18n();
  return (
    <SettingsRow label={label} className={last ? "border-b-0" : undefined}>
      <button type="button" className={BUTTON} onClick={onManage}>
        {t("settings.privacy.manage")}
      </button>
    </SettingsRow>
  );
}

// ---------------------------------------------------------------------------
// The pane
// ---------------------------------------------------------------------------

export default function PrivacyPane({
  user = null,
  onAccount,
  onOpenTab,
}: {
  user?: User | null;
  /** Shows Settings, Account (profile photo, deleting the account). Left out, those rows are too. */
  onAccount?: () => void;
  /** Closes Settings and brings a home tab to the front. Left out, the Agents and Calendar rows are too. */
  onOpenTab?: (tab: PrivacyTab) => void;
}) {
  const { t, tNodes } = useI18n();
  const [summary, setSummary] = useState<Load<PrivacySummary>>({ state: "loading" });
  const [storage, setStorage] = useState<BrowserStorageSummary | null>(() => readBrowserStorage());
  const [page, setPage] = useState<Page>("main");
  const desktopOnly = t("settings.privacy.desktopOnly");
  const reduce = useReducedMotionPref();

  const rootRef = useRef<HTMLDivElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const protectRowRef = useRef<HTMLButtonElement>(null);
  const usageRowRef = useRef<HTMLButtonElement>(null);
  /** The detail page last left, so coming back puts the caret on the row that opened it. */
  const leftFrom = useRef<Exclude<Page, "main"> | null>(null);

  const refresh = useCallback(() => {
    setStorage(readBrowserStorage());
    const get = window.meridian?.getPrivacySummary;
    if (!get) {
      setSummary({ state: "error", error: desktopOnly });
      return;
    }
    void get().then(
      (r) => setSummary(r.ok ? { state: "ready", value: r.summary } : { state: "error", error: r.error }),
      (err: unknown) => setSummary({ state: "error", error: err instanceof Error ? err.message : String(err) }),
    );
  }, [desktopOnly]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const go = (next: Page) => {
    if (next === "main" && page !== "main") leftFrom.current = page;
    setPage(next);
    rootRef.current?.closest<HTMLElement>(".overflow-y-auto")?.scrollTo({ top: 0 });
  };

  // The caret follows the page: onto the way back when a page opens, and
  // onto the row that opened it on the way back.
  useEffect(() => {
    if (page !== "main") {
      backRef.current?.focus({ preventScroll: true });
      return;
    }
    const from = leftFrom.current;
    if (from) (from === "protect" ? protectRowRef : usageRowRef).current?.focus({ preventScroll: true });
  }, [page]);

  const enter = reduce
    ? { initial: { opacity: 0 }, animate: { opacity: 1 } }
    : { initial: { opacity: 0, x: page === "main" ? -8 : 8 }, animate: { opacity: 1, x: 0 } };

  // Your data, after Export and Local history: only the rows whose action this window can take.
  const dataRows: Array<{ key: string; row: (last: boolean) => ReactNode }> = [];
  if (onAccount) {
    dataRows.push({
      key: "photo",
      row: (last) => <ManageRow label={t("settings.privacy.cat.profile")} onManage={onAccount} last={last} />,
    });
  }
  if (onOpenTab) {
    dataRows.push(
      { key: "agents", row: (last) => <ManageRow label={t("home.tab.agents")} onManage={() => onOpenTab("agents")} last={last} /> },
      {
        key: "calendar",
        row: (last) => (
          <ManageRow label={t("settings.privacy.row.calendar")} onManage={() => onOpenTab("calendar")} last={last} />
        ),
      },
    );
  }
  if (window.meridian?.revealDataFolder) dataRows.push({ key: "folder", row: (last) => <DataFolderRow last={last} /> });
  if (onAccount) {
    dataRows.push({
      key: "delete",
      row: (last) => <ManageRow label={t("settings.account.delete")} onManage={onAccount} last={last} />,
    });
  }

  return (
    <div ref={rootRef}>
      <motion.div key={page} {...enter} transition={{ duration: reduce ? 0 : 0.18, ease: [0.33, 1, 0.68, 1] }}>
        {page === "protect" ? (
          <>
            <SubPageHead
              title={t("settings.privacy.protect")}
              lead={t("settings.privacy.protectLead")}
              onBack={() => go("main")}
              backRef={backRef}
            />
            <ProtectPage summary={summary} storage={storage} />
          </>
        ) : page === "use" ? (
          <>
            <SubPageHead
              title={t("settings.privacy.use")}
              lead={t("settings.privacy.useLead")}
              onBack={() => go("main")}
              backRef={backRef}
            />
            <UsePage summary={summary} />
          </>
        ) : (
          <>
            <SettingsSection title={t("settings.section.privacy")}>
              <p className="mt-1 max-w-[580px] text-[13px] font-normal leading-relaxed text-[#6b7280]">
                {tNodes("settings.privacy.intro", {
                  policy: <InlineLink onClick={() => openLegal("privacy")}>{t("settings.privacy.policyLink")}</InlineLink>,
                  terms: <InlineLink onClick={() => openLegal("terms")}>{t("settings.privacy.termsLink")}</InlineLink>,
                })}
              </p>
              <div className="mt-2">
                <NavRow label={t("settings.privacy.protect")} onOpen={() => go("protect")} buttonRef={protectRowRef} />
                <NavRow label={t("settings.privacy.use")} onOpen={() => go("use")} buttonRef={usageRowRef} last />
              </div>
            </SettingsSection>

            <Preferences onLearnMore={go} />

            <SettingsSection title={t("settings.privacy.data")}>
              <ExportControl user={user} />
              <ClearHistory summary={summary} onCleared={refresh} last={dataRows.length === 0} />
              {dataRows.map((r, i) => (
                <Fragment key={r.key}>{r.row(i === dataRows.length - 1)}</Fragment>
              ))}
            </SettingsSection>
          </>
        )}
      </motion.div>
    </div>
  );
}
