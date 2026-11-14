"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowLeftRight,
  CalendarRange,
  Check,
  Clock,
  Copy,
  Eraser,
  GitCommitHorizontal,
  History,
  MoreHorizontal,
  PanelRight,
  Paperclip,
  Pencil,
  Play,
  Plus,
  SlidersHorizontal,
  Timer,
  Trash2,
  X,
} from "lucide-react";
import { STARTERS, eventStudyFromHistory, hasNoHistorySource, validateSpec, type QualityReport, type StrategySpecV2 } from "@falcon/backtest";
import { cardExplain } from "@falcon/ripple";
import { sortByTime } from "@/lib/workspace/feed";
import { tabId } from "@/lib/workspace/layout";
import {
  getAudit,
  getReview,
  getRun,
  runKey,
  setSpec,
  startAudit,
  startReview,
  startRun,
  updateStrategy,
  useRunsVersion,
  type RunState,
  type SavedStrategy,
  type SpecVersion,
} from "@/lib/workspace/strategies";
import { useWorkspace } from "../context";
import { EmptyState, MONO, Panel, timeAgo } from "../parts";
import { AssistantLabel, ConversationThread, useStrategyChat, type StrategyChat, type TurnApply } from "../strategy/Conversation";
import { HistoryStudyView } from "../strategy/HistoryStudy";
import { Interpretation } from "../strategy/Interpretation";
import { ResultsV2 } from "../strategy/ResultsV2";
import { StrategyContext } from "../strategy/StrategyContext";
import { SOURCE, Versions } from "../strategy/Versions";
import { CardBody, CardHeader, Dropdown, ICON_BUTTON, IconButton, SelectorLabel, TextButton, selectorClass, type Icon, type MenuGroup } from "../shell/ui";
import { observeSettledSize } from "../shell/resize";

/**
 * Strategy Lab v2 (docs/design/strategy-lab-v2.md, 3.1-3.3) in two panes:
 * on the left the conversation and the numbered rules (the run is gated on
 * them), on the right the result for the chosen version (evidence label,
 * curves, flags, trades). The composer at the bottom sends to the
 * conversation; Run runs the backtest. Saved in this browser.
 */

/** The last finished run shown per strategy, so an edit does not blank the results. */
const shownKey = new Map<string, string>();
/** When each run started, to show how long it took. */
const runStarted = new Map<string, number>();

function noteRun(key: string, run: RunState | null) {
  // A retry restarts the clock; keep the first start.
  if (run?.status === "running" && (!run.retrying || !runStarted.has(key))) runStarted.set(key, run.startedAt);
}

function runMs(key: string | null): number | null {
  const run = getRun(key);
  const start = key ? runStarted.get(key) : undefined;
  if (run?.status !== "done" || start === undefined || run.finishedAt < start) return null;
  return run.finishedAt - start;
}

function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.round((now - since) / 1000));
}

/** True while the element is narrower than `px` (a split pane, say): Strategy Lab then shows one inner pane at a time. */
function useNarrow(px: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    return observeSettledSize(el, (rect) => setNarrow(rect.width < px));
  }, [px]);
  return [ref, narrow] as const;
}

export function StrategyTab({ strategyId, headerExtra }: { strategyId: string; headerExtra?: React.ReactNode }) {
  const { strategies, newStrategy } = useWorkspace();
  const s = strategies.find((x) => x.id === strategyId);
  if (!s) {
    return (
      <>
        <CardHeader title="Strategy Lab" actions={headerExtra} />
        <CardBody>
          <div className="mx-auto w-full max-w-[560px] px-7 py-16">
            <EmptyState title="This strategy is no longer saved">
              <button
                type="button"
                onClick={() => newStrategy()}
                className="inline-flex h-8 items-center rounded-lg border border-black/10 px-3 text-[12.5px] text-[#1d1b1b] outline-none transition-colors hover:bg-[#efefec] focus-visible:border-black/40"
              >
                New strategy
              </button>
            </EmptyState>
          </div>
        </CardBody>
      </>
    );
  }
  return <StrategyView key={s.id} s={s} headerExtra={headerExtra} />;
}

type RightMode = "result" | "history" | "details";

