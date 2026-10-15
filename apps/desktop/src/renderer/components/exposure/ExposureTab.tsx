import { useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { researchHoldings, useExposure } from "@/lib/exposure-store";
import { BUTTON, LABEL, SKELETON, SURFACE, Segmented } from "@/components/earnings/earnings-ui";
import { exposurePct, sharePct, type ExposureSummary } from "../../../shared/exposure";
import { CompanyCell, NUM, SourceLink, TickerLink, ViaTickers, displayName, headlineText } from "./exposure-ui";

/**
 * Exposure: what the reader's holdings depend on together, which a broker
 * statement never shows. Read from the 10-K and 20-F filings step1 extracts
 * (shared/exposure.ts has the arithmetic and the rules):
 *
 *   one line built from the figures, when a company sits under a fifth of
 *   the account or more;
 *   shared dependencies, by exposed weight, each with the holdings it sits
 *   under and the filing of its strongest link;
 *   customer concentration, from shares the filings disclose;
 *   overlap, the pairs of holdings that depend on the most of the same names;
 *   one quiet line for the holdings with no filing read yet.
 *
 * Rows are one line each. A listed company's ticker opens the stock; the
 * source opens the filing.
 */

/** Shared dependencies drawn before "Show all". */
const SHARED_ROWS = 10;
/** Names an overlap row prints before "+N". */
const OVERLAP_NAMES = 4;

const SHARED_GRID = "grid grid-cols-[minmax(0,1fr)_96px_minmax(0,190px)_minmax(0,250px)] items-center gap-x-4";
const CUSTOMER_GRID = "grid grid-cols-[96px_minmax(0,1fr)_minmax(0,250px)] items-center gap-x-4";
const OVERLAP_GRID = "grid grid-cols-[150px_minmax(0,1fr)_72px] items-center gap-x-4";
const ROW = "rounded-xl px-2 py-[7px] transition-colors hover:bg-[#1d1b1b]/[0.04]";

function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-[260px] flex-col items-center justify-center px-6 py-12 text-center">{children}</div>;
}

function Skeleton() {
  return (
    <div className="space-y-3 px-5 py-5" aria-hidden>
      <div className={cn(SKELETON, "h-3 w-40")} />
      {["w-[52%]", "w-[44%]", "w-[58%]", "w-[40%]", "w-[48%]"].map((w) => (
        <div key={w} className={SHARED_GRID}>
          <div className={cn(SKELETON, "h-3", w)} />
          <div className={cn(SKELETON, "ml-auto h-3 w-10")} />
          <div className={cn(SKELETON, "h-3 w-24")} />
          <div className={cn(SKELETON, "h-3 w-36")} />
        </div>
      ))}
    </div>
  );
}

function Section({ title, count, children }: { title: string; count: number; children: ReactNode }) {
  return (
    <section className="border-t-[0.5px] border-black/[0.06] pt-3 first-of-type:border-t-0" aria-label={title}>
      <h3 className="flex items-baseline gap-2 px-2 pb-1">
        <span className="text-[13px] font-medium text-[#1d1b1b]">{title}</span>
        <span className="ml-auto text-[11.5px] tabular-nums text-[#9CA3AF]">{count}</span>
      </h3>
      {children}
    </section>
  );
}

function Heads({ grid, cells }: { grid: string; cells: Array<{ text: string; right?: boolean }> }) {
  return (
    <div className={cn(grid, "px-2 pb-1 pt-1")} aria-hidden>
      {cells.map((c) => (
        <span key={c.text} className={cn(LABEL, "truncate", c.right && "text-right")}>
          {c.text}
        </span>
      ))}
    </div>
  );
}

