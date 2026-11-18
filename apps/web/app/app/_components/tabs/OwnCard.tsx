"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { Check, FlaskConical, Loader2 } from "lucide-react";
import {
  IMAGE_ACCEPT,
  MAX_UPLOAD_BYTES,
  fetchPortfolioSources,
  importBrokerHoldings,
  openBrokerWindow,
  readScreenshotHoldings,
  type ImportResponse,
  type PortfolioSources,
} from "@/lib/portfolio-client";
import { importSummary } from "@/lib/portfolio-holdings";
import {
  clearDemoHoldings,
  clearPaperHoldings,
  demoOnList,
  markHoldingsAdded,
  mergeHoldings,
  ownCardVisible,
  readAskedFalcon,
  readDemoTickers,
  readHoldingsAdded,
  readHoldingsSources,
  readSightingOpened,
  setupProgress,
  subscribeOwnCard,
  withoutDemo,
  writeDemoTickers,
  type SetupState,
} from "@/lib/workspace/own-card";
import { importStage, type ImportSource, type PortfolioStage, type StageAction } from "@/lib/workspace/bring-portfolio";
import { useWorkspace } from "../context";
import { BlurOverlay } from "../shell/BlurOverlay";
import { TextButton } from "../shell/ui";
import { BringPortfolio, type PortfolioOption } from "./BringPortfolio";

/**
 * "Start with what you own": the Dashboard's setup card (tasks and the rule
 * for showing it: lib/workspace/own-card.ts). Its bottom row offers the next
 * task. For holdings that is the welcome flow's broker import (or the
 * screenshot reader when the broker is off), with the screenshot and a demo
 * portfolio as the other ways in (lib/portfolio-client.ts); imports put the
 * tickers in the portfolio and mark the holdings task done. "Get started"
 * on the holdings task frosts the page (shell/BlurOverlay.tsx) and puts "Bring
 * your portfolio" in front (BringPortfolio.tsx: broker, screenshot or demo),
 * which then shows each flow's real steps. Also the "Demo portfolio" line and
 * "Clear demo".
 */

/**
 * The paper portfolio: the paper account (lib/paper-account.ts, kept by
 * lib/workspace/holdings.ts) and, from before paper accounts, the tickers-only
 * demo's tickers still marked in this workspace. "Clear paper portfolio" takes
 * both away and, when nothing else added holdings, opens the holdings task again.
 */
export function usePaperPortfolio() {
  const { portfolio, portfolioLoaded, setPortfolio, userId, holdings, clearPaper } = useWorkspace();
  const marked = useSyncExternalStore(subscribeOwnCard, () => readDemoTickers(userId)?.join(",") ?? "", () => "");
  const tickers = useMemo(() => demoOnList(portfolio, marked ? marked.split(",") : null), [portfolio, marked]);
  const sources = useSyncExternalStore(subscribeOwnCard, () => readHoldingsSources(userId).join(","), () => "");

  // Every old demo ticker gone (Clear portfolio, or another device): the mark goes too, and with it the demo's part of the holdings task.
  useEffect(() => {
    if (portfolioLoaded && marked && !tickers.length) {
      writeDemoTickers(userId, null);
      clearDemoHoldings(userId);
    }
  }, [portfolioLoaded, marked, tickers.length, userId]);

  // A paper account kept only in memory is gone after a reload: its part of the holdings task goes too.
  useEffect(() => {
    if (holdings.status === "ready" && !holdings.paper && sources.split(",").includes("paper")) clearPaperHoldings(userId);
  }, [holdings.paper, holdings.status, sources, userId]);

  const clear = useCallback(async () => {
    if (tickers.length) setPortfolio(withoutDemo(portfolio, readDemoTickers(userId)));
    writeDemoTickers(userId, null);
    clearPaperHoldings(userId);
    await clearPaper();
  }, [clearPaper, portfolio, setPortfolio, tickers.length, userId]);

  return { account: holdings.paper, inMemory: holdings.paperInMemory, legacyTickers: tickers, on: holdings.paper !== null || tickers.length > 0, clear };
}

const ASK_RECHECK_MS = 5_000;

/** Whether this workspace's stored Falcon AI sessions hold a question; re-read on focus and every few seconds. */
function useAskedFalcon(scope: string): boolean {
  const [asked, setAsked] = useState(() => readAskedFalcon(scope));
  useEffect(() => {
    if (asked) return;
    const check = () => setAsked(readAskedFalcon(scope));
    check();
    const timer = setInterval(check, ASK_RECHECK_MS);
    window.addEventListener("focus", check);
    window.addEventListener("storage", check);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", check);
      window.removeEventListener("storage", check);
    };
  }, [asked, scope]);
  return asked;
}

