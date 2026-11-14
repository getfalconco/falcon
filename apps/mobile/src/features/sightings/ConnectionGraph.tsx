import { useMemo } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Svg, { Circle, G, Line, Rect, Text as SvgText } from "react-native-svg";
import type { RippleCard, RippleHit } from "@falcon/ripple";
import { colors, fonts } from "@/theme";
import { directionColor, directionSoft, isSelfHit, relationLabel } from "./format";

/** Graph units: close to points at the phone's content width. */
const R_EVENT = 31;
const R_HIT = 24;
const RING_1 = 140;
const RING_2_STEP = 96;
const PAD = 12;
const MAX_HEIGHT = 340;

type Node = { hit: RippleHit; x: number; y: number; from: { x: number; y: number } };

/** About 5.6 units a character in 9.5 pt mono, plus padding. */
function labelWidth(text: string) {
  return text.length * 5.8 + 12;
}

/**
 * Lays the hits around the event company: direct links on one ring, starting
 * at the top, second degree links further out beyond the company they come
 * through (or beyond the event when that company is not on the card).
 */
function layout(card: RippleCard): { nodes: Node[]; box: { x: number; y: number; w: number; h: number } } {
  // A "self" hit is the event company itself: it is the centre node, never a line to itself.
  const linked = card.hits.filter((h) => !isSelfHit(h, card.event.ticker));
  const direct = linked.filter((h) => h.degree !== 2);
  const second = linked.filter((h) => h.degree === 2);
  const center = { x: 0, y: 0 };
  const nodes: Node[] = [];
  const angleOf = new Map<string, number>();

  const n1 = Math.max(direct.length, 1);
  // Second degree links whose middle company is not on the card get a free
  // slot on the ring (when it has room); the rest sit beyond that company.
  const directTickers = new Set(direct.map((h) => h.ticker.toUpperCase()));
  const orphans = second.some((h) => !h.via || !directTickers.has(h.via.toUpperCase()));
  const slots = orphans && direct.length < 6 ? direct.length + 1 : n1;
  direct.forEach((hit, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / slots;
    angleOf.set(hit.ticker.toUpperCase(), a);
    nodes.push({ hit, x: Math.cos(a) * RING_1, y: Math.sin(a) * RING_1, from: center });
  });

  const spare = -Math.PI / 2 + (direct.length * 2 * Math.PI) / slots;
  second.forEach((hit, i) => {
    const viaNode = hit.via ? nodes.find((n) => n.hit.ticker.toUpperCase() === hit.via!.toUpperCase()) : undefined;
    const base = viaNode ? (angleOf.get(viaNode.hit.ticker.toUpperCase()) ?? spare) : spare;
    // Siblings through the same company fan out a little.
    const a = base + (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2) * 0.42;
    const r = RING_1 + RING_2_STEP;
    const from = viaNode ? { x: viaNode.x, y: viaNode.y } : center;
    nodes.push({ hit, x: Math.cos(a) * r, y: Math.sin(a) * r, from });
  });

  let minX = -R_EVENT;
  let maxX = R_EVENT;
  let minY = -R_EVENT;
  let maxY = R_EVENT;
  for (const node of nodes) {
    minX = Math.min(minX, node.x - R_HIT);
    maxX = Math.max(maxX, node.x + R_HIT);
    minY = Math.min(minY, node.y - R_HIT);
    maxY = Math.max(maxY, node.y + R_HIT);
  }
  return {
    nodes,
    box: { x: minX - PAD, y: minY - PAD, w: maxX - minX + PAD * 2, h: maxY - minY + PAD * 2 },
  };
}

/**
 * Only this event's connections: the event company in the middle, the
 * companies it reaches around it, each line labeled with the relation. Node
 * rings carry the direction color; held companies are filled.
 */