function SharedSection({ summary }: { summary: ExposureSummary }) {
  const { t } = useI18n();
  const [all, setAll] = useState(false);
  const rows = all ? summary.shared : summary.shared.slice(0, SHARED_ROWS);
  const more = summary.shared.length - rows.length;
  return (
    <Section title={t("exposure.shared.title")} count={summary.shared.length}>
      <Heads
        grid={SHARED_GRID}
        cells={[
          { text: t("exposure.col.company") },
          { text: t("exposure.col.exposed"), right: true },
          { text: t("exposure.col.through") },
          { text: t("exposure.col.link") },
        ]}
      />
      <ul className="pb-2">
        {rows.map((row) => (
          <li key={row.key} className={cn(SHARED_GRID, ROW)}>
            <CompanyCell row={row} />
            <span className={cn(NUM, "text-[#1d1b1b]")} title={t("exposure.row.linked", { pct: exposurePct(row.linkedWeight) })}>
              {exposurePct(row.exposure)}
            </span>
            <ViaTickers row={row} max={4} />
            <SourceLink source={row.source} />
          </li>
        ))}
      </ul>
      {more > 0 ? (
        <button type="button" onClick={() => setAll(true)} className={cn(BUTTON, "mb-3 ml-2")}>
          {t("exposure.showAll", { count: summary.shared.length })}
        </button>
      ) : null}
    </Section>
  );
}

function CustomerSection({ summary }: { summary: ExposureSummary }) {
  const { t } = useI18n();
  return (
    <Section title={t("exposure.customers.title")} count={summary.customers.length}>
      <Heads grid={CUSTOMER_GRID} cells={[{ text: t("exposure.col.holding") }, { text: t("exposure.col.share") }, { text: t("exposure.col.source") }]} />
      <ul className="pb-2">
        {summary.customers.map((row) => (
          <li key={row.ticker} className={cn(CUSTOMER_GRID, ROW)}>
            <span className="flex min-w-0 items-center">
              <TickerLink ticker={row.ticker} />
            </span>
            <span className="flex min-w-0 items-baseline gap-4 overflow-hidden">
              {row.customers.map((c) => (
                <span key={c.key} className="flex min-w-0 shrink items-baseline gap-1.5" title={c.name}>
                  <span className="truncate text-[12.5px] text-[#1d1b1b]">{displayName(c.name)}</span>
                  <span className={cn(NUM, "shrink-0 text-[#4b5563]")}>{sharePct(c.share)}</span>
                </span>
              ))}
            </span>
            <SourceLink source={row.source} />
          </li>
        ))}
      </ul>
    </Section>
  );
}