function StrategyView({ s, headerExtra }: { s: SavedStrategy; headerExtra?: React.ReactNode }) {
  const { userId, feed, strategies, openSighting, openStrategy, newStrategy, deleteStrategy, closeTab, backtestSighting } = useWorkspace();
  const update = useCallback((patch: Partial<SavedStrategy>) => updateStrategy(userId, s.id, patch), [s.id, userId]);
  useRunsVersion();

  const valid = useMemo(() => validateSpec(s.spec).ok, [s.spec]);
  const key = runKey(s.spec);
  const run = getRun(key);
  noteRun(key, run);
  const lastKey = run?.status === "done" ? key : (shownKey.get(s.id) ?? null);
  const last = getRun(lastKey);
  const shown = last?.status === "done" ? last.result : null;
  const stale = shown !== null && lastKey !== key;
  const running = run?.status === "running";
  const elapsed = useElapsed(running ? run.startedAt : null);

  const go = useCallback(
    (opts: { countTrial: boolean; force?: boolean; spec?: StrategySpecV2 }) => {
      const spec = opts.spec ?? s.spec;
      if (!validateSpec(spec).ok) return;
      const trials = s.trials + (opts.countTrial ? 1 : 0);
      if (opts.countTrial) update({ trials, confirmed: true });
      const k = runKey(spec);
      void startRun(spec, { trials: Math.max(1, trials), force: opts.force }).then((r) => {
        if (r.status === "done") {
          shownKey.set(s.id, k);
          update({ ranAt: Date.now(), autorun: false });
          if (r.result.spec.portfolio.mode !== "event_study") void startAudit(spec, r.result.quality);
        } else if (s.autorun) update({ autorun: false });
      });
    },
    [s.autorun, s.id, s.spec, s.trials, update],
  );

  // A reopened tab that ran before shows its result again (prices are cached; not a new trial).
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current) return;
    opened.current = true;
    if (s.ranAt && s.confirmed && valid && !run) go({ countTrial: false });
    // Once, on open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Backtest this: run as soon as the tab opens.
  useEffect(() => {
    if (s.autorun && valid && run?.status !== "running" && run?.status !== "done") go({ countTrial: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.autorun, key]);

  const card = s.origin.kind === "sighting" ? (feed?.cards.find((c) => c.id === (s.origin as { cardId: string }).cardId) ?? null) : null;
  const studies = useMemo(() => (card ? eventStudyFromHistory(card) : []), [card]);
  const noHistory = s.origin.kind === "sighting" && !s.origin.hasHistory && (card ? hasNoHistorySource(card) : true);

  const onApply = (a: TurnApply) => {
    if (a.spec) {
      setSpec(userId, s.id, a.spec, "chat", {
        conversation: a.conversation,
        text: a.text ?? s.text,
        origin: s.origin.kind === "blank" ? { kind: "text" } : s.origin,
      });
    } else update({ conversation: a.conversation });
  };
  const chat = useStrategyChat(s, onApply);

  const isBlank = s.origin.kind === "blank" && s.versions.length < 2 && !s.confirmed;
  /** A starter fills a blank strategy, or opens as a new one. */
  const startFrom = (id: string) => {
    const t = STARTERS.find((x) => x.id === id);
    if (!t) return;
    if (!isBlank) {
      newStrategy({ spec: structuredClone(t.spec), text: t.text, origin: { kind: "template", templateId: t.id } });
      return;
    }
    setSpec(userId, s.id, structuredClone(t.spec), "template", {
      origin: { kind: "template", templateId: t.id },
      text: t.text,
      conversation: { ...s.conversation, intent: t.text, pending: null, answers: [], assumptions: [], notExpressible: [], note: null },
    });
  };

  const onSpec = (spec: StrategySpecV2, source: SpecVersion["source"]) => {
    setSpec(userId, s.id, spec, source);
    // A slider release re-runs a strategy that already ran (design 2.6); Tier B then refreshes.
    if (source === "slider" && s.confirmed && validateSpec(spec).ok) go({ countTrial: true, spec });
  };

  const [rootRef, narrow] = useNarrow(880);
  const [narrowView, setNarrowView] = useState<"chat" | "result">("chat");
  const runNow = () => {
    if (!valid || running || !chat.hasSpec) return;
    if (narrow) setNarrowView("result");
    go({ countTrial: true, force: run?.status === "error" });
  };

  const onExplain = (quality: QualityReport) => void startReview(s.spec, quality, Math.max(1, s.trials));
  const showConversation = s.origin.kind !== "sighting";

  /* ------------------------------------------------ panes and versions */
  const [showRules, setShowRules] = useState(true);
  const [rightMode, setRightMode] = useState<RightMode>("result");
  const [resultsOpen, setResultsOpen] = useState(true);
  const [pickedV, setPickedV] = useState<number | null>(null);

  const currentV = useMemo(() => [...s.versions].reverse().find((v) => runKey(v.spec) === key)?.v ?? s.versions[s.versions.length - 1]?.v ?? 1, [key, s.versions]);
  const picked = pickedV !== null && pickedV !== currentV ? (s.versions.find((v) => v.v === pickedV) ?? null) : null;
  const pickedKey = picked ? runKey(picked.spec) : null;
  const pickedRun = getRun(pickedKey);
  const pickedResult = pickedRun?.status === "done" ? pickedRun.result : null;

  const displayed = picked ? pickedResult : shown;
  const displayedKey = picked ? pickedKey : lastKey;

  const versionGroups = (): MenuGroup[] => {
    const list = [...s.versions].reverse();
    const viewing = picked ? picked.v : currentV;
    const item = (v: SpecVersion) => ({
      id: String(v.v),
      label: `Version ${v.v}`,
      text: `v${v.v} version ${v.v}`,
      description: `${SOURCE[v.source]} · ${timeAgo(new Date(v.at).toISOString())}${getRun(runKey(v.spec))?.status === "done" ? " · has a result" : ""}`,
      selected: v.v === viewing,
    });
    return [
      { label: "Current", items: list.filter((v) => v.v === currentV).map(item) },
      { label: "Earlier versions", items: list.filter((v) => v.v !== currentV).map(item) },
    ];
  };

  const strategyGroups = (): MenuGroup[] => [
    {
      label: "Your strategies",
      items: [...strategies]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .map((x) => ({
          id: x.id,
          label: x.rules.name.trim() || "Untitled strategy",
          description: `Edited ${timeAgo(new Date(x.updatedAt).toISOString())}`,
          selected: x.id === s.id,
        })),
    },
    { label: "Starters", items: STARTERS.map((t) => ({ id: `starter:${t.id}`, label: t.spec.name, text: t.spec.name, description: t.text })) },
    { items: [{ id: "new", label: "New blank strategy", icon: Plus }] },
  ];

  const name = s.spec.name || "Untitled strategy";
  const showLeft = !narrow || narrowView === "chat";
  const showRight = narrow ? narrowView === "result" : resultsOpen;

  return (
    <div ref={rootRef} className="flex min-h-0 min-w-0 flex-1 flex-col" role="region" aria-label={`Strategy Lab: ${name}`}>
      <CardHeader
        title="Strategy Lab"
        actions={
          <>
            {narrow ? (
              <div role="tablist" aria-label="Strategy Lab panes" className="mr-1 flex rounded-lg bg-black/[0.05] p-0.5">
                {(["chat", "result"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="tab"
                    aria-selected={narrowView === v}
                    onClick={() => setNarrowView(v)}
                    className={`h-7 rounded-md px-2.5 text-[13px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-black/20 ${
                      narrowView === v ? "bg-white font-medium text-[#1d1b1b] shadow-[0_1px_2px_rgba(0,0,0,0.08)]" : "text-[#767676] hover:text-[#1d1b1b]"
                    }`}
                  >
                    {v === "chat" ? "Chat" : "Result"}
                  </button>
                ))}
              </div>
            ) : null}
            <TextButton icon={Eraser} onClick={chat.clear} disabled={!chat.canClear} title="Clear this visit's messages, notes and open questions">
              Clear
            </TextButton>
            <TextButton
              icon={History}
              pressed={resultsOpen && rightMode === "history"}
              onClick={() => {
                setResultsOpen(true);
                if (narrow) setNarrowView("result");
                setRightMode((m) => (m === "history" ? "result" : "history"));
              }}
            >
              History
            </TextButton>
            {!resultsOpen && !narrow ? (
              <TextButton icon={PanelRight} onClick={() => setResultsOpen(true)}>
                Results
              </TextButton>
            ) : null}
            {headerExtra}
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        {/* Left: the conversation and the rules. */}
        {showLeft ? (
        <Pane
          label="Conversation"
          className={showRight ? "border-r border-black/[0.08]" : ""}
          header={
            <LeftHeader
              s={s}
              name={name}
              groups={strategyGroups}
              showRules={showRules}
              onPick={(id) => {
                if (id === "new") newStrategy();
                else if (id.startsWith("starter:")) startFrom(id.slice("starter:".length));
                else if (id !== s.id) openStrategy(id);
              }}
              onRename={(n) => setSpec(userId, s.id, { ...s.spec, name: n.slice(0, 80) }, "settings")}
              onToggleRules={() => setShowRules((v) => !v)}
              onDuplicate={() =>
                newStrategy({
                  spec: { ...s.spec, name: `${s.spec.name} copy`.slice(0, 80) },
                  text: s.text,
                  conversation: { ...s.conversation, pending: null, note: null },
                  origin: s.origin.kind === "sighting" ? { kind: "text" } : s.origin,
                  confirmed: false,
                })
              }
              onDelete={() => deleteStrategy(s.id)}
              onClose={() => closeTab(tabId({ kind: "strategy", strategyId: s.id }))}
            />
          }
          footer={
            <>
              <Meta icon={GitCommitHorizontal} title="Current version">
                v{currentV}
              </Meta>
              <Meta icon={Play} title="Runs of this strategy (each is a trial)">
                {s.trials} {s.trials === 1 ? "run" : "runs"}
              </Meta>
              <Meta icon={Clock} title="Last edited">
                {timeAgo(new Date(s.updatedAt).toISOString())}
              </Meta>
            </>
          }
        >
          <div className="flex flex-col gap-5 px-5 py-5">
            {s.origin.kind === "sighting" ? (
              <p className="text-[13px] leading-[20px] text-[#767676]">
                {s.origin.hasHistory ? `Tests past ${s.origin.basis} on the companies the` : "Past events like the"}{" "}
                <button
                  type="button"
                  onClick={() => openSighting((s.origin as { cardId: string }).cardId)}
                  className="text-[#4b4b48] underline decoration-black/20 underline-offset-2 outline-none hover:text-[#1d1b1b] focus-visible:decoration-black/60"
                >
                  {s.origin.eventTicker} sighting
                </button>{" "}
                {s.origin.hasHistory ? "reaches." : "on the companies it reaches."}
              </p>
            ) : null}
            {showConversation ? <ConversationThread s={s} chat={chat} onStarter={startFrom} /> : null}
            {(s.origin.kind !== "blank" || s.versions.length > 1) && showRules ? (
              <div className="flex flex-col gap-1">
                <AssistantLabel />
                <Interpretation
                  spec={s.spec}
                  assumptions={s.conversation.assumptions}
                  notExpressible={s.conversation.notExpressible}
                  confirmed={s.confirmed}
                  running={running}
                  onSpec={onSpec}
                  onRun={runNow}
                />
              </div>
            ) : null}
          </div>
        </Pane>
        ) : null}

        {/* Right: the result for the chosen version. */}
        {showRight ? (
          <Pane
            label="Result"
            header={
              <>
                <Dropdown
                  label="Choose a version"
                  searchPlaceholder="Select a version..."
                  width={260}
                  groups={versionGroups}
                  onSelect={(id) => {
                    const n = Number(id);
                    setPickedV(n === currentV ? null : n);
                    setRightMode("result");
                  }}
                  button={({ open, props }) => (
                    <button {...props} className={selectorClass(open)}>
                      <SelectorLabel>{picked ? `Version ${picked.v}` : `Result, v${currentV}`}</SelectorLabel>
                    </button>
                  )}
                />
                <div className="flex shrink-0 items-center gap-0.5">
                  <Dropdown
                    label="More result actions"
                    kind="menu"
                    align="right"
                    width={220}
                    groups={() => [
                      {
                        items: [
                          ...(chat.hasSpec && valid && !running ? [{ id: "run", label: s.confirmed ? "Run again" : "Run these rules", icon: Play }] : []),
                          ...(displayed ? [{ id: "copy", label: "Copy run ID", icon: Copy }] : []),
                          { id: "history", label: "Version history", icon: History },
                        ],
                      },
                    ]}
                    onSelect={(id) => {
                      if (id === "run") runNow();
                      else if (id === "copy" && displayed) void navigator.clipboard?.writeText(`${displayed.specHash}#${displayed.provenance.trial}`).catch(() => undefined);
                      else setRightMode("history");
                    }}
                    button={({ open, props }) => (
                      <button {...props} title="More" className={`${ICON_BUTTON} ${open ? "bg-black/[0.06] text-[#1d1b1b]" : ""}`}>
                        <MoreHorizontal width={16} height={16} strokeWidth={1.75} aria-hidden />
                      </button>
                    )}
                  />
                  <IconButton
                    label={rightMode === "details" ? "Hide strategy details" : "Strategy details"}
                    icon={SlidersHorizontal}
                    pressed={rightMode === "details"}
                    onClick={() => setRightMode((m) => (m === "details" ? "result" : "details"))}
                  />
                  {narrow ? null : <IconButton label="Hide results" icon={X} onClick={() => setResultsOpen(false)} />}
                </div>
              </>
            }
            footer={displayed ? <RunMeta result={displayed} ms={runMs(displayedKey)} /> : <span>No result yet</span>}
          >
            <div className="flex flex-col gap-5 px-5 py-5">
              {rightMode === "history" ? (
                s.versions.length > 1 ? (
                  <Versions
                    versions={s.versions}
                    current={s.spec}
                    onRestore={(v) => {
                      setSpec(userId, s.id, v.spec, v.source);
                      setPickedV(null);
                    }}
                  />
                ) : (
                  <EmptyState title="Only one version so far. Each change by chat, slider or formula adds one." />
                )
              ) : rightMode === "details" ? (
                <StrategyContext strategyId={s.id} />
              ) : picked ? (
                <>
                  <div className="flex items-center justify-between gap-3 rounded-lg border border-black/[0.08] bg-[#f8f8f6] px-3.5 py-2">
                    <span className="text-[13px] text-[#4b4b48]">Showing version {picked.v}, not the current rules.</span>
                    <span className="flex shrink-0 items-center gap-0.5">
                      <TextButton
                        onClick={() => {
                          setSpec(userId, s.id, picked.spec, picked.source);
                          setPickedV(null);
                        }}
                      >
                        Restore
                      </TextButton>
                      <TextButton onClick={() => setPickedV(null)}>Back to current</TextButton>
                    </span>
                  </div>
                  {pickedResult ? (
                    <ResultsV2
                      name={picked.spec.name || "This strategy"}
                      result={pickedResult}
                      stale={false}
                      audit={getAudit(pickedKey)}
                      review={getReview(pickedKey)}
                      onExplain={(quality) => void startReview(picked.spec, quality, Math.max(1, s.trials))}
                    />
                  ) : (
                    <EmptyState title={`Version ${picked.v} has no result in this visit. Restore it to run it.`} />
                  )}
                </>
              ) : (
                <>
                  {studies.length ? <HistoryStudyView studies={studies} eventTicker={s.origin.kind === "sighting" ? s.origin.eventTicker : ""} /> : null}
                  {noHistory && !studies.length ? (
                    <Panel className="px-5 py-4">
                      <p className="text-[13px] leading-[20px] text-[#4b4b48]">
                        No history source yet for {s.origin.kind === "sighting" ? `${s.origin.eventTicker} events` : "events"} of this type (for example monthly revenue reports). The past
                        record is not in the backtest data, so there is nothing to measure. Earnings Sightings test against the full earnings record.
                      </p>
                    </Panel>
                  ) : null}

                  <RunStatus
                    running={running}
                    retrying={running && run.retrying}
                    elapsed={elapsed}
                    error={run?.status === "error" ? run : null}
                    tickers={s.spec.universe.kind === "static" ? s.spec.universe.tickers.length : 11}
                  />

                  {shown ? (
                    <ResultsV2 name={name === "Untitled strategy" ? "This strategy" : name} result={shown} stale={stale} audit={getAudit(lastKey)} review={getReview(lastKey)} onExplain={onExplain} />
                  ) : !running && !noHistory ? (
                    <div className="flex flex-col items-center px-4 py-10 text-center">
                      <p className="max-w-[400px] text-[14px] leading-[21px] text-[#767676]">
                        {isBlank
                          ? "The result shows here: how much evidence the past data gives, then the curves, flags and trades."
                          : "Read the numbered rules, adjust the parameters if needed, then press Run. The result opens with how much evidence the past data gives, followed by the curves, flags and trades."}
                      </p>
                    </div>
                  ) : null}
                </>
              )}
            </div>
          </Pane>
        ) : null}
      </div>

      <Composer
        s={s}
        chat={chat}
        canRun={chat.hasSpec && valid && !running}
        running={running}
        onRun={runNow}
        onStarter={startFrom}
        onNew={() => newStrategy()}
        sightings={feed?.cards ?? []}
        onSighting={backtestSighting}
      />
    </div>
  );
}

/* ------------------------------------------------------------- panes */

function Pane({ label, header, footer, children, className = "" }: { label: string; header: React.ReactNode; footer?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <section aria-label={label} className={`flex min-w-0 flex-1 basis-0 flex-col ${className}`}>
      <div className="flex h-[52px] shrink-0 items-center justify-between gap-2 px-3">{header}</div>
      <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      {footer ? (
        <div className="flex h-9 shrink-0 items-center justify-center gap-4 px-4 text-[11.5px] text-[#9a9a9a]" style={{ fontFamily: MONO }}>
          {footer}
        </div>
      ) : null}
    </section>
  );
}

function Meta({ icon: I, title, children }: { icon: Icon; title: string; children: React.ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap" title={title}>
      <I width={12} height={12} strokeWidth={1.75} aria-hidden />
      <span className="sr-only">{title}: </span>
      {children}
    </span>
  );
}

function RunMeta({ result, ms }: { result: { specHash: string; provenance: { trial: number }; metrics: { tradeCount: number }; period: { start: string; end: string } }; ms: number | null }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(t);
  }, [copied]);
  const id = `${result.specHash}#${result.provenance.trial}`;
  return (
    <>
      <Meta icon={Timer} title="Run time">
        {ms === null ? "n/a" : `${ms.toLocaleString("en-US")}ms`}
      </Meta>
      <Meta icon={ArrowLeftRight} title="Trades">
        {result.metrics.tradeCount.toLocaleString("en-US")} {result.metrics.tradeCount === 1 ? "trade" : "trades"}
      </Meta>
      <Meta icon={CalendarRange} title="Period">
        {result.period.start} to {result.period.end}
      </Meta>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard
            ?.writeText(id)
            .then(() => setCopied(true))
            .catch(() => undefined);
        }}
        title={id}
        aria-label={copied ? "Run ID copied" : "Copy run ID"}
        className="inline-flex items-center gap-1 rounded px-1 outline-none transition-colors hover:text-[#1d1b1b] focus-visible:ring-2 focus-visible:ring-black/20"
      >
        {copied ? <Check width={12} height={12} strokeWidth={2} aria-hidden /> : <Copy width={12} height={12} strokeWidth={1.75} aria-hidden />}
        {copied ? "Copied" : "Run ID"}
      </button>
    </>
  );
}

