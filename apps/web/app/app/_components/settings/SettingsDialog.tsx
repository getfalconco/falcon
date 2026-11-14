"use client";

import { Fragment, useEffect, useId, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowDownRight, ArrowUpRight, Bell, Check, CircleUser, FlaskConical, LayoutGrid, Monitor, Moon, Palette, Search, Shield, Sun, X } from "lucide-react";
import { useAppearance, type Appearance } from "@/lib/workspace/appearance";
import { GEIST, MONO, SERIF } from "../parts";
import type { Icon } from "../shell/ui";
import { Segmented, SettingRow, TextSelect, type Option } from "./controls";

/**
 * Settings, a large modal in the manner of the Claude desktop app's: search
 * and sections on the left, the section's rows on the right. Only Appearance
 * is built; the other sections are listed as coming soon.
 */

type SectionId = "account" | "notifications" | "appearance" | "workspace" | "privacy" | "strategy";

const NAV: { id: SectionId; label: string; icon: Icon; ready: boolean }[][] = [
  [
    { id: "account", label: "Account", icon: CircleUser, ready: false },
    { id: "notifications", label: "Notifications", icon: Bell, ready: false },
  ],
  [
    { id: "appearance", label: "Appearance", icon: Palette, ready: true },
    { id: "workspace", label: "Workspace", icon: LayoutGrid, ready: false },
    { id: "privacy", label: "Privacy", icon: Shield, ready: false },
  ],
  [{ id: "strategy", label: "Strategy Lab", icon: FlaskConical, ready: false }],
];

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

