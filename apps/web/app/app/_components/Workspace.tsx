"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { strategyFromSighting } from "@falcon/backtest";
import { isApproved } from "@/lib/auth";
import { needsWelcome } from "@/lib/onboarding";
import { isSupabaseConfigured, requireSupabase } from "@/lib/supabase";
import { KIND_LABEL } from "@/lib/workspace/feed";
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
import { MAX_TABS, readLayout, tabId, writeLayout, type Tab, type WorkspaceLayout } from "@/lib/workspace/layout";
import { useSightings } from "@/lib/workspace/sightings";
import { BLANK_RULES, createStrategy, deleteStrategy, useStrategies } from "@/lib/workspace/strategies";
import BrandMark from "../../components/BrandMark";
import { CompactToday } from "./CompactToday";
import { ContextPanel } from "./ContextPanel";
import { WorkspaceContext, type WorkspaceApi } from "./context";
import { GEIST, MONO, timeAgo } from "./parts";
import { Sidebar } from "./Sidebar";
import { TabBar } from "./TabBar";
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
        setGate({ state: "ready", viewer: { userId: "preview", email: null, client: null } });
        return;
      }
      if (!isSupabaseConfigured) return leave("/login?next=/app");
      const client = requireSupabase();
      const session = (await client.auth.getSession().catch(() => null))?.data.session ?? null;
      if (!session || !isApproved(session.user)) return leave("/login?next=/app");
      if (!welcomeFinishedThisVisit() && (await needsWelcome(client))) return leave("/welcome?next=/app");
      if (live) setGate({ state: "ready", viewer: { userId: session.user.id, email: session.user.email ?? null, client } });
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