function LeftHeader({
  s,
  name,
  groups,
  showRules,
  onPick,
  onRename,
  onToggleRules,
  onDuplicate,
  onDelete,
  onClose,
}: {
  s: SavedStrategy;
  name: string;
  groups: () => MenuGroup[];
  showRules: boolean;
  onPick: (id: string) => void;
  onRename: (name: string) => void;
  onToggleRules: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(s.spec.name);
  const [confirm, setConfirm] = useState(false);
  const hasRules = s.origin.kind !== "blank" || s.versions.length > 1;

  return (
    <>
      {renaming ? (
        <input
          aria-label="Strategy name"
          autoFocus
          value={draft}
          maxLength={80}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            if (draft.trim() && draft !== s.spec.name) onRename(draft.trim());
            setRenaming(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            else if (e.key === "Escape") {
              setDraft(s.spec.name);
              setRenaming(false);
            }
          }}
          className="h-8 min-w-0 max-w-[320px] flex-1 rounded-lg border border-black/20 bg-white px-2.5 text-[14px] font-medium text-[#1d1b1b] outline-none focus:border-black/40"
        />
      ) : (
        <Dropdown
          label="Choose a strategy"
          searchPlaceholder="Select a strategy..."
          width={280}
          groups={groups}
          onSelect={onPick}
          className="max-w-[min(320px,60%)]"
          button={({ open, props }) => (
            <button {...props} className={selectorClass(open)}>
              <SelectorLabel>
                {name}
                {s.spec.legacy ? <span className="ml-1.5 font-normal text-[#9a9a9a]">v1 rules</span> : null}
              </SelectorLabel>
            </button>
          )}
        />
      )}
      {confirm ? (
        <span className="flex shrink-0 items-center gap-1 text-[13px] text-[#4b4b48]">
          Delete this strategy?
          <button type="button" onClick={onDelete} className="rounded-md px-2 py-1 text-[#b3432f] outline-none hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-black/20">
            Delete
          </button>
          <button type="button" onClick={() => setConfirm(false)} className="rounded-md px-2 py-1 outline-none hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-black/20">
            Keep
          </button>
        </span>
      ) : (
        <div className="flex shrink-0 items-center gap-0.5">
          <Dropdown
            label="More strategy actions"
            kind="menu"
            align="right"
            width={200}
            groups={[
              {
                items: [
                  { id: "rename", label: "Rename", icon: Pencil },
                  { id: "duplicate", label: "Duplicate", icon: Copy },
                  { id: "delete", label: "Delete", icon: Trash2, danger: true },
                ],
              },
            ]}
            onSelect={(id) => {
              if (id === "rename") {
                setDraft(s.spec.name);
                setRenaming(true);
              } else if (id === "duplicate") onDuplicate();
              else setConfirm(true);
            }}
            button={({ open, props }) => (
              <button {...props} title="More" className={`${ICON_BUTTON} ${open ? "bg-black/[0.06] text-[#1d1b1b]" : ""}`}>
                <MoreHorizontal width={16} height={16} strokeWidth={1.75} aria-hidden />
              </button>
            )}
          />
          <IconButton label={showRules ? "Hide rules and parameters" : "Show rules and parameters"} icon={SlidersHorizontal} pressed={showRules && hasRules} disabled={!hasRules} onClick={onToggleRules} />
          <IconButton label="Close strategy" icon={X} onClick={onClose} />
        </div>
      )}
    </>
  );
}