type Row = { id: string; title: string; description?: string; render: (labelId: string) => ReactNode };

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';

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
  const { appearance, resolved, update } = useAppearance();

  // After the gear menu hands focus back to its trigger (a timeout of its own).
  useEffect(() => {
    const t = setTimeout(() => searchRef.current?.focus(), 0);
    return () => clearTimeout(t);
  }, []);

  const general: Row[] = [
    {
      id: "theme",
      title: "Theme",
      description: "System follows your computer's setting.",
      render: (l) => <Segmented labelledBy={l} value={appearance.theme} options={THEME} onChange={(theme) => update({ theme })} />,
    },
    {
      id: "font",
      title: "Interface font",
      render: () => <TextSelect label="Interface font" value={appearance.font} options={FONT} onChange={(font) => update({ font })} />,
    },
    {
      id: "size",
      title: "Text size",
      description: "Text across the workspace.",
      render: () => <TextSelect label="Text size" value={appearance.size} options={SIZE} onChange={(size) => update({ size })} />,
    },
    {
      id: "width",
      title: "Content width",
      description: "How wide Sighting and Ticker pages read.",
      render: () => <TextSelect label="Content width" value={appearance.width} options={WIDTH} onChange={(width) => update({ width })} />,
    },
    {
      id: "motion",
      title: "Motion",
      description: "Reduced turns off animations. System follows your computer's setting.",
      render: () => <TextSelect label="Motion" value={appearance.motion} options={MOTION} onChange={(motion) => update({ motion })} />,
    },
  ];

  const query = q.trim().toLowerCase();
  const hit = (s: string) => !query || s.toLowerCase().includes(query);
  const rows = general.filter((r) => hit(r.title));
  const showPreview = hit("Preview") || hit("Falcon Light") || hit("Falcon Dark");
  const appearanceHits = rows.length > 0 || showPreview;
  const nav = useMemo(
    () => NAV.map((g) => g.filter((n) => !query || n.label.toLowerCase().includes(query) || (n.id === "appearance" && appearanceHits))).filter((g) => g.length),
    [appearanceHits, query],
  );

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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30 p-6 dark:bg-black/55"
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
        className="flex h-[min(720px,calc(100dvh-48px))] w-[min(960px,calc(100vw-48px))] flex-col overflow-hidden rounded-[14px] border border-line/10 bg-raised text-fore shadow-[0_24px_64px_rgba(0,0,0,0.18)] dark:shadow-[0_24px_64px_rgba(0,0,0,0.6)]"
        style={{ fontFamily: GEIST }}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-line/[0.08] pl-6 pr-3">
          <h2 id={titleId} className="text-fs-17 font-medium tracking-[-0.01em] text-fore">
            Settings
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            title="Close"
            className="flex h-8 w-8 items-center justify-center rounded-lg text-quiet outline-none transition-colors hover:bg-line/[0.06] hover:text-fore focus-visible:ring-2 focus-visible:ring-line/20"
          >
            <X width={17} height={17} strokeWidth={1.75} aria-hidden />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <div className="flex w-[300px] shrink-0 flex-col px-3 pb-3 pt-4">
            <label className="mx-1 flex h-9 items-center gap-2 rounded-lg border border-line/10 px-2.5 transition-colors focus-within:border-line/30">
              <Search width={15} height={15} strokeWidth={1.75} className="shrink-0 text-faint" aria-hidden />
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

            <nav aria-label="Settings sections" className="mt-3 flex min-h-0 flex-1 flex-col overflow-y-auto">
              {nav.map((group, gi) => (
                <Fragment key={gi}>
                  {gi > 0 ? <span className="mx-4 my-2 h-px w-6 shrink-0 bg-line/[0.12]" aria-hidden /> : null}
                  {group.map((n) => {
                    const on = n.ready && n.id === section;
                    const I = n.icon;
                    return (
                      <button
                        key={n.id}
                        type="button"
                        aria-current={on ? "page" : undefined}
                        aria-disabled={!n.ready || undefined}
                        onClick={() => n.ready && setSection(n.id)}
                        className={`mx-1 flex h-11 shrink-0 items-center gap-3 rounded-lg px-3 text-left text-fs-14 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line/20 ${
                          on ? "bg-line/[0.06] font-medium text-fore" : n.ready ? "text-fore-3 hover:bg-line/[0.04] hover:text-fore" : "cursor-default text-quiet"
                        }`}
                      >
                        <I width={17} height={17} strokeWidth={1.6} className="shrink-0" aria-hidden />
                        <span className="min-w-0 flex-1 truncate">{n.label}</span>
                        {n.ready ? null : (
                          <span className="rounded-full border border-line/10 px-1.5 py-px text-fs-11 leading-fs-16 text-faint">Soon</span>
                        )}
                      </button>
                    );
                  })}
                </Fragment>
              ))}
            </nav>

            <button
              type="button"
              onClick={onHelp}
              className="mx-1 mt-2 flex h-10 shrink-0 items-center gap-2 rounded-lg px-3 text-left text-fs-13.5 text-quiet outline-none transition-colors hover:bg-line/[0.04] hover:text-fore focus-visible:ring-2 focus-visible:ring-line/20"
            >
              <span className="flex-1">Help center</span>
              <ArrowUpRight width={15} height={15} strokeWidth={1.75} aria-hidden />
            </button>
          </div>

          <div className="min-w-0 flex-1 overflow-y-auto px-10 pb-10 pt-7">
            {appearanceHits ? (
              <>
                {rows.length ? (
                  <section aria-labelledby={`${baseId}-general`}>
                    <h3 id={`${baseId}-general`} className="text-fs-16 font-medium text-fore">
                      General
                    </h3>
                    <div className="mt-1">
                      {rows.map((r) => (
                        <SettingRow key={r.id} id={`${baseId}-${r.id}`} title={r.title} description={r.description}>
                          {r.render(`${baseId}-${r.id}`)}
                        </SettingRow>
                      ))}
                    </div>
                  </section>
                ) : null}
                {showPreview ? (
                  <section aria-labelledby={`${baseId}-preview`} className={rows.length ? "mt-8" : ""}>
                    <h3 id={`${baseId}-preview`} className="text-fs-16 font-medium text-fore">
                      Preview
                    </h3>
                    <p className="mt-1 text-fs-13 leading-fs-19 text-quiet">A Sighting card in each theme. Choose one to use it.</p>
                    <div className="mt-5 grid grid-cols-2 gap-5">
                      <ThemePreview theme="light" active={resolved === "light"} onPick={() => update({ theme: "light" })} />
                      <ThemePreview theme="dark" active={resolved === "dark"} onPick={() => update({ theme: "dark" })} />
                    </div>
                  </section>
                ) : null}
              </>
            ) : (
              <p className="pt-2 text-fs-14 text-quiet">No settings match &ldquo;{q.trim()}&rdquo;.</p>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** One theme's small preview: a header like a picker, then a Sighting card drawn in that theme. */
function ThemePreview({ theme, active, onPick }: { theme: "light" | "dark"; active: boolean; onPick: () => void }) {
  const name = theme === "light" ? "Falcon Light" : "Falcon Dark";
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex items-center justify-between gap-2 px-0.5">
        <span className="text-fs-13 text-quiet">{theme === "light" ? "Light" : "Dark"}</span>
        <span className="flex items-center gap-1 text-fs-13.5 text-fore">
          {active ? <Check width={14} height={14} strokeWidth={2} aria-hidden /> : null}
          {name}
        </span>
      </div>
      <button
        type="button"
        onClick={onPick}
        aria-pressed={active}
        aria-label={`Use ${name}`}
        className={`f-${theme} block w-full overflow-hidden rounded-xl border bg-page p-3 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-line/30 ${
          active ? "border-line/30" : "border-line/[0.1] hover:border-line/20"
        }`}
        style={{ colorScheme: theme }}
      >
        <PreviewCard />
      </button>
    </div>
  );
}

/** Sample content, only for the preview. */
function PreviewCard() {
  return (
    <div className="pointer-events-none rounded-lg border border-line/[0.08] bg-surface px-3.5 py-3 text-fore" aria-hidden>
      <div className="flex items-center gap-1.5 text-fs-10.5 text-fore/50" style={{ fontFamily: MONO }}>
        <span className="truncate uppercase tracking-[0.12em]">Supplier news</span>
        <span>·</span>
        <span className="text-fore">TSM</span>
        <span>·</span>
        <span className="whitespace-nowrap">2h ago</span>
      </div>
      <div className="mt-1.5 text-fs-14 leading-fs-20 text-fore" style={{ fontFamily: SERIF }}>
        A chip maker raised its outlook
      </div>
      <div className="mt-0.5 truncate text-fs-12 leading-fs-17 text-quiet">Its biggest customers tend to follow.</div>
      <div className="mt-2.5 flex items-center gap-1.5">
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
