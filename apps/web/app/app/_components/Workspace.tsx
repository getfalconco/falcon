"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeftRight, LifeBuoy, Loader2, MoreHorizontal, PanelRight, PictureInPicture2, RotateCw, X } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { strategyFromSighting } from "@falcon/backtest";
import { isApproved } from "@/lib/auth";
import { needsWelcome } from "@/lib/onboarding";
import { isSupabaseConfigured, requireSupabase } from "@/lib/supabase";
import { cardExplain } from "@falcon/ripple";
import {
  cleanFocus,
  fetchNames,
  fetchServerFocus,
  readLocalFocus,
  saveServerFocus,
  welcomeFinishedThisVisit,
  writeLocalFocus,
  type FocusItem,
} from "@/lib/workspace/focus";
import { setTokenGetter } from "@/lib/workspace/api-auth";
import { MAX_TABS, readLayout, tabId, writeLayout, type Tab, type WorkspaceLayout } from "@/lib/workspace/layout";
import { useSightings } from "@/lib/workspace/sightings";
import { MAIN_WORKSPACE_ID, storageScope, useWorkspaceIndex } from "@/lib/workspace/workspaces";
import { BLANK_RULES, createStrategy, deleteStrategy, useStrategies } from "@/lib/workspace/strategies";
import BrandMark from "../../components/BrandMark";
import { CompactToday } from "./CompactToday";
import { HowToReadDialog, HowToReadFirstVisit } from "./explain";
import { ContextPanel } from "./ContextPanel";
import { WorkspaceContext, type WorkspaceApi } from "./context";
import { FocusListView, SightingsListView } from "./ListViews";
import { GEIST, timeAgo } from "./parts";
import { CardBody, CardHeader, Dropdown, ICON_BUTTON, IconButton, TextButton } from "./shell/ui";
import { NAV, Sidebar, TAB_ICON, navTarget, readRailPinned, writeRailPinned, type NavId, type OpenItem } from "./Sidebar";
import { FloatingHelp, HelpThread, setHelpFloating, useHelp } from "./help/HelpChat";
import { DragDockProvider, useDragDock, type DropResult, type Side } from "./split/dnd";
import { SplitArea } from "./split/SplitArea";
import { TopBar, type TopLink } from "./TopBar";
import type { WorkspaceSwitcherApi } from "./WorkspaceSwitcher";
import { DashboardTab } from "./tabs/DashboardTab";
import { GraphTab } from "./tabs/GraphTab";
import { SightingTab } from "./tabs/SightingTab";
import { StrategyTab } from "./tabs/StrategyTab";
import { TickerTab } from "./tabs/TickerTab";

const IS_DEV = process.env.NODE_ENV === "development";

type Viewer = {
  /** Storage key: the Supabase user id, or "preview" in the development preview. */
  userId: string;
  email: string | null;
  client: SupabaseClient | null;
};

type Gate = { state: "checking" } | { state: "ready"; viewer: Viewer } | { state: "leaving" };

/**
 * Who is looking. Signed-out visitors go to the login, members who have not
 * finished the welcome flow go there first. In development `?preview=1` opens
 * the Workspace without an account (sample feed and focus list).
 */
function useGate(): Gate {
  const router = useRouter();
  const [gate, setGate] = useState<Gate>({ state: "checking" });

  useEffect(() => {
    let live = true;
    const leave = (to: string) => {
      if (!live) return;
      setGate({ state: "leaving" });
      router.replace(to);
    };
    const preview = IS_DEV && new URLSearchParams(window.location.search).get("preview") === "1";

    (async () => {
      if (preview) {
        // No account: the AI/compute routes accept that only under `next dev` (lib/strategy/guard.ts).
        setTokenGetter(null);
        setGate({ state: "ready", viewer: { userId: "preview", email: null, client: null } });
        return;
      }
      if (!isSupabaseConfigured) return leave("/login?next=/app");
      const client = requireSupabase();
      const session = (await client.auth.getSession().catch(() => null))?.data.session ?? null;
      if (!session || !isApproved(session.user)) return leave("/login?next=/app");
      if (!welcomeFinishedThisVisit() && (await needsWelcome(client))) return leave("/welcome?next=/app");
      if (!live) return;
      // Strategy Lab and Help send the member's token (lib/workspace/api-auth.ts); set before anything can run.
      setTokenGetter(async () => (await client.auth.getSession()).data.session?.access_token ?? null);
      setGate({ state: "ready", viewer: { userId: session.user.id, email: session.user.email ?? null, client } });
    })();

    return () => {
      live = false;
    };
  }, [router]);

  // Signing out in another tab ends this one too.
  useEffect(() => {
    if (gate.state !== "ready" || !gate.viewer.client) return;
    const { data } = gate.viewer.client.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") window.location.assign("/login");
    });
    return () => data.subscription.unsubscribe();
  }, [gate]);

  return gate;
}