/** The three tasks, from real state (holdings: an import or the demo through Falcon, not the portfolio's length). */
function useSetupState(): SetupState {
  const { userId } = useWorkspace();
  const holdings = useSyncExternalStore(subscribeOwnCard, () => readHoldingsAdded(userId), () => false);
  const sighting = useSyncExternalStore(subscribeOwnCard, () => readSightingOpened(userId), () => false);
  const ask = useAskedFalcon(userId);
  return { holdings, sighting, ask };
}

/** An empty ring that fills as tasks finish, with a check once all are done. */
function ProgressRing({ done, total }: { done: number; total: number }) {
  const r = 6.5;
  const length = 2 * Math.PI * r;
  const all = total > 0 && done >= total;
  return (
    <svg width={16} height={16} viewBox="0 0 16 16" className="shrink-0" aria-hidden>
      <circle cx={8} cy={8} r={r} fill="none" strokeWidth={1.5} strokeDasharray="2 2" className="stroke-line/30" />
      {done > 0 ? (
        <circle
          cx={8}
          cy={8}
          r={r}
          fill="none"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeDasharray={`${(length * done) / total} ${length}`}
          transform="rotate(-90 8 8)"
          className="stroke-fore"
        />
      ) : null}
      {all ? <Check x={4} y={4} width={8} height={8} strokeWidth={3} className="text-fore" /> : null}
    </svg>
  );
}

type RowAction = { label: string; run: () => void; disabled?: boolean };

/** /api/portfolio/status for this page visit, so the card does not flicker when the Dashboard remounts. */
let knownSources: PortfolioSources | null = null;

