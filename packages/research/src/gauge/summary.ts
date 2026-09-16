/**
 * Summary semantics (spec §4): evaluable counts, overall state, the binding
 * line (worst check's reason verbatim — fail > caution, lower check number on
 * ties) and the one-sentence readout. No composite score, by design.
 */

import type { GaugeConfig } from "./config.js";
import { fill } from "./templates.js";
import type { GaugeCheck, GaugeOverall, GaugeSummary } from "./types.js";

const SEVERITY: Record<GaugeCheck["status"], number> = { fail: 3, caution: 2, pass: 1, n_a: 0 };

/** The most constraining check: fail beats caution; among equals the lower §3 number wins. Null when nothing is caution/fail. */
export function worstCheck(checks: GaugeCheck[]): GaugeCheck | null {
  let worst: GaugeCheck | null = null;
  for (const c of checks) {
    if (c.status !== "fail" && c.status !== "caution") continue;
    if (!worst || SEVERITY[c.status] > SEVERITY[worst.status] || (SEVERITY[c.status] === SEVERITY[worst.status] && c.number < worst.number)) worst = c;
  }
  return worst;
}

export function summarize(checks: GaugeCheck[], config: GaugeConfig): GaugeSummary {
  const T = config.templates;
  const evaluable = checks.filter((c) => c.status !== "n_a");
  const aligned = evaluable.filter((c) => c.status === "pass").length;
  const cautions = evaluable.filter((c) => c.status === "caution").length;
  const fails = evaluable.filter((c) => c.status === "fail").length;
  const unavailable = checks.length - evaluable.length;

  const overall: GaugeOverall = fails > 0 ? "blocked" : cautions >= 2 ? "mixed" : "clear";
  const worst = worstCheck(checks);

  // G2: mixed is a plurality — the binding line names every caution (short labels, check order)
  // instead of one "worst" row. Clear/blocked keep the single most constraining line.
  let binding_line: string;
  let sentence: string;
  if (overall === "mixed") {
    const labels = evaluable
      .filter((c) => c.status === "caution")
      .sort((a, b) => a.number - b.number)
      .map((c) => c.short_label ?? c.label.toLowerCase());
    binding_line = fill(T, "summary_mixed", { n: cautions, labels: labels.join(", ") });
    sentence = binding_line;
  } else if (overall === "blocked" && worst) {
    binding_line = worst.reason;
    sentence = fill(T, "summary_blocked", { reason: worst.reason });
  } else if (worst) {
    binding_line = worst.reason;
    sentence = fill(T, "summary_clear_except", { check: worst.label.toLowerCase(), reason: worst.reason });
  } else {
    binding_line = fill(T, "summary_clear_all", { aligned, evaluable: evaluable.length });
    sentence = binding_line;
  }

  return {
    evaluable: evaluable.length,
    aligned,
    cautions,
    fails,
    unavailable,
    overall,
    binding_check: worst?.key ?? null,
    binding_line,
    sentence,
    calibrating: unavailable >= config.calibratingNaCount,
    tooltip: fill(T, `tooltip_${overall}`),
  };
}
