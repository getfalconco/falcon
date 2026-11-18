"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDownRight, ArrowUpRight, Bell, Briefcase, CreditCard, Gauge, LayoutGrid, Monitor, Moon, Palette, Search, ShieldCheck, Sparkles, Sun, User, X } from "lucide-react";
import { useAppearance, type Appearance } from "@/lib/workspace/appearance";
import { clearHoldingsAdded, writeDemoTickers } from "@/lib/workspace/own-card";
import { KIND_LABEL, contractLabel } from "@/lib/portfolio-holdings";
import { MISSING, accountLabel, money, pctText, priceText, qtyText, signedMoney, weightText } from "@/lib/workspace/positions-view";
import { useWorkspace } from "../context";
import { PositionLogo } from "../tabs/PositionLogo";
import { CAP_DEFAULT, CAP_OPTIONS, readCap, subscribeCap, writeCap } from "@/lib/workspace/position-cap";
import { GEIST, MONO, SERIF } from "../parts";
import type { Icon } from "../shell/ui";
import { BoxSelect, SectionHeading, Segmented, SettingRow, TextSelect, type Option } from "./controls";
import { AccountSettings } from "./AccountSettings";

/**
 * Settings, laid out after the Claude desktop app's Settings dialog (about
 * 960x744): search and grouped sections on the left, the section's rows on
 * the right. Account, Appearance and Portfolio have their settings; the other
 * sections show their heading until they get theirs.
 */

type SectionId = "account" | "billing" | "usage" | "appearance" | "notifications" | "privacy" | "portfolio" | "workspace" | "strategy";

const NAV: { id: SectionId; label: string; icon: Icon }[][] = [
  [
    { id: "account", label: "Account", icon: User },
    { id: "billing", label: "Billing", icon: CreditCard },
    { id: "usage", label: "Usage", icon: Gauge },
  ],
  [
    { id: "appearance", label: "Appearance", icon: Palette },
    { id: "notifications", label: "Notifications", icon: Bell },
    { id: "privacy", label: "Privacy", icon: ShieldCheck },
  ],
  [
    { id: "portfolio", label: "Portfolio", icon: Briefcase },
    { id: "workspace", label: "Workspace", icon: LayoutGrid },
    { id: "strategy", label: "Falcon AI", icon: Sparkles },
  ],
];
const LABEL: Record<SectionId, string> = Object.fromEntries(NAV.flat().map((n) => [n.id, n.label])) as Record<SectionId, string>;

const THEME: Option<Appearance["theme"]>[] = [
  { value: "system", label: "System", icon: Monitor },
  { value: "light", label: "Light", icon: Sun },
  { value: "dark", label: "Dark", icon: Moon },
];
const FONT: Option<Appearance["font"]>[] = [
  { value: "geist", label: "Geist" },
  { value: "system", label: "System font" },
];
const SIZE: Option<Appearance["size"]>[] = [
  { value: "small", label: "Small" },
  { value: "medium", label: "Medium" },
  { value: "large", label: "Large" },
];
const WIDTH: Option<Appearance["width"]>[] = [
  { value: "narrow", label: "Narrow" },
  { value: "wide", label: "Wide" },
];
const MOTION: Option<Appearance["motion"]>[] = [
  { value: "system", label: "System" },
  { value: "reduced", label: "Reduced" },
  { value: "full", label: "Full" },
];
const LIGHT_THEMES: Option<"falcon-light">[] = [{ value: "falcon-light", label: "Falcon Light" }];
const DARK_THEMES: Option<"falcon-dark">[] = [{ value: "falcon-dark", label: "Falcon Dark" }];

type Row = { id: string; title: string; render: (labelId: string) => ReactNode };

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
const FOCUS = "outline-none focus-visible:ring-2 focus-visible:ring-line/25";

/** `onHelp` closes Settings and opens the help chat (focus goes there, not back to the gear). */
export function SettingsDialog({ open, onClose, onHelp, initialSection }: { open: boolean; onClose: () => void; onHelp: () => void; initialSection?: "portfolio" }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!open || !mounted) return null;
  return createPortal(<SettingsPanel onClose={onClose} onHelp={onHelp} initialSection={initialSection} />, document.body);
}