function Splash({ busy }: { busy: boolean }) {
  return (
    <div className="flex h-[100dvh] items-center justify-center bg-[#fdfdfd]">
      <div className="flex flex-col items-center gap-4">
        <BrandMark size={28} />
        {busy ? <Loader2 className="h-4 w-4 animate-spin text-[#9a9a9a]" aria-label="Loading" /> : null}
      </div>
    </div>
  );
}

export default function Workspace() {
  const gate = useGate();
  if (gate.state !== "ready") return <Splash busy={gate.state === "checking"} />;
  return <WorkspaceReady viewer={gate.viewer} />;
}

function useAccessToken(client: SupabaseClient | null) {
  return useCallback(async () => {
    if (!client) return null;
    try {
      return (await client.auth.getSession()).data.session?.access_token ?? null;
    } catch {
      return null;
    }
  }, [client]);
}

type FocusSource = {
  /** Storage scope of the workspace (lib/workspace/workspaces.ts). */
  scope: string;
  /** Main workspace of a signed-in member: loads from and saves to the account. */
  server: boolean;
  /** Main workspace of the development preview: starts from the sample list, saves nothing. */
  sample: boolean;
};

/**
 * The focus list for one workspace: memory or this browser first, then the
 * server (main workspace only). Other workspaces start empty and stay in this
 * browser; they never call saveServerFocus, which would overwrite the
 * member's real list.
 */
function useFocus({ scope, server, sample }: FocusSource, getToken: () => Promise<string | null>) {
  const [focus, setFocus] = useState<FocusItem[]>(() => readLocalFocus(scope) ?? []);
  const [loaded, setLoaded] = useState(() => readLocalFocus(scope) !== null);

  useEffect(() => {
    if (loaded) return;
    let live = true;
    (async () => {
      let items: FocusItem[] = [];
      if (sample) {
        // The inline NODE_ENV check lets the build drop the fixture entirely.
        if (process.env.NODE_ENV === "development") items = (await import("@/lib/workspace/fixture")).SAMPLE_FOCUS;
      } else if (server) {
        const token = await getToken();
        const tickers = token ? await fetchServerFocus(token) : null;
        if (tickers?.length) {
          const names = await fetchNames(tickers);
          items = cleanFocus(tickers.map((ticker) => ({ ticker, name: names[ticker] ?? "" })));
        }
      }
      if (!live) return;
      setFocus(items);
      setLoaded(true);
      if (!sample) writeLocalFocus(scope, items);
    })();
    return () => {
      live = false;
    };
  }, [getToken, loaded, sample, scope, server]);

  // Fill in names the welcome flow or an old save left out.
  useEffect(() => {
    const missing = focus.filter((f) => !f.name).map((f) => f.ticker);
    if (!missing.length) return;
    let live = true;
    void fetchNames(missing).then((names) => {
      if (!live || !Object.keys(names).length) return;
      setFocus((prev) => prev.map((f) => (f.name ? f : { ...f, name: names[f.ticker] ?? "" })));
    });
    return () => {
      live = false;
    };
  }, [focus]);

  const update = useCallback(
    (next: FocusItem[]) => {
      const clean = cleanFocus(next);
      setFocus(clean);
      if (sample) return;
      writeLocalFocus(scope, clean);
      if (server) void getToken().then((token) => (token ? saveServerFocus(token, clean) : undefined));
    },
    [getToken, sample, scope, server],
  );

  return { focus, loaded, update };
}

function useLayout(userId: string) {
  const [layout, setLayout] = useState<WorkspaceLayout>(() => readLayout(userId));
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    writeLayout(userId, layout);
  }, [layout, userId]);
  return [layout, setLayout] as const;
}

/** Adds `tab` (if missing) right after the active one, dropping the oldest tab not in view when full. */
function withTab(layout: WorkspaceLayout, tab: Tab): WorkspaceLayout {
  if (layout.tabs.some((t) => t.id === tab.id)) return layout;
  const at = layout.tabs.findIndex((t) => t.id === layout.activeId);
  let tabs = [...layout.tabs.slice(0, at + 1), tab, ...layout.tabs.slice(at + 1)];
  if (tabs.length > MAX_TABS) {
    // Drop the oldest tab that is not the one being opened or one on screen.
    const drop = tabs.findIndex((t) => t.id !== tab.id && t.id !== layout.activeId && t.id !== layout.split?.other);
    tabs = tabs.filter((_, i) => i !== drop);
  }
  return { ...layout, tabs };
}

