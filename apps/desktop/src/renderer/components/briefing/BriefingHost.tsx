import { Component, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BRIEFING_OPEN_EVENT } from "@/lib/briefing-open";
import {
  AUTO_OPEN_DEADLINE_MS,
  RETURN_AFTER_MS,
  decideAutoOpen,
  markShownThisLaunch,
  shownThisLaunchFor,
  type SeenStore,
} from "@/lib/briefing-seen";
import { getBriefingState, isFullyDegraded, retainBriefing, subscribeBriefing } from "@/lib/briefing-store";
import { briefingAutoOpen, briefingEnabled } from "@/lib/dashboard-config";
import { isDemoMode } from "@/lib/demo-mode";
import { hasPaperAccount, subscribePaperAccount } from "@/lib/paper-account";
import { resolveBriefingWindow, type BriefingWindow } from "../../../shared/briefing-types";
import BriefingPanel from "./BriefingPanel";

type Props = {
  /** The dashboard's privacy switch, passed straight through to the panel. */
  masked: boolean;
  /** Which page is up ("dashboard", "stock", "graph"). The panel only opens by itself over the dashboard. */
  view: string;
};

/** How often the open-by-itself decision is asked again while it is still "wait". */
const DECIDE_EVERY_MS = 200;

/**
 * A render error inside the panel must stay inside the panel. The host is
 * mounted in the dashboard's own tree, so without a boundary here one bad
 * field in one report would unmount the page the reader was trying to get to.
 * The fallback shows no error text: this is a product surface, and whatever
 * the message says belongs in the console, not in front of a reader.
 */
class BriefingBoundary extends Component<{ onClose: () => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error("[briefing] panel render failed:", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return createPortal(
      <div className="app-no-drag fixed inset-0 z-[80] flex items-center justify-center bg-black/10 backdrop-blur-[3px]">
        <div
          role="alertdialog"
          aria-modal="true"
          aria-label="Handover"
          className="w-[420px] max-w-[92vw] rounded-3xl border border-white/60 bg-white/70 p-6 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.04] backdrop-blur-xl"
        >
          <div className="select-none font-sans text-[11px] font-medium tracking-[0.08em] text-[#9CA3AF]">HANDOVER</div>
          <p className="mt-2 font-baskerville text-[17px] leading-[1.35] text-[#1d1b1b]">The handover could not be drawn.</p>
          <p className="mt-1 text-[12px] leading-[1.5] text-[#9CA3AF]">The rest of the dashboard is unaffected.</p>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => this.setState({ failed: false })}
              className="rounded-xl border-[0.5px] border-black/[0.12] px-3.5 py-1.5 font-sans text-[12px] font-medium text-[#1d1b1b] transition-colors hover:bg-black/[0.04]"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => {
                this.setState({ failed: false });
                this.props.onClose();
              }}
              className="glass-cta px-3.5 py-1.5 font-sans text-[12px] font-medium"
            >
              Close
            </button>
          </div>
        </div>
      </div>,
      document.body,
    );
  }
}

/** The launch mark's store; see `BRIEFING_SHOWN_LAUNCH_KEY` for why it is the session one. */
function launchStore(): SeenStore | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

/**
 * Which session the main process would hand over to right now. The main
 * process is asked first because its clock is the one the report is built
 * against (a developer can run it on a simulated one); the engine's own rule,
 * run here on the local clock, stands in when the handler is not there.
 */
async function currentWindow(): Promise<BriefingWindow | null> {
  try {
    const ask = window.meridian?.getBriefingWindow;
    if (typeof ask === "function") {
      const answer = await ask();
      if (answer && answer.ok === true) return answer.window;
    }
    return resolveBriefingWindow(new Date());
  } catch {
    return null;
  }
}

/**
 * Records that the panel was shown for the session the report on screen hands
 * over to. Nothing to record until a report is there: the panel can be opened
 * by hand while the first request is still out, and the caller then writes
 * the mark when the report lands. A demo report is marked too: the mark is
 * what puts out the card's dot, and the dot is lit for whatever is on screen.
 */
function markShown(): void {
  const report = getBriefingState().report;
  if (!report) return;
  const store = launchStore();
  if (!store) return;
  markShownThisLaunch(store, report.window.target_session_ymd, new Date().toISOString());
}