/* ----------------------------------------------------------- composer */

function Composer({
  s,
  chat,
  canRun,
  running,
  onRun,
  onStarter,
  onNew,
  sightings,
  onSighting,
}: {
  s: SavedStrategy;
  chat: StrategyChat;
  canRun: boolean;
  running: boolean;
  onRun: () => void;
  onStarter: (id: string) => void;
  onNew: () => void;
  sightings: Parameters<typeof sortByTime>[0];
  onSighting: (cardId: string) => void;
}) {
  const [text, setText] = useState("");
  const fixed = s.origin.kind === "sighting";
  const locked = fixed || chat.waiting;
  const placeholder = fixed
    ? "Rules from a Sighting are fixed here. Duplicate the strategy to change them by chat."
    : chat.waiting
      ? "Answer the questions above, then press Continue."
      : chat.hasSpec
        ? "Describe a change to the rules. Enter sends, ⌘↵ runs."
        : "Describe a strategy in plain words. Enter sends.";

  const send = () => {
    if (chat.send(text)) setText("");
  };

  const sightingGroups = (): MenuGroup[] => [
    {
      label: "Sightings",
      items: sortByTime(sightings).map((c) => {
        const ex = cardExplain(c);
        return { id: c.id, label: `${c.event.ticker} ${ex.kicker.toLowerCase()}`, description: ex.title };
      }),
    },
  ];

  return (
    <div className="shrink-0 border-t border-black/[0.06] px-6 pb-5 pt-4">
      <div className="mx-auto w-full max-w-[800px] rounded-xl border border-black/[0.12] bg-white shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-colors focus-within:border-black/30">
        <textarea
          aria-label={chat.hasSpec ? "Describe a change to the rules" : "Describe a strategy in plain words"}
          value={text}
          rows={2}
          maxLength={4000}
          disabled={locked}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
            if (e.metaKey || e.ctrlKey) {
              e.preventDefault();
              onRun();
            } else if (!e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder={placeholder}
          className="block max-h-[160px] min-h-[52px] w-full resize-none rounded-t-xl bg-transparent px-4 pt-3 text-[14px] leading-[21px] text-[#1d1b1b] outline-none placeholder:text-[#9a9a9a] disabled:cursor-not-allowed"
        />
        <div className="flex items-center justify-between gap-2 px-3 pb-3 pt-1">
          <div className="flex items-center gap-2">
            <Dropdown
              label="Start from an example"
              side="top"
              width={280}
              searchPlaceholder="Select an example..."
              groups={[{ label: "Starters", items: STARTERS.map((t) => ({ id: t.id, label: t.spec.name, text: t.spec.name, description: t.text })) }]}
              onSelect={onStarter}
              button={({ open, props }) => (
                <button
                  {...props}
                  className={`inline-flex h-8 items-center rounded-lg border border-black/[0.12] px-2.5 text-[13px] text-[#3d3b3a] outline-none transition-colors hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-black/20 ${
                    open ? "bg-black/[0.05]" : ""
                  }`}
                >
                  Examples
                </button>
              )}
            />
            <Dropdown
              label="Backtest a Sighting"
              side="top"
              width={300}
              searchPlaceholder="Select a Sighting..."
              groups={sightingGroups}
              onSelect={onSighting}
              button={({ open, props }) => (
                <button
                  {...props}
                  title="Backtest a Sighting"
                  className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-black/[0.12] text-[#4b4b48] outline-none transition-colors hover:bg-black/[0.04] focus-visible:ring-2 focus-visible:ring-black/20 ${
                    open ? "bg-black/[0.05]" : ""
                  }`}
                >
                  <Paperclip width={15} height={15} strokeWidth={1.75} aria-hidden />
                </button>
              )}
            />
          </div>
          <div className="flex items-center gap-1.5">
            <IconButton label="New strategy" icon={Plus} onClick={onNew} />
            <button
              type="button"
              onClick={onRun}
              disabled={!canRun}
              aria-keyshortcuts="Meta+Enter Control+Enter"
              title={chat.hasSpec ? "Run the backtest (each run counts as a trial)" : "Describe a strategy first"}
              className="inline-flex h-8 items-center gap-2 rounded-lg bg-[#1c1917] pl-3 pr-2.5 text-[13px] font-medium text-[rgb(231,231,231)] outline-none transition-colors hover:bg-[#0f0d0b] focus-visible:ring-2 focus-visible:ring-black/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {running ? "Running" : "Run"}
              <kbd className="font-sans text-[12px] font-normal text-white/55">⌘↵</kbd>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function RunStatus({
  running,
  retrying,
  elapsed,
  error,
  tickers,
}: {
  running: boolean;
  retrying: boolean;
  elapsed: number;
  error: { message: string; errors: string[]; issues: { message: string }[] } | null;
  tickers: number;
}) {
  if (!running && !error) return null;
  return (
    <div className="flex flex-col gap-2">
      {running ? (
        <div role="status" aria-live="polite" className="flex items-center gap-3">
          <div className="relative h-[3px] w-[180px] shrink-0 overflow-hidden rounded-full bg-black/[0.07]">
            <div className="absolute inset-y-0 w-1/3 animate-[falcon-progress_1.2s_ease-in-out_infinite] rounded-full bg-[#1d1b1b]/70" />
          </div>
          <span className="text-[12px] text-[#767676]" style={{ fontFamily: MONO }}>
            {retrying ? "Still loading, trying again" : `Loading daily prices for ${tickers} ${tickers === 1 ? "ticker" : "tickers"} and running the checks`} {elapsed}s
          </span>
          <style>{`@keyframes falcon-progress { 0% { left: -33% } 100% { left: 100% } }`}</style>
        </div>
      ) : null}
      {error ? (
        <div role="alert" className="text-[12.5px] leading-[19px] text-[#b3432f]">
          {error.message}
          {error.issues.length ? (
            <span className="text-[#767676]"> {error.issues.slice(0, 3).map((i) => i.message).join(" ")}</span>
          ) : error.errors.length > 1 ? (
            <span className="text-[#767676]"> {error.errors.slice(1, 4).join("; ")}</span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
