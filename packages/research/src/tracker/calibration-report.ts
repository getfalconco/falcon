/**
 * Tracker calibration report over the live data dir (shadow-mode readout).
 * Run: npx tsx src/tracker/calibration-report.ts  → prints + writes markdown.
 */
import fs from "node:fs";
import path from "node:path";
import { addTradingDays, nyYmd, tradingDaysBetween } from "./calendar.js";
import { DEFAULT_TRACKER_CONFIG } from "./config.js";
import { computeGapStats, computeQuantContext } from "./quant.js";
import { driftScore, olsBeta, simpleReturns } from "./math.js";
import type { DailyBar, TickerState, TrackerMessage } from "./types.js";

const dir = "C:/Users/zelqd/Desktop/Meridian/apps/desktop/data/tracker";
const cfg = DEFAULT_TRACKER_CONFIG;
const bench: DailyBar[] = JSON.parse(fs.readFileSync(path.join(dir, "spy-bars.json"), "utf8")).bars;
const states: TickerState[] = fs
  .readdirSync(path.join(dir, "state"))
  .map((f) => JSON.parse(fs.readFileSync(path.join(dir, "state", f), "utf8")));
const messages: TrackerMessage[] = fs
  .readFileSync(path.join(dir, "messages.jsonl"), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l));

const out: string[] = [];
const p = (s = "") => out.push(s);
const pct = (v: number | null) => (v == null ? "—" : `${(v * 100).toFixed(1)}%`);
const f = (v: number | null | undefined, d = 2) => (v == null || Number.isNaN(v) ? "—" : v.toFixed(d));
const percentile = (xs: number[], q: number) => {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))];
};
const today = nyYmd(new Date());

// ---------------------------------------------------------------------------
p("# Tracker kalibrasyon raporu");
p();
const firstTs = messages.map((m) => m.timestamp).sort()[0];
const shadowStart = nyYmd(new Date(firstTs));
const shadowDays = Math.max(1, tradingDaysBetween(shadowStart, today) + 1);
p(`Shadow başlangıcı: ${shadowStart} · bugün ${today} · **${shadowDays} işlem günü** · ${states.length} ticker · ${messages.length} mesaj`);
p();

// 1. Detector firing table ---------------------------------------------------
p("## 1. Dedektör tetikleme tablosu");
p();
const ANOM = ["gap_event","volume_anomaly","silence_anomaly","filing_overdue","unexplained_move","drift_event","news_burst","insider_cluster"];
p("| Dedektör | Toplam | Gün/ort | Ticker sayısı | Dağılım |");
p("|---|---:|---:|---:|---|");
for (const t of ANOM) {
  const ms = messages.filter((m) => m.type === t);
  const byT: Record<string, number> = {};
  for (const m of ms) byT[m.ticker] = (byT[m.ticker] ?? 0) + 1;
  const dist = Object.entries(byT).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(" ");
  p(`| ${t} | ${ms.length} | ${(ms.length / shadowDays).toFixed(2)} | ${Object.keys(byT).length} | ${dist || "—"} |`);
}
p();
const never = ANOM.filter((t) => !messages.some((m) => m.type === t));
p(`Hiç ateşlemeyen: **${never.join(", ") || "yok"}**`);
const chan: Record<string, number> = {};
for (const m of messages) if (!ANOM.includes(m.type)) chan[m.type] = (chan[m.type] ?? 0) + 1;
p(`Kanal mesajları: ${Object.entries(chan).map(([k, v]) => `${k} ${v}`).join(" · ")}`);
// catch_up share among close-run messages
const closeRun = messages.filter((m) => ["volume_anomaly","silence_anomaly","filing_overdue","unexplained_move","drift_event"].includes(m.type));
const cu = closeRun.filter((m) => (m.payload as any).catch_up === true).length;
p(`Kapanış koşusu mesajları: ${closeRun.length}, catch_up=true: ${cu} (bayrak bu turdan itibaren yazılıyor; eski mesajlarda alan yok)`);
p();