/** The focus list for this viewer: memory or this browser first, then the server. */
function useFocus(viewer: Viewer, getToken: () => Promise<string | null>) {
  const [focus, setFocus] = useState<FocusItem[]>(() => readLocalFocus(viewer.userId) ?? []);
  const [loaded, setLoaded] = useState(() => readLocalFocus(viewer.userId) !== null);

  useEffect(() => {
    if (loaded) return;
    let live = true;
    (async () => {
      let items: FocusItem[] = [];
      if (viewer.userId === "preview") {
        // The inline NODE_ENV check lets the build drop the fixture entirely.
        if (process.env.NODE_ENV === "development") items = (await import("@/lib/workspace/fixture")).SAMPLE_FOCUS;
      } else {
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
      if (viewer.userId !== "preview") writeLocalFocus(viewer.userId, items);
    })();
    return () => {
      live = false;
    };
  }, [getToken, loaded, viewer.userId]);

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
      if (viewer.userId === "preview") return;
      writeLocalFocus(viewer.userId, clean);
      void getToken().then((token) => (token ? saveServerFocus(token, clean) : undefined));
    },
    [getToken, viewer.userId],
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

/** Puts `tab` right after the active one (or focuses it if it is open). */
function openIn(layout: WorkspaceLayout, tab: Tab): WorkspaceLayout {
  if (layout.tabs.some((t) => t.id === tab.id)) return { ...layout, activeId: tab.id };
  const at = layout.tabs.findIndex((t) => t.id === layout.activeId);
  let tabs = [...layout.tabs.slice(0, at + 1), tab, ...layout.tabs.slice(at + 1)];
  if (tabs.length > MAX_TABS) {
    // Drop the oldest tab that is not the one being opened or the one in view.
    const drop = tabs.findIndex((t) => t.id !== tab.id && t.id !== layout.activeId);
    tabs = tabs.filter((_, i) => i !== drop);
  }
  return { ...layout, tabs, activeId: tab.id };
}

function WorkspaceReady({ viewer }: { viewer: Viewer }) {
  const getToken = useAccessToken(viewer.client);
  const { focus, loaded: focusLoaded, update: setFocusList } = useFocus(viewer, getToken);
  const focusTickers = useMemo(() => focus.map((f) => f.ticker), [focus]);
  const focusSet = useMemo(() => new Set(focusTickers), [focusTickers]);
  const sightings = useSightings(focusTickers, { getToken, enabled: focusLoaded });
  const [layout, setLayout] = useLayout(viewer.userId);
  const strategies = useStrategies(viewer.userId);
  const [clock, setClock] = useState(() => Date.now());

  // Keeps "updated 3m ago" honest.
  useEffect(() => {
    const t = setInterval(() => setClock(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const open = useCallback((tab: Tab) => setLayout((l) => openIn(l, tab)), [setLayout]);
  const openStrategy = useCallback(
    (strategyId: string) => open({ id: tabId({ kind: "strategy", strategyId }), kind: "strategy", strategyId }),
    [open],
  );
  const newStrategy = useCallback(
    (init?: Parameters<typeof createStrategy>[1]) => openStrategy(createStrategy(viewer.userId, init ?? { rules: BLANK_RULES }).id),
    [openStrategy, viewer.userId],
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
        const title = card ? `${card.event.ticker} ${KIND_LABEL[card.event.kind].toLowerCase()}` : undefined;
        open({ id: tabId({ kind: "sighting", cardId }), kind: "sighting", cardId, title });
      },
      openTab: (kind) => (kind === "strategy" ? newStrategy() : open({ id: kind, kind } as Tab)),
      userId: viewer.userId,
      strategies,
      openStrategy,
      newStrategy,
      deleteStrategy: (strategyId) => {
        const id = tabId({ kind: "strategy", strategyId });
        setLayout((l) => {
          const index = l.tabs.findIndex((t) => t.id === id);
          if (index === -1) return l;
          const tabs = l.tabs.filter((t) => t.id !== id);
          const activeId = l.activeId === id ? (tabs[index] ?? tabs[index - 1])?.id ?? "" : l.activeId;
          return { ...l, tabs, activeId };
        });
        deleteStrategy(viewer.userId, strategyId);
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
    [focus, focusSet, newStrategy, open, openStrategy, setFocusList, setLayout, sightings.feed, sightings.loadedAt, sightings.sample, sightings.status, strategies, viewer.userId],
  );

  const active = layout.tabs.find((t) => t.id === layout.activeId) ?? null;

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
          return card ? `${card.event.ticker} ${KIND_LABEL[card.event.kind].toLowerCase()}` : tab.title ?? "Sighting";
        }
      }
    },
    [sightings.feed, strategies],
  );

  const close = useCallback(
    (id: string) =>
      setLayout((l) => {
        const index = l.tabs.findIndex((t) => t.id === id);
        if (index === -1) return l;
        const tabs = l.tabs.filter((t) => t.id !== id);
        const activeId = l.activeId === id ? (tabs[index] ?? tabs[index - 1])?.id ?? "" : l.activeId;
        return { ...l, tabs, activeId };
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

  const signOut = useMemo(() => {
    const client = viewer.client;
    if (!client) return null;
    return () => {
      void client.auth.signOut().finally(() => window.location.assign("/login"));
    };
  }, [viewer.client]);

  return (
    <WorkspaceContext.Provider value={api}>
      <div className="lg:hidden">
        <CompactToday />
      </div>

      <div className="hidden h-[100dvh] overflow-hidden bg-[#fdfdfd] text-[#1d1b1b] lg:flex" style={{ fontFamily: GEIST }}>
        {layout.sidebarOpen ? (
          <Sidebar
            email={viewer.email}
            onSignOut={signOut}
            activeTicker={active?.kind === "ticker" ? active.ticker : null}
            activeCardId={active?.kind === "sighting" ? active.cardId : null}
          />
        ) : null}

        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar
            tabs={layout.tabs}
            activeId={layout.activeId}
            titleFor={titleFor}
            onSelect={(id) => setLayout((l) => ({ ...l, activeId: id }))}
            onClose={close}
            onMove={move}
            onNew={(kind) => api.openTab(kind)}
            sidebarOpen={layout.sidebarOpen}
            contextOpen={layout.contextOpen}
            onToggleSidebar={() => setLayout((l) => ({ ...l, sidebarOpen: !l.sidebarOpen }))}
            onToggleContext={() => setLayout((l) => ({ ...l, contextOpen: !l.contextOpen }))}
          />
          <div className="flex min-h-0 flex-1">
            <div
              key={active?.id ?? "none"}
              role="tabpanel"
              aria-label={active ? titleFor(active) : "No tab"}
              className={`min-w-0 flex-1 ${active?.kind === "graph" ? "overflow-hidden" : "overflow-y-auto"}`}
            >
              {active ? <TabContent tab={active} /> : <NoTabs onOpen={(kind) => api.openTab(kind)} />}
            </div>
            {layout.contextOpen ? <ContextPanel tab={active} /> : null}
          </div>
          <StatusBar sample={sightings.sample} loadedAt={sightings.loadedAt} clock={clock} status={sightings.status} />
        </main>
      </div>
    </WorkspaceContext.Provider>
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
    <div className="flex h-full items-center justify-center">
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

function StatusBar({ sample, loadedAt, clock, status }: { sample: boolean; loadedAt: number | null; clock: number; status: string }) {
  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-black/[0.08] bg-[#f6f6f3] px-3 text-[11px] text-[#9a9a9a]" style={{ fontFamily: MONO }}>
      <span>
        {status === "loading" && !loadedAt
          ? "Loading sightings"
          : loadedAt
            ? `Sightings updated ${timeAgo(new Date(loadedAt).toISOString(), clock)}`
            : ""}
      </span>
      {sample ? <span className="text-[#b0782f]">Sample data, development only</span> : null}
    </div>
  );
}
