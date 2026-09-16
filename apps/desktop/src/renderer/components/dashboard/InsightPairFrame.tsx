import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowLeft, ArrowDownRight, ArrowUpRight, Loader2, Minus } from "lucide-react";
import SelectionGloss from "./SelectionGloss";
import StockIcon from "../stock/StockIcon";
import {
  buildPairCalendar,
  dayColor,
  dayLabel,
  monthTicks,
  roleLabel,
  WEEKDAY_TICKS,
} from "../../lib/second-order-card";
import { cn } from "../../lib/utils";
import type {
  PairExplanation,
  PairExplanationRequest,
  PairOutlook,
} from "../../../shared/pair-explanation";
import type { PropagationDirection } from "../../../shared/propagation-run-types";
import type {
  PairHistoryEvent,
  PairOutcome,
  PropagationPairHistory,
} from "../../../shared/propagation-pair";

/**
 * The frame the Insight panel opens onto one affected name: who it is, why
 * this event reaches it, what events like it have done to it before — and the
 * engine's own record on the pair, every call listed, over the same field of
 * days the card uses.
 *
 * Everything measured here comes from the run store through
 * `propagation:pair-history`; the written part is one cached model call. The
 * frame computes no verdicts of its own.
 */

/* ------------------------------------------------------------------ */
/* The record                                                          */
/* ------------------------------------------------------------------ */

const SECTION_LABEL =
  "select-none font-sans text-[10.5px] font-medium tracking-[0.08em] text-[#9CA3AF]";

const OUTCOME_LABEL: Record<PairOutcome, string> = {
  hit: "called right",
  partial: "right, short",
  miss: "called wrong",
  open: "open",
  expired: "expired",
};

/** What each verdict actually means, for the row that carries it. */
const OUTCOME_HINT: Record<PairOutcome, string> = {
  hit: "Moved the way the engine called it, at or past the size it called.",
  partial: "Moved the way it was called, but short of the size.",
  miss: "Moved against the direction the engine called.",
  open: "Has not moved far enough either way to say.",
  expired: "The horizon passed before the move resolved.",
};

/** Green for a call that landed, red for one that went the other way, grey
 *  for the ones the market hasn't answered. */
const OUTCOME_COLOR: Record<PairOutcome, string> = {
  hit: "#16A34A",
  partial: "#63A059",
  miss: "#DC2626",
  open: "#9CA3AF",
  expired: "#9CA3AF",
};

/** Up is blue and down is red on this surface, the same as the field: the
 *  colour says which way, never whether it is good news. */
const OUTLOOK_COLOR: Record<PairOutlook["direction"], string> = {
  up: "#22509E",
  down: "#A81C1C",
  unclear: "#6b7280",
};

const OUTLOOK_ICON: Record<PairOutlook["direction"], typeof ArrowUpRight> = {
  up: ArrowUpRight,
  down: ArrowDownRight,
  unclear: Minus,
};

/**
 * The expectation, up front. The prose underneath explains it; this says it —
 * which way, how big, by when, and how much weight it carries.
 */
function Outlook({ outlook, ticker }: { outlook: PairOutlook; ticker: string }) {
  const color = OUTLOOK_COLOR[outlook.direction];
  const Icon = OUTLOOK_ICON[outlook.direction];
  const facts = [
    outlook.magnitude ? `Size ${outlook.magnitude}` : null,
    outlook.horizon ? `Over ${outlook.horizon}` : null,
    `${outlook.conviction.charAt(0).toUpperCase() + outlook.conviction.slice(1)} conviction`,
  ].filter((x): x is string => x !== null);

  return (
    <div className="mt-5 rounded-2xl border border-white/60 bg-white/45 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04]">
      <div className={SECTION_LABEL}>THE EXPECTATION</div>
      <div className="mt-2.5 flex items-start gap-2.5">
        <span
          aria-hidden
          className="mt-[2px] flex h-6 w-6 shrink-0 items-center justify-center rounded-full"
          style={{ color, backgroundColor: `${color}14` }}
        >
          <Icon className="h-4 w-4" strokeWidth={2.25} />
        </span>
        <p className="text-[15px] font-medium leading-[1.45] text-[#1d1b1b]">
          {outlook.call || `${ticker}: ${outlook.direction}`}
        </p>
      </div>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5 text-[11.5px] text-[#6b7280]">
        {facts.map((fact) => (
          <span key={fact}>{fact}</span>
        ))}
      </div>
    </div>
  );
}

function pct(v: number | null | undefined, digits = 1): string {
  return v == null || !Number.isFinite(v) ? "—" : `${(v * 100).toFixed(digits)}%`;
}

function signedPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const p = v * 100;
  return `${p > 0 ? "+" : p < 0 ? "−" : ""}${Math.abs(p).toFixed(1)}%`;
}