// 2. Metric distributions — replay last N closes -------------------------------
p("## 2. Metrik dağılımları (tetiklenmemişler dahil)");
p();
const N_CLOSES = 60;
type Row = { day: string; ticker: string; resid: number | null; move: number | null; vol: number | null; drift: number | null; gap: number | null; r2: number | null };
const rows: Row[] = [];
for (const s of states) {
  const days = s.bars.map((b) => b.d);
  const lastDays = days.slice(-N_CLOSES);
  for (const day of lastDays) {
    const cut = { ...s, bars: s.bars.filter((b) => b.d <= day) };
    const bb = bench.filter((b) => b.d <= day);
    const q = computeQuantContext({ state: cut, benchBars: bb, config: cfg, now: new Date(`${day}T21:00:00Z`), quote: null, benchQuote: null, asOfCompletedSession: true });
    const g = computeGapStats(cut.bars, cfg);
    rows.push({ day, ticker: s.ticker, resid: q.residual_zscore, move: q.move_zscore, vol: q.volume_ratio, drift: driftScore(q.momentum_5d, q.daily_vol_30d), gap: g?.gapZ ?? null, r2: q.r_squared });
  }
}
const metrics: Array<[string, (r: Row) => number | null, number[]]> = [
  ["|residual_zscore|", (r) => (r.resid == null ? null : Math.abs(r.resid)), [2.0, 2.5, 3.0]],
  ["|move_zscore|", (r) => (r.move == null ? null : Math.abs(r.move)), [2.0, 2.5, 3.0]],
  ["volume_ratio", (r) => r.vol, [2.0, 3.0, 4.0]],
  ["drift_z", (r) => r.drift, [2.0, 2.5, 3.0]],
  ["|gap_z|", (r) => (r.gap == null ? null : Math.abs(r.gap)), [2.0, 2.5, 3.0]],
];
p(`Replay: son ${N_CLOSES} kapanış × ${states.length} ticker = ${rows.length} ticker-gün (saf fonksiyonlar bar geçmişi üzerinde yeniden koşturuldu; hepsi kapanış sonrası, quote yok).`);
p();
p("| Metrik | n | p50 | p90 | p95 | p99 | max | >eşik1 | >eşik2 | >eşik3 | /gün@eşik1 |");
p("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const [name, get, th] of metrics) {
  const xs = rows.map(get).filter((v): v is number => v != null && Number.isFinite(v));
  const over = th.map((t) => xs.filter((v) => v > t).length);
  p(`| ${name} | ${xs.length} | ${f(percentile(xs, .5))} | ${f(percentile(xs, .9))} | ${f(percentile(xs, .95))} | ${f(percentile(xs, .99))} | ${f(Math.max(...xs))} | ${over[0]} (>${th[0]}) | ${over[1]} (>${th[1]}) | ${over[2]} (>${th[2]}) | ${(over[0] / N_CLOSES).toFixed(1)} |`);
}
p();
p("Yorum için: '/gün@eşik1' = eşik 2.0'da evren genelinde günde kaç ticker-gün eşiği geçiyor (unexplained_move için ayrıca haber-yok ve earnings-dışı koşulları var, gerçek tetik daha az).");
p();
// per-ticker worst offenders for resid/move at 2.0
const byTicker: Record<string, { resid: number; move: number; vol: number; drift: number }> = {};
for (const r of rows) {
  const b = (byTicker[r.ticker] ??= { resid: 0, move: 0, vol: 0, drift: 0 });
  if (r.resid != null && Math.abs(r.resid) > 2) b.resid++;
  if (r.move != null && Math.abs(r.move) > 2) b.move++;
  if (r.vol != null && r.vol > 3) b.vol++;
  if (r.drift != null && r.drift > 2) b.drift++;
}
p(`Eşik aşımı en yüksek ticker'lar (son ${N_CLOSES} kapanış):`);
p();
p("| Ticker | |resid_z|>2 | |move_z|>2 | vol_ratio>3 | drift_z>2 |");
p("|---|---:|---:|---:|---:|");
Object.entries(byTicker).sort((a, b) => (b[1].resid + b[1].move + b[1].vol + b[1].drift) - (a[1].resid + a[1].move + a[1].vol + a[1].drift)).slice(0, 12)
  .forEach(([t, b]) => p(`| ${t} | ${b.resid} | ${b.move} | ${b.vol} | ${b.drift} |`));
