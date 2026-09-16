import { useEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { openExternalUrl } from "@/lib/open-url";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  BackLink,
  EmptyState,
  ErrorState,
  Loading,
  MicroLabel,
  RowCard,
  Tag,
} from "@/components/product-ui";
import { listEdgesFor, listEdgesInto, type GraphEdge } from "@/lib/events";
import { PRODUCT, PTYPE, RADIUS } from "@/theme";

/**
 * Relationship graph for one company, as a drill-in rather than a tab.
 *
 * A force-directed canvas is a poor browse surface on a phone, so this renders
 * the same data the desktop GraphView draws — but grouped by relationship
 * category, with the filing quote behind each edge — which is what the graph is
 * actually consulted for.
 */
type Direction = "out" | "in";

export default function GraphScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { ticker } = useLocalSearchParams<{ ticker: string }>();
  const symbol = String(ticker ?? "").toUpperCase();

  const [direction, setDirection] = useState<Direction>("out");
  const [edges, setEdges] = useState<GraphEdge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Effect-scoped cancellation: fast Touches <-> Touched by toggles must not
  // let the slower response overwrite the newer one.
  useEffect(() => {
    let cancelled = false;
    setEdges(null);
    setError(null);
    void (async () => {
      try {
        const rows =
          direction === "out" ? await listEdgesFor(symbol) : await listEdgesInto(symbol);
        if (!cancelled) setEdges(rows);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Could not load the graph.");
        setEdges([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [symbol, direction, reloadKey]);

  // Group by relationship category — supplier, customer, partner, …
  const grouped = useMemo(() => {
    const map = new Map<string, GraphEdge[]>();
    for (const e of edges ?? []) {
      const key = e.category || "other";
      map.set(key, [...(map.get(key) ?? []), e]);
    }
    return [...map.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [edges]);

  return (
    <View style={[styles.root, { paddingTop: insets.top }]}>
      <View style={styles.topBar}>
        <BackLink
          onPress={() => (router.canGoBack() ? router.back() : router.replace("/dashboard"))}
        />
        <MicroLabel>Relationships</MicroLabel>
        <View style={styles.back} />
      </View>

      <View style={styles.header}>
        <Text style={PTYPE.greeting}>{symbol}</Text>

        <View style={styles.segment}>
          {(
            [
              { id: "out" as const, label: "Touches" },
              { id: "in" as const, label: "Touched by" },
            ]
          ).map((opt) => {
            const active = direction === opt.id;
            return (
              <Pressable
                key={opt.id}
                onPress={() => setDirection(opt.id)}
                style={[styles.segItem, active && styles.segItemActive]}
              >
                <Text style={[styles.segText, active && styles.segTextActive]}>
                  {opt.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {edges === null && !error ? (
        <Loading />
      ) : error ? (
        <ErrorState message={error} onRetry={() => setReloadKey((k) => k + 1)} />
      ) : edges!.length === 0 ? (
        <EmptyState
          title="No relationships mapped"
          body={`${symbol} hasn't been through SEC extraction yet, or has no counterparties on this side.`}
        />
      ) : (
        <ScrollView
          contentContainerStyle={[styles.scroll, { paddingBottom: insets.bottom + 24 }]}
        >
          {grouped.map(([category, list]) => (
            <View key={category} style={styles.group}>
              <View style={styles.groupHead}>
                <MicroLabel>{category}</MicroLabel>
                <Text style={PTYPE.num}>{list.length}</Text>
              </View>

              <View style={styles.rows}>
                {list.map((e) => {
                  const other =
                    direction === "out"
                      ? (e.counterparty_ticker ?? e.counterparty_name)
                      : e.root_ticker;
                  // Outbound rows jump to the counterparty; inbound rows jump
                  // to the company touching us (root of the edge).
                  const jumpTarget =
                    direction === "out" ? e.counterparty_ticker : e.root_ticker;
                  const conf = Math.round(
                    Math.min(1, Math.max(0, e.confidence ?? 0)) * 100,
                  );
                  return (
                    <RowCard key={e.id}>
                      <View style={styles.rowTop}>
                        <Text style={styles.pair}>
                          {direction === "out" ? symbol : other}
                          <Text style={styles.arrow}> → </Text>
                          {direction === "out" ? other : symbol}
                        </Text>
                        {jumpTarget && jumpTarget.toUpperCase() !== symbol ? (
                          <Pressable
                            onPress={() => router.push(`/graph/${jumpTarget}`)}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={`Open ${jumpTarget} graph`}
                          >
                            <Feather name="corner-up-right" size={14} color={PRODUCT.fgFaint} />
                          </Pressable>
                        ) : null}
                      </View>

                      {direction === "out" && e.counterparty_ticker ? (
                        <Text style={styles.name}>{e.counterparty_name}</Text>
                      ) : null}

                      {e.evidence_quote ? (
                        <Text style={styles.quote} numberOfLines={4}>
                          “{e.evidence_quote}”
                        </Text>
                      ) : null}

                      <View style={styles.tags}>
                        {e.subtype ? <Tag label={e.subtype} /> : null}
                        <Tag label={`${conf}% conf`} />
                        {e.strength_tier ? (
                          <Tag
                            label={e.strength_tier}
                            color={e.strength_tier === "critical" ? PRODUCT.brand : undefined}
                          />
                        ) : null}
                      </View>

                      {e.source_url ? (
                        <Text
                          style={styles.source}
                          onPress={() => void openExternalUrl(e.source_url)}
                        >
                          Filing ↗
                        </Text>
                      ) : null}
                    </RowCard>
                  );
                })}
              </View>
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: PRODUCT.bg },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  back: { width: 28, alignItems: "flex-start" },
  header: { paddingHorizontal: 20, paddingBottom: 14, gap: 12 },
  segment: {
    flexDirection: "row",
    alignSelf: "flex-start",
    backgroundColor: PRODUCT.fill,
    borderRadius: RADIUS.control,
    padding: 2,
    gap: 2,
  },
  segItem: { paddingHorizontal: 10, paddingVertical: 10, borderRadius: 8 },
  segItemActive: { backgroundColor: PRODUCT.card },
  segText: { fontFamily: PTYPE.body.fontFamily, fontSize: 11.5, color: PRODUCT.fgSubtle },
  segTextActive: { color: PRODUCT.fg },
  scroll: { paddingHorizontal: 20, paddingBottom: 28, gap: 20 },
  group: { gap: 8 },
  groupHead: { flexDirection: "row", justifyContent: "space-between", alignItems: "baseline" },
  rows: { gap: 8 },
  rowTop: { flexDirection: "row", justifyContent: "space-between", alignItems: "center" },
  pair: { ...PTYPE.ticker },
  arrow: { color: PRODUCT.fgSubtle },
  name: { ...PTYPE.small, marginTop: 4 },
  quote: {
    ...PTYPE.small,
    fontStyle: "italic",
    marginTop: 10,
    paddingLeft: 10,
    borderLeftWidth: 2,
    borderLeftColor: PRODUCT.border,
  },
  tags: { flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 10 },
  source: {
    fontFamily: PTYPE.body.fontFamily,
    fontSize: 12,
    color: PRODUCT.brand,
    marginTop: 10,
  },
});
