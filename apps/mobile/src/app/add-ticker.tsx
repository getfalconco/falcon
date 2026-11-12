import { useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Check, Plus } from "lucide-react-native";
import { SheetScreen, type CloseSheet } from "@/components/Sheet";
import { TextField } from "@/components/TextField";
import { apiUrl } from "@/lib/env";
import { syncFocusList } from "@/lib/focusList";
import { haptics } from "@/lib/haptics";
import { currentUserId } from "@/lib/home";
import { addHolding, heldTickers, removeHolding } from "@/lib/holdings";
import { MAX_STOCKS } from "@/lib/onboarding";
import { SHEET_DETENTS } from "@/lib/sheets";
import { useSightings } from "@/lib/sightings";
import { colors, fonts } from "@/theme";

type Result = { ticker: string; name: string };
type Search = { status: "idle" | "loading" | "ready" | "error"; query: string; results: Result[] };

const DEBOUNCE_MS = 180;
/** Suggestions from today's cards while the field is empty. */
const SUGGESTIONS = 8;

/** The Portfolio tab's search sheet: find a ticker by symbol or company name, tap to add or remove it. */
export default function AddTickerSheet() {
  return <SheetScreen detent={SHEET_DETENTS.addTicker[0]}>{(close) => <AddTicker close={close} />}</SheetScreen>;
}

function useTickerSearch(query: string): Search {
  const [search, setSearch] = useState<Search>({ status: "idle", query: "", results: [] });
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      setSearch({ status: "idle", query: "", results: [] });
      return;
    }
    setSearch((prev) => ({ ...prev, status: "loading", query: q }));
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(apiUrl(`/api/tickers?q=${encodeURIComponent(q)}`), { signal: controller.signal })
        .then(async (res) => {
          const body = (await res.json()) as { results?: Result[] };
          if (!res.ok || !Array.isArray(body.results)) throw new Error("search");
          setSearch({ status: "ready", query: q, results: body.results });
        })
        .catch(() => {
          if (!controller.signal.aborted) setSearch({ status: "error", query: q, results: [] });
        });
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);
  return search;
}

