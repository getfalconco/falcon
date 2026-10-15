import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { ChevronDown, Loader2, X } from "lucide-react";
import { useHeldTickers, useWatchlistTickers } from "@/components/calendar/use-calendar-data";
import { useI18n } from "@/lib/i18n";
import { useEarnings } from "@/lib/earnings-store";
import { cn } from "@/lib/utils";
import type { Agent } from "../../../shared/agent-types";
import { cleanDraft } from "./agent-draft";
import { suggestedName, understanding } from "./agent-format";
import { starterDraft } from "./agent-prefill";
import { buildStarterTemplates, starterBrief, starterTitle, type StarterTemplate } from "./agent-templates";
import { BUTTON, FIELD } from "./agent-ui";
import {
  CONFIRM,
  DESCRIBE,
  WIZARD_STEPS,
  blockReason,
  confirmIssues,
  initialWizard,
  nextMove,
  pendingQuestion,
  textToRead,
  wizardReducer,
  type WizardStart,
  type WizardState,
} from "./agent-wizard";
import AgentConfirmCard from "./AgentConfirmCard";
import { createAgent, draftFromBrief } from "./agents-store";

/**
 * Create Agent, in two steps.
 *
 *   1 of 2  The agent's name, the reader's own, and what it should do, in
 *           the reader's words. It need not be about a company: a topic, a
 *           macro release, the market's headlines or a schedule all work.
 *           Starters made from what the reader holds fill in the instruction
 *           as examples, each with the draft it stands for: kept as put in,
 *           Next goes to step 2 without reading the words. When the words give nothing to act on, one question
 *           about what is missing is asked right there.
 *   2 of 2  "Did we understand you?": Falcon's reading as a few plain
 *           sentences, built from what will actually run. Start agent, or
 *           Change to go back with the words intact. Adjust details opens the
 *           parts one by one, for whoever wants them.
 *
 * Both ways into creating an agent open this modal: the empty Agents tab
 * (by itself) and New agent (the list's button, N). A screen that already
 * knows what to watch (an earnings drawer's "Create agent", the Filing
 * changes card's "Watch filings") hands in a draft it built, and the modal
 * opens on step 2 with its trigger set and nothing to read. Closing it (the
 * X, Esc, a click outside) keeps what was typed: it stays mounted with the
 * tab, and opening it again picks up where the reader was.
 */

/** Same arrival as the settings panel: a fade, at the size it will keep. */
const PANEL_FADE = {
  initial: { opacity: 0 },
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  transition: { duration: 0.2, ease: [0.33, 1, 0.68, 1] },
} as const;

/** A chip the reader picks: the glass of a secondary button. */
const CHIP =
  "app-no-drag rounded-xl border border-white/60 bg-white/55 px-3 py-1.5 text-left text-[12.5px] font-normal text-[#1d1b1b] shadow-[inset_0_1px_0_rgba(255,255,255,0.7)] ring-1 ring-black/[0.04] transition-colors duration-150 hover:bg-white/75";
const CHIP_ON = "bg-white/90 ring-black/[0.12]";

/** The lighter placeholder of the two fields: light, and the tertiary tone on dark. */
const SOFT_PLACEHOLDER = "placeholder:text-[#b4b4ae] [[data-theme=dark]_&]:placeholder:text-[var(--text-tertiary)]";

/** An open menu or suggestion list inside the panel takes Esc for itself. */
const OPEN_POPUP = '[aria-haspopup][aria-expanded="true"], [role="combobox"][aria-expanded="true"]';

const NO_NAMES: readonly string[] = [];

