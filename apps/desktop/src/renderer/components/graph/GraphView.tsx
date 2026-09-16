import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ForceGraph2D, { type ForceGraphMethods } from "react-force-graph-2d";
import { Search } from "lucide-react";
import useMeasure from "react-use-measure";
import type { GraphFile, GraphNode } from "../../../shared/graph-types";
import {
  CATEGORY_LABELS,
  COUNTERPARTY_NODE_COLOR,
  SEEDED_NODE_COLOR,
  categoryColor,
  linkOpacity,
  withAlpha,
} from "@/lib/graph-colors";
import {
  type ForceGraphLink,
  type ForceGraphNode,
  type NodeEdgeRow,
  buildForceGraphData,
  edgesForNode,
  matchNodes,
} from "@/lib/graph-data";
import { cn } from "@/lib/utils";

type Props = {
  graph: GraphFile;
};

function formatGeneratedAt(iso: string): string {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function EdgeRow({ row }: { row: NodeEdgeRow }) {
  return (
    <article className="space-y-1 rounded-md border border-dashed border-black/[0.12] bg-white/[0.55] px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
            row.direction === "outbound"
              ? "bg-white/[0.08] text-foreground/80"
              : "bg-white/[0.05] text-muted-foreground",
          )}
        >
          {row.direction === "outbound" ? "→ out" : "← in"}
        </span>
        <span
          className="rounded px-1.5 py-0.5 text-[10px] font-medium"
          style={{
            backgroundColor: withAlpha(categoryColor(row.category), 0.18),
            color: categoryColor(row.category),
          }}
        >
          {row.category}
          {row.subtype ? ` · ${row.subtype.replace(/_/g, " ")}` : ""}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {Math.round(row.confidence * 100)}%
        </span>
      </div>
      <p className="text-[11px] leading-relaxed text-foreground/85">{row.peerLabel}</p>
      <p className="text-[11px] leading-relaxed text-muted-foreground">{row.evidence_quote}</p>
      <p className="text-[10px] text-muted-foreground/80">Source: {row.source_ticker}</p>
    </article>
  );
}