p();

// 3. r² distribution -----------------------------------------------------------
p("## 3. r² dağılımı (tüm evren)");
p();
const r2rows = states.map((s) => {
  // earnings-day exclusion experiment
  const cut = s.bars;
  const bByDay = new Map(bench.map((b) => [b.d, b]));
  const at: DailyBar[] = [], ab: DailyBar[] = [];
  for (const bar of cut) { const m = bByDay.get(bar.d); if (m) { at.push(bar); ab.push(m); } }
  const y = simpleReturns(at.map((b) => b.c)), x = simpleReturns(ab.map((b) => b.c));
  const days = at.slice(1).map((b) => b.d);
  const base = olsBeta(y, x, 90);
  // reaction days: earnings date (bmo/dmh) or next session (amc)
  const reaction = new Set<string>();
  for (const e of s.earnings) {
    const idx = days.indexOf(e.date);
    if (e.hour === "amc") { const nx = days.find((d) => d > e.date); if (nx) reaction.add(nx); }
    else if (idx >= 0) reaction.add(e.date); else { const nx = days.find((d) => d > e.date); if (nx) reaction.add(nx); }
  }
  const keep = days.map((_, i) => i).slice(-90).filter((i) => !reaction.has(days[i]));
  const ex = keep.length >= 60 ? olsBeta(keep.map((i) => y[i]), keep.map((i) => x[i]), keep.length) : null;
  return { t: s.ticker, r2: s.quant?.r_squared ?? base?.r2 ?? null, beta: s.quant?.beta_90d ?? base?.beta ?? null, r2ex: ex?.r2 ?? null, betaex: ex?.beta ?? null, excl: [...reaction].filter((d) => days.slice(-90).includes(d)).length };
}).sort((a, b) => (a.r2 ?? 0) - (b.r2 ?? 0));
const fallback = r2rows.filter((r) => r.r2 != null && r.r2 < cfg.thresholds.lowR2Fallback).length;
const r2s = r2rows.map((r) => r.r2).filter((v): v is number => v != null);
p(`Fallback (r² < ${cfg.thresholds.lowR2Fallback}) kapsamı: **${fallback}/${r2rows.length} ticker = ${pct(fallback / r2rows.length)}** → evrenin bu kadarı move_zscore yolunda. Medyan r² ${f(percentile(r2s, .5), 3)}, p90 ${f(percentile(r2s, .9), 3)}.`);
p();
p("Earnings-günü dışlama deneyi: 90 günlük pencereden earnings tepki günleri çıkarılınca r² ne oluyor (v2 kararı için, şimdilik sadece gözlem).");
p();
p("| Ticker | beta | r² | fallback | earnings günü (90d içinde) | r² (earnings hariç) | beta (hariç) |");
p("|---|---:|---:|:-:|---:|---:|---:|");
for (const r of r2rows) p(`| ${r.t} | ${f(r.beta)} | ${f(r.r2, 3)} | ${r.r2 != null && r.r2 < cfg.thresholds.lowR2Fallback ? "✓" : ""} | ${r.excl} | ${f(r.r2ex, 3)} | ${f(r.betaex)} |`);
p();
const gains = r2rows.filter((r) => r.r2 != null && r.r2ex != null).map((r) => (r.r2ex! - r.r2!));
p(`Dışlama etkisi: medyan Δr² ${f(percentile(gains, .5), 3)}, max Δr² ${f(Math.max(...gains), 3)}; dışlama sonrası fallback'te kalan ${r2rows.filter((r) => r.r2ex != null && r.r2ex < cfg.thresholds.lowR2Fallback).length} ticker.`);
p();