function OwnCard({ state, onDismiss, onImported }: { state: SetupState; onDismiss: () => void; onImported: (text: string) => void }) {
  const { portfolio, getToken, setPortfolio, userId, openSightings, openTab, saveImport, createPaper } = useWorkspace();
  const preview = userId.split(":")[0] === "preview";
  const progress = setupProgress(state);
  const [sources, setSources] = useState<PortfolioSources | null>(knownSources);
  const [busy, setBusy] = useState<ImportSource | null>(null);
  // "Bring your portfolio" in front of the frosted page; null when closed.
  const [stage, setStage] = useState<PortfolioStage | null>(null);
  // The last step stays on screen while the overlay animates out.
  const lastStage = useRef<PortfolioStage>({ step: "choose" });
  if (stage) lastStage.current = stage;
  const run = useRef<AbortController | null>(null);
  const popupRef = useRef<Window | null>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const portfolioRef = useRef(portfolio);
  portfolioRef.current = portfolio;

  useEffect(() => {
    let live = true;
    void fetchPortfolioSources().then((s) => {
      knownSources = s;
      if (live) setSources(s);
    });
    return () => {
      live = false;
    };
  }, []);

  /** Stops the import in flight: its popup listener and requests go, and its window closes. */
  const stopRun = useCallback(() => {
    run.current?.abort();
    run.current = null;
    const popup = popupRef.current;
    popupRef.current = null;
    if (popup && !popup.closed) popup.close();
    setBusy(null);
  }, []);
  useEffect(() => stopRun, [stopRun]);

  /** The end of a run: clears the busy button unless a newer run took over. */
  const settle = useCallback((ac: AbortController) => {
    if (run.current !== ac) return;
    run.current = null;
    popupRef.current = null;
    setBusy(null);
  }, []);

  const headers = useCallback(async (): Promise<HeadersInit | null> => {
    const token = await getToken();
    return token ? { Authorization: `Bearer ${token}` } : null;
  }, [getToken]);

  /**
   * What an import gave back: its positions and balances saved to the account
   * (signed-in main workspace; lib/workspace/holdings.ts), its tickers into the
   * portfolio, the task marked done, and the step to show. The save goes first,
   * so the ticker list saved after it already holds the new tickers.
   */
  const take = useCallback(
    async (source: ImportSource, res: ImportResponse): Promise<PortfolioStage> => {
      const holdings = res.holdings;
      let summary: string | undefined;
      if (res.import && holdings?.length) {
        const tickersText = importStage(source, holdings);
        const base = tickersText.step === "done" ? tickersText.text : "";
        try {
          const { stored } = await saveImport(res.import);
          summary = stored ? importSummary(res.import) : `${base} Sizes aren't stored yet.`;
        } catch {
          summary = `${base} Sizes couldn't be saved; try again later.`;
        }
      }
      const next = importStage(source, holdings, summary);
      if (next.step === "done" && holdings) {
        setPortfolio(mergeHoldings(portfolioRef.current, holdings));
        // Tickers an import brought in are the member's own now: Clear paper portfolio leaves them.
        const marked = readDemoTickers(userId);
        if (marked?.length) writeDemoTickers(userId, marked.filter((t) => !next.tickers.includes(t)));
        markHoldingsAdded(userId, source);
        onImported(next.text);
      }
      return next;
    },
    [onImported, saveImport, setPortfolio, userId],
  );

  const connectBroker = useCallback(async () => {
    if (preview) {
      setStage({ step: "preview", source: "broker" });
      return;
    }
    stopRun();
    // Opened inside the click so pop-up blockers allow it; pointed at SnapTrade once there is a link.
    const popup = openBrokerWindow();
    if (!popup) {
      setStage({ step: "blocked" });
      return;
    }
    const ac = new AbortController();
    run.current = ac;
    popupRef.current = popup;
    setBusy("broker");
    setStage({ step: "opening" });
    try {
      const h = await headers();
      if (!h) throw new Error("Sign in again to connect a broker.");
      const result = await importBrokerHoldings(popup, h, {
        signal: ac.signal,
        onReading: () => {
          if (!ac.signal.aborted) setStage({ step: "reading", source: "broker" });
        },
      });
      if (ac.signal.aborted) return;
      if (result === null) {
        setStage({ step: "cancelled" });
        return;
      }
      const next = await take("broker", result);
      if (!ac.signal.aborted) setStage(next);
    } catch (err) {
      if (ac.signal.aborted) return;
      if (!popup.closed) popup.close();
      setStage({ step: "error", source: "broker", text: err instanceof Error ? err.message : "We couldn't connect your broker." });
    } finally {
      settle(ac);
    }
  }, [headers, preview, settle, stopRun, take]);

  // The file picker is the browser's own; the panel shows the reading step once a file is chosen.
  const pickScreenshot = useCallback(() => {
    if (preview) setStage({ step: "preview", source: "screenshot" });
    else imageInput.current?.click();
  }, [preview]);

  const uploadScreenshot = useCallback(
    async (file: File) => {
      if (preview) {
        setStage({ step: "preview", source: "screenshot" });
        return;
      }
      stopRun();
      if (file.size > MAX_UPLOAD_BYTES) {
        setStage({ step: "error", source: "screenshot", text: "That image is over 10 MB." });
        return;
      }
      const ac = new AbortController();
      run.current = ac;
      setBusy("screenshot");
      setStage({ step: "reading", source: "screenshot" });
      try {
        const h = await headers();
        if (!h) throw new Error("Sign in again to upload a screenshot.");
        const result = await readScreenshotHoldings(file, h, ac.signal);
        if (ac.signal.aborted) return;
        const next = await take("screenshot", result);
        if (!ac.signal.aborted) setStage(next);
      } catch (err) {
        if (ac.signal.aborted) return;
        setStage({ step: "error", source: "screenshot", text: err instanceof Error ? err.message : "We couldn't read that screenshot." });
      } finally {
        settle(ac);
      }
    },
    [headers, preview, settle, stopRun, take],
  );

  const pick = (option: PortfolioOption) => {
    if (option === "broker") void connectBroker(); // Inside this click, so the window may open.
    else if (option === "screenshot") pickScreenshot();
    else setStage({ step: "paper" });
  };

  /**
   * The paper form's submit: the account made (stored when it can be), the task marked done, and the
   * overlay closed straight away. No success screen; a notification system will confirm it later.
   * Throws for the form.
   */
  const submitPaper = useCallback(
    async (balance: number, name: string | null) => {
      await createPaper(balance, name);
      markHoldingsAdded(userId, "paper");
      setStage(null);
    },
    [createPaper, userId],
  );

  const onStageAction = (a: StageAction) => {
    if (a === "reopen" || a === "retry") {
      if (stage?.step === "error" && stage.source === "screenshot") {
        setStage({ step: "choose" });
        pickScreenshot();
      } else void connectBroker(); // Still inside this click.
    } else if (a === "done") {
      setStage(null);
    } else {
      // Cancel or Back: nothing keeps running, and the three ways in come back.
      stopRun();
      setStage({ step: "choose" });
    }
  };

  // Escape, the ×, or a click on the frosted page.
  const closePanel = useCallback(() => {
    stopRun();
    setStage(null);
  }, [stopRun]);

  // The next task's row: what it says, its button, and the other ways in.
  const openPanel = () => setStage({ step: "choose" });
  let task: string;
  let action: RowAction;
  if (progress.next === "holdings") {
    // One line; the panel behind Get started offers broker, screenshot and demo.
    task = "Connect your assets";
    action = { label: "Get started", run: openPanel };
  } else if (progress.next === "sighting") {
    task = "Open a Sighting";
    action = { label: "Open Sightings", run: openSightings };
  } else if (progress.next === "ask") {
    task = "Ask Falcon AI a question";
    action = { label: "Ask Falcon AI", run: () => openTab("strategy") };
  } else {
    task = "Falcon is watching your portfolio.";
    action = { label: "Done", run: onDismiss };
  }
  const anyBusy = busy !== null;

  return (
    <section
      aria-labelledby="own-card-title"
      className="relative w-full rounded-2xl border border-line/[0.08] bg-raised px-5 py-4 shadow-[0_1px_2px_rgba(0,0,0,0.05),0_8px_24px_-6px_rgba(0,0,0,0.10)] [container-type:inline-size]"
    >
      <div className="flex items-start gap-6">
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="flex items-center gap-2 text-fs-13 text-quiet">
            <ProgressRing done={progress.done} total={progress.total} />
            {progress.done} of {progress.total} tasks complete
          </p>
          <h2 id="own-card-title" className="mt-2 text-fs-17 font-semibold leading-fs-24 text-fore">
            Make Falcon yours
          </h2>
          <p className="mt-1 text-fs-14 leading-fs-21 text-quiet">
            Add your holdings and Falcon tracks what moves them, before you have to ask.
          </p>
        </div>
      </div>

      <div className="mt-3.5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl bg-page px-4 py-2.5">
        <div className="min-w-0 flex-1">
          <p className="text-fs-14 leading-fs-20 text-fore">
            <span className="font-semibold">{progress.next === null ? "All set." : progress.done === 0 ? "First task:" : "Next task:"}</span> {task}
          </p>
        </div>
        <button
          ref={startButton}
          type="button"
          onClick={action.run}
          disabled={action.disabled || anyBusy}
          aria-busy={anyBusy || undefined}
          className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-solid px-3.5 text-fs-13 font-medium text-solid-ink outline-none transition-colors hover:bg-solid-hover focus-visible:ring-2 focus-visible:ring-line/30 disabled:cursor-default disabled:opacity-50"
        >
          {anyBusy ? <Loader2 width={14} height={14} strokeWidth={2} className="animate-spin" aria-hidden /> : null}
          {busy === "screenshot" ? "Reading" : busy === "broker" ? "Connecting" : action.label}
        </button>
      </div>

      <input
        ref={imageInput}
        type="file"
        accept={IMAGE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void uploadScreenshot(file);
        }}
      />
      <BlurOverlay open={stage !== null} onClose={closePanel} label="Bring your portfolio" returnFocus={startButton}>
        <BringPortfolio
          stage={stage ?? lastStage.current}
          sources={sources}
          preview={preview}
          onPick={pick}
          onAction={onStageAction}
          onClose={closePanel}
          onDropImage={(file) => void uploadScreenshot(file)}
          onCreatePaper={submitPaper}
        />
      </BlurOverlay>
    </section>
  );
}