export default function GraphView({ graph }: Props) {
  const fgRef = useRef<ForceGraphMethods<ForceGraphNode, ForceGraphLink> | undefined>(undefined);
  const [containerRef, bounds] = useMeasure();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const { nodes, links } = useMemo(() => buildForceGraphData(graph), [graph]);
  const nodeById = useMemo(
    () => new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n])),
    [graph.nodes],
  );

  const selectedNode = selectedId ? nodeById.get(selectedId) : null;
  const selectedEdges = useMemo(
    () => (selectedId ? edgesForNode(selectedId, graph.edges, nodeById) : []),
    [selectedId, graph.edges, nodeById],
  );

  const searchMatches = useMemo(() => matchNodes(search, nodes), [search, nodes]);

  const focusNode = useCallback((node: ForceGraphNode) => {
    setSelectedId(node.id);
    const inst = fgRef.current;
    if (!inst || node.x == null || node.y == null) return;
    inst.centerAt(node.x, node.y, 700);
    inst.zoom(2.2, 700);
  }, []);

  useEffect(() => {
    const inst = fgRef.current;
    if (!inst) return;
    inst.d3Force("charge")?.strength((node: ForceGraphNode) => (node.isSeeded ? -140 : -60));
    inst.d3Force("link")?.distance((link: ForceGraphLink) => (link.confidence > 0.85 ? 70 : 95));
  }, [nodes, links]);

  function handleSearchSubmit(event: React.FormEvent) {
    event.preventDefault();
    const target = searchMatches[0];
    if (target) focusNode(target);
  }

  const graphData = useMemo(() => ({ nodes, links }), [nodes, links]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <div className="relative min-w-0 flex-1" ref={containerRef}>
        <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-start justify-between gap-3 p-4">
          <form
            onSubmit={handleSearchSubmit}
            className="pointer-events-auto flex w-full max-w-xs items-center gap-2 rounded-md border border-white/[0.08] bg-background/90 px-3 py-2 backdrop-blur-sm"
          >
            <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search nodes…"
              className="w-full bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
              aria-label="Search graph nodes"
            />
          </form>
          <div className="pointer-events-none hidden text-right text-[11px] leading-relaxed text-muted-foreground sm:block">
            <div>
              {graph.nodeCount} nodes · {graph.edgeCount} edges
            </div>
            <div>Updated {formatGeneratedAt(graph.generatedAt)}</div>
          </div>
        </div>

        <div className="pointer-events-none absolute bottom-4 left-4 z-10 rounded-md border border-white/[0.08] bg-background/90 px-3 py-2 backdrop-blur-sm">
          <p className="mb-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
            Categories
          </p>
          <div className="flex flex-col gap-1">
            {CATEGORY_LABELS.map(({ id, label }) => (
              <div key={id} className="flex items-center gap-2 text-[11px] text-foreground/80">
                <span
                  className="h-2 w-2 shrink-0 rounded-full"
                  style={{ backgroundColor: categoryColor(id) }}
                />
                {label}
              </div>
            ))}
          </div>
        </div>

        {bounds.width > 0 && bounds.height > 0 ? (
          <ForceGraph2D
            ref={fgRef}
            width={bounds.width}
            height={bounds.height}
            graphData={graphData}
            backgroundColor="transparent"
            linkColor={(link) => withAlpha(categoryColor(link.category), linkOpacity(link.confidence))}
            linkWidth={(link) => (link.confidence > 0.85 ? 1.4 : 1)}
            linkDirectionalArrowLength={3.5}
            linkDirectionalArrowRelPos={1}
            cooldownTicks={80}
            onNodeClick={(node) => {
              focusNode(node as ForceGraphNode);
            }}
            onBackgroundClick={() => setSelectedId(null)}
            nodeRelSize={1}
            nodeVal={(node) => ((node as ForceGraphNode).isSeeded ? 8 : 3.5)}
            nodeCanvasObject={(node, ctx, globalScale) => {
              const n = node as ForceGraphNode;
              const radius = n.isSeeded ? 6 : 3.5;
              const x = n.x ?? 0;
              const y = n.y ?? 0;
              const isSelected = selectedId === n.id;

              ctx.beginPath();
              ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
              ctx.fillStyle = n.isSeeded ? SEEDED_NODE_COLOR : COUNTERPARTY_NODE_COLOR;
              ctx.fill();

              // Canvas paints on the app background, so these are ink values,
              // not the near-white this was drawn in when the shell was dark.
              if (isSelected) {
                ctx.strokeStyle = "rgba(29,27,27,0.85)";
                ctx.lineWidth = 1.75 / globalScale;
                ctx.stroke();
              }

              const showLabel = n.isSeeded || globalScale > 1.1 || isSelected;
              if (showLabel) {
                const fontSize = Math.max(10 / globalScale, 3);
                ctx.font = `${n.isSeeded ? 600 : 500} ${fontSize}px Inter, system-ui, sans-serif`;
                ctx.textAlign = "center";
                ctx.textBaseline = "top";
                // A soft halo keeps a label legible where it crosses an edge
                // or another node, without boxing every one of them.
                ctx.lineJoin = "round";
                ctx.miterLimit = 2;
                ctx.strokeStyle = "rgba(252,252,250,0.9)";
                ctx.lineWidth = 3 / globalScale;
                ctx.strokeText(n.displayLabel, x, y + radius + 2 / globalScale);
                ctx.fillStyle = isSelected ? "rgba(29,27,27,0.98)" : "rgba(55,59,66,0.85)";
                ctx.fillText(n.displayLabel, x, y + radius + 2 / globalScale);
              }
            }}
            nodePointerAreaPaint={(node, color, ctx) => {
              const n = node as ForceGraphNode;
              const radius = n.isSeeded ? 10 : 7;
              ctx.fillStyle = color;
              ctx.beginPath();
              ctx.arc(node.x ?? 0, node.y ?? 0, radius, 0, 2 * Math.PI, false);
              ctx.fill();
            }}
          />
        ) : null}

        {search.trim() && searchMatches.length > 0 ? (
          <div className="absolute left-4 top-[4.25rem] z-10 max-h-48 w-64 overflow-y-auto rounded-md border border-white/[0.08] bg-background/95 text-sm shadow-lg backdrop-blur-sm">
            {searchMatches.slice(0, 8).map((node) => (
              <button
                key={node.id}
                type="button"
                onClick={() => focusNode(node)}
                className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left hover:bg-white/[0.06]"
              >
                <span className="font-medium text-foreground">{node.displayLabel}</span>
                <span className="text-[11px] text-muted-foreground">{node.label}</span>
              </button>
            ))}
          </div>
        ) : null}
      </div>

      <aside
        className={cn(
          "flex w-[min(100%,22rem)] shrink-0 flex-col border-l border-dashed border-black/[0.12] bg-background transition-[width,opacity]",
          selectedNode ? "opacity-100" : "w-0 border-l-0 opacity-0",
        )}
        aria-hidden={!selectedNode}
      >
        {selectedNode ? (
          <>
            <div className="border-b border-dashed border-black/[0.12] px-4 py-3">
              <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                {selectedNode.kind === "ticker" ? "Ticker" : "Counterparty"}
              </p>
              <h2 className="mt-1 text-base font-medium text-foreground">{selectedNode.label}</h2>
              <p className="mt-0.5 text-xs text-muted-foreground">{selectedNode.id}</p>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {selectedEdges.length} edge{selectedEdges.length === 1 ? "" : "s"}
              </p>
            </div>
            <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto px-4 py-2.5">
              {selectedEdges.length === 0 ? (
                <p className="text-sm text-muted-foreground">No edges for this node.</p>
              ) : (
                selectedEdges.map((row, index) => (
                  <EdgeRow key={`${row.source_ticker}-${row.category}-${index}`} row={row} />
                ))
              )}
            </div>
          </>
        ) : null}
      </aside>
    </div>
  );
}
