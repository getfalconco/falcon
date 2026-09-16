import { useEffect, useState } from "react";
import { ActivityIndicator, ScrollView, StyleSheet, Text, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import GlassIconButton from "@/components/GlassIconButton";
import GlassPanel from "@/components/GlassPanel";
import { Screen, useNavClearance } from "@/components/product-ui";
import {
  getInsightExplanation,
  getPropagationRun,
  isEngineEnabled,
  listPropagationRuns,
  type InsightExplanation,
} from "@/lib/engine";
import { orderRuns, type PropagationRun } from "@/lib/propagation-runs";
import { FONTS, PRODUCT, PTYPE } from "@/theme";

/**
 * The event behind the dashboard's Insight card, at full size: its headline,
 * and the engine's written brief underneath.
 *
 * Both come off the engine service. The card hands over a run id when it opens
 * this page; arriving from the tab with no id, it opens on the same event the
 * card would lead with — `orderRuns` decides that on both surfaces, so the two
 * never disagree about which event is the day's.
 *
 * The brief itself is written once per run and shared through Supabase, so
 * this is usually a table read; only the first reader of an event waits on the
 * model.
 */
export default function InsightScreen() {
  const router = useRouter();
  const navClearance = useNavClearance();
  const { run: runParam } = useLocalSearchParams<{ run?: string }>();

  const [run, setRun] = useState<PropagationRun | null>(null);
  const [explanation, setExplanation] = useState<InsightExplanation | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Which event this page is about: the one handed over, or the one the card
  // would be leading with.
  useEffect(() => {
    if (!isEngineEnabled()) {
      setError("No engine is configured for this build.");
      setLoading(false);
      return;
    }
    let cancelled = false;

    void (async () => {
      try {
        let id = runParam?.trim() ?? "";
        if (!id) {
          const best = orderRuns(await listPropagationRuns(200))[0];
          if (!best) {
            if (!cancelled) {
              setError("Nothing has moved through the network yet.");
              setLoading(false);
            }
            return;
          }
          id = best.run_id;
        }
        const next = await getPropagationRun(id);
        if (cancelled) return;
        if (!next) {
          setError("That event is no longer in the engine's store.");
          setLoading(false);
          return;
        }
        setRun(next);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not reach the engine.");
          setLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [runParam]);

  // The brief. Asked for only once the run is known, because the run id is the
  // key it is cached under.
  useEffect(() => {
    if (!run) return;
    let cancelled = false;

    void getInsightExplanation(run.run_id)
      .then((next) => {
        if (cancelled) return;
        if (next) setExplanation(next);
        else setError("The engine has no brief for this event yet.");
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "The brief could not be written.");
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [run]);

  const headline = run ? `${run.root_ticker.toUpperCase()} ${run.event.label}` : "";

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={[styles.scroll, { paddingBottom: navClearance }]}
        scrollIndicatorInsets={{ bottom: navClearance }}
      >
        <View style={styles.topBar}>
          <GlassIconButton
            icon="chevron-left"
            accessibilityLabel="Back"
            onPress={() => (router.canGoBack() ? router.back() : router.replace("/dashboard"))}
          />
        </View>

        <Text style={styles.headline}>
          {headline || (loading ? "Reading the network…" : "No event")}
        </Text>

        {run ? (
          <GlassPanel style={styles.panel}>
            {explanation ? (
              <>
                <Text style={styles.summary}>{explanation.summary}</Text>
                {explanation.points.length > 0 ? (
                  <View style={styles.points}>
                    {explanation.points.map((point) => (
                      <View key={point} style={styles.point}>
                        <View style={styles.bullet} />
                        <Text style={styles.pointText}>{point}</Text>
                      </View>
                    ))}
                  </View>
                ) : null}
              </>
            ) : loading ? (
              <View style={styles.pending}>
                <ActivityIndicator color={PRODUCT.fgMuted} />
                <Text style={styles.pendingText}>Writing the brief…</Text>
              </View>
            ) : (
              <Text style={styles.pendingText}>{error ?? "No brief for this event."}</Text>
            )}
          </GlassPanel>
        ) : error ? (
          <Text style={styles.pendingText}>{error}</Text>
        ) : null}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  // `paddingBottom` comes from useNavClearance() at render time.
  scroll: { paddingHorizontal: 20, paddingTop: 12 },
  topBar: { flexDirection: "row", marginBottom: 20 },
  headline: {
    fontFamily: FONTS.sansMedium,
    fontSize: 26,
    lineHeight: 32,
    letterSpacing: -0.3,
    color: PRODUCT.fg,
    marginBottom: 20,
  },
  panel: { marginBottom: 12 },
  summary: { ...PTYPE.body, fontSize: 15.5, lineHeight: 24, color: PRODUCT.fgBody },
  points: { marginTop: 16, gap: 10 },
  point: { flexDirection: "row", gap: 10 },
  bullet: {
    width: 5,
    height: 5,
    borderRadius: 2.5,
    marginTop: 8,
    backgroundColor: PRODUCT.fgSubtle,
  },
  pointText: { flex: 1, fontFamily: FONTS.sans, fontSize: 14, lineHeight: 21, color: PRODUCT.fgBody },
  pending: { flexDirection: "row", alignItems: "center", gap: 10 },
  pendingText: { ...PTYPE.small },
});