/** "Paper portfolio", what it holds, and "Clear paper portfolio", while there is one. */
export function PaperMark({ className = "" }: { className?: string }) {
  const paper = usePaperPortfolio();
  if (!paper.on) return null;
  const cash = paper.account?.cash;
  const what =
    cash != null
      ? `${paper.account?.name ?? "Paper account"}: $${Math.round(cash).toLocaleString("en-US")} in cash, not your holdings.`
      : "Sample tickers, not your holdings.";
  return (
    <div className={`flex flex-wrap items-center gap-x-2 gap-y-1 ${className}`}>
      <span className="inline-flex h-6 items-center gap-1.5 rounded-full bg-line/[0.06] px-2.5 text-fs-12 leading-none text-fore-4">
        <FlaskConical width={12} height={12} strokeWidth={2} className="shrink-0 text-quiet" aria-hidden />
        Paper portfolio
      </span>
      <span className="text-fs-13 text-quiet">{what}</span>
      <TextButton onClick={() => void paper.clear()}>Clear paper portfolio</TextButton>
    </div>
  );
}

/** Under the Dashboard brief: the setup card, the demo mark, and what an import just added. */
export function StartWithWhatYouOwn() {
  const { portfolioLoaded } = useWorkspace();
  const state = useSetupState();
  // Closing hides the card for this visit only; it comes back the next time the Dashboard opens.
  const [dismissed, setDismissed] = useState(false);
  const [imported, setImported] = useState<string | null>(null);
  const visible = ownCardVisible({ portfolioLoaded, dismissed, state });
  const onImported = useCallback((text: string) => setImported(text), []);
  if (!visible && !imported) return null;

  return (
    <div className="flex flex-col items-start gap-3 pl-1.5">
      {visible ? (
        // Development only: a double-click hides the card for this visit, so the cards below can be checked without it.
        <div
          className="w-full"
          onDoubleClick={process.env.NODE_ENV === "development" ? () => setDismissed(true) : undefined}
        >
          <OwnCard state={state} onDismiss={() => setDismissed(true)} onImported={onImported} />
        </div>
      ) : null}
      {imported ? (
        <p className="text-fs-13 text-quiet" role="status">
          {imported}
        </p>
      ) : null}
    </div>
  );
}
