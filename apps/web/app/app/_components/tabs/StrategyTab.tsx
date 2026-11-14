"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Copy, Trash2 } from "lucide-react";
import { STARTERS, eventStudyFromHistory, hasNoHistorySource, validateSpec, type QualityReport, type StrategySpecV2 } from "@falcon/backtest";
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
  type SavedStrategy,
  type SpecVersion,
} from "@/lib/workspace/strategies";
import { useWorkspace } from "../context";
import { EmptyState, MONO, Panel, SERIF } from "../parts";
import { Conversation, type TurnApply } from "../strategy/Conversation";
import { HistoryStudyView } from "../strategy/HistoryStudy";
import { Interpretation } from "../strategy/Interpretation";
import { ResultsV2 } from "../strategy/ResultsV2";
import { Versions } from "../strategy/Versions";

/**
 * Strategy Lab v2 (docs/design/strategy-lab-v2.md, 3.1-3.3): describe the
 * strategy in plain words, answer up to 3 questions, confirm the numbered
 * rules (the run is gated on them), then read the evidence label, curves,
 * flags and trades. Sliders and formula edits make new versions; Explain is
 * optional. Saved in this browser.
 */

/** The last finished run shown per strategy, so an edit does not blank the results. */
const shownKey = new Map<string, string>();

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

export function StrategyTab({ strategyId }: { strategyId: string }) {
  const { strategies, newStrategy } = useWorkspace();
  const s = strategies.find((x) => x.id === strategyId);
  if (!s) {
    return (
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
    );
  }
  return <StrategyView key={s.id} s={s} />;
}

function StrategyView({ s }: { s: SavedStrategy }) {
  const { userId, feed, openSighting, newStrategy, deleteStrategy } = useWorkspace();
  const update = useCallback((patch: Partial<SavedStrategy>) => updateStrategy(userId, s.id, patch), [s.id, userId]);
  useRunsVersion();

  const valid = useMemo(() => validateSpec(s.spec).ok, [s.spec]);
  const key = runKey(s.spec);
  const run = getRun(key);
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

  const onStarter = (id: string) => {
    const t = STARTERS.find((x) => x.id === id);
    if (!t) return;
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

  const onExplain = (quality: QualityReport) => void startReview(s.spec, quality, Math.max(1, s.trials));
  const showConversation = s.origin.kind !== "sighting";

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-7 py-6">
      <Header
        s={s}
        onName={(name) => setSpec(userId, s.id, { ...s.spec, name: name.slice(0, 80) }, "settings")}
        onOpenSighting={openSighting}
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
      />

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,460px)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          {showConversation ? <Conversation s={s} onApply={onApply} onStarter={onStarter} /> : null}
          {s.origin.kind !== "blank" || s.versions.length > 1 ? (
            <Interpretation
              spec={s.spec}
              assumptions={s.conversation.assumptions}
              notExpressible={s.conversation.notExpressible}
              confirmed={s.confirmed}
              running={running}
              onSpec={onSpec}
              onRun={() => go({ countTrial: true, force: run?.status === "error" })}
            />
          ) : null}
          <Versions versions={s.versions} current={s.spec} onRestore={(v) => setSpec(userId, s.id, v.spec, v.source)} />
        </div>

        <div className="flex min-w-0 flex-col gap-5">
          {studies.length ? <HistoryStudyView studies={studies} eventTicker={s.origin.kind === "sighting" ? s.origin.eventTicker : ""} /> : null}
          {noHistory && !studies.length ? (
            <Panel className="px-5 py-4">
              <p className="text-[13px] leading-[20px] text-[#4b4b48]">
                No history source yet for {s.origin.kind === "sighting" ? `${s.origin.eventTicker} events` : "events"} of this type (for example monthly revenue reports). The past record is
                not in the backtest data, so there is nothing to measure. Earnings Sightings test against the full earnings record.
              </p>
            </Panel>
          ) : null}

          <RunStatus running={running} retrying={running && run.retrying} elapsed={elapsed} error={run?.status === "error" ? run : null} tickers={s.spec.universe.kind === "static" ? s.spec.universe.tickers.length : 11} />

          {shown ? (
            <ResultsV2 name={s.spec.name || "This strategy"} result={shown} stale={stale} audit={getAudit(lastKey)} review={getReview(lastKey)} onExplain={onExplain} />
          ) : !running && !noHistory ? (
            <Panel className="px-5 py-6">
              <p className="text-[13px] leading-[20px] text-[#767676]">
                {s.origin.kind === "blank" && s.versions.length < 2
                  ? "Describe a strategy or start from one of the examples. Falcon writes the rules back in numbered steps; nothing runs until you confirm them."
                  : "Read the numbered rules, adjust the parameters if needed, then run them. The result opens with how much evidence the past data gives, followed by the curves, flags and trades."}
              </p>
            </Panel>
          ) : null}
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
          <div className="relative h-[3px] w-[220px] overflow-hidden rounded-full bg-black/[0.07]">
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
          {error.issues.length ? <span className="text-[#767676]"> {error.issues.slice(0, 3).map((i) => i.message).join(" ")}</span> : error.errors.length > 1 ? <span className="text-[#767676]"> {error.errors.slice(1, 4).join("; ")}</span> : null}
        </div>
      ) : null}
    </div>
  );
}

