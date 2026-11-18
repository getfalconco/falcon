"use client";

import { useEffect, useMemo, useState } from "react";
import { Activity, Building2, CircleDot, Layers, Link2, Signal, Sparkles, Target } from "lucide-react";
import type { Filter, FilterFieldDef, FilterOption } from "@/components/ui/filter-token-bar";
import type { GraphAll } from "@/lib/workspace/graph";
import { IV_LEVELS, ivCuts, type GraphFilterContext } from "@/lib/workspace/graph-filter";

/**
 * The fields of the Graph tab's filter bar and where its filters are kept.
 * What each filter does: lib/workspace/graph-filter.ts.
 */

const icon = (Icon: typeof Link2) => <Icon width={13} height={13} strokeWidth={1.8} aria-hidden />;

/** Payload relation codes (scripts/graph-shards.mjs): what the target is to the source. */
const RELATIONS: FilterOption[] = [
  { value: "1", label: "Customer" },
  { value: "0", label: "Supplier" },
  { value: "2", label: "Competitor" },
  { value: "3", label: "Partner" },
];

/** Payload strength codes: 3 critical, 2 important, 1 marginal. */
const STRENGTHS: FilterOption[] = [
  { value: "3", label: "Critical" },
  { value: "2", label: "Important" },
  { value: "1", label: "Marginal" },
];

const SIZES: FilterOption[] = [1, 3, 5, 10, 20].map((n) => ({ value: String(n), label: `${n} ${n === 1 ? "link" : "links"}` }));

const IS_IS_NOT = [
  { value: "is", label: "is" },
  { value: "is_not", label: "is not" },
];

const COMPANY_LIMIT = 60;

/** "Nov 13" from "2026-11-13"; "the latest session" without a date. */
function sessionLabel(asOf: string | null): string {
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) return "the latest session";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(`${asOf}T00:00:00Z`));
}

function ivOptions(ctx: GraphFilterContext): FilterOption[] {
  const { high, veryHigh, count } = ivCuts(ctx.iv);
  const pct = (v: number) => `${Math.round(v)}%`;
  const on = sessionLabel(ctx.ivAsOf);
  return [
    { value: "very_high", label: `Very high · top 10% on ${on} (≥${pct(veryHigh)})` },
    { value: "high", label: `High · top 25% on ${on} (≥${pct(high)})` },
    ...IV_LEVELS.map((n) => ({ value: `ge${n}`, label: `≥${n}% · ${on}` })),
    { value: "any", label: `Any · ${count.toLocaleString("en-US")} ${count === 1 ? "name" : "names"} priced ${on}` },
  ];
}