/** Puts `tab` right after the active one (or focuses it if it is open). */
function openIn(layout: WorkspaceLayout, tab: Tab): WorkspaceLayout {
  return { ...withTab(layout, tab), activeId: tab.id };
}

type Section = "tab" | "focus" | "sightings" | "help";
const SECTION_TARGETS: ReadonlySet<string> = new Set(["focus", "sightings", "help"]);

/** The tab a view target names: one already open, or one built from its id. */
function tabFromTarget(target: string, tabs: readonly Tab[]): Tab | null {
  const found = tabs.find((t) => t.id === target);
  if (found) return found;
  if (target === "dashboard" || target === "graph") return { id: target, kind: target };
  if (target.startsWith("ticker:")) return { id: target, kind: "ticker", ticker: target.slice(7) };
  if (target.startsWith("sighting:")) return { id: target, kind: "sighting", cardId: target.slice(9) };
  if (target.startsWith("strategy:")) return { id: target, kind: "strategy", strategyId: target.slice(9) };
  return null;
}

function navOf(target: string | null, tabs: readonly Tab[]): NavId | null {
  if (!target) return null;
  if (target === "dashboard" || target === "graph" || target === "focus" || target === "sightings") return target;
  return tabFromTarget(target, tabs)?.kind === "strategy" ? "strategy" : null;
}

/** Picks the active workspace and mounts it under its own key, so switching reloads every piece of state. */
function WorkspaceReady({ viewer }: { viewer: Viewer }) {
  const workspaces = useWorkspaceIndex(viewer.userId);
  const id = workspaces.active.id;
  return <WorkspaceScoped key={id} viewer={viewer} scope={storageScope(viewer.userId, id)} main={id === MAIN_WORKSPACE_ID} workspaces={workspaces} />;
}

type PaneRole = "single" | "primary" | "other";