function Header({
  s,
  onName,
  onOpenSighting,
  onDuplicate,
  onDelete,
}: {
  s: SavedStrategy;
  onName: (name: string) => void;
  onOpenSighting: (cardId: string) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}) {
  const [confirm, setConfirm] = useState(false);
  const [name, setName] = useState(s.spec.name);
  useEffect(() => setName(s.spec.name), [s.spec.name]);
  return (
    <header className="flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <span className="text-[11px] uppercase tracking-[0.16em] text-[#1d1b1b]/45" style={{ fontFamily: MONO }}>
          Strategy{s.spec.legacy ? " · v1 rules" : ""}
        </span>
        <input
          aria-label="Strategy name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name !== s.spec.name && onName(name.trim())}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
          className="mt-1 block w-full rounded-md bg-transparent text-[26px] leading-[36px] text-[#1d1b1b] outline-none placeholder:text-[#c4c4c0] hover:bg-black/[0.02] focus:bg-black/[0.02]"
          style={{ fontFamily: SERIF }}
          placeholder="Untitled strategy"
        />
        {s.origin.kind === "sighting" ? (
          <p className="mt-1 text-[12.5px] text-[#767676]">
            {s.origin.hasHistory ? `Tests past ${s.origin.basis} on the companies the` : "Past events like the"}{" "}
            <button
              type="button"
              onClick={() => onOpenSighting((s.origin as { cardId: string }).cardId)}
              className="text-[#4b4b48] underline decoration-black/20 underline-offset-2 outline-none hover:text-[#1d1b1b] focus-visible:decoration-black/60"
            >
              {s.origin.eventTicker} sighting
            </button>{" "}
            {s.origin.hasHistory ? "reaches." : "on the companies it reaches."}
          </p>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-1 pt-5">
        {confirm ? (
          <span className="flex items-center gap-2 text-[12px] text-[#4b4b48]">
            Delete this strategy?
            <button type="button" onClick={onDelete} className="rounded-md px-2 py-1 text-[#b3432f] outline-none hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-black/20">
              Delete
            </button>
            <button type="button" onClick={() => setConfirm(false)} className="rounded-md px-2 py-1 outline-none hover:bg-black/[0.05] focus-visible:ring-2 focus-visible:ring-black/20">
              Keep
            </button>
          </span>
        ) : (
          <>
            <IconButton label="Duplicate" onClick={onDuplicate}>
              <Copy width={14} height={14} aria-hidden />
            </IconButton>
            <IconButton label="Delete" onClick={() => setConfirm(true)}>
              <Trash2 width={14} height={14} aria-hidden />
            </IconButton>
          </>
        )}
      </div>
    </header>
  );
}

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-8 w-8 items-center justify-center rounded-md text-[#767676] outline-none transition-colors hover:bg-black/[0.05] hover:text-[#1d1b1b] focus-visible:ring-2 focus-visible:ring-black/20"
    >
      {children}
    </button>
  );
}
