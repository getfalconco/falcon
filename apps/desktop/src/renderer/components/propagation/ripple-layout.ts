import type { PropagationRole, PropagationTarget } from "../../../shared/propagation-run-types";

/**
 * Deterministic radial layout for the ripple map (spec §8): root at the
 * centre, targets fanned out in fixed role sectors — suppliers left,
 * customers right, competitors below, partners/dependencies above — identical
 * every run. Positions are a pure function of (targets, viewport), so the
 * reveal animation and the chip order never depend on physics. The fan is an
 * ellipse that fits the viewport; dense sectors alternate an inner ring.
 */

export type RippleGroup = "suppliers" | "customers" | "competitors" | "partners";

export const GROUP_OF_ROLE: Record<PropagationRole, RippleGroup> = {
  supplier: "suppliers",
  customer: "customers",
  competitor: "competitors",
  partner: "partners",
  dependency: "partners",
  depended_on_by: "partners",
};

export const GROUP_LABEL: Record<RippleGroup, string> = {
  suppliers: "Suppliers",
  customers: "Customers",
  competitors: "Competitors",
  partners: "Partners & dependencies",
};

/** Centre angle (degrees, SVG clockwise from +x) and max half-spread of each sector. */
const SECTOR: Record<RippleGroup, { center: number; halfSpread: number }> = {
  customers: { center: 0, halfSpread: 30 },
  competitors: { center: 90, halfSpread: 30 },
  suppliers: { center: 180, halfSpread: 30 },
  partners: { center: 270, halfSpread: 30 },
};

export const CHIP_W = 92;
export const CHIP_H = 44;

export type PlacedTarget = {
  key: string;
  target: PropagationTarget;
  group: RippleGroup;
  /** Chip centre. */
  x: number;
  y: number;
  angle: number;
  /** 1 = outer ring, < 1 = inner ring. */
  ring: number;
  /** Reveal order for the stagger. */
  order: number;
};

export type RippleLayout = {
  width: number;
  height: number;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  placed: PlacedTarget[];
  groups: Array<{ group: RippleGroup; count: number; labelX: number; labelY: number; anchor: "start" | "middle" | "end" }>;
};

export function targetKey(t: PropagationTarget): string {
  return `${t.target}|${t.relationship.role}`;
}

const TIER_RANK = { strong: 3, moderate: 2, weak: 1 } as const;
const PRICING_RANK = { open: 5, partial: 4, contradicted: 3, stale: 2, unknown: 1, priced: 0 } as const;

/** Ranking used by both the map (sector order) and the table (open + strong first). */
export function rankTarget(t: PropagationTarget): number {
  const vetoed = t.stage2?.verdict === "vetoed" ? -100 : 0;
  return vetoed + PRICING_RANK[t.pricing.status] * 10 + TIER_RANK[t.transmission.tier];
}

export function compareTargets(a: PropagationTarget, b: PropagationTarget): number {
  const r = rankTarget(b) - rankTarget(a);
  if (r !== 0) return r;
  return (a.ticker ?? a.label).localeCompare(b.ticker ?? b.label);
}

const LABEL_PAD = 14;

export function layoutRipple(targets: PropagationTarget[], width: number, height: number): RippleLayout {
  const cx = width / 2;
  const cy = height / 2;
  // The outer ring: chips must stay inside the viewport with room for the
  // sector labels at the top and bottom edges.
  const rx = Math.max(150, width / 2 - CHIP_W / 2 - 28);
  const ry = Math.max(110, height / 2 - CHIP_H / 2 - 40);

  const byGroup = new Map<RippleGroup, PropagationTarget[]>();
  for (const t of targets) {
    const g = GROUP_OF_ROLE[t.relationship.role];
    const list = byGroup.get(g) ?? [];
    list.push(t);
    byGroup.set(g, list);
  }

  const placed: PlacedTarget[] = [];
  let order = 0;
  for (const group of ["customers", "competitors", "suppliers", "partners"] as RippleGroup[]) {
    const list = (byGroup.get(group) ?? []).sort(compareTargets);
    const n = list.length;
    if (n === 0) continue;
    const { center, halfSpread } = SECTOR[group];
    const spread = n === 1 ? 0 : Math.min(halfSpread, 10 + n * 5);
    // Dense sectors alternate an inner ring so neighbours never touch; the
    // best-ranked chip (open + strong) takes the outer ring first.
    const rings = n > 6 ? [1, 0.76, 0.52] : n > 3 ? [1, 0.66] : [1];
    list.forEach((t, i) => {
      const frac = n === 1 ? 0.5 : i / (n - 1);
      const angle = center - spread + frac * 2 * spread;
      const ring = rings[i % rings.length];
      const rad = (angle * Math.PI) / 180;
      placed.push({
        key: targetKey(t),
        target: t,
        group,
        x: cx + Math.cos(rad) * rx * ring,
        y: cy + Math.sin(rad) * ry * ring,
        angle,
        ring,
        order: order++,
      });
    });
  }

  // Sector labels sit at the viewport edges — deterministic, never clipped.
  const labelPos: Record<RippleGroup, { x: number; y: number; anchor: "start" | "middle" | "end" }> = {
    suppliers: { x: LABEL_PAD, y: LABEL_PAD, anchor: "start" },
    customers: { x: width - LABEL_PAD, y: LABEL_PAD, anchor: "end" },
    partners: { x: cx, y: LABEL_PAD, anchor: "middle" },
    competitors: { x: cx, y: height - LABEL_PAD, anchor: "middle" },
  };
  const groups = (["suppliers", "partners", "customers", "competitors"] as RippleGroup[])
    .filter((g) => (byGroup.get(g)?.length ?? 0) > 0)
    .map((group) => ({
      group,
      count: byGroup.get(group)?.length ?? 0,
      labelX: labelPos[group].x,
      labelY: labelPos[group].y,
      anchor: labelPos[group].anchor,
    }));

  return { width, height, cx, cy, rx, ry, placed, groups };
}