function BriefingHostInner({ masked, view }: Props) {
  const [open, setOpen] = useState(false);

  // The arrival check runs from timers and listeners that outlive a render, so
  // what it needs of the current render is read through refs.
  const viewRef = useRef(view);
  viewRef.current = view;
  const openRef = useRef(open);
  openRef.current = open;

  const close = useCallback(() => setOpen(false), []);

  const openByHand = useCallback(() => setOpen(true), []);

  // A panel opened by hand counts as shown too, or a return after a long spell
  // away would lay it over the reader a second time in the same launch. The
  // report is often still loading at the moment of the press, so the mark is
  // written when it lands, for as long as the panel is up.
  useEffect(() => {
    if (!open) return;
    markShown();
    return subscribeBriefing(markShown);
  }, [open]);

  // Shift+M from any page, and the card's "open" event. M is for "morning":
  // the letters that would fit the name better are taken (H is the diagnostics
  // panel, B is Base), and a shortcut that means two things means neither.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
      const isM = event.code === "KeyM" || event.key.toLowerCase() === "m";
      if (!isM) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable) return;
      }
      event.preventDefault();
      if (openRef.current) setOpen(false);
      else openByHand();
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener(BRIEFING_OPEN_EVENT, openByHand);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener(BRIEFING_OPEN_EVENT, openByHand);
    };
  }, [openByHand]);

  // Opening by itself, once per launch, on arrival. An arrival is the mount,
  // or the window coming back after a long spell in the background. Everything
  // an arrival starts (the hold on the store, the timer) is torn down when it
  // is decided and again in the cleanup, so a second run of this effect
  // (StrictMode, a remount) begins from nothing and cannot open the panel twice.
  useEffect(() => {
    let arrival = 0;
    let arrivedAt = 0;
    let engaged = false;
    let lastResizeAt = Number.NEGATIVE_INFINITY;
    let blurredAt: number | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    let release: (() => void) | null = null;
    let unwatchAccount: (() => void) | null = null;

    const settle = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      release?.();
      release = null;
      unwatchAccount?.();
      unwatchAccount = null;
    };

    const decide = () => {
      const state = getBriefingState();
      const report = state.status === "ready" ? state.report : null;
      const now = performance.now();
      const decision = decideAutoOpen({
        enabled: briefingEnabled() && briefingAutoOpen(),
        demo: isDemoMode(),
        hasAccount: hasPaperAccount(),
        // Judged against the report's own target session, not the clock's: a
        // report built on a simulated clock is shown for the session it names.
        shownThisLaunch: report ? shownThisLaunchFor(launchStore(), report.window.target_session_ymd) : false,
        reportReady: report !== null,
        fullyDegraded: report ? isFullyDegraded(report) : false,
        engaged,
        view: viewRef.current,
        msSinceArrival: now - arrivedAt,
        msSinceResize: now - lastResizeAt,
        otherDialogOpen: document.querySelector('[role="dialog"][aria-modal="true"]') !== null,
      });
      if (decision === "wait") return;
      settle();
      if (decision !== "open" || !report || openRef.current) return;
      // Marked before the panel is up: a crash or a force-quit with the panel
      // open then leaves the mark behind, and the panel does not come back on
      // every reload until someone manages to close it cleanly.
      markShown();
      setOpen(true);
    };

    // The hold on the store is what sends a full report request to the
    // providers, so it is taken only once this arrival can still end in the
    // panel opening: a session already shown this launch does not cost a round.
    const watch = (mine: number) => {
      void currentWindow().then((w) => {
        if (mine !== arrival || !w) return;
        if (shownThisLaunchFor(launchStore(), w.target_session_ymd)) return;
        release = retainBriefing();
        timer = setInterval(decide, DECIDE_EVERY_MS);
        decide();
      });
    };

    const arrive = () => {
      settle();
      const mine = ++arrival;
      arrivedAt = performance.now();
      engaged = false;
      // The cheap questions first.
      if (!briefingAutoOpen() || isDemoMode() || viewRef.current !== "dashboard" || openRef.current) return;
      if (hasPaperAccount()) {
        watch(mine);
        return;
      }
      // A book can still be on its way. On a fresh machine, or after cleared
      // storage, it is restored from the cloud a few hundred milliseconds after
      // the dashboard mounts, and reading "no account" once would cost this
      // launch's showing. The wait stays inside this arrival: a book that lands
      // an hour later must not lay the panel over whatever the reader is doing
      // by then.
      unwatchAccount = subscribePaperAccount(() => {
        if (mine !== arrival || !hasPaperAccount()) return;
        unwatchAccount?.();
        unwatchAccount = null;
        if (openRef.current || engaged || performance.now() - arrivedAt > AUTO_OPEN_DEADLINE_MS) return;
        watch(mine);
      });
    };

    const onEngage = (event: Event) => {
      // A bare modifier is not the reader doing something: Shift goes down on
      // the way to a shortcut, and Alt or Meta on the way to another window.
      if (event instanceof KeyboardEvent && ["Shift", "Control", "Alt", "Meta"].includes(event.key)) return;
      engaged = true;
    };
    const onResize = () => {
      lastResizeAt = performance.now();
    };
    const onBlur = () => {
      blurredAt = Date.now();
    };
    const onFocus = () => {
      const away = blurredAt === null ? 0 : Date.now() - blurredAt;
      blurredAt = null;
      if (away >= RETURN_AFTER_MS) arrive();
    };

    const passive = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", onEngage, passive);
    window.addEventListener("keydown", onEngage, passive);
    window.addEventListener("wheel", onEngage, passive);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onBlur);
    window.addEventListener("focus", onFocus);
    arrive();

    return () => {
      arrival += 1;
      settle();
      window.removeEventListener("pointerdown", onEngage, passive);
      window.removeEventListener("keydown", onEngage, passive);
      window.removeEventListener("wheel", onEngage, passive);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onBlur);
      window.removeEventListener("focus", onFocus);
    };
  }, []);

  return (
    <BriefingBoundary onClose={close}>
      <BriefingPanel open={open} onClose={close} masked={masked} />
    </BriefingBoundary>
  );
}

/**
 * The handover briefing's one mount point. It owns whether the panel is up:
 * by itself once per launch, whatever the phase, from the dashboard card, and
 * with Shift+M from anywhere. While the feature is off it renders nothing and
 * listens to nothing.
 */
export default function BriefingHost({ masked, view }: Props) {
  if (!briefingEnabled()) return null;
  return <BriefingHostInner masked={masked} view={view} />;
}
