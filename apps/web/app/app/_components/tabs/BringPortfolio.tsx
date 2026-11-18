"use client";

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AlertCircle, Check, ChevronRight, ImageUp, Info, Landmark, Loader2, Lock, Play, X } from "lucide-react";
import type { PortfolioSources } from "@/lib/portfolio-client";
import { PAPER_DEFAULT_NAME, balanceError, formatBalanceInput, parseBalance } from "@/lib/paper-account";
import { ACTION_LABEL, droppedImage, shownTickers, stageView, type PortfolioStage, type StageAction } from "@/lib/workspace/bring-portfolio";
import { SERIF } from "../parts";

/**
 * "Bring your portfolio": what sits in front of the frosted backdrop after
 * the setup card's "Get started" (OwnCard.tsx runs the flows; the steps and
 * their wording are lib/workspace/bring-portfolio.ts). No panel background:
 * the blur is the background, and only the rows and the info box have their
 * own border and fill. A dropped image anywhere on the overlay goes to the
 * screenshot reader.
 *
 * Trading through SnapTrade is planned, so the copy makes no promise either way
 * about trades: it neither offers trading (not built yet) nor rules it out. Today's
 * import is one-time and read-only (app/api/portfolio/broker/holdings revokes the
 * grant after reading).
 */

export type PortfolioOption = "broker" | "screenshot" | "demo";

const FOCUS_RING = "outline-none focus-visible:ring-2 focus-visible:ring-line/30";
const PRIMARY = `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg bg-solid px-3.5 text-fs-13 font-medium text-solid-ink transition-colors hover:bg-solid-hover ${FOCUS_RING}`;
const SECONDARY = `inline-flex h-8 shrink-0 items-center rounded-lg px-3.5 text-fs-13 font-medium text-fore transition-colors hover:bg-line/[0.06] ${FOCUS_RING}`;

export function BringPortfolio({
  stage,
  sources,
  preview,
  onPick,
  onAction,
  onClose,
  onDropImage,
  onCreatePaper,
}: {
  stage: PortfolioStage;
  sources: PortfolioSources | null;
  preview: boolean;
  onPick: (option: PortfolioOption) => void;
  onAction: (action: StageAction) => void;
  onClose: () => void;
  onDropImage: (file: File) => void;
  /** The paper form's submit; throws with a message to show under the balance. */
  onCreatePaper: (balance: number, name: string | null) => Promise<void>;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [dragging, setDragging] = useState(false);
  const busy = stage.step === "opening" || stage.step === "reading";
  const brokerOn = preview || sources?.broker === true;
  const shotOn = preview || sources?.screenshot === true;

  // A new step: if its change took focus away (the button that had it is gone), focus the step's first control.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel || panel.contains(document.activeElement)) return;
    panel.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
  }, [stage]);

  // Done closes by itself after a moment.
  const autoClose = stage.step === "choose" ? undefined : stageView(stage).autoCloseMs;
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  useEffect(() => {
    if (!autoClose) return;
    const t = setTimeout(() => onActionRef.current("done"), autoClose);
    return () => clearTimeout(t);
  }, [autoClose, stage]);

  // An image dropped anywhere while the panel is open goes to the screenshot reader (and never opens in the tab).
  const dropRef = useRef(onDropImage);
  dropRef.current = onDropImage;
  const canDrop = !busy && stage.step !== "done" && stage.step !== "paper" && shotOn;
  useEffect(() => {
    const files = (e: DragEvent) => Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === "file");
    const over = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = canDrop ? "copy" : "none";
      setDragging(canDrop);
    };
    const leave = (e: DragEvent) => {
      if (!e.relatedTarget) setDragging(false);
    };
    const drop = (e: DragEvent) => {
      if (!files(e)) return;
      e.preventDefault();
      setDragging(false);
      const file = droppedImage(Array.from(e.dataTransfer?.files ?? []));
      if (canDrop && file) dropRef.current(file);
    };
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, [canDrop]);

  return (
    <div ref={panelRef} className="w-[min(460px,calc(100vw-32px))] text-fore">
      <div className="flex items-start gap-4">
        <div className="min-w-0 flex-1">
          <h2 className="text-fs-28 leading-fs-34 text-fore" style={{ fontFamily: SERIF }}>
            Bring your portfolio
          </h2>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          title="Close"
          className={`-mr-1.5 -mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-quiet transition-colors hover:bg-line/[0.06] hover:text-fore ${FOCUS_RING}`}
        >
          <X width={18} height={18} strokeWidth={1.75} aria-hidden />
        </button>
      </div>

      <div className="mt-6">
        {stage.step === "choose" ? (
          <div className="flex flex-col gap-2.5">
            <OptionRow
              autoFocus
              accent
              icon={<Landmark width={20} height={20} strokeWidth={1.75} aria-hidden />}
              title="Connect your broker"
              pill="Best"
              text={brokerOn ? "Robinhood, Schwab, IBKR and more." : "Not available yet."}
              disabled={!brokerOn}
              onClick={() => onPick("broker")}
            />
            <OptionRow
              icon={<ImageUp width={20} height={20} strokeWidth={1.75} aria-hidden />}
              title="Drop a screenshot"
              text={shotOn ? "Falcon reads your positions. Nothing to log into." : "Not available yet."}
              disabled={!shotOn}
              highlighted={dragging}
              onClick={() => onPick("screenshot")}
            />
            <OptionRow
              icon={<Play width={18} height={18} strokeWidth={1.75} aria-hidden />}
              title="Look around first"
              text="Explore Falcon with a paper portfolio."
              onClick={() => onPick("demo")}
            />
          </div>
        ) : stage.step === "paper" ? (
          <PaperForm onCreate={onCreatePaper} onBack={() => onAction("back")} />
        ) : (
          <StageBlock stage={stage} onAction={onAction} dragging={dragging} />
        )}
      </div>

      <div className={`mt-4 rounded-2xl ${stage.step === "paper" || (stage.step === "done" && stage.paper) ? "hidden" : ""} border border-line/[0.06] bg-line/[0.035] px-4 py-3.5`}>
        <p className="flex items-center gap-2 text-fs-13 font-semibold leading-fs-20 text-fore">
          <Lock width={14} height={14} strokeWidth={2} className="shrink-0 text-quiet" aria-hidden />
          You stay in control
        </p>
        <ul className="mt-2.5 grid grid-cols-2 gap-x-4 gap-y-1.5 text-fs-13 leading-fs-20 text-fore-3">
          <Can yes>See positions and balances</Can>
          <Can>Move or withdraw money</Can>
        </ul>
        <p className="mt-2.5 text-fs-12 leading-fs-18 text-quiet">Secured by SnapTrade. Falcon never sees your broker login.</p>
      </div>
    </div>
  );
}