/** Example instructions, from the reader's holdings, watchlist and the earnings calendar. Mounted only while the first step shows. */
function Starters({ activeId, onPick }: { activeId: string | null; onPick: (t: StarterTemplate) => void }) {
  const { language: lang, t } = useI18n();
  const held = useHeldTickers();
  const watchlist = useWatchlistTickers();
  const own = held.length + watchlist.length > 0;
  const earnings = useEarnings(own ? "mine" : "tracked", own ? held : NO_NAMES, own ? watchlist : NO_NAMES);
  const rows = earnings.value?.rows;
  const starters = useMemo(() => {
    const list = (rows ?? []).map((r) => ({ ticker: r.ticker, date: r.date, held: r.held, watchlist: r.watchlist }));
    return buildStarterTemplates({ held, watchlist, reporting: own ? list : [], tracked: own ? [] : list });
  }, [rows, held, watchlist, own]);
  return (
    <div className="space-y-2">
      <p className="text-[12px] text-[#6b7280]">{own ? t("agents.wizard.startersOwn") : t("agents.wizard.examples")}</p>
      <div className="flex flex-wrap gap-2">
        {starters.map((tpl) => {
          const id = `${tpl.id}:${tpl.ticker}`;
          return (
            <button
              key={id}
              type="button"
              aria-pressed={activeId === id}
              onClick={() => onPick(tpl)}
              className={cn(CHIP, activeId === id && CHIP_ON)}
            >
              {starterTitle(tpl, lang)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export default function AgentWizard({
  open,
  onClose,
  onCreated,
  initialBrief,
}: {
  open: boolean;
  onClose: () => void;
  onCreated: (agent: Agent) => void;
  /**
   * An instruction handed in from elsewhere (an earnings row), with a name
   * when one came with it: the wizard starts over from it, once per `seq`.
   * With a draft (an earnings drawer, the Filing changes card) it starts on
   * the confirm step instead, and nothing is sent to be read.
   */
  initialBrief?: WizardStart | null;
}) {
  const { language: lang, t } = useI18n();
  const [s, dispatch] = useReducer(wizardReducer, undefined, initialWizard);
  const [details, setDetails] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const nameField = useRef<HTMLInputElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const answerBox = useRef<HTMLDivElement>(null);
  const question = pendingQuestion(s);

  const appliedBrief = useRef(0);
  useEffect(() => {
    if (!initialBrief || initialBrief.seq === appliedBrief.current) return;
    appliedBrief.current = initialBrief.seq;
    setDetails(false);
    if (initialBrief.draft) {
      dispatch({ type: "prefill", draft: initialBrief.draft, name: initialBrief.name });
      return;
    }
    dispatch({ type: "reset" });
    dispatch({ type: "brief", text: initialBrief.text });
    dispatch({ type: "name", text: initialBrief.name?.trim() || suggestedName(initialBrief.text, lang) });
  }, [initialBrief, lang]);

  // Each step starts at its top, and the caret goes where the step starts:
  // the name while it is empty, else the instruction, on the first step; the
  // step's title on the second so a screen reader hears where it is.
  useEffect(() => {
    if (!open) return;
    if (scroller.current) scroller.current.scrollTop = 0;
    const id = window.setTimeout(() => {
      if (s.step === DESCRIBE) (nameField.current && !nameField.current.value.trim() ? nameField.current : area.current)?.focus({ preventScroll: true });
      else heading.current?.focus({ preventScroll: true });
    }, 60);
    return () => window.clearTimeout(id);
    // Only on opening and on a change of step, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, s.step]);

  // A question takes the caret as it appears.
  useEffect(() => {
    if (!open || !question) return;
    const id = window.setTimeout(() => answerBox.current?.querySelector("input")?.focus({ preventScroll: true }), 60);
    return () => window.clearTimeout(id);
  }, [open, question]);

  // Esc closes, and nothing more: what was typed is kept. Listened to in the
  // capture phase so an open menu inside the panel is seen before it closes
  // itself, and takes the key instead.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (panel.current?.querySelector(OPEN_POPUP)) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  const read = useCallback(
    async (text: string) => {
      dispatch({ type: "draft-start", text });
      const res = await draftFromBrief(text);
      if (res.ok) dispatch({ type: "draft-done", text, draft: res.data });
      else dispatch({ type: "draft-failed", text, error: res.error || t("agents.error.brief") });
    },
    [t],
  );

  const create = async (state: WizardState) => {
    if (!state.draft) return;
    dispatch({ type: "create-start" });
    const res = await createAgent(cleanDraft({ ...state.draft, name: state.name.trim() || state.draft.name }));
    if (!res.ok) {
      dispatch({ type: "create-failed", error: res.error || t("agents.error.create") });
      return;
    }
    dispatch({ type: "reset" });
    setDetails(false);
    onCreated(res.data);
  };

  const move = nextMove(s);
  const next = () => {
    switch (move) {
      case "draft":
        void read(textToRead(s));
        return;
      case "advance":
        dispatch({ type: "forward" });
        return;
      case "fix":
        dispatch({ type: "tried" });
        setDetails(true);
        return;
      case "create":
        void create(s);
        return;
      default:
        return;
    }
  };

  // Ctrl+Enter (Cmd+Enter) continues from anywhere in the panel; Enter alone
  // from a one-line field, where it has nothing else to do.
  const onPanelKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Enter" || e.defaultPrevented || e.nativeEvent.isComposing) return;
    const el = e.target as HTMLElement;
    const mod = e.metaKey || e.ctrlKey;
    const oneLine = el instanceof HTMLInputElement && el.type !== "checkbox" && el.getAttribute("aria-expanded") !== "true";
    if (!mod && !oneLine) return;
    e.preventDefault();
    next();
  };

  const pickStarter = (tpl: StarterTemplate) => {
    const { text, select } = starterBrief(tpl, lang);
    // The starter brings its draft: unedited, its words need no reading.
    dispatch({ type: "template", id: `${tpl.id}:${tpl.ticker}`, text, draft: starterDraft(tpl, lang) });
    requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      // The ticker is selected so typing replaces it.
      if (select) el.setSelectionRange(select[0], select[1]);
      else el.setSelectionRange(text.length, text.length);
    });
  };

  const issues = s.step === CONFIRM && s.tried ? confirmIssues(s, lang) : [];
  const footerNote = s.createError
    ? { tone: "error" as const, text: s.createError }
    : issues[0]
      ? { tone: "fix" as const, text: issues[0].text }
      : null;
  const reason = blockReason(s);
  const reasonText = reason ? t(`agents.wizard.blocked.${reason}`) : undefined;
  const reading = s.draftingFor !== null;
  const isConfirm = s.step === CONFIRM && s.draft;
  const primaryLabel = isConfirm
    ? s.creating
      ? t("agents.understand.starting")
      : t("agents.understand.start")
    : reading
      ? t("agents.create.reading")
      : t("agents.wizard.next");

  let body;
  if (!isConfirm) {
    body = (
      <div className="space-y-4">
        <label className="block space-y-1.5">
          <span className="text-[12px] text-[#6b7280]">{t("agents.wizard.nameLabel")}</span>
          <input
            ref={nameField}
            value={s.name}
            onChange={(e) => dispatch({ type: "name", text: e.target.value })}
            placeholder={t("agents.wizard.namePlaceholder")}
            maxLength={80}
            aria-describedby={reason === "name" ? "agent-wizard-name-hint" : undefined}
            className={cn(FIELD, "h-9", SOFT_PLACEHOLDER)}
          />
          {/* The words are in (typed, or a starter's) and only the name holds Next back: said here, not only in Next's tooltip. */}
          {reason === "name" ? (
            <span id="agent-wizard-name-hint" className="block text-[11.5px] text-[#6b7280]">
              {t("agents.wizard.blocked.name")}
            </span>
          ) : null}
        </label>
        <label className="block space-y-1.5">
          <span className="text-[12px] text-[#6b7280]">{t("agents.wizard.instructionLabel")}</span>
          <textarea
            ref={area}
            value={s.brief}
            onChange={(e) => dispatch({ type: "brief", text: e.target.value })}
            rows={5}
            placeholder={t("agents.wizard.placeholder")}
            className={cn(FIELD, "min-h-[128px] resize-none rounded-2xl px-4 py-3 text-[13.5px] leading-[1.6]", SOFT_PLACEHOLDER)}
          />
        </label>
        {question ? (
          <div ref={answerBox} className="rounded-2xl bg-black/[0.04] px-4 py-3" role="group" aria-label={t(`agents.clarify.${question.field}`)}>
            <p className="text-[13px] font-medium text-[#1d1b1b]">{t(`agents.clarify.${question.field}`)}</p>
            <p className="mt-0.5 text-[12px] text-[#6b7280]">{t(`agents.clarify.${question.field}Hint`)}</p>
            <input
              value={s.answer}
              onChange={(e) => dispatch({ type: "answer", text: e.target.value })}
              aria-label={t("agents.clarify.answerAria")}
              className={cn(FIELD, "mt-2.5 h-9")}
            />
          </div>
        ) : null}
        {s.draftError ? (
          <p role="alert" className="text-[12.5px] leading-[1.5] text-[#DC2626]">
            {t("agents.wizard.watch.failed")}: {s.draftError}
          </p>
        ) : null}
        {open && s.step === DESCRIBE ? <Starters activeId={s.templateId} onPick={pickStarter} /> : null}
      </div>
    );
  } else {
    const summary = understanding(s.draft!, lang);
    body = (
      <div className="space-y-4">
        <div className="space-y-1.5 text-[13.5px] leading-[1.6] text-[#1d1b1b]">
          {summary.lines.map((l) => (
            <p key={l}>{l}</p>
          ))}
        </div>
        {summary.note ? <p className="text-[12.5px] leading-[1.5] text-[#6b7280]">{summary.note}</p> : null}
        <section className="rounded-2xl border border-black/[0.06]">
          <button
            type="button"
            aria-expanded={details}
            aria-controls="agent-wizard-details"
            onClick={() => setDetails((v) => !v)}
            className="app-no-drag flex w-full items-center justify-between gap-3 rounded-2xl px-4 py-2.5 text-left text-[12.5px] text-[#4b5563] transition-colors hover:bg-black/[0.04]"
          >
            {t("agents.understand.adjust")}
            <ChevronDown className={cn("h-4 w-4 shrink-0 text-[#6b7280] transition-transform duration-150", details && "rotate-180")} strokeWidth={1.75} aria-hidden />
          </button>
          {details ? (
            <div id="agent-wizard-details" className="px-3 pb-3">
              <AgentConfirmCard draft={s.draft!} onChange={(d) => dispatch({ type: "edit", draft: d })} />
            </div>
          ) : null}
        </section>
      </div>
    );
  }

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div key="agent-wizard" className="fixed inset-0 z-[90] flex items-center justify-center">
          {/* Backdrop: the tab blurs away behind the panel. */}
          <motion.div
            className="app-no-drag absolute inset-0 bg-black/10"
            style={{ backdropFilter: "blur(14px)", WebkitBackdropFilter: "blur(14px)" }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.33, 1, 0.68, 1] }}
            onClick={onClose}
          />

          <motion.div
            ref={panel}
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-wizard-title"
            onKeyDown={onPanelKey}
            className={cn(
              "app-no-drag relative flex max-h-[min(660px,88vh)] w-[min(680px,92vw)] flex-col overflow-hidden rounded-3xl border border-white/60 bg-white/40 shadow-[inset_0_1px_0_rgba(255,255,255,0.7),0_40px_100px_rgba(0,0,0,0.22)] ring-1 ring-black/[0.04] backdrop-blur-xl backdrop-saturate-150",
              // Light: near-opaque, so nothing behind the panel reads through its glass.
              "[:root:not([data-theme=dark])_&]:bg-white/90",
            )}
            {...PANEL_FADE}
          >
            <div className="flex shrink-0 items-center gap-3 border-b border-black/[0.06] py-3 pl-6 pr-4">
              <h2 id="agent-wizard-title" className="min-w-0 flex-1 truncate text-[14px] font-medium text-[#1d1b1b]">
                {t("agents.wizard.heading")}
              </h2>
              <span className="shrink-0 text-[12px] tabular-nums text-[#9CA3AF]" aria-live="polite">
                {t("agents.wizard.stepOf", { step: s.step + 1, total: WIZARD_STEPS.length })}
              </span>
              <button
                type="button"
                onClick={onClose}
                aria-label={t("agents.wizard.close")}
                className="app-no-drag rounded-lg p-1.5 text-[#6b7280] transition-colors hover:bg-black/[0.04] hover:text-[#1d1b1b]"
              >
                <X className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              </button>
            </div>

            <div ref={scroller} className="scrollbar-meridian min-h-0 flex-1 overflow-y-auto px-6 pb-5 pt-4">
              <h3 ref={heading} tabIndex={-1} className="font-baskerville text-[20px] leading-[1.3] text-[#1d1b1b] outline-none">
                {isConfirm ? t("agents.understand.title") : t("agents.wizard.describe.title")}
              </h3>
              <div className="mt-4">{body}</div>
            </div>

            <div className="flex shrink-0 items-center gap-3 border-t border-black/[0.06] px-6 py-3">
              {isConfirm ? (
                <button type="button" onClick={() => dispatch({ type: "back" })} disabled={s.creating} className={BUTTON}>
                  {t("agents.understand.change")}
                </button>
              ) : null}
              <div className="min-w-0 flex-1">
                {footerNote ? (
                  <p role="alert" className={cn("truncate text-[12px]", footerNote.tone === "error" ? "text-[#DC2626]" : "text-[#B45309]")}>
                    {footerNote.text}
                  </p>
                ) : null}
              </div>
              {/* A disabled button takes no hover, so the reason sits on its wrapper. */}
              <span title={reasonText} className="shrink-0">
                <button
                  type="button"
                  onClick={next}
                  disabled={move === "blocked" || move === "answer" || move === "busy"}
                  aria-describedby={reasonText ? "agent-wizard-reason" : undefined}
                  className="glass-cta cta-primary app-no-drag inline-flex h-8 items-center gap-1.5 px-4 text-[12.5px] font-medium disabled:cursor-not-allowed disabled:opacity-50 [[data-theme=dark]_&]:disabled:opacity-100"
                >
                  {reading || s.creating ? <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" strokeWidth={2} aria-hidden /> : null}
                  {primaryLabel}
                </button>
              </span>
              {reasonText ? (
                <span id="agent-wizard-reason" className="sr-only">
                  {reasonText}
                </span>
              ) : null}
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