function WorkspaceScoped({
  viewer,
  scope,
  main,
  workspaces,
}: {
  viewer: Viewer;
  /** Storage key for this workspace's focus list, tabs and strategies. */
  scope: string;
  main: boolean;
  workspaces: WorkspaceSwitcherApi;
}) {
  const getToken = useAccessToken(viewer.client);
  const preview = viewer.userId === "preview";
  const { focus, loaded: focusLoaded, update: setFocusList } = useFocus({ scope, server: main && !preview, sample: main && preview }, getToken);
  const focusTickers = useMemo(() => focus.map((f) => f.ticker), [focus]);
  const focusSet = useMemo(() => new Set(focusTickers), [focusTickers]);
  const sightings = useSightings(focusTickers, { getToken, enabled: focusLoaded });
  const [layout, setLayout] = useLayout(scope);
  const strategies = useStrategies(scope);
  const [clock, setClock] = useState(() => Date.now());
  // Focus list, Sightings and Help open in the card without being tabs; any tab action returns to the tab.
  // A new workspace opens on its empty focus list, ready to add a ticker.
  const [section, setSection] = useState<Section>(() => (!main && !readLocalFocus(scope)?.length ? "focus" : "tab"));
  const [guideOpen, setGuideOpen] = useState(false);
  const closeGuide = useCallback(() => setGuideOpen(false), []);
  const [railPinned, setRailPinned] = useState(() => readRailPinned(viewer.userId));
  const [focusedRole, setFocused] = useState<"primary" | "other">("primary");
  const help = useHelp();
  const areaRef = useRef<HTMLDivElement>(null);

  // Keeps "updated 3m ago" honest.
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /* ----------------------------------------------- what is on screen */
  const primary: string | null = section !== "tab" ? section : layout.activeId || null;
  const split = layout.split && primary && layout.split.other !== primary ? layout.split : null;
  const focused = split ? focusedRole : "primary";
  const focusedTarget = focused === "other" && split ? split.other : primary;
  const primaryRef = useRef(primary);
  primaryRef.current = primary;
  const splitRef = useRef(split);
  splitRef.current = split;
  const focusedRef = useRef(focused);
  focusedRef.current = focused;

  const goPrimary = useCallback(
    (target: string) => {
      if (SECTION_TARGETS.has(target)) {
        setSection(target as Section);
        return;
      }
      setSection("tab");
      setLayout((l) => {
        const tab = tabFromTarget(target, l.tabs);
        return tab ? openIn(l, tab) : l;
      });
    },
    [setLayout],
  );

  const setOther = useCallback(
    (target: string, side?: Side) =>
      setLayout((l) => {
        const tab = SECTION_TARGETS.has(target) ? null : tabFromTarget(target, l.tabs);
        if (!tab && !SECTION_TARGETS.has(target)) return l;
        const base = tab ? withTab(l, tab) : l;
        return { ...base, split: { other: target, side: side ?? l.split?.side ?? "right", ratio: l.split?.ratio ?? 0.5 } };
      }),
    [setLayout],
  );

  /** Shows `target` in the focused pane, or focuses the pane that already shows it. */
  const navigate = useCallback(
    (target: string) => {
      const sp = splitRef.current;
      if (sp) {
        if (target === primaryRef.current) return setFocused("primary");
        if (target === sp.other) return setFocused("other");
        if (focusedRef.current === "other") return setOther(target);
      }
      goPrimary(target);
    },
    [goPrimary, setOther],
  );

  const open = useCallback((tab: Tab) => navigate(tab.id), [navigate]);
  const openStrategy = useCallback(
    (strategyId: string) => open({ id: tabId({ kind: "strategy", strategyId }), kind: "strategy", strategyId }),
    [open],
  );
  const newStrategy = useCallback(
    (init?: Parameters<typeof createStrategy>[1]) => openStrategy(createStrategy(scope, init ?? { rules: BLANK_RULES }).id),
    [openStrategy, scope],
  );

  const close = useCallback(
    (id: string) =>
      setLayout((l) => {
        const index = l.tabs.findIndex((t) => t.id === id);
        if (index === -1) return l;
        const tabs = l.tabs.filter((t) => t.id !== id);
        const activeId = l.activeId === id ? (tabs[index] ?? tabs[index - 1])?.id ?? "" : l.activeId;
        // A split loses its second pane when that pane closes or would now show the same view.
        const split = l.split && l.split.other !== id && l.split.other !== activeId ? l.split : null;
        return { ...l, tabs, activeId, split };
      }),
    [setLayout],
  );

  const move = useCallback(
    (id: string, to: number) =>
      setLayout((l) => {
        const from = l.tabs.findIndex((t) => t.id === id);
        if (from === -1) return l;
        const tabs = [...l.tabs];
        const [tab] = tabs.splice(from, 1);
        tabs.splice(Math.max(0, Math.min(tabs.length, to)), 0, tab);
        return { ...l, tabs };
      }),
    [setLayout],
  );

  const api: WorkspaceApi = useMemo(
    () => ({
      feed: sightings.feed,
      feedStatus: sightings.status,
      sample: sightings.sample,
      loadedAt: sightings.loadedAt,
      refreshFeed: sightings.refresh,
      focus,
      focusSet,
      openTicker: (ticker) => open({ id: tabId({ kind: "ticker", ticker }), kind: "ticker", ticker }),
      openSighting: (cardId) => {
        const card = sightings.feed?.cards.find((c) => c.id === cardId);
        const title = card ? `${card.event.ticker} ${cardExplain(card).kicker.toLowerCase()}` : undefined;
        const tab: Tab = { id: tabId({ kind: "sighting", cardId }), kind: "sighting", cardId, title };
        // Keep the card's title with the tab so it reads well before the feed loads.
        setLayout((l) => withTab(l, tab));
        open(tab);
      },
      openTab: (kind) => (kind === "strategy" ? newStrategy() : open({ id: kind, kind } as Tab)),
      userId: scope,
      strategies,
      openStrategy,
      newStrategy,
      closeTab: close,
      deleteStrategy: (strategyId) => {
        close(tabId({ kind: "strategy", strategyId }));
        deleteStrategy(scope, strategyId);
      },
      backtestSighting: (cardId) => {
        // One strategy per card: open the one made before, else build the rules and run them.
        const made = strategies.find((s) => s.origin.kind === "sighting" && s.origin.cardId === cardId);
        if (made) return openStrategy(made.id);
        const card = sightings.feed?.cards.find((c) => c.id === cardId);
        if (!card) return;
        const b = strategyFromSighting(card);
        newStrategy({
          rules: b.strategy,
          origin: { kind: "sighting", cardId, eventTicker: card.event.ticker, basis: b.basis, notes: b.notes, hasHistory: b.hasHistory },
          // Event types without history yet would only show an empty run.
          autorun: b.hasHistory,
        });
      },
      addFocus: (item) => {
        if (!focusSet.has(item.ticker)) setFocusList([...focus, item]);
      },
      removeFocus: (ticker) => setFocusList(focus.filter((f) => f.ticker !== ticker)),
    }),
    // `sightings.refresh` is rebuilt every render; the rest decides.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [close, focus, focusSet, newStrategy, open, openStrategy, scope, setFocusList, setLayout, sightings.feed, sightings.loadedAt, sightings.sample, sightings.status, strategies],
  );

  const titleFor = useCallback(
    (tab: Tab): string => {
      switch (tab.kind) {
        case "dashboard":
          return "Dashboard";
        case "graph":
          return "Graph";
        case "strategy":
          return strategies.find((s) => s.id === tab.strategyId)?.rules.name.trim() || "Strategy";
        case "ticker":
          return tab.ticker;
        case "sighting": {
          const card = sightings.feed?.cards.find((c) => c.id === tab.cardId);
          return card ? `${card.event.ticker} ${cardExplain(card).kicker.toLowerCase()}` : tab.title ?? "Sighting";
        }
      }
    },
    [sightings.feed, strategies],
  );

  const labelFor = useCallback(
    (target: string): string => {
      if (target === "focus") return "Focus list";
      if (target === "sightings") return "Sightings";
      if (target === "help") return "Help";
      const tab = tabFromTarget(target, layout.tabs);
      return tab ? titleFor(tab) : target;
    },
    [layout.tabs, titleFor],
  );

  /** What the help chat is told the person is looking at. */
  const describe = useCallback(
    (target: string | null): string => {
      if (!target) return "";
      if (target === "focus") return "Focus list";
      if (target === "sightings") return "Sightings list";
      if (target === "help") return "";
      const tab = tabFromTarget(target, layout.tabs);
      if (!tab) return "";
      if (tab.kind === "dashboard") return "Dashboard (Today)";
      if (tab.kind === "graph") return "Graph";
      if (tab.kind === "ticker") return `Ticker page for ${tab.ticker}`;
      if (tab.kind === "sighting") {
        const card = sightings.feed?.cards.find((c) => c.id === tab.cardId);
        return card ? `Sighting: ${cardExplain(card).title}` : `Sighting: ${titleFor(tab)}`;
      }
      return `Strategy Lab, strategy "${titleFor(tab)}"`;
    },
    [layout.tabs, sightings.feed, titleFor],
  );
  const helpView = describe(focusedTarget === "help" ? (focused === "other" ? primary : split?.other ?? null) : focusedTarget);

  const signOut = useMemo(() => {
    const client = viewer.client;
    if (!client) return null;
    return () => {
      void client.auth.signOut().finally(() => window.location.assign("/login"));
    };
  }, [viewer.client]);

  // The old tabs, minus Dashboard and Graph which are nav items of their own.
  const openItems: OpenItem[] = useMemo(
    () =>
      layout.tabs
        .filter((t) => t.kind !== "dashboard" && t.kind !== "graph")
        .map((t) => ({ id: t.id, kind: t.kind, title: titleFor(t), ticker: t.kind === "ticker" ? t.ticker : t.kind === "sighting" ? titleFor(t).split(" ")[0] : undefined })),
    [layout.tabs, titleFor],
  );

  const current = navOf(focusedTarget, layout.tabs);
  const focusedKind = focusedTarget ? tabFromTarget(focusedTarget, layout.tabs)?.kind : undefined;
  const activeLink: TopLink = focusedTarget === "sightings" || focusedKind === "sighting" ? "sightings" : focusedKind === "strategy" ? "strategy" : "workspace";

  /** Strategy Lab: the last strategy open, else the last one edited, else a new one. */
  const labTarget = useCallback((): string => {
    const openOne = [...layout.tabs].reverse().find((t) => t.kind === "strategy");
    if (openOne) return openOne.id;
    const recent = [...strategies].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    return tabId({ kind: "strategy", strategyId: (recent ?? createStrategy(scope, { rules: BLANK_RULES })).id });
  }, [layout.tabs, scope, strategies]);

  const nav = useCallback((id: NavId) => navigate(id === "strategy" ? labTarget() : id), [labTarget, navigate]);

  /** The round split button: next to the current view, or in place of the pane not in focus. */
  const splitWith = useCallback(
    (target: string) => {
      const sp = splitRef.current;
      if (!sp) {
        if (target !== primaryRef.current) setOther(target, "right");
        return;
      }
      if (target === primaryRef.current) return setFocused("primary");
      if (target === sp.other) return setFocused("other");
      if (focusedRef.current === "primary") setOther(target);
      else goPrimary(target);
    },
    [goPrimary, setOther],
  );

  /** Closes the pane showing `target`; the other one fills the card. */
  const closePane = useCallback(
    (target: string) => {
      const sp = splitRef.current;
      if (!sp) return;
      setFocused("primary");
      setLayout((l) => ({ ...l, split: null }));
      if (target === primaryRef.current) goPrimary(sp.other);
    },
    [goPrimary, setLayout],
  );

  const swapSides = useCallback(() => setLayout((l) => (l.split ? { ...l, split: { ...l.split, side: l.split.side === "left" ? "right" : "left", ratio: 1 - l.split.ratio } } : l)), [setLayout]);

  const helpOnScreen = primary === "help" || split?.other === "help";
  const openHelp = useCallback(() => {
    if (primaryRef.current === "help") return setFocused("primary");
    if (splitRef.current?.other === "help") return setFocused("other");
    setHelpFloating(true);
  }, []);
  const dockHelp = useCallback(
    (side: Side = "right") => {
      if (primaryRef.current === "help") return;
      setHelpFloating(false);
      setOther("help", side);
      setFocused("other");
    },
    [setOther],
  );
  const undockHelp = useCallback(() => {
    setHelpFloating(true);
    if (splitRef.current) closePane("help");
    else goPrimary("dashboard");
  }, [closePane, goPrimary]);

  const onDrop = useCallback(
    ({ payload, zone }: DropResult) => {
      const t = payload.target;
      const sp = splitRef.current;
      const prim = primaryRef.current;
      if (!zone) {
        // A pane dragged out of the main area leaves the split; the help chat floats again.
        if (payload.from === "pane") {
          if (t === "help") undockHelp();
          else closePane(t);
        }
        return;
      }
      if (t === "help") setHelpFloating(false);
      if (!sp) {
        if (t === prim || !prim) return;
        setOther(t, zone);
        setFocused("other");
        return;
      }
      const primarySide: Side = sp.side === "left" ? "right" : "left";
      if (t === sp.other || t === prim) {
        if ((t === sp.other ? sp.side : primarySide) !== zone) swapSides();
        return;
      }
      if (zone === sp.side) {
        setOther(t);
        setFocused("other");
      } else if (SECTION_TARGETS.has(t) && !SECTION_TARGETS.has(sp.other)) {
        // Focus list, Sightings and Help take the saved slot, so a reload keeps them; the tab there moves over.
        goPrimary(sp.other);
        setOther(t, zone);
        setFocused("other");
      } else {
        goPrimary(t);
        setFocused("primary");
      }
    },
    [closePane, goPrimary, setOther, swapSides, undockHelp],
  );

  const toggleContext = useCallback(() => setLayout((l) => ({ ...l, contextOpen: !l.contextOpen })), [setLayout]);
  const status =
    sightings.status === "loading" && !sightings.loadedAt
      ? "Loading sightings"
      : sightings.loadedAt
        ? `Updated ${timeAgo(new Date(sightings.loadedAt).toISOString(), clock)}`
        : "";

  /* ------------------------------------------------------ pane views */

  /** "…" menu and close button for a pane header. */
  const paneActions = (target: string, role: PaneRole) => {
    if (role === "single") {
      const candidates = [...NAV.map((n) => navTarget(n.id)).filter((x): x is string => x !== null), ...openItems.map((o) => o.id)].filter((c) => c !== target);
      return (
        <Dropdown
          label="View options"
          kind="menu"
          align="right"
          width={260}
          groups={() => [
            {
              label: "Open in split view",
              items: candidates.map((c) => {
                const tab = tabFromTarget(c, layout.tabs);
                return { id: `split:${c}`, label: labelFor(c), icon: tab ? TAB_ICON[tab.kind] : NAV.find((n) => n.id === c)?.icon };
              }),
            },
            { items: target === "help" ? [] : [{ id: "help", label: "Dock help chat to the right", icon: LifeBuoy }] },
          ]}
          onSelect={(id) => (id === "help" ? dockHelp("right") : splitWith(id.slice(6)))}
          button={({ open: o, props }) => (
            <button {...props} title="View options" className={`${ICON_BUTTON} ${o ? "bg-black/[0.06] text-[#1d1b1b]" : ""}`}>
              <MoreHorizontal width={16} height={16} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        />
      );
    }
    const name = labelFor(target);
    return (
      <>
        <Dropdown
          label={`${name} pane options`}
          kind="menu"
          align="right"
          width={220}
          groups={() => [
            {
              items: [
                { id: "swap", label: "Swap sides", icon: ArrowLeftRight },
                ...(target === "help" ? [{ id: "undock", label: "Undock help chat", icon: PictureInPicture2 }] : []),
                { id: "close", label: "Close this pane", icon: X },
              ],
            },
          ]}
          onSelect={(id) => (id === "swap" ? swapSides() : id === "undock" ? undockHelp() : closePane(target))}
          button={({ open: o, props }) => (
            <button {...props} title="Pane options" className={`${ICON_BUTTON} ${o ? "bg-black/[0.06] text-[#1d1b1b]" : ""}`}>
              <MoreHorizontal width={16} height={16} strokeWidth={1.75} aria-hidden />
            </button>
          )}
        />
        {target === "help" ? <IconButton label="Undock help chat" icon={PictureInPicture2} onClick={undockHelp} /> : null}
        <IconButton label={`Close ${name} pane`} icon={X} onClick={() => closePane(target)} />
      </>
    );
  };

  const renderTarget = (target: string | null, role: PaneRole) => {
    if (!target) {
      return (
        <>
          <CardHeader title="Workspace" />
          <NoTabs onOpen={(kind) => api.openTab(kind)} />
        </>
      );
    }
    const extra = paneActions(target, role);
    if (target === "focus") return <FocusListView headerExtra={extra} />;
    if (target === "sightings") return <SightingsListView onGuide={() => setGuideOpen(true)} headerExtra={extra} />;
    if (target === "help") {
      return (
        <>
          <CardHeader title="Help" actions={extra} />
          <HelpThread view={helpView} autoFocus />
        </>
      );
    }
    const tab = tabFromTarget(target, layout.tabs);
    if (!tab) return renderTarget(null, role);
    if (tab.kind === "strategy") return <StrategyTab key={tab.id} strategyId={tab.strategyId} headerExtra={extra} />;
    const details = role === "single" && layout.contextOpen;
    return (
      <div key={tab.id} role="region" aria-label={titleFor(tab)} className="flex min-h-0 flex-1 flex-col">
        <CardHeader
          title={titleFor(tab)}
          titleMono={tab.kind === "ticker"}
          actions={
            <>
              {tab.kind === "dashboard" || tab.kind === "graph" ? (
                <TextButton icon={RotateCw} onClick={sightings.refresh}>
                  Refresh
                </TextButton>
              ) : role === "single" ? (
                <TextButton icon={X} onClick={() => close(tab.id)}>
                  Close
                </TextButton>
              ) : null}
              {role === "single" ? (
                <TextButton icon={PanelRight} onClick={toggleContext} pressed={layout.contextOpen}>
                  Details
                </TextButton>
              ) : null}
              {extra}
            </>
          }
        />
        <div className="flex min-h-0 flex-1">
          <CardBody fill={tab.kind === "graph"}>
            <TabContent tab={tab} />
          </CardBody>
          {details ? <ContextPanel tab={tab} /> : null}
        </div>
      </div>
    );
  };

  const pane = (target: string | null, role: PaneRole) => (
    <Pane
      key={role === "single" ? "single" : `${role}:${target}`}
      role={role}
      target={target}
      label={target ? labelFor(target) : "Workspace"}
      focused={role !== "single" && (role === focused)}
      onFocus={() => role !== "single" && setFocused(role)}
    >
      {renderTarget(target, role)}
    </Pane>
  );

  return (
    <WorkspaceContext.Provider value={api}>
      <HowToReadFirstVisit />
      <HowToReadDialog open={guideOpen} onClose={closeGuide} />
      <div className="lg:hidden">
        <CompactToday />
      </div>

      <DragDockProvider areaRef={areaRef} onDrop={onDrop}>
        <div className="hidden h-[100dvh] flex-col overflow-hidden bg-[#f4f4f2] text-[#1d1b1b] lg:flex" style={{ fontFamily: GEIST }}>
          <TopBar
            email={viewer.email}
            workspaces={workspaces}
            activeLink={activeLink}
            contextOpen={layout.contextOpen}
            onNav={nav}
            onLink={(id) => (id === "workspace" ? nav("dashboard") : id === "docs" ? openHelp() : nav(id))}
            onToggleContext={toggleContext}
            onGuide={() => setGuideOpen(true)}
            onSignOut={signOut}
          />
          <div className="flex min-h-0 flex-1">
            <Sidebar
              pinned={railPinned}
              onTogglePin={() => {
                setRailPinned((p) => {
                  writeRailPinned(viewer.userId, !p);
                  return !p;
                });
              }}
              current={current}
              activeTarget={focusedTarget}
              marked={split && primary ? new Set([primary, split.other]) : EMPTY_SET}
              primaryTarget={primary}
              openItems={openItems}
              onNav={nav}
              onSelectTab={navigate}
              onCloseTab={close}
              onMoveTab={(id, delta) => {
                const at = openItems.findIndex((t) => t.id === id);
                const neighbor = openItems[at + delta];
                if (at !== -1 && neighbor) move(id, layout.tabs.findIndex((t) => t.id === neighbor.id));
              }}
              onSplit={(item) => splitWith("nav" in item ? (item.nav === "strategy" ? labTarget() : item.nav) : item.target)}
              onCloseSplit={closePane}
              onGuide={() => setGuideOpen(true)}
              onHelp={openHelp}
              onSignOut={signOut}
              status={
                <>
                  {status}
                  {sightings.sample ? <span className="block text-[#b0782f]">Sample data, development only</span> : null}
                </>
              }
            />

            <div ref={areaRef} className="mb-3 mr-3 flex min-w-0 flex-1">
              {split ? (
                <SplitArea
                  ratio={split.ratio}
                  onRatio={(ratio) => setLayout((l) => (l.split ? { ...l, split: { ...l.split, ratio } } : l))}
                  left={split.side === "left" ? pane(split.other, "other") : pane(primary, "primary")}
                  right={split.side === "left" ? pane(primary, "primary") : pane(split.other, "other")}
                />
              ) : (
                pane(primary, "single")
              )}
            </div>
          </div>
        </div>
        {help.floating && !helpOnScreen ? <FloatingHelp userId={viewer.userId} view={helpView} onClose={() => setHelpFloating(false)} onDock={() => dockHelp("right")} /> : null}
      </DragDockProvider>
    </WorkspaceContext.Provider>
  );
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/** One white card; in split view a pane whose header drags (out to undock, onto the other half to swap). */
function Pane({
  role,
  target,
  label,
  focused,
  onFocus,
  children,
}: {
  role: PaneRole;
  target: string | null;
  label: string;
  focused: boolean;
  onFocus: () => void;
  children: React.ReactNode;
}) {
  const { begin } = useDragDock();
  return (
    <section
      aria-label={role === "single" ? undefined : `${label} pane${focused ? ", in focus" : ""}`}
      className={`flex min-w-0 flex-1 flex-col rounded-xl border bg-white shadow-[0_1px_2px_rgba(0,0,0,0.03)] transition-colors ${
        focused ? "border-black/[0.16]" : "border-black/[0.08]"
      }`}
      onPointerDownCapture={onFocus}
      onFocusCapture={onFocus}
      onPointerDown={(e) => {
        if (role === "single" || !target) return;
        const el = e.target as HTMLElement;
        if (!el.closest("[data-pane-header]") || el.closest("button, a, input, textarea, select, [role=combobox], [role=listbox], [role=menu]")) return;
        begin(e, { target, label, from: "pane" });
      }}
    >
      {children}
    </section>
  );
}

function TabContent({ tab }: { tab: Tab }) {
  switch (tab.kind) {
    case "dashboard":
      return <DashboardTab />;
    case "graph":
      return <GraphTab />;
    case "ticker":
      return <TickerTab ticker={tab.ticker} />;
    case "sighting":
      return <SightingTab cardId={tab.cardId} />;
    case "strategy":
      return <StrategyTab strategyId={tab.strategyId} />;
  }
}

function NoTabs({ onOpen }: { onOpen: (kind: "dashboard" | "graph" | "strategy") => void }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => onOpen("dashboard")}
          className="inline-flex h-9 items-center rounded-lg bg-[#1c1917] px-4 text-[13px] text-[rgb(231,231,231)] outline-none transition-colors hover:bg-[#0f0d0b] focus-visible:ring-2 focus-visible:ring-black/30"
        >
          Open dashboard
        </button>
        <button
          type="button"
          onClick={() => onOpen("graph")}
          className="inline-flex h-9 items-center rounded-lg border border-black/10 px-4 text-[13px] text-[#1d1b1b] outline-none transition-colors hover:bg-[#efefec] focus-visible:border-black/40"
        >
          Open graph
        </button>
        <button
          type="button"
          onClick={() => onOpen("strategy")}
          className="inline-flex h-9 items-center rounded-lg border border-black/10 px-4 text-[13px] text-[#1d1b1b] outline-none transition-colors hover:bg-[#efefec] focus-visible:border-black/40"
        >
          New strategy
        </button>
      </div>
    </div>
  );
}
