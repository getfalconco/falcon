"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDownRight, ArrowUpRight, Bell, CreditCard, FlaskConical, Gauge, LayoutGrid, Monitor, Moon, Palette, Search, ShieldCheck, Sun, User, X } from "lucide-react";
import { useAppearance, type Appearance } from "@/lib/workspace/appearance";
import { GEIST, MONO, SERIF } from "../parts";
import type { Icon } from "../shell/ui";
import { BoxSelect, SectionHeading, Segmented, SettingRow, TextSelect, type Option } from "./controls";

/**
 * Settings, laid out after the Claude desktop app's Settings dialog (about
 * 960x744): search and grouped sections on the left, the section's rows on
 * the right. Appearance has its settings; the other sections show their
 * heading until they get theirs.
 */

type SectionId = "account" | "billing" | "usage" | "appearance" | "notifications" | "privacy" | "workspace" | "strategy";

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
    { id: "workspace", label: "Workspace", icon: LayoutGrid },
    { id: "strategy", label: "Strategy Lab", icon: FlaskConical },
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
export function SettingsDialog({ open, onClose, onHelp }: { open: boolean; onClose: () => void; onHelp: () => void }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!open || !mounted) return null;
  return createPortal(<SettingsPanel onClose={onClose} onHelp={onHelp} />, document.body);
}

function SettingsPanel({ onClose, onHelp }: { onClose: () => void; onHelp: () => void }) {
  const titleId = useId();
  const baseId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [section, setSection] = useState<SectionId>("appearance");
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
  const nav = useMemo(
    () => NAV.map((g) => g.filter((n) => !query || n.label.toLowerCase().includes(query) || (n.id === "appearance" && appearanceHits))).filter((g) => g.length),
    [appearanceHits, query],
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
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-line/10 pl-[15px] pr-[7px]">
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
            ) : shown ? (
              <SectionHeading>{LABEL[shown]}</SectionHeading>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
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