/**
 * The size the engine called, carrying the direction it called it in.
 *
 * `expected_pct` is a magnitude — the direction lives beside it — so printing
 * it bare made a call of "2.2% down" answered by a 5.9% fall read as a flat
 * contradiction that the engine had nonetheless scored right. Where the
 * direction is mixed or unclear the engine compares magnitudes only, and the
 * ± says so.
 */
function calledPct(v: number | null | undefined, direction: PropagationDirection): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = direction === "positive" ? "+" : direction === "negative" ? "−" : "±";
  return `${sign}${(Math.abs(v) * 100).toFixed(1)}%`;
}

function roleWord(role: string): string {
  const word = roleLabel(role as Parameters<typeof roleLabel>[0]);
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function day(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso.slice(0, 10);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** `regulatory_decision` is the engine's word for it, not the reader's. */
function eventType(type: string): string {
  return type.replace(/_/g, " ");
}

/**
 * The record, said rather than tabulated. A column of "Expired unresolved 0"
 * is precise and unreadable; this leads with the score, says what it means in
 * a sentence, and only shows the outcomes that actually happened.
 */
function RecordSummary({ history, root }: { history: PropagationPairHistory; root: string }) {
  const right = history.hits + history.partials;
  const resolved = right + history.misses;
  const waiting = history.open + history.expired;

  const sentence = (() => {
    if (history.events.length === 0) {
      return `This is the first event the engine has carried from ${root} to ${history.target}.`;
    }
    if (resolved === 0) {
      return `${plural(history.events.length, "call", "calls")} so far and none has resolved, so there is nothing to score yet.`;
    }
    const parts = [
      `Of ${plural(resolved, "resolved call", "resolved calls")}, ${right} moved the way the engine said and ${history.misses} moved against it.`,
    ];
    if (history.partials > 0) {
      parts.push(
        `${history.partials} of the right ones got the direction but fell short of the size called.`,
      );
    }
    if (waiting > 0) {
      parts.push(`${plural(waiting, "call is", "calls are")} still waiting on the market.`);
    }
    return parts.join(" ");
  })();

  const size =
    history.avg_expected_pct != null && history.avg_realized_pct != null
      ? `The engine usually calls a ${pct(history.avg_expected_pct)} move on this link. ${
          history.target
        } has actually moved ${pct(history.avg_realized_pct)}${
          history.avg_ratio == null
            ? ""
            : ` — about ${history.avg_ratio.toFixed(1)}× the size called`
        }.`
      : null;

  // Only what happened: a row of zeroes teaches nothing.
  const chips = (
    [
      { label: `${history.hits} right`, tone: "hit" },
      { label: `${history.partials} right but short`, tone: "partial" },
      { label: `${history.misses} wrong`, tone: "miss" },
      { label: `${history.open} still open`, tone: "open" },
      { label: `${history.expired} expired`, tone: "expired" },
    ] satisfies Array<{ label: string; tone: PairOutcome }>
  ).filter((c) => !c.label.startsWith("0 "));

  return (
    <div className="rounded-2xl border border-white/60 bg-white/45 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04]">
      <div className="flex items-baseline gap-2">
        <span className="text-[34px] font-medium leading-none tabular-nums text-[#1d1b1b]">
          {resolved === 0 ? "—" : `${right} of ${resolved}`}
        </span>
        <span className="text-[13px] text-[#6b7280]">
          {resolved === 0 ? "nothing scored yet" : "calls right"}
        </span>
      </div>

      <p className="mt-3 text-[13px] leading-[1.55] text-[#4b5563]">{sentence}</p>

      {chips.length > 0 ? (
        <div className="mt-3.5 flex flex-wrap gap-1.5">
          {chips.map((chip) => (
            <span
              key={chip.label}
              title={OUTCOME_HINT[chip.tone]}
              className="rounded-full px-2.5 py-[4px] text-[11px] font-medium leading-none"
              style={{
                color: OUTCOME_COLOR[chip.tone],
                backgroundColor: `${OUTCOME_COLOR[chip.tone]}14`,
              }}
            >
              {chip.label}
            </span>
          ))}
        </div>
      ) : null}

      {size ? (
        <p className="mt-3.5 border-t border-black/[0.06] pt-3 text-[12.5px] leading-[1.55] text-[#6b7280]">
          {size}
        </p>
      ) : null}
    </div>
  );
}

function EventRow({ event }: { event: PairHistoryEvent }) {
  return (
    <li className="flex items-start gap-3 border-b border-black/[0.05] py-2.5 last:border-b-0">
      <span className="w-[92px] shrink-0 font-['Geist_Mono'] text-[11px] leading-[1.5] tabular-nums text-[#9CA3AF]">
        {day(event.event_ts)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[12.5px] leading-[1.45] text-[#1d1b1b]">
          {event.event_label}
        </span>
        <span className="mt-0.5 block text-[11px] leading-[1.4] text-[#9CA3AF]">
          {eventType(event.event_type)} · called{" "}
          {calledPct(event.expected_pct, event.expected_direction)} · moved{" "}
          {signedPct(event.realized_pct)}
        </span>
      </span>
      <span
        title={OUTCOME_HINT[event.outcome]}
        className="shrink-0 rounded-full px-2 py-[3px] text-[10.5px] font-medium leading-none"
        style={{
          color: OUTCOME_COLOR[event.outcome],
          backgroundColor: `${OUTCOME_COLOR[event.outcome]}14`,
        }}
      >
        {OUTCOME_LABEL[event.outcome]}
      </span>
    </li>
  );
}

/* ------------------------------------------------------------------ */
/* The field of days                                                   */
/* ------------------------------------------------------------------ */

const PITCH = 13;
const CELL = 10;
const RADIUS = 2;
const GUTTER = 20;
const BAND = 13;
const MIN_WEEKS = 19;
const MAX_WEEKS = 52;
const LABEL = "#9CA3AF";
const LABEL_FONT = "Geist Mono, ui-monospace, monospace";

/** The card's calendar, without the hover card: the pair's days, coloured by
 *  how far each day's call travelled. */
function PairCalendar({ events, root }: { events: PairHistoryEvent[]; root: string }) {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: HTMLDivElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    // Layout width, not a rect: the panel opens under a scale animation, and
    // a rect measured mid-flight carries it.
    setWidth(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    observer.current = ro;
  }, []);
  useEffect(() => () => observer.current?.disconnect(), []);

  const measured = width > GUTTER + PITCH;
  const weeks = measured
    ? Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, Math.floor((width - GUTTER) / PITCH)))
    : MIN_WEEKS;
  const pitch = measured ? (width - GUTTER) / weeks : PITCH;
  const columns = useMemo(
    () => buildPairCalendar(events, new Date(), weeks, root),
    [events, weeks, root],
  );

  const svgW = GUTTER + columns.length * pitch;
  const svgH = BAND + 7 * pitch;
  const months = monthTicks(columns);

  return (
    <div ref={ref} className="flex justify-center">
      <svg
        viewBox={`0 0 ${svgW} ${svgH}`}
        width={svgW}
        height={svgH}
        className="block h-auto max-w-full"
        role="img"
        aria-label="Days this pair has been called"
      >
        {months.map((tick) => (
          <text
            key={`${tick.column}-${tick.label}`}
            x={GUTTER + tick.column * pitch}
            y={BAND - 4}
            fontSize={8}
            fontFamily={LABEL_FONT}
            fill={LABEL}
          >
            {tick.label}
          </text>
        ))}
        {WEEKDAY_TICKS.map((tick) => (
          <text
            key={tick.label}
            x={GUTTER - 5}
            y={BAND + tick.row * pitch + pitch / 2 + 2.8}
            fontSize={8}
            fontFamily={LABEL_FONT}
            fill={LABEL}
            textAnchor="end"
          >
            {tick.label}
          </text>
        ))}
        {columns.map((column, w) =>
          column.map((cell, d) => (
            <rect
              key={cell.date}
              x={GUTTER + w * pitch + (pitch - CELL) / 2}
              y={BAND + d * pitch + (pitch - CELL) / 2}
              width={CELL}
              height={CELL}
              rx={RADIUS}
              fill={dayColor(cell)}
            >
              {cell.items.length > 0 ? <title>{dayLabel(cell)}</title> : null}
            </rect>
          )),
        )}
      </svg>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The frame                                                           */
/* ------------------------------------------------------------------ */

function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <section className="mt-6 first:mt-0">
      <h3 className={SECTION_LABEL}>{label}</h3>
      <div className="mt-2">{children}</div>
    </section>
  );
}

export type InsightPairSubject = {
  ticker: string;
  label?: string;
  role?: string;
  tier?: string;
  mechanism?: string;
  /** Signed share of the called move travelled, on this run's call. */
  pricedIn?: number | null;
};

export default function InsightPairFrame({
  rootTicker,
  subject,
  request,
  onBack,
}: {
  rootTicker: string;
  subject: InsightPairSubject;
  /** Everything but the record — the frame adds that once it has it. */
  request: Omit<PairExplanationRequest, "record" | "precedents"> | null;
  onBack: () => void;
}) {
  const ticker = subject.ticker.toUpperCase();
  const [history, setHistory] = useState<PropagationPairHistory | null>(null);
  const [explanation, setExplanation] = useState<PairExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // The record first — it is local, instant, and the write-up is asked to
  // reason about it, so it has to be in hand before the model is called.
  useEffect(() => {
    let cancelled = false;
    setHistory(null);
    setExplanation(null);
    setError(null);
    setLoading(true);

    const pending = window.meridian?.getPropagationPairHistory?.({
      root: rootTicker,
      target: ticker,
    });
    void Promise.resolve(pending)
      .then(async (res) => {
        if (cancelled) return;
        const record = res?.ok ? res.history : null;
        if (record) setHistory(record);
        if (!request) {
          setLoading(false);
          return;
        }
        const explain = window.meridian?.getPairExplanation?.({
          ...request,
          record: record
            ? {
                hits: record.hits,
                partials: record.partials,
                misses: record.misses,
                open: record.open,
                expired: record.expired,
                hit_rate: record.hit_rate,
                avg_expected_pct: record.avg_expected_pct,
                avg_realized_pct: record.avg_realized_pct,
                avg_ratio: record.avg_ratio,
              }
            : undefined,
          precedents: record
            ? record.events.slice(0, 10).map((e) => ({
                label: e.event_label,
                type: e.event_type,
                event_ts: e.event_ts,
                outcome: e.outcome,
                expected_pct: e.expected_pct,
                realized_pct: e.realized_pct,
              }))
            : undefined,
        });
        if (!explain) {
          setError("No explanation service available.");
          setLoading(false);
          return;
        }
        const written = await explain;
        if (cancelled) return;
        if (written?.ok) setExplanation(written.explanation);
        else setError(written?.error ?? "No explanation available.");
        setLoading(false);
      })
      .catch(() => {
        if (cancelled) return;
        setError("Couldn't reach the propagation store.");
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [rootTicker, ticker, request?.run_id, request?.headline]);

  const name = subject.label ?? history?.label ?? null;
  const role = subject.role ?? history?.role ?? null;
  const events = history?.events ?? [];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <button
        type="button"
        onClick={onBack}
        className="mb-4 flex shrink-0 items-center gap-1.5 self-start rounded-full border border-white/60 bg-white/55 py-1.5 pl-2 pr-3 text-[11.5px] font-medium text-[#4b5563] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] backdrop-blur-xl transition-colors hover:bg-white/75 hover:text-[#1d1b1b]"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} aria-hidden />
        All names
      </button>

      <div className="min-h-0 flex-1 overflow-y-auto pr-1">
        {/* Who it is. */}
        <div className="flex items-center gap-3">
          <StockIcon
            symbol={ticker}
            companyName={name ?? undefined}
            size="md"
            className="h-11 w-11 shrink-0"
          />
          <div className="min-w-0">
            <div className="text-[26px] font-medium leading-none tracking-[-0.01em] text-[#1d1b1b]">
              {ticker}
            </div>
            <div className="mt-1.5 truncate text-[13px] leading-none text-[#6b7280]">
              {name ?? "—"}
            </div>
          </div>
        </div>

        {role ? (
          <p className="mt-3 text-[12px] leading-[1.5] text-[#6b7280]">{roleWord(role)}</p>
        ) : null}

        {/* The write-up. */}
        <AnimatePresence mode="wait" initial={false}>
          {loading && !explanation ? (
            <motion.div
              key="loading"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="mt-6 flex items-center gap-2 text-[13px] text-[#9CA3AF]"
            >
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
              Reading the record…
            </motion.div>
          ) : explanation ? (
            <motion.div
              key="written"
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.34, ease: [0.4, 0, 0.2, 1] }}
              className="mt-1"
            >
              {explanation.outlook ? (
                <Outlook outlook={explanation.outlook} ticker={ticker} />
              ) : null}

              <Section label="WHY IT REACHES THIS NAME">
                <SelectionGloss context={explanation.why} ticker={ticker}>
                  <p className="text-[14px] leading-[1.62] text-[#374151]">{explanation.why}</p>
                </SelectionGloss>
              </Section>

              {explanation.precedent ? (
                <Section label="WHAT EVENTS LIKE THIS HAVE DONE">
                  <SelectionGloss context={explanation.precedent} ticker={ticker}>
                    <p className="text-[14px] leading-[1.62] text-[#374151]">
                      {explanation.precedent}
                    </p>
                  </SelectionGloss>
                </Section>
              ) : null}

              {explanation.this_time ? (
                <Section label="THIS TIME">
                  <SelectionGloss context={explanation.this_time} ticker={ticker}>
                    <p className="text-[14px] leading-[1.62] text-[#374151]">
                      {explanation.this_time}
                    </p>
                  </SelectionGloss>
                </Section>
              ) : null}

              {explanation.watch.length > 0 ? (
                <Section label="WHAT WOULD CONFIRM OR KILL IT">
                  <ul className="space-y-2.5">
                    {explanation.watch.map((line) => (
                      <li
                        key={line}
                        className="flex gap-2.5 text-[13px] leading-[1.55] text-[#4b5563]"
                      >
                        <span
                          aria-hidden
                          className="mt-[7px] h-[5px] w-[5px] shrink-0 rounded-full bg-[#9CA3AF]"
                        />
                        <span>{line}</span>
                      </li>
                    ))}
                  </ul>
                </Section>
              ) : null}
            </motion.div>
          ) : error ? (
            <motion.p
              key="error"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              className="mt-6 text-[13px] text-[#9CA3AF]"
            >
              {error}
            </motion.p>
          ) : null}
        </AnimatePresence>

        {/* The record: the number, then every call behind it. */}
        <Section label="THE ENGINE'S RECORD ON THIS PAIR">
          {history ? (
            <>
              <RecordSummary history={history} root={rootTicker.toUpperCase()} />
              {events.length > 0 ? (
                <ul className={cn("mt-4", "text-left")}>
                  {events.map((event) => (
                    <EventRow key={`${event.run_id}-${event.event_ts}`} event={event} />
                  ))}
                </ul>
              ) : (
                <p className="mt-3 text-[13px] text-[#9CA3AF]">
                  This is the first event the engine has propagated from{" "}
                  {rootTicker.toUpperCase()} to {ticker}.
                </p>
              )}
            </>
          ) : (
            <p className="text-[13px] text-[#9CA3AF]">Reading the run store…</p>
          )}
        </Section>

        {/* And the whole span of it, as days. */}
        <Section label="EVERY DAY THIS PAIR HAS BEEN CALLED">
          <PairCalendar events={events} root={rootTicker.toUpperCase()} />
          <p className="mt-3 text-[11.5px] leading-[1.5] text-[#9CA3AF]">
            Blank while the market has not answered the call, red where the name went the other
            way, blue as the called move lands — the same reading as the card's own field.
          </p>
        </Section>
      </div>
    </div>
  );
}