export function graphFilterFields(whole: GraphAll | null | undefined, ctx: GraphFilterContext): FilterFieldDef[] {
  // Biggest companies first, so an empty search shows the hubs.
  const companies = (whole?.n ?? []).slice().sort((a, b) => b[2] - a[2]);
  const loadOptions = async (query: string): Promise<FilterOption[]> => {
    const q = query.trim().toLowerCase();
    const lead = (t: string) => (t.toLowerCase() === q ? 2 : t.toLowerCase().startsWith(q) ? 1 : 0);
    const hits = q
      ? companies.filter(([t, name]) => t.toLowerCase().startsWith(q) || name.toLowerCase().includes(q)).sort((a, b) => lead(b[0]) - lead(a[0]))
      : companies;
    return hits.slice(0, COMPANY_LIMIT).map(([t, name]) => ({ value: t, label: name && name !== t ? `${t} · ${name}` : t }));
  };
  const sectors = Array.from(new Set(companies.map((c) => c[3] ?? "").filter(Boolean))).sort();

  const fields: FilterFieldDef[] = [
    {
      id: "relation",
      label: "Relation",
      icon: icon(Link2),
      operators: [
        { value: "is_any", label: "is any of", multi: true },
        { value: "is", label: "is" },
      ],
      options: RELATIONS,
    },
    {
      id: "strength",
      label: "Strength",
      icon: icon(Signal),
      operators: [{ value: "is_any", label: "is any of", multi: true }],
      options: STRENGTHS,
    },
    {
      id: "company",
      label: "Company",
      icon: icon(Building2),
      operators: [{ value: "is_any", label: "is any of", multi: true }],
      loadOptions,
    },
  ];
  if (sectors.length) {
    fields.push({
      id: "sector",
      label: "Sector",
      icon: icon(Layers),
      operators: [
        { value: "is_any", label: "is any of", multi: true },
        { value: "is_not_any", label: "is none of", multi: true },
      ],
      options: sectors.map((s) => ({ value: s, label: s })),
    });
  }
  fields.push(
    {
      id: "size",
      label: "Size",
      icon: icon(CircleDot),
      operators: [{ value: "at_least", label: "at least" }],
      options: SIZES,
    },
    {
      // The field id stays "focus" (saved filters and Falcon AI's actions use it); it is the portfolio.
      id: "focus",
      label: "Portfolio",
      icon: icon(Target),
      operators: IS_IS_NOT,
      options: [{ value: "in", label: "In my portfolio" }],
    },
    {
      id: "opportunity",
      label: "Opportunities",
      icon: icon(Sparkles),
      operators: IS_IS_NOT,
      options: [{ value: "has", label: "Listed today" }],
    },
  );
  // Whenever /api/options?all=1 returns data (OPTIONS_DISPLAY decides on the server who gets it).
  if (ctx.iv.size) {
    fields.push({
      id: "iv",
      label: "Implied vol",
      icon: icon(Activity),
      operators: [{ value: "is_any", label: "is any of", multi: true }],
      options: ivOptions(ctx),
    });
  }
  return fields;
}

/** Fields rebuilt when the graph, today's feed or the options data changes (the company search reads the node list). */
export function useGraphFilterFields(whole: GraphAll | null | undefined, ctx: GraphFilterContext): FilterFieldDef[] {
  return useMemo(() => graphFilterFields(whole, ctx), [whole, ctx]);
}

/* ------------------------------------------------------------------ */
/* Saved per workspace for the browser session                          */
/* ------------------------------------------------------------------ */

const KEY_PREFIX = "falcon.graph-filters.v1";

function readFilters(scope: string): Filter[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.sessionStorage.getItem(`${KEY_PREFIX}:${scope}`);
    const list: unknown = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (f): f is Filter =>
          !!f &&
          typeof f === "object" &&
          typeof f.id === "string" &&
          typeof f.field === "string" &&
          typeof f.operator === "string" &&
          Array.isArray(f.values) &&
          f.values.every((v: unknown) => typeof v === "string"),
      )
      .slice(0, 20);
  } catch {
    return [];
  }
}

/** The filter list for this workspace (`scope` is its storage scope), kept in sessionStorage. */
export function useGraphFilters(scope: string): [Filter[], (filters: Filter[]) => void] {
  const [filters, setFilters] = useState<Filter[]>(() => readFilters(scope));
  // Falcon AI sets the filters from the Desk (lab/app-bridge.ts pushGraphFilters).
  useEffect(() => {
    const onPush = (e: Event) => {
      const d = (e as CustomEvent<{ scope?: string; filters?: Filter[] }>).detail;
      if (d?.scope === scope && Array.isArray(d.filters)) setFilters(d.filters);
    };
    window.addEventListener("falcon:graph-filters", onPush);
    return () => window.removeEventListener("falcon:graph-filters", onPush);
  }, [scope]);
  useEffect(() => {
    try {
      const key = `${KEY_PREFIX}:${scope}`;
      if (filters.length) window.sessionStorage.setItem(key, JSON.stringify(filters));
      else window.sessionStorage.removeItem(key);
    } catch {
      // Blocked storage: the filters last as long as the tab.
    }
  }, [filters, scope]);
  return [filters, setFilters];
}
