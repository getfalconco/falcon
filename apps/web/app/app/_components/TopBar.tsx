"use client";

import { BookOpen, LogOut, PanelRight, Settings, Target } from "lucide-react";
import { Dropdown, ICON_BUTTON, SelectorLabel, selectorClass } from "./shell/ui";
import type { NavId } from "./Sidebar";
import { WorkspaceSwitcher, type WorkspaceSwitcherApi } from "./WorkspaceSwitcher";

export type TopLink = "workspace" | "sightings" | "strategy" | "docs";

const LINKS: { id: TopLink; label: string }[] = [
  { id: "workspace", label: "Workspace" },
  { id: "sightings", label: "Sightings" },
  { id: "strategy", label: "Strategy Lab" },
  { id: "docs", label: "Docs" },
];

/**
 * Desktop top bar on the gray page: mark, "Falcon" and the workspace
 * switcher on the left, text links, settings and the account circle on the right.
 */
export function TopBar({
  email,
  workspaces,
  activeLink,
  contextOpen,
  onNav,
  onLink,
  onToggleContext,
  onGuide,
  onSignOut,
}: {
  email: string | null;
  workspaces: WorkspaceSwitcherApi;
  activeLink: TopLink;
  contextOpen: boolean;
  onNav: (id: NavId) => void;
  onLink: (id: TopLink) => void;
  onToggleContext: () => void;
  onGuide: () => void;
  onSignOut: (() => void) | null;
}) {
  const initial = (email?.trim()[0] ?? "P").toUpperCase();

  return (
    <header className="flex h-14 shrink-0 items-center justify-between gap-6 px-4">
      <div className="flex min-w-0 items-center gap-1">
        <span className="mr-1.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[#1c1917] text-[12.5px] font-medium text-[rgb(231,231,231)]" aria-hidden>
          F
        </span>
        <Dropdown
          label="Falcon"
          kind="menu"
          width={220}
          groups={[{ label: "Falcon", items: [{ id: "site", label: "Open getfalcon.co", description: "The public site, in this tab" }] }]}
          onSelect={() => window.location.assign("/")}
          button={({ open, props }) => (
            <button {...props} className={selectorClass(open)}>
              <SelectorLabel>Falcon</SelectorLabel>
            </button>
          )}
        />
        <span className="px-0.5 text-[15px] text-[#c4c4c0]" aria-hidden>
          /
        </span>
        <WorkspaceSwitcher api={workspaces} />
      </div>

      <div className="flex shrink-0 items-center gap-1">
        <nav aria-label="Main" className="mr-2 flex items-center gap-0.5">
          {LINKS.map((l) => {
            const on = l.id === activeLink;
            return (
              <button
                key={l.id}
                type="button"
                onClick={() => onLink(l.id)}
                aria-current={on ? "page" : undefined}
                className={`inline-flex h-8 items-center rounded-lg px-2.5 text-[14px] outline-none transition-colors hover:text-[#1d1b1b] focus-visible:ring-2 focus-visible:ring-black/20 ${
                  on ? "font-medium text-[#1d1b1b]" : "text-[#8a8a85]"
                }`}
              >
                {l.label}
              </button>
            );
          })}
        </nav>
        <Dropdown
          label="Settings"
          kind="menu"
          align="right"
          width={232}
          groups={[
            {
              label: "Workspace",
              items: [
                { id: "details", label: "Details panel", icon: PanelRight, selected: contextOpen, description: contextOpen ? "Shown beside each view" : "Hidden" },
                { id: "focus", label: "Edit focus list", icon: Target },
                { id: "guide", label: "How to read", icon: BookOpen },
              ],
            },
          ]}
          onSelect={(id) => {
            if (id === "details") onToggleContext();
            else if (id === "focus") onNav("focus");
            else onGuide();
          }}
          button={({ open, props }) => (
            <button {...props} title="Settings" className={`${ICON_BUTTON} ${open ? "bg-black/[0.06] text-[#1d1b1b]" : ""}`}>
              <Settings width={17} height={17} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        />
        <Dropdown
          label="Account"
          kind="menu"
          align="right"
          width={232}
          groups={[
            {
              label: "Account",
              items: onSignOut
                ? [{ id: "out", label: "Sign out", icon: LogOut, description: email ?? undefined }]
                : [{ id: "leave", label: "Leave preview", icon: LogOut, description: "Preview, no account" }],
            },
          ]}
          onSelect={(id) => (id === "out" && onSignOut ? onSignOut() : window.location.assign("/"))}
          button={({ open, props }) => (
            <button
              {...props}
              title={email ?? "Preview"}
              className={`ml-1 flex h-8 w-8 items-center justify-center rounded-full bg-[#e6e6e3] text-[13px] font-medium text-[#3d3b3a] outline-none transition-colors hover:bg-[#dcdcd8] focus-visible:ring-2 focus-visible:ring-black/25 ${
                open ? "bg-[#dcdcd8]" : ""
              }`}
            >
              {initial}
            </button>
          )}
        />
      </div>
    </header>
  );
}