function ResultRow({
  result,
  held,
  full,
  onToggle,
  first,
}: {
  result: Result;
  held: boolean;
  full: boolean;
  onToggle: () => void;
  first: boolean;
}) {
  const disabled = !held && full;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${held ? "Remove" : "Add"} ${result.ticker}, ${result.name}`}
      accessibilityState={{ selected: held, disabled }}
      disabled={disabled}
      onPress={onToggle}
      style={({ pressed }) => [
        styles.row,
        first ? null : styles.rowDivider,
        pressed ? styles.rowPressed : null,
        disabled ? styles.rowOff : null,
      ]}
    >
      <Text style={styles.ticker}>{result.ticker}</Text>
      <Text style={styles.name} numberOfLines={1}>
        {result.name.toUpperCase() === result.ticker.toUpperCase() ? "" : result.name}
      </Text>
      <View style={[styles.toggle, held ? styles.toggleOn : null]}>
        {held ? (
          <Check size={15} strokeWidth={2.2} color={colors.primaryText} />
        ) : (
          <Plus size={15} strokeWidth={2} color={colors.ink} />
        )}
      </View>
    </Pressable>
  );
}

function AddTicker({ close }: { close: CloseSheet }) {
  const insets = useSafeAreaInsets();
  const sightings = useSightings();
  const [query, setQuery] = useState("");
  const search = useTickerSearch(query);
  const held = useMemo(() => heldTickers(sightings.holdings), [sightings.holdings]);
  const full = held.size >= MAX_STOCKS;
  const userId = useRef<string | null>(null);

  useEffect(() => {
    void currentUserId().then((id) => {
      userId.current = id;
    });
  }, []);

  // Empty field: companies today's Sightings reach that aren't in the list yet.
  const suggestions = useMemo(() => {
    const seen = new Set<string>();
    const out: Result[] = [];
    for (const card of sightings.feed?.cards ?? []) {
      const entries = [
        { ticker: card.event.ticker, name: card.event.companyName },
        ...card.hits.map((h) => ({ ticker: h.ticker, name: h.companyName })),
      ];
      for (const entry of entries) {
        const t = entry.ticker.toUpperCase();
        if (seen.has(t) || held.has(t)) continue;
        seen.add(t);
        out.push({ ticker: t, name: entry.name });
      }
    }
    return sightings.sample ? [] : out.slice(0, SUGGESTIONS);
  }, [held, sightings.feed, sightings.sample]);

  const toggle = (result: Result) => {
    const ticker = result.ticker.toUpperCase();
    if (held.has(ticker)) {
      haptics.select();
      removeHolding(ticker);
    } else if (addHolding({ ticker, name: result.name }, userId.current)) {
      haptics.success();
    } else {
      haptics.error();
      return;
    }
    syncFocusList();
  };

  const typing = query.trim() !== "";
  const list = typing ? search.results : suggestions;

  return (
    <View style={styles.body}>
      <View style={styles.header}>
        <View style={styles.headerSide} />
        <Text style={styles.title} accessibilityRole="header">
          Add a ticker
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            haptics.select();
            close();
          }}
          hitSlop={10}
          style={styles.headerSide}
        >
          {({ pressed }) => <Text style={[styles.done, pressed ? styles.donePressed : null]}>Done</Text>}
        </Pressable>
      </View>

      <View style={styles.field}>
        <TextField
          value={query}
          onChangeText={setQuery}
          placeholder="Ticker or company"
          autoFocus
          autoCapitalize="characters"
          autoCorrect={false}
          spellCheck={false}
          returnKeyType="search"
          clearButtonMode="while-editing"
          accessibilityLabel="Search tickers"
        />
      </View>

      <ScrollView
        style={styles.list}
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        showsVerticalScrollIndicator={false}
      >
        {!typing && list.length > 0 ? <Text style={styles.label}>In today’s sightings</Text> : null}
        {typing && search.status === "loading" && search.results.length === 0 ? (
          <ActivityIndicator style={styles.spinner} color={colors.faint} />
        ) : null}
        {typing && search.status === "ready" && list.length === 0 ? (
          <Text style={styles.empty}>No matches</Text>
        ) : null}
        {typing && search.status === "error" ? <Text style={styles.empty}>Search is unavailable right now</Text> : null}
        {list.map((result, i) => (
          <ResultRow
            key={result.ticker}
            result={result}
            held={held.has(result.ticker.toUpperCase())}
            full={full}
            first={i === 0}
            onToggle={() => toggle(result)}
          />
        ))}
        {full ? <Text style={styles.limit}>Up to {MAX_STOCKS} tickers</Text> : null}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  body: { flex: 1 },
  header: {
    marginTop: 4,
    marginBottom: 12,
    paddingHorizontal: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  headerSide: { width: 56, alignItems: "flex-end" },
  title: { fontFamily: fonts.sansMedium, fontSize: 17, lineHeight: 22, color: colors.ink, textAlign: "center" },
  done: { fontFamily: fonts.sansMedium, fontSize: 15, color: colors.ink },
  donePressed: { opacity: 0.5 },
  field: { paddingHorizontal: 20 },
  list: { flex: 1, marginTop: 10 },
  label: {
    marginTop: 12,
    marginBottom: 4,
    marginHorizontal: 24,
    fontFamily: fonts.mono,
    fontSize: 10.5,
    letterSpacing: 1.6,
    textTransform: "uppercase",
    color: "rgba(29, 27, 27, 0.45)",
  },
  spinner: { marginTop: 28 },
  empty: { marginTop: 32, textAlign: "center", fontFamily: fonts.serif, fontSize: 16, color: colors.muted },
  limit: { marginTop: 16, textAlign: "center", fontFamily: fonts.sans, fontSize: 13, color: colors.faint },
  row: { minHeight: 56, marginHorizontal: 24, flexDirection: "row", alignItems: "center", gap: 14 },
  rowDivider: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: colors.hairline },
  rowPressed: { opacity: 0.55 },
  rowOff: { opacity: 0.4 },
  ticker: { minWidth: 64, fontFamily: fonts.mono, fontSize: 14.5, color: colors.ink },
  name: { flex: 1, minWidth: 0, fontFamily: fonts.sans, fontSize: 15, color: colors.body },
  toggle: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: StyleSheet.hairlineWidth * 2,
    borderColor: colors.hairline,
  },
  toggleOn: { backgroundColor: colors.primary, borderColor: colors.primary },
});