// 4. Channel health ------------------------------------------------------------
p("## 4. Kanal sağlığı");
p();
p("| Kanal | Şu an hatalı | En eski last_success_at | Hata metinleri |");
p("|---|---:|---|---|");
for (const ch of ["news","filings","calendar","price"] as const) {
  const errs = states.filter((s) => s.health[ch].last_error);
  const oldest = states.map((s) => s.health[ch].last_success_at).filter(Boolean).sort()[0] ?? "—";
  const texts = [...new Set(errs.map((s) => String(s.health[ch].last_error).slice(0, 40)))].join("; ");
  p(`| ${ch} | ${errs.length}/${states.length} | ${oldest} | ${texts || "—"} |`);
}
p();
const stale = states.filter((s) => s.lastNewsPollAt && Date.now() - Date.parse(s.lastNewsPollAt) > 2 * 3600e3);
p(`Haber poll'u 2 saatten eski olan ticker: ${stale.length} ${stale.length ? "(" + stale.map((s) => s.ticker).join(",") + ")" : ""}`);
const under30 = states.filter((s) => Object.keys(s.newsCounts).length < 30);
p(`Haber tabanı 30 günün altında (silence/news_burst kapalı): ${under30.length} ${under30.length ? "(" + under30.map((s) => s.ticker + ":" + Object.keys(s.newsCounts).length).join(",") + ")" : ""}`);
const notSeeded = states.filter((s) => !s.insiderBackfilledAt);
p(`Insider fazı tamamlanmamış: ${notSeeded.length}`);
const ip = states.reduce((a, s) => ({ att: a.att + s.insiderParse.attempted, par: a.par + s.insiderParse.parsed, kept: a.kept + s.insiderParse.kept }), { att: 0, par: 0, kept: 0 });
p(`Form 4 ingest toplamı: attempted ${ip.att} · parsed ${ip.par} · kept ${ip.kept}`);
p(`429 backoff sayacı **tutulmuyor** — health yalnızca son denemenin durumunu saklıyor, sayaç loga gidiyor. Kalıcı sayaç için ayrı iş.`);
p();

// 5. earnings_window coverage -----------------------------------------------------
p("## 5. earnings_window kapsaması (önümüzdeki 14 gün)");
p();
const horizon = addTradingDays(today, 10);
const upcoming: Array<{ t: string; due: string; conf: boolean; emitted: boolean }> = [];
const sched = new Set(messages.filter((m) => m.type === "scheduled_event").map((m) => `${m.ticker}|${(m.payload as any).due_at}`));
for (const s of states) for (const e of s.scheduledEarnings) {
  const d = e.dueAt.slice(0, 10);
  if (d >= today && d <= horizon) upcoming.push({ t: s.ticker, due: d, conf: e.confirmed, emitted: sched.has(`${s.ticker}|${e.dueAt}`) });
}
upcoming.sort((a, b) => a.due.localeCompare(b.due));
p(`Pencere: ${today} → ${horizon} (10 işlem günü). Evrende **${upcoming.length}** earnings, scheduled_event üretilmiş: **${upcoming.filter((u) => u.emitted).length}**.`);
p();
p("| Tarih | Ticker | confirmed | scheduled_event |");
p("|---|---|:-:|:-:|");
for (const u of upcoming) p(`| ${u.due} | ${u.t} | ${u.conf ? "✓" : "—"} | ${u.emitted ? "✓" : "**✗**"} |`);
p();
const noSched = states.filter((s) => s.scheduledEarnings.length === 0).map((s) => s.ticker);
p(`Hiç scheduled earnings'i olmayan ticker: ${noSched.join(", ") || "yok"}`);

fs.writeFileSync("C:/Users/zelqd/AppData/Local/Temp/claude/C--Users-zelqd-Desktop-Meridian/960f1ec6-aca4-4bd0-a5e0-a93d9fe3da46/scratchpad/tracker-calibration-report.md", out.join("\n"));
console.log(out.join("\n"));
