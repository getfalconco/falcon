import { useEffect, useState } from "react";
import GraphView from "@/components/graph/GraphView";
import { useI18n } from "@/lib/i18n";
import type { GraphFile } from "../../../shared/graph-types";

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string | null }
  | { kind: "ready"; graph: GraphFile };

export default function GraphScreen() {
  const { t, tNodes } = useI18n();
  const [state, setState] = useState<LoadState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      if (!window.meridian?.getGraphData) {
        if (!cancelled) {
          // null: the words are chosen at render, in the reader's language.
          setState({ kind: "error", message: null });
        }
        return;
      }

      const result = await window.meridian.getGraphData();
      if (cancelled) return;

      if (!result.ok) {
        setState({ kind: "error", message: result.error });
        return;
      }
      setState({ kind: "ready", graph: result.graph });
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  if (state.kind === "loading") {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
        {t("panels.graph.loading")}
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-8 text-center">
        <p className="text-sm text-foreground">{t("panels.graph.loadFailed")}</p>
        <p className="max-w-md text-sm text-muted-foreground">{state.message ?? t("panels.graph.unavailable")}</p>
        <p className="text-xs text-muted-foreground/80">
          {tNodes("panels.graph.generateHint", {
            command: <code className="rounded bg-white/[0.06] px-1 py-0.5">pnpm graph</code>,
            file: <code className="rounded bg-white/[0.06] px-1 py-0.5">data/graph.json</code>,
          })}
        </p>
      </div>
    );
  }

  return <GraphView graph={state.graph} />;
}