export function ConnectionGraph({
  card,
  held,
  width,
  onSelect,
}: {
  card: RippleCard;
  held: Set<string>;
  width: number;
  onSelect?: (hit: RippleHit) => void;
}) {
  const { nodes, box } = useMemo(() => layout(card), [card]);
  const height = Math.min(MAX_HEIGHT, (width * box.h) / box.w);
  // The viewBox is fitted and centered ("meet"): graph units to points.
  const scale = Math.min(width / box.w, height / box.h);
  const offX = (width - box.w * scale) / 2;
  const offY = (height - box.h * scale) / 2;
  const toPoint = (x: number, y: number) => ({ left: offX + (x - box.x) * scale, top: offY + (y - box.y) * scale });

  return (
    <View style={{ width, height }}>
      <View
        accessible
        accessibilityRole="image"
        accessibilityLabel={`${card.event.ticker} and the ${nodes.length} companies it reaches`}
      >
        <Svg width={width} height={height} viewBox={`${box.x} ${box.y} ${box.w} ${box.h}`}>
          {nodes.map(({ hit, x, y, from }) => (
            <Line
              key={`line-${hit.ticker}`}
              x1={from.x}
              y1={from.y}
              x2={x}
              y2={y}
              stroke="rgba(29, 27, 27, 0.16)"
              strokeWidth={1.25}
              strokeDasharray={hit.degree === 2 ? "3 4" : undefined}
            />
          ))}

          {nodes.map(({ hit, x, y, from }) => {
            const text = relationLabel(hit.relation).toLowerCase();
            const w = labelWidth(text);
            // Halfway along the visible part of the line, between the two circles.
            const len = Math.hypot(x - from.x, y - from.y) || 1;
            const r0 = from.x === 0 && from.y === 0 ? R_EVENT : R_HIT;
            const t = (r0 + (len - r0 - R_HIT) / 2) / len;
            const mx = from.x + (x - from.x) * t;
            const my = from.y + (y - from.y) * t;
            return (
              <G key={`label-${hit.ticker}`}>
                <Rect
                  x={mx - w / 2}
                  y={my - 8}
                  width={w}
                  height={16}
                  rx={8}
                  fill={colors.background}
                  stroke="rgba(29, 27, 27, 0.08)"
                  strokeWidth={1}
                />
                <SvgText
                  x={mx}
                  y={my + 3.2}
                  fontFamily={fonts.mono}
                  fontSize={9.5}
                  letterSpacing={0.3}
                  fill="rgba(29, 27, 27, 0.6)"
                  textAnchor="middle"
                >
                  {text}
                </SvgText>
              </G>
            );
          })}

          <Circle cx={0} cy={0} r={R_EVENT} fill={colors.primary} />
          <SvgText x={0} y={4.2} fontFamily={fonts.mono} fontSize={12} fill={colors.primaryText} textAnchor="middle">
            {card.event.ticker}
          </SvgText>

          {nodes.map(({ hit, x, y }) => {
            const isHeld = held.has(hit.ticker.toUpperCase());
            const color = directionColor(hit.direction);
            return (
              <G key={`node-${hit.ticker}`}>
                {/* Opaque base so the lines stop at the circle under a tinted fill. */}
                <Circle cx={x} cy={y} r={R_HIT} fill="#ffffff" />
                <Circle
                  cx={x}
                  cy={y}
                  r={R_HIT}
                  fill={isHeld ? directionSoft(hit.direction) : "#ffffff"}
                  stroke={color}
                  strokeWidth={isHeld ? 2 : 1.4}
                />
                <SvgText
                  x={x}
                  y={y + 3.6}
                  fontFamily={fonts.mono}
                  fontSize={hit.ticker.length > 4 ? 9 : 10.5}
                  fill={colors.ink}
                  textAnchor="middle"
                >
                  {hit.ticker}
                </SvgText>
              </G>
            );
          })}
        </Svg>
      </View>
      {/* Taps go to plain views over the nodes (SVG press handlers differ by platform). */}
      {onSelect
        ? nodes.map(({ hit, x, y }) => {
            const p = toPoint(x, y);
            const size = R_HIT * 2 * scale + 8;
            return (
              <Pressable
                key={`tap-${hit.ticker}`}
                accessibilityRole="button"
                accessibilityLabel={`${hit.ticker}, ${relationLabel(hit.relation)}`}
                onPress={() => onSelect(hit)}
                style={[styles.tap, { left: p.left - size / 2, top: p.top - size / 2, width: size, height: size }]}
              />
            );
          })
        : null}
    </View>
  );
}

const styles = StyleSheet.create({
  tap: { position: "absolute", borderRadius: 999 },
});
