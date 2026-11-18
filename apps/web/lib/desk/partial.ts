/**
 * The last words of a strategy test that ran out of time (app/api/desk/chat).
 * A reply has a fixed number of requests (MAX_RESUMES). In its last one the
 * route makes the model answer in text before time runs out (FINAL_NOTE); if
 * even that fails, the route writes this summary itself, so the member always
 * gets what ran, what it showed and what did not run, never an empty reply.
 * Pure (no network), so node:test can check it.
 */

import type { RunResult } from "./run-result";

/** Appended to the last tool results of a reply's final request, with tool_choice none. */
export const FINAL_NOTE =
  "(Falcon: this reply has reached its time limit and no more tools can run. Answer now, in the member's language: what ran and its key numbers (copied from the tool results), what did not run (for example the audit), and the evidence label: if the audit did not run, say the result is unaudited and only a first look. Do not promise to continue.)";

type Block = { type?: string; name?: string; id?: string; tool_use_id?: string; content?: unknown; is_error?: boolean; input?: unknown };
type Turn = { role: string; content?: unknown };

const blocks = (t: Turn): Block[] => (Array.isArray(t.content) ? (t.content as Block[]) : []);

function resultText(b: Block): string {
  if (typeof b.content === "string") return b.content;
  if (Array.isArray(b.content)) return b.content.map((c) => (c && typeof c === "object" && typeof (c as { text?: unknown }).text === "string" ? (c as { text: string }).text : "")).join("");
  return "";
}

function json(s: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(s);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type RunSteps = {
  /** load_events: rows loaded (null when it was not called or failed). */
  events: number | null;
  /** load_prices: tickers loaded (null when no load finished). */
  prices: number | null;
  /** Code execution commands run. */
  commands: number;
  /** audit_run finished with a verdict (not deferred, not failed). */
  audited: boolean;
};

/** What a reply's turns did so far. `auditTool` is the audit tool's name (lib/desk/audit-run.ts). */
export function runSteps(turns: readonly Turn[], auditTool = "audit_run"): RunSteps {
  const names = new Map<string, string>();
  const out: RunSteps = { events: null, prices: null, commands: 0, audited: false };
  for (const t of turns) {
    for (const b of blocks(t)) {
      if (b.type === "tool_use" && b.id && b.name) names.set(b.id, b.name);
      else if (b.type === "server_tool_use" && b.name === "bash_code_execution") out.commands++;
      else if (b.type === "tool_result" && b.tool_use_id && !b.is_error) {
        const name = names.get(b.tool_use_id);
        const r = json(resultText(b));
        if (!r || typeof r.error === "string") continue;
        if (name === "load_events" && typeof r.rows === "number") out.events = (out.events ?? 0) + r.rows;
        else if (name === "load_prices" && typeof r.tickers_loaded === "number") out.prices = Math.max(out.prices ?? 0, r.tickers_loaded);
        else if (name === auditTool) out.audited = true;
      }
    }
  }
  return out;
}

const pct = (v: number | null | undefined) => (typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "n/a");
const num = (v: number | null | undefined, d = 2) => (typeof v === "number" && Number.isFinite(v) ? v.toFixed(d) : "n/a");

/** Turkish when the member wrote in Turkish (its letters), else English. */
export function replyLanguage(text: string): "tr" | "en" {
  return /[çğışöüÇĞİŞÖÜ]/.test(text) ? "tr" : "en";
}

/**
 * A short, honest Markdown summary of a strategy test cut off for good: what ran, the result's headline numbers if
 * the script finished, and what did not run. Never claims more than the turns show.
 */
export function partialRunSummary(o: { turns: readonly Turn[]; result: RunResult | null; lang: "tr" | "en"; auditTool?: string }): string {
  const s = runSteps(o.turns, o.auditTool);
  const r = o.result;
  const m = r?.metrics;
  const tr = o.lang === "tr";
  const ran: string[] = [];
  const not: string[] = [];
  if (s.events !== null) ran.push(tr ? `olaylar yüklendi (${s.events.toLocaleString("tr-TR")} satır)` : `events loaded (${s.events.toLocaleString("en-US")} rows)`);
  if (s.prices !== null) ran.push(tr ? `fiyatlar yüklendi (${s.prices.toLocaleString("tr-TR")} hisse)` : `prices loaded (${s.prices.toLocaleString("en-US")} tickers)`);
  else not.push(tr ? "fiyat yüklemesi" : "the price load");
  if (s.commands) ran.push(tr ? `test kodu çalıştı (${s.commands} komut)` : `the test script ran (${s.commands} command${s.commands === 1 ? "" : "s"})`);
  if (!r) not.push(tr ? "testin sonucu (sonuç dosyası yazılmadı)" : "the test's result (no result file was written)");
  if (!s.audited) not.push(tr ? "bağımsız denetim" : "the independent audit");
  const lines: string[] = [];
  lines.push(tr ? "**Bu yanıt süre sınırına ulaştı; işte gelinen nokta.**" : "**This reply reached its time limit; here is where it got to.**");
  if (ran.length) lines.push(`${tr ? "Çalışanlar" : "Ran"}: ${ran.join("; ")}.`);
  if (r && m) {
    const bench = r.benchmark || "SPY";
    lines.push(
      tr
        ? `Sonuç (${r.period.start} – ${r.period.end}): toplam getiri ${pct(m.total_return)} (${bench}: ${pct(m.benchmark?.total_return)}), yıllık ${pct(m.cagr)}, Sharpe ${num(m.sharpe)}, en büyük düşüş ${pct(m.max_dd)}, ${r.closed_trades ?? m.trades ?? r.trade_count} işlem.`
        : `Result (${r.period.start} to ${r.period.end}): total return ${pct(m.total_return)} (${bench}: ${pct(m.benchmark?.total_return)}), CAGR ${pct(m.cagr)}, Sharpe ${num(m.sharpe)}, max drawdown ${pct(m.max_dd)}, ${r.closed_trades ?? m.trades ?? r.trade_count} trades.`,
    );
  }
  if (not.length) lines.push(`${tr ? "Çalışmayanlar" : "Did not run"}: ${not.join("; ")}.`);
  lines.push(
    s.audited
      ? tr
        ? "Kanıt etiketi sonuç panelindeki denetimdedir."
        : "The evidence label is the audit's, in the results panel."
      : tr
        ? "Kanıt etiketi: **Denetlenmedi** — bu yalnızca bir ilk bakıştır. Daha az şey isteyerek (ör. daha kısa dönem) tekrar sorarsanız test denetimle birlikte tamamlanabilir."
        : "Evidence label: **Unaudited** — a first look only. Ask again for less at once (e.g. a shorter period) and the test can finish with its audit.",
  );
  return lines.join("\n\n");
}
