import { useMemo, useState } from "react";
import { useI18n } from "@/lib/i18n";
import { useReducedMotionPref } from "@/lib/motion";
import { openStock } from "@/lib/stock-open";
import { cn } from "@/lib/utils";
import type { StockGraphTab } from "../../../../shared/stock-graph";
import { VIEW_H, VIEW_W, type EgoLayout, type LayoutNode } from "./ego-layout";

/**
 * The drawing: the stock in the middle, its neighbours around it by group,
 * a few second-hop companies outside. Static SVG, placed by `egoLayout`; the
 * only movement is a fade when a group is picked or a node is pointed at, and
 * that goes too when motion is reduced.
 *
 * Colours are the graph screen's category colours (mid tones that sit on the
 * cream and on the dark canvas alike); everything else is a theme token.
 */

export const TAB_COLOR: Record<StockGraphTab, string> = {
  suppliers: "#5b8fbf",
  customers: "#5a9e78",
  competitors: "#b86b6b",
  dependencies: "#8b7bb8",
};

const NEUTRAL = "var(--text-tertiary)";

function labelPlacement(node: LayoutNode): { dx: number; dy: number; anchor: "start" | "middle" | "end" } {
  const dx = node.x - VIEW_W / 2;
  const dy = node.y - VIEW_H / 2;
  const r = node.hop === 1 ? 9 : 7;
  // Side nodes carry their label outward; top and bottom ones above or below.
  if (Math.abs(dx) / (VIEW_W / 2) > Math.abs(dy) / (VIEW_H / 2) * 0.9) {
    return dx < 0 ? { dx: -r, dy: 3.5, anchor: "end" } : { dx: r, dy: 3.5, anchor: "start" };
  }
  return dy < 0 ? { dx: 0, dy: -r, anchor: "middle" } : { dx: 0, dy: r + 8, anchor: "middle" };
}

export default function EgoGraph({
  layout,
  ticker,
  selected,
  held,
  watching,
}: {
  layout: EgoLayout;
  ticker: string;
  selected: StockGraphTab | null;
  held: ReadonlySet<string>;
  watching: ReadonlySet<string>;
}) {
  const { t } = useI18n();
  const reduced = useReducedMotionPref();
  const [hover, setHover] = useState<string | null>(null);
  const byId = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  const touching = useMemo(() => {
    if (!hover) return null;
    const ids = new Set([hover]);
    for (const e of layout.edges) {
      if (e.from === hover) ids.add(e.to);
      if (e.to === hover) ids.add(e.from);
    }
    return ids;
  }, [hover, layout]);

  const nodeOpacity = (node: LayoutNode): number => {
    if (touching) return touching.has(node.id) ? 1 : 0.35;
    if (selected && node.hop > 0 && node.tab !== selected) return 0.45;
    return 1;
  };
  const fade = reduced ? "" : "transition-opacity duration-150";

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      role="img"
      aria-label={t("stocktab.graph.drawing", { ticker })}
      className="block h-auto w-full max-h-[300px] select-none"
    >
      <g>
        {layout.edges.map((e) => {
          const a = byId.get(e.from);
          const b = byId.get(e.to);
          if (!a || !b) return null;
          const color = e.tab ? TAB_COLOR[e.tab] : NEUTRAL;
          const lit = touching ? touching.has(e.from) && touching.has(e.to) : !selected || e.tab === selected;
          const base = e.hop === 1 ? (e.weak ? 0.45 : 0.8) : e.weak ? 0.25 : 0.45;
          return (
            <line
              key={e.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke={color}
              strokeWidth={e.hop === 1 ? (e.link.tier === "critical" ? 2 : 1.4) : 1}
              strokeDasharray={e.weak ? "3 3" : undefined}
              strokeLinecap="round"
              opacity={lit ? base : base * 0.3}
              className={fade}
            >
              {e.weak ? <title>{t("stocktab.graph.weak")}</title> : null}
            </line>
          );
        })}
      </g>
      <g>
        {layout.nodes.map((node) => {
          if (node.hop === 0) {
            return (
              <g key={node.id}>
                <circle cx={node.x} cy={node.y} r={21} style={{ fill: "var(--primary-bg)" }} />
                <text
                  x={node.x}
                  y={node.y + 3.5}
                  textAnchor="middle"
                  className="font-sans text-[10.5px] font-semibold"
                  style={{ fill: "var(--primary-fg)" }}
                >
                  {node.label}
                </text>
              </g>
            );
          }
          const color = node.hop === 1 && node.tab ? TAB_COLOR[node.tab] : NEUTRAL;
          const place = labelPlacement(node);
          const clickable = node.ticker !== null;
          const own = node.ticker !== null && (held.has(node.ticker) || watching.has(node.ticker));
          const r = node.hop === 1 ? 5.5 : 3.5;
          return (
            <g
              key={node.id}
              opacity={nodeOpacity(node)}
              className={cn(fade, clickable && "cursor-pointer outline-none")}
              role={clickable ? "button" : undefined}
              tabIndex={clickable ? 0 : undefined}
              aria-label={clickable ? t("stocktab.tab.open", { ticker: node.ticker! }) : undefined}
              onMouseEnter={() => setHover(node.id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(node.id)}
              onBlur={() => setHover(null)}
              onClick={clickable ? () => openStock(node.ticker!, node.name) : undefined}
              onKeyDown={
                clickable
                  ? (ev) => {
                      if (ev.key === "Enter" || ev.key === " ") {
                        ev.preventDefault();
                        openStock(node.ticker!, node.name);
                      }
                    }
                  : undefined
              }
            >
              <title>{node.name}</title>
              {/* A wider invisible target than the dot itself. */}
              <circle cx={node.x} cy={node.y} r={12} fill="transparent" />
              {own ? (
                <circle
                  cx={node.x}
                  cy={node.y}
                  r={r + 3}
                  fill="none"
                  strokeWidth={1.25}
                  style={{ stroke: "var(--text-primary)" }}
                  opacity={held.has(node.ticker!) ? 0.75 : 0.4}
                />
              ) : null}
              <circle cx={node.x} cy={node.y} r={r} fill={color} opacity={node.hop === 1 ? 1 : 0.7} />
              <text
                x={node.x + place.dx}
                y={node.y + place.dy}
                textAnchor={place.anchor}
                className={cn("font-sans", node.hop === 1 ? "text-[10.5px] font-medium" : "text-[9.5px]")}
                style={{ fill: node.hop === 1 ? "var(--text-body)" : "var(--text-tertiary)" }}
              >
                {node.label}
              </text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}