function SettingsPanel({ onClose, onHelp, initialSection }: { onClose: () => void; onHelp: () => void; initialSection?: SectionId }) {
  const titleId = useId();
  const baseId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [section, setSection] = useState<SectionId>(initialSection ?? "appearance");
  const { appearance, update } = useAppearance();

  // After the gear menu hands focus back to its trigger (a timeout of its own).
  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const general: Row[] = [
    { id: "theme", title: "Theme", render: (l) => <Segmented labelledBy={l} value={appearance.theme} options={THEME} onChange={(theme) => update({ theme })} /> },
    { id: "font", title: "Interface font", render: () => <TextSelect label="Interface font" value={appearance.font} options={FONT} onChange={(font) => update({ font })} /> },
    { id: "size", title: "Text size", render: () => <TextSelect label="Text size" value={appearance.size} options={SIZE} onChange={(size) => update({ size })} /> },
    { id: "width", title: "Content width", render: () => <TextSelect label="Content width" value={appearance.width} options={WIDTH} onChange={(width) => update({ width })} /> },
    { id: "motion", title: "Motion", render: () => <TextSelect label="Motion" value={appearance.motion} options={MOTION} onChange={(motion) => update({ motion })} /> },
  ];

  const query = q.trim().toLowerCase();
  const hit = (s: string) => !query || s.toLowerCase().includes(query);
  const rows = general.filter((r) => hit(r.title));
  const showCards = hit("Cards") || hit("Falcon Light") || hit("Falcon Dark");
  const appearanceHits = rows.length > 0 || showCards;
  const portfolioHits = hit("Clear portfolio") || hit("Holdings") || hit("Accounts") || hit("Positions") || hit("Paper") || hit("Position cap");
  const accountHits =
    hit("Profile") || hit("Profile photo") || hit("Full name") || hit("What should Falcon call you?") || hit("What best describes your work?") || hit("Account ID") || hit("Where you're logged in") || hit("Log out of all devices");
  const nav = useMemo(
    () =>
      NAV.map((g) => g.filter((n) => !query || n.label.toLowerCase().includes(query) || (n.id === "appearance" && appearanceHits) || (n.id === "portfolio" && portfolioHits) || (n.id === "account" && accountHits))).filter(
        (g) => g.length,
      ),
    [accountHits, appearanceHits, portfolioHits, query],
  );
  const visible = nav.flat().map((n) => n.id);
  // While searching, the right side shows the first section that matches when the open one does not.
  const shown: SectionId | null = visible.includes(section) ? section : visible[0] ?? null;

  // Escape closes (an open select inside handles its own Escape first); Tab stays inside.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Escape") {
      e.preventDefault();
      if (q && document.activeElement === searchRef.current) setQ("");
      else onClose();
      return;
    }
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null || el === document.activeElement);
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-6 dark:bg-black/60"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
        className="flex h-[min(744px,calc(100dvh-48px))] w-[min(960px,calc(100vw-48px))] flex-col overflow-hidden rounded-[12px] border border-line/10 bg-raised text-fore shadow-[0_24px_64px_rgba(0,0,0,0.18)] dark:shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
        style={{ fontFamily: GEIST }}
      >
        <div className="flex h-10 shrink-0 items-center justify-between pl-[15px] pr-[7px]">
          <h2 id={titleId} className="text-fs-15 font-medium text-fore">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
            className={`flex h-7 w-7 items-center justify-center rounded-md text-fore-3 transition-colors hover:bg-line/[0.06] hover:text-fore ${FOCUS}`}
          >
            <X width={16} height={16} strokeWidth={1.5} aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-[197px] shrink-0 flex-col border-r border-line/10 px-[15px] pb-[5px] pt-4">
            <label className="flex h-[26px] shrink-0 items-center gap-[13px] rounded-[8px] bg-line/[0.06] pl-2 pr-2">
              <Search width={16} height={16} strokeWidth={1.5} className="shrink-0 text-faint" aria-hidden />
              <input
                ref={searchRef}
                type="search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search"
                aria-label="Search settings"
                className="min-w-0 flex-1 bg-transparent text-fs-14 text-fore outline-none placeholder:text-faint [&::-webkit-search-cancel-button]:hidden"
              />
            </label>

            <nav aria-label="Settings sections" className="mt-[10px] flex min-h-0 flex-1 flex-col overflow-y-auto">
              {nav.map((group, gi) => (
                <Fragment key={gi}>
                  {gi > 0 ? <span className="mx-[11px] my-[10px] h-px shrink-0 bg-line/10" aria-hidden /> : null}
                  {group.map((n) => {
                    const on = n.id === shown;
                    const I = n.icon;
                    return (
                      <button
                        key={n.id}
                        type="button"
                        aria-current={on ? "page" : undefined}
                        onClick={() => setSection(n.id)}
                        className={`flex h-[31px] shrink-0 items-center gap-3 rounded-[8px] pl-[9px] pr-2 text-left text-fs-14 text-fore transition-colors ${FOCUS} ${
                          on ? "bg-line/[0.09]" : "hover:bg-line/[0.05]"
                        }`}
                      >
                        <I width={16} height={16} strokeWidth={1.5} className="shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{n.label}</span>
                      </button>
                    );
                  })}
                </Fragment>
              ))}
            </nav>

            <button
              type="button"
              onClick={onHelp}
              className={`mt-2 flex h-[31px] shrink-0 items-center gap-2 rounded-[8px] pl-1 pr-[11px] text-left text-fs-14 text-quiet transition-colors hover:text-fore ${FOCUS}`}
            >
              <span className="flex-1">Help center</span>
              <ArrowUpRight width={16} height={16} strokeWidth={1.5} aria-hidden />
            </button>
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto pb-8 pl-4 pr-[18px] pt-[13px]">
            {shown === "appearance" ? (
              <>
                {rows.length ? (
                  <section aria-labelledby={`${baseId}-general`}>
                    <SectionHeading id={`${baseId}-general`}>General</SectionHeading>
                    <div className="mt-3">
                      {rows.map((r) => (
                        <SettingRow key={r.id} id={`${baseId}-${r.id}`} title={r.title}>
                          {r.render(`${baseId}-${r.id}`)}
                        </SettingRow>
                      ))}
                    </div>
                  </section>
                ) : null}
                {showCards ? (
                  <section aria-labelledby={`${baseId}-cards`} className={rows.length ? "mt-[35px]" : ""}>
                    <SectionHeading id={`${baseId}-cards`}>Cards</SectionHeading>
                    <div className="mt-6 grid grid-cols-2 gap-4">
                      <div className="flex min-w-0 flex-col gap-3">
                        <BoxSelect label="Light card theme" value="falcon-light" options={LIGHT_THEMES} onChange={() => undefined} />
                        <CardPreview theme="light" />
                      </div>
                      <div className="flex min-w-0 flex-col gap-3">
                        <BoxSelect label="Dark card theme" value="falcon-dark" options={DARK_THEMES} onChange={() => undefined} />
                        <CardPreview theme="dark" />
                      </div>
                    </div>
                  </section>
                ) : null}
              </>
            ) : shown === "account" ? (
              <AccountSettings headingId={`${baseId}-account`} />
            ) : shown === "portfolio" ? (
              <PortfolioSettings headingId={`${baseId}-portfolio`} />
            ) : shown ? (
              <SectionHeading>{LABEL[shown]}</SectionHeading>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

const DANGER = `h-[26px] rounded-[7px] bg-down/[0.1] px-[9px] text-fs-14 text-down transition-colors hover:bg-down/[0.16] ${FOCUS}`;
const QUIET_BUTTON = `h-[26px] rounded-[7px] px-[9px] text-fs-14 text-quiet transition-colors hover:bg-line/[0.06] hover:text-fore ${FOCUS}`;

/**
 * The workspace's portfolio: its tickers, and for the signed-in member's main
 * workspace the stored accounts (balances) and positions with live prices
 * (lib/workspace/holdings.ts), grouped by account. "Clear portfolio" empties
 * everything: the tickers here and on the account, every stored account and
 * position, the paper account, and opens the setup card's holdings task again.
 * Asks once before clearing. Amounts come from memory only.
 */
function PortfolioSettings({ headingId }: { headingId: string }) {
  const { portfolio, portfolioLoaded, setPortfolio, userId, holdings, clearHoldings, clearPaper } = useWorkspace();
  const cap = useSyncExternalStore(subscribeCap, () => readCap(userId), () => CAP_DEFAULT);
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);
  const count = portfolio.length;
  const tickers = portfolio.slice(0, 8).map((f) => f.ticker).join(", ") + (count > 8 ? ` and ${count - 8} more` : "");
  const what = count === 1 ? "1 ticker" : `${count} tickers`;
  const accounts = holdings.data?.accounts ?? [];
  const positions = holdings.data?.positions ?? [];
  const anything = count > 0 || accounts.length > 0 || positions.length > 0;
  const main = !userId.includes(":");
  const sizesMissing = holdings.mode === "sizes" && holdings.data !== null && !holdings.data.available;

  const clear = () => {
    setPortfolio([]);
    void clearHoldings();
    void clearPaper();
    writeDemoTickers(userId, null);
    clearHoldingsAdded(userId);
    setConfirming(false);
    setCleared(true);
  };

  return (
    <section aria-labelledby={headingId}>
      <SectionHeading id={headingId}>Portfolio</SectionHeading>
      <div className="mt-3">
        <SettingRow
          id={`${headingId}-holdings`}
          title="Holdings"
          description={
            !portfolioLoaded
              ? "Loading"
              : count
                ? `${what}: ${tickers}`
                : accounts.length
                  ? "No tickers yet."
                  : cleared
                    ? "Portfolio cleared."
                    : "No portfolio yet. Bring your portfolio from the Dashboard."
          }
        >
          {/* The ⌘P portfolio (development only) is in memory: nothing to clear, and the real one stays out of reach. */}
          {!holdings.test && anything ? (
            confirming ? (
              <span className="flex items-center gap-2">
                <span className="text-fs-14 text-quiet">Remove everything?</span>
                <button type="button" onClick={() => setConfirming(false)} className={QUIET_BUTTON}>
                  Cancel
                </button>
                <button type="button" onClick={clear} className={DANGER} autoFocus>
                  Clear
                </button>
              </span>
            ) : (
              <button type="button" onClick={() => setConfirming(true)} className={DANGER}>
                Clear portfolio
              </button>
            )
          ) : null}
        </SettingRow>
      </div>

      <div className="mt-1">
        <SettingRow id={`${headingId}-cap`} title="Position cap" description="The most one holding should take of the account. Positions above this share of the account are marked on the Dashboard.">
          <TextSelect label="Position cap" value={String(cap)} options={CAP_CHOICES} onChange={(v) => writeCap(userId, Number(v))} />
        </SettingRow>
      </div>

      {accounts.length ? <AccountsBlock headingId={headingId} /> : null}

      <p className="mt-5 max-w-[560px] text-fs-13 leading-fs-20 text-quiet">
        {main
          ? "Your portfolio comes from a broker import, a screenshot of your holdings, a CSV or your paper account, through Bring your portfolio on the Dashboard. Falcon keeps the tickers, and for each position its quantity, average cost, price and value as imported, with each account's name, institution, the last 4 characters of its number and its balances. Prices shown here are live. "
          : "Other workspaces keep tickers only, in this browser; sizes and balances belong to your main workspace. "}
        {sizesMissing ? "Sizes and balances aren't stored yet: for now only tickers are kept. " : ""}
        Clearing removes everything from this workspace{main ? " and your account" : ""}; you can bring your portfolio in again at any time.
      </p>
    </section>
  );
}

const CAP_CHOICES: Option<string>[] = CAP_OPTIONS.map((n) => ({ value: String(n), label: `${n}%` }));

const SET_COLS = "grid grid-cols-[minmax(120px,1.7fr)_minmax(52px,0.6fr)_minmax(68px,0.8fr)_minmax(70px,0.8fr)_minmax(88px,1fr)_minmax(96px,1.1fr)_minmax(46px,0.5fr)] items-baseline gap-x-2";

/** Each account (name, institution, ••last4, balances, as of, source) with its positions. */
function AccountsBlock({ headingId }: { headingId: string }) {
  const { holdings } = useWorkspace();
  const accounts = holdings.data?.accounts ?? [];
  const positions = holdings.data?.positions ?? [];
  const dash = (n: number | null, f: (n: number) => string) => (n === null ? MISSING : f(n));
  return (
    <section aria-labelledby={`${headingId}-accounts`} className="mt-[35px]">
      <SectionHeading id={`${headingId}-accounts`}>Accounts and positions</SectionHeading>
      <div className="mt-3 flex flex-col gap-6">
        {accounts.map((a) => {
          const rows = positions.filter((p) => p.accountId === a.id).sort((x, y) => (y.weight ?? -1e9) - (x.weight ?? -1e9) || x.symbol.localeCompare(y.symbol));
          const cur = a.currency ?? "USD";
          return (
            <div key={a.id} className="rounded-[10px] border border-line/[0.08]">
              <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 px-4 py-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2 text-fs-14 font-medium text-fore">
                    {accountLabel(a)}
                    {a.source === "paper" ? <span className="rounded-full bg-line/[0.07] px-2 py-px text-fs-11 font-medium text-fore-4">Paper</span> : null}
                  </div>
                  <div className="text-fs-13 text-quiet">
                    {[a.institution, SOURCE_LABEL[a.source], a.asOf ? `as of ${formatDay(a.asOf)}` : null, a.holdingsUnavailable ? "the broker could not return holdings" : null].filter(Boolean).join(" · ")}
                  </div>
                </div>
                <dl className="flex gap-5 text-right text-fs-13 tabular-nums">
                  {(
                    [
                      ["Total", a.totalValue],
                      ["Cash", a.cash],
                      ["Buying power", a.buyingPower],
                    ] as const
                  ).map(([k, v]) => (
                    <div key={k}>
                      <dt className="text-quiet">{k}</dt>
                      <dd className="text-fore">{dash(v, (n) => money(n, cur))}</dd>
                    </div>
                  ))}
                </dl>
              </div>
              {rows.length ? (
                <div className="overflow-x-auto">
                  <div role="table" aria-label={`Positions in ${accountLabel(a)}`} className="min-w-[600px] px-4 pb-2 text-fs-13 leading-fs-20 tabular-nums">
                    <div role="row" className={`${SET_COLS} h-8 items-center text-fs-12 text-quiet`}>
                      <span role="columnheader">Symbol</span>
                      <span role="columnheader" className="text-right">Quantity</span>
                      <span role="columnheader" className="text-right">Avg cost</span>
                      <span role="columnheader" className="text-right">Live price</span>
                      <span role="columnheader" className="text-right">Live value</span>
                      <span role="columnheader" className="text-right">Unrealised P&amp;L</span>
                      <span role="columnheader" className="text-right" title="Share of all positions, cash left out (the Dashboard card's bars include cash)">
                        Weight
                      </span>
                    </div>
                    {rows.map((p) => (
                      <div role="row" key={p.key} className={`${SET_COLS} -mx-2 rounded-md px-2 py-1.5 hover:bg-line/[0.035]`}>
                        <span role="cell" className="flex min-w-0 items-center gap-2 self-center">
                          <PositionLogo row={{ kind: p.kind, ticker: p.ticker, symbol: p.symbol, label: p.kind === "crypto" ? p.symbol : contractLabel(p) }} />
                          <span className="min-w-0">
                            <span className="block truncate text-fore">{p.kind === "crypto" ? p.symbol : contractLabel(p)}</span>
                            <span className="block truncate text-fs-12 text-quiet">
                              {KIND_LABEL[p.kind]}
                              {(p.quantity ?? 0) < 0 ? " · Short" : ""}
                            </span>
                          </span>
                        </span>
                        <span role="cell" className="text-right text-fore">{dash(p.quantity, qtyText)}</span>
                        <span role="cell" className="text-right text-fore-4">{dash(p.avgCost, (n) => priceText(n, p.group))}</span>
                        <span role="cell" className="text-right text-fore" title={p.priceSource === "import" ? "Price at import" : p.priceSource === "close" ? "Last close" : undefined}>
                          {dash(p.lastPrice, (n) => priceText(n, p.group))}
                          {p.priceSource === "import" ? <span className="text-faint">*</span> : null}
                        </span>
                        <span role="cell" className="text-right text-fore">{dash(p.value, (n) => money(n, p.group))}</span>
                        <span role="cell" className={`text-right ${p.unrealized === null ? "text-quiet" : p.unrealized > 0 ? "text-up" : p.unrealized < 0 ? "text-down" : "text-quiet"}`}>
                          {p.unrealized === null ? (
                            MISSING
                          ) : (
                            <>
                              <span className="block">{signedMoney(p.unrealized, p.group)}</span>
                              {p.unrealizedPct !== null ? <span className="block text-fs-12">{pctText(p.unrealizedPct, 1)}</span> : null}
                            </>
                          )}
                        </span>
                        <span role="cell" className="text-right text-fore-4">{p.weight === null ? MISSING : weightText(p.weight)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <p className="px-4 pb-3 text-fs-13 text-quiet">{a.source === "paper" ? "Cash only, no positions yet." : "No positions."}</p>
              )}
            </div>
          );
        })}
      </div>
      {positions.some((p) => p.priceSource === "import") ? <p className="mt-2 text-fs-12 text-quiet">* Price at import: no live quote for this one.</p> : null}
    </section>
  );
}

const SOURCE_LABEL: Record<string, string> = { broker: "Broker import", screenshot: "Screenshot", csv: "CSV", paper: "Paper account" };

function formatDay(iso: string): string {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) ? d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "";
}

/** A Sighting card drawn in one theme, the size of the reference's code previews. */
function CardPreview({ theme }: { theme: "light" | "dark" }) {
  return (
    <div
      className={`f-${theme} pointer-events-none h-[88px] overflow-hidden rounded-[8px] border border-line/10 bg-surface px-3 py-[9px] text-fore`}
      style={{ colorScheme: theme }}
      aria-hidden
    >
      <div className="flex items-center gap-1.5 text-fs-10.5 text-fore/50" style={{ fontFamily: MONO }}>
        <span className="truncate uppercase tracking-[0.12em]">Supplier news</span>
        <span>·</span>
        <span className="text-fore">TSM</span>
        <span>·</span>
        <span className="whitespace-nowrap">2h ago</span>
      </div>
      <div className="mt-1 truncate text-fs-14 leading-fs-20 text-fore" style={{ fontFamily: SERIF }}>
        A chip maker raised its outlook
      </div>
      <div className="mt-[7px] flex items-center gap-1.5">
        <span className="text-fs-11 text-faint">Affects</span>
        {(
          [
            ["NVDA", "up"],
            ["AMD", "up"],
            ["INTC", "down"],
          ] as const
        ).map(([t, d]) => {
          const I = d === "up" ? ArrowUpRight : ArrowDownRight;
          return (
            <span key={t} className="inline-flex h-[20px] items-center gap-0.5 rounded-md border border-line/10 px-1 text-fs-10.5 leading-none text-fore">
              <span style={{ fontFamily: MONO }}>{t}</span>
              <I width={11} height={11} strokeWidth={2} className={d === "up" ? "text-up" : "text-down"} />
            </span>
          );
        })}
      </div>
    </div>
  );
}