function OptionRow({
  icon,
  title,
  pill,
  text,
  accent = false,
  highlighted = false,
  disabled = false,
  autoFocus = false,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  pill?: string;
  text: string;
  accent?: boolean;
  highlighted?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  onClick: () => void;
}) {
  const tone = accent
    ? "border-solid/80 bg-raised hover:border-solid"
    : highlighted
      ? "border-iris/45 bg-iris/[0.07]"
      : "border-line/[0.10] bg-raised/60 hover:border-line/[0.16] hover:bg-raised";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-autofocus={autoFocus && !disabled ? "" : undefined}
      className={`group flex w-full items-center gap-4 rounded-2xl border px-4 py-4 text-left transition-colors disabled:cursor-default disabled:opacity-50 ${tone} ${FOCUS_RING}`}
    >
      <span
        className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${accent ? "bg-solid text-solid-ink" : "bg-line/[0.05] text-fore-3"}`}
      >
        {icon}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-center gap-2">
          <span className="text-fs-15 font-semibold leading-fs-22 text-fore">{title}</span>
          {pill ? <span className="rounded-full bg-solid px-2 py-0.5 text-fs-11 font-medium leading-fs-14 text-solid-ink">{pill}</span> : null}
        </span>
        <span className="mt-0.5 block text-fs-13 leading-fs-20 text-quiet">{text}</span>
      </span>
      <ChevronRight width={18} height={18} strokeWidth={1.75} className="shrink-0 text-faint transition-transform group-hover:translate-x-0.5" aria-hidden />
    </button>
  );
}

function Can({ yes = false, children }: { yes?: boolean; children: ReactNode }) {
  return (
    <li className="flex items-center gap-2">
      {yes ? (
        <Check width={14} height={14} strokeWidth={2.25} className="shrink-0 text-up" aria-hidden />
      ) : (
        <X width={14} height={14} strokeWidth={2.25} className="shrink-0 text-down" aria-hidden />
      )}
      <span>
        <span className="sr-only">{yes ? "Can: " : "Cannot: "}</span>
        {children}
      </span>
    </li>
  );
}

function StageBlock({ stage, onAction, dragging }: { stage: Exclude<PortfolioStage, { step: "choose" }>; onAction: (a: StageAction) => void; dragging: boolean }) {
  const view = stageView(stage);
  const tickers = stage.step === "done" ? shownTickers(stage.tickers) : null;
  const icon =
    view.tone === "busy" ? (
      <Loader2 width={20} height={20} strokeWidth={2} className="animate-spin" aria-hidden />
    ) : view.tone === "ok" ? (
      <Check width={20} height={20} strokeWidth={2.25} aria-hidden />
    ) : view.tone === "problem" ? (
      <AlertCircle width={20} height={20} strokeWidth={1.75} aria-hidden />
    ) : (
      <Info width={20} height={20} strokeWidth={1.75} aria-hidden />
    );
  const tile = view.tone === "ok" ? "bg-up/[0.12] text-up" : view.tone === "problem" ? "bg-down/[0.10] text-down" : "bg-line/[0.05] text-fore-3";
  return (
    <div
      className={`rounded-2xl border px-4 py-4 transition-colors ${dragging ? "border-iris/45 bg-iris/[0.07]" : "border-line/[0.10] bg-raised/60"}`}
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start gap-4">
        <span className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl ${tile}`}>{icon}</span>
        <div className="min-w-0 flex-1 pt-0.5">
          <p className="text-fs-15 font-semibold leading-fs-22 text-fore">{view.title}</p>
          <p className="mt-0.5 text-fs-13 leading-fs-20 text-quiet">{view.body}</p>
          {tickers?.shown.length ? (
            <ul className="mt-2.5 flex flex-wrap gap-1.5" aria-label="Tickers added">
              {tickers.shown.map((t) => (
                <li key={t} className="inline-flex h-6 items-center rounded-full bg-line/[0.06] px-2.5 text-fs-12 font-medium leading-none text-fore">
                  {t}
                </li>
              ))}
              {tickers.more ? <li className="inline-flex h-6 items-center px-1 text-fs-12 leading-none text-quiet">and {tickers.more} more</li> : null}
            </ul>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap justify-end gap-2">
        {[...view.actions].reverse().map((a) => {
          const primary = a === view.actions[0];
          return (
            <button
              key={`${stage.step}-${a}`}
              type="button"
              data-autofocus={primary ? "" : undefined}
              onClick={() => onAction(a)}
              className={primary && a !== "cancel" && a !== "back" ? PRIMARY : SECONDARY}
            >
              {ACTION_LABEL[a]}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const FIELD_LABEL = "block text-fs-13 font-medium leading-fs-20 text-fore";
const FIELD_INPUT =
  "mt-1.5 block w-full border-0 border-b bg-transparent px-0 pb-2 pt-1 text-fs-17 leading-fs-24 text-fore outline-none transition-colors placeholder:text-faint";
const FIELD_LINE = "border-line/[0.16] focus:border-fore";
const FIELD_LINE_ERROR = "border-down/70 focus:border-down";

/**
 * "Look around first": a paper account with a starting cash balance (USD,
 * $1,000 to $10,000,000) and an optional name. No box or fill: labels above,
 * the value on a thin line, the blur behind as the background.
 */
function PaperForm({ onCreate, onBack }: { onCreate: (balance: number, name: string | null) => Promise<void>; onBack: () => void }) {
  const [balance, setBalance] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const errorId = "paper-balance-error";

  const submit = async () => {
    const problem = balanceError(balance);
    if (problem) {
      setError(problem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onCreate(parseBalance(balance)!, name.trim() || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Your paper account couldn't be created.");
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      className="flex flex-col"
      aria-label="Create a paper account"
    >
      <p className="text-fs-14 leading-fs-21 text-quiet">Start with cash and explore Falcon. Nothing here touches a real account.</p>
      <div className="mt-7">
        <label htmlFor="paper-balance" className={FIELD_LABEL}>
          Starting balance
        </label>
        <input
          id="paper-balance"
          data-autofocus=""
          inputMode="decimal"
          autoComplete="off"
          placeholder="$100,000"
          value={balance ? `$${balance}` : ""}
          onChange={(e) => {
            setBalance(formatBalanceInput(e.target.value));
            if (error) setError(null);
          }}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          className={`${FIELD_INPUT} tabular-nums ${error ? FIELD_LINE_ERROR : FIELD_LINE}`}
        />
        {error ? (
          <p id={errorId} role="alert" className="mt-2 text-fs-13 leading-fs-20 text-down">
            {error}
          </p>
        ) : (
          <p className="mt-2 text-fs-12 leading-fs-18 text-quiet">US dollars, from $1,000 to $10,000,000.</p>
        )}
      </div>
      <div className="mt-7">
        <label htmlFor="paper-name" className={FIELD_LABEL}>
          Account name <span className="font-normal text-quiet">(optional)</span>
        </label>
        <input
          id="paper-name"
          autoComplete="off"
          maxLength={40}
          placeholder={PAPER_DEFAULT_NAME}
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={`${FIELD_INPUT} ${FIELD_LINE}`}
        />
      </div>
      <button
        type="submit"
        disabled={busy}
        aria-busy={busy || undefined}
        className={`mt-9 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-solid text-fs-15 font-medium text-solid-ink transition-colors hover:bg-solid-hover disabled:opacity-60 ${FOCUS_RING}`}
      >
        {busy ? <Loader2 width={16} height={16} strokeWidth={2} className="animate-spin" aria-hidden /> : null}
        Create paper account
      </button>
      <button type="button" onClick={onBack} className={`mx-auto mt-3 rounded-md px-2 py-1 text-fs-13 text-quiet transition-colors hover:text-fore ${FOCUS_RING}`}>
        Back
      </button>
    </form>
  );
}