function OverlapSection({ summary }: { summary: ExposureSummary }) {
  const { t } = useI18n();
  return (
    <Section
      title={summary.scope === "watchlist" ? t("exposure.overlap.titleWatch") : t("exposure.overlap.title")}
      count={summary.overlaps.length}
    >
      <Heads
        grid={OVERLAP_GRID}
        cells={[{ text: t("exposure.col.pair") }, { text: t("exposure.col.shared") }, { text: t("exposure.col.count"), right: true }]}
      />
      <ul className="pb-2">
        {summary.overlaps.map((row) => {
          const shown = row.shared.slice(0, OVERLAP_NAMES);
          const rest = row.shared.slice(OVERLAP_NAMES);
          return (
            <li key={`${row.a}|${row.b}`} className={cn(OVERLAP_GRID, ROW)}>
              <span className="flex min-w-0 items-center gap-2">
                <TickerLink ticker={row.a} />
                <TickerLink ticker={row.b} />
              </span>
              <span className="flex min-w-0 items-baseline gap-3 overflow-hidden">
                {shown.map((s) => (
                  <span key={s.key} title={s.name} className="shrink-0 truncate text-[12.5px] text-[#4b5563]">
                    {displayName(s.name)}
                  </span>
                ))}
                {rest.length > 0 ? (
                  <span title={rest.map((s) => s.name).join("\n")} className="shrink-0 text-[11.5px] text-[#9CA3AF]">
                    {t("exposure.more", { count: rest.length })}
                  </span>
                ) : null}
              </span>
              <span className={cn(NUM, "text-[#1d1b1b]")}>{row.shared.length}</span>
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function GapLine({ summary, canResearch }: { summary: ExposureSummary; canResearch: boolean }) {
  const { t } = useI18n();
  const [queued, setQueued] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  if (summary.gaps.length === 0) return null;
  const names = summary.gaps.map((g) => g.ticker).join(", ");
  const waiting = summary.gaps.filter((g) => !queued.has(g.ticker)).map((g) => g.ticker);
  const text =
    summary.scope === "watchlist"
      ? t("exposure.gaps.lineWatch", { names })
      : t("exposure.gaps.line", { names, pct: exposurePct(summary.gapWeight) });
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t-[0.5px] border-black/[0.06] px-5 py-2.5">
      <p className="min-w-0 text-[12px] leading-[1.5] text-[#6b7280]">{text}</p>
      {canResearch ? (
        waiting.length > 0 ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void researchHoldings(waiting).then((list) => {
                setQueued((q) => new Set([...q, ...list]));
                setBusy(false);
              });
            }}
            className={BUTTON}
          >
            {t("exposure.gaps.research")}
          </button>
        ) : (
          <span className="text-[12px] text-[#9CA3AF]">{t("exposure.gaps.queued")}</span>
        )
      ) : null}
    </div>
  );
}

export default function ExposureTab() {
  const { t } = useI18n();
  const view = useExposure();
  const { summary, scope } = view;

  const noNames = view.positions === 0 && view.watched === 0;
  const empty = summary !== null && summary.shared.length === 0 && summary.customers.length === 0 && summary.overlaps.length === 0;
  const header = summary ? headlineText(t, summary.headline, scope) : null;

  let body: ReactNode;
  if (noNames) {
    body = (
      <Centered>
        <p className="text-[14px] font-medium text-[#1d1b1b]">{t("exposure.empty.noNames")}</p>
        <p className="mt-1.5 max-w-[440px] text-[13px] leading-[1.55] text-[#6b7280]">{t("exposure.empty.noNamesHint")}</p>
      </Centered>
    );
  } else if (!summary && view.error !== null) {
    body = (
      <Centered>
        <p className="text-[14px] font-medium text-[#1d1b1b]">{view.error === "restart" ? t("exposure.error.restart") : t("exposure.error.load")}</p>
        {view.error === "restart" ? null : (
          <button type="button" onClick={view.retry} className={cn(BUTTON, "mt-4")}>
            {t("exposure.error.retry")}
          </button>
        )}
      </Centered>
    );
  } else if (!summary) {
    body = <Skeleton />;
  } else if (summary.companies === 0) {
    body = (
      <Centered>
        <p className="text-[13.5px] text-[#6b7280]">{t("exposure.empty.funds")}</p>
      </Centered>
    );
  } else if (empty) {
    body = (
      <Centered>
        <p className="text-[13.5px] text-[#6b7280]">{t("exposure.empty.none")}</p>
      </Centered>
    );
  } else {
    body = (
      <div className="px-3 pb-3">
        {summary.shared.length > 0 ? <SharedSection key={`${scope}-shared`} summary={summary} /> : null}
        {summary.customers.length > 0 ? <CustomerSection summary={summary} /> : null}
        {summary.overlaps.length > 0 ? <OverlapSection summary={summary} /> : null}
      </div>
    );
  }

  const notes: string[] = [];
  if (summary && !noNames && summary.shared.length > 0) notes.push(t("exposure.note.formula"));
  if (summary && !noNames && scope === "watchlist") notes.push(t("exposure.note.watchEqual"));

  return (
    <div className="app-no-drag px-8 pb-10 pt-5">
      <div className={cn(SURFACE, "overflow-visible")}>
        <div className="flex flex-wrap items-center gap-2 border-b border-black/[0.06] px-4 py-3">
          <Segmented
            value={scope}
            label={t("exposure.scope.label")}
            onChange={view.setScope}
            options={[
              { id: "account" as const, text: t("exposure.scope.account") },
              { id: "watchlist" as const, text: t("exposure.scope.watchlist") },
            ]}
          />
          {summary && !noNames && summary.companies > 0 ? (
            <span className="ml-auto text-[12px] tabular-nums text-[#9CA3AF]" aria-live="polite">
              {t("exposure.coverage", { covered: summary.covered, companies: summary.companies })}
            </span>
          ) : null}
        </div>

        {header && !noNames ? (
          <p className="border-b-[0.5px] border-black/[0.06] px-5 py-2.5 text-[13px] leading-[1.5] text-[#1d1b1b]">{header}</p>
        ) : null}

        {body}

        {summary && !noNames ? <GapLine key={scope} summary={summary} canResearch={scope === "account" && !view.demo} /> : null}

        {notes.length > 0 ? (
          <div className="space-y-1 border-t-[0.5px] border-black/[0.06] px-5 py-3">
            {notes.map((note) => (
              <p key={note} className="text-[11.5px] leading-[1.45] text-[#9CA3AF]">
                {note}
              </p>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
