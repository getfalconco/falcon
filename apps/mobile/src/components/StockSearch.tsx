import { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Image,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import Svg, { Circle, Rect } from "react-native-svg";
import {
  addRecentStockSearch,
  getRecentStockSearches,
  subscribeRecentStockSearches,
} from "@/lib/recent-stock-search";
import {
  getStockLogoUrl,
  isIndexSymbol,
  searchUsStocks,
  type StockCatalogEntry,
} from "@/lib/stock-catalog";
import { FONTS, PRODUCT, PTYPE, RADIUS } from "@/theme";

type Props = {
  onSelect: (entry: StockCatalogEntry) => void;
  onQueryChange?: (query: string) => void;
};

/** SearchResultRow: paddingVertical 12×2 + two-line body (~39) + hairline. Logo is 32. */
const SEARCH_RESULT_ROW_HEIGHT = 64;
const VISIBLE_RESULT_ROWS = 4;
/** Trending label: paddingTop 12 + microLabel 14 + marginBottom 10. */
const TRENDING_LABEL_HEIGHT = 36;
const RESULT_LIST_MAX_HEIGHT = SEARCH_RESULT_ROW_HEIGHT * VISIBLE_RESULT_ROWS;

function UsFlag() {
  return (
    <Svg
      width={18}
      height={12}
      viewBox="0 0 20 14"
      accessibilityLabel="United States"
    >
      <Rect width="20" height="14" fill="#B22234" />
      <Rect y="1" width="20" height="1" fill="#FFFFFF" />
      <Rect y="3" width="20" height="1" fill="#FFFFFF" />
      <Rect y="5" width="20" height="1" fill="#FFFFFF" />
      <Rect y="7" width="20" height="1" fill="#FFFFFF" />
      <Rect y="9" width="20" height="1" fill="#FFFFFF" />
      <Rect y="11" width="20" height="1" fill="#FFFFFF" />
      <Rect width="8" height="7" fill="#3C3B6E" />
      <Circle cx="1.3" cy="1.2" r="0.42" fill="#FFFFFF" />
      <Circle cx="3.1" cy="1.2" r="0.42" fill="#FFFFFF" />
      <Circle cx="4.9" cy="1.2" r="0.42" fill="#FFFFFF" />
      <Circle cx="2.2" cy="2.5" r="0.42" fill="#FFFFFF" />
      <Circle cx="4" cy="2.5" r="0.42" fill="#FFFFFF" />
      <Circle cx="1.3" cy="3.8" r="0.42" fill="#FFFFFF" />
      <Circle cx="3.1" cy="3.8" r="0.42" fill="#FFFFFF" />
      <Circle cx="4.9" cy="3.8" r="0.42" fill="#FFFFFF" />
      <Circle cx="2.2" cy="5.1" r="0.42" fill="#FFFFFF" />
      <Circle cx="4" cy="5.1" r="0.42" fill="#FFFFFF" />
    </Svg>
  );
}

function StockLogo({ symbol, size }: { symbol: string; size: number }) {
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setFailed(false);
  }, [symbol]);

  if (failed) {
    return <View style={[styles.logoFallback, { width: size, height: size, borderRadius: size * 0.2 }]} />;
  }

  return (
    <Image
      source={{ uri: getStockLogoUrl(symbol) }}
      accessible={false}
      onError={() => setFailed(true)}
      resizeMode="contain"
      style={{ width: size, height: size, borderRadius: size * 0.2 }}
    />
  );
}

function SearchResultRow({
  entry,
  onSelect,
}: {
  entry: StockCatalogEntry;
  onSelect: (entry: StockCatalogEntry) => void;
}) {
  return (
    <Pressable
      onPress={() => onSelect(entry)}
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
      accessibilityRole="button"
      accessibilityLabel={`${entry.companyName} ${entry.symbol}`}
    >
      <StockLogo symbol={entry.symbol} size={32} />
      <View style={styles.rowBody}>
        <Text style={styles.company} numberOfLines={1}>
          {entry.companyName}
        </Text>
        <View style={styles.metaLine}>
          <Text style={styles.meta} numberOfLines={1}>
            {entry.symbol}
            {entry.exchange ? ` · ${entry.exchange}` : ""}
          </Text>
          {!isIndexSymbol(entry.symbol) ? <UsFlag /> : null}
        </View>
      </View>
      <Feather name="chevron-right" size={16} color={PRODUCT.fgFaint} />
    </Pressable>
  );
}

export default function StockSearch({ onSelect, onQueryChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<StockCatalogEntry[]>([]);
  const [trending, setTrending] = useState<StockCatalogEntry[]>([]);
  const [trendingReady, setTrendingReady] = useState(false);
  const [recent, setRecent] = useState<StockCatalogEntry[]>([]);
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    void getRecentStockSearches().then(setRecent);
    return subscribeRecentStockSearches(() => {
      void getRecentStockSearches().then(setRecent);
    });
  }, []);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    setTrendingReady(false);
    void searchUsStocks("", 12)
      .then((entries) => {
        if (!cancelled) {
          setTrending(entries.filter((entry) => !isIndexSymbol(entry.symbol)).slice(0, 8));
        }
      })
      .catch(() => {
        if (!cancelled) setTrending([]);
      })
      .finally(() => {
        if (!cancelled) setTrendingReady(true);
      });

    return () => {
      cancelled = true;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    let cancelled = false;
    const timer = setTimeout(() => {
      setLoading(true);
      void searchUsStocks(query, 12)
        .then((entries) => {
          if (!cancelled) setResults(entries);
        })
        .catch(() => {
          if (!cancelled) setResults([]);
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }, 180);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [open, query]);

  const handleSelect = useCallback(
    (entry: StockCatalogEntry) => {
      void addRecentStockSearch(entry);
      setQuery(entry.symbol);
      onQueryChange?.(entry.symbol);
      onSelect(entry);
      setOpen(false);
      Keyboard.dismiss();
    },
    [onQueryChange, onSelect],
  );

  const handleQuery = (value: string) => {
    setQuery(value);
    onQueryChange?.(value);
    if (!open) setOpen(true);
  };

  useEffect(() => {
    const sub = Keyboard.addListener("keyboardDidHide", () => setOpen(false));
    return () => {
      sub.remove();
      if (blurTimer.current) clearTimeout(blurTimer.current);
    };
  }, []);

  const trimmedQuery = query.trim();
  const showSearchResults = trimmedQuery.length > 0;
  const showPanel = open;
  const listMaxHeight = showSearchResults
    ? RESULT_LIST_MAX_HEIGHT
    : RESULT_LIST_MAX_HEIGHT + TRENDING_LABEL_HEIGHT;

  return (
    <View style={styles.root}>
      <View style={styles.searchBar}>
        <Feather name="search" size={16} color={PRODUCT.fgFaint} />
        <TextInput
          value={query}
          onChangeText={handleQuery}
          onFocus={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            setOpen(true);
          }}
          onBlur={() => {
            if (blurTimer.current) clearTimeout(blurTimer.current);
            blurTimer.current = setTimeout(() => setOpen(false), 180);
          }}
          placeholder="Search for stocks"
          placeholderTextColor={PRODUCT.fgFaint}
          autoCapitalize="none"
          autoCorrect={false}
          spellCheck={false}
          autoComplete="off"
          returnKeyType="search"
          accessibilityLabel="Search stocks"
          style={styles.input}
        />
        {query.length > 0 ? (
          <Pressable
            onPress={() => {
              setQuery("");
              onQueryChange?.("");
              setOpen(true);
            }}
            hitSlop={8}
            accessibilityLabel="Clear search"
          >
            <Feather name="x" size={16} color={PRODUCT.fgFaint} />
          </Pressable>
        ) : null}
      </View>

      {showPanel ? (
        <View style={styles.panel}>
          {!showSearchResults && recent.length > 0 ? (
            <View style={styles.recentBlock}>
              <Text style={styles.sectionLabel}>Recent</Text>
              <View style={styles.chips}>
                {recent.map((entry) => (
                  <Pressable
                    key={entry.symbol}
                    onPress={() => handleSelect(entry)}
                    style={({ pressed }) => [styles.chipRecent, pressed && styles.rowPressed]}
                  >
                    <StockLogo symbol={entry.symbol} size={20} />
                    <Text style={styles.chipRecentText} numberOfLines={1}>
                      {entry.companyName}{" "}
                      <Text style={styles.chipRecentSymbol}>{entry.symbol}</Text>
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          ) : null}

          <ScrollView
            style={[styles.list, { maxHeight: listMaxHeight }]}
            nestedScrollEnabled
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
            persistentScrollbar={false}
          >
            {showSearchResults ? (
              loading ? (
                <View style={styles.loading}>
                  <ActivityIndicator color={PRODUCT.fgSubtle} />
                </View>
              ) : results.length === 0 ? (
                <Text style={styles.empty}>No tickers found.</Text>
              ) : (
                results.map((entry) => (
                  <SearchResultRow key={entry.symbol} entry={entry} onSelect={handleSelect} />
                ))
              )
            ) : (
              <View style={styles.trendingBlock}>
                <Text style={[styles.sectionLabel, styles.trendingLabel]}>Trending</Text>
                {!trendingReady ? (
                  <View style={styles.loading}>
                    <ActivityIndicator color={PRODUCT.fgSubtle} />
                  </View>
                ) : (
                  trending.map((entry) => (
                    <SearchResultRow key={entry.symbol} entry={entry} onSelect={handleSelect} />
                  ))
                )}
              </View>
            )}
          </ScrollView>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { gap: 10 },
  searchBar: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    backgroundColor: PRODUCT.card,
    borderRadius: 16,
    paddingHorizontal: 14,
    paddingVertical: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PRODUCT.border,
  },
  input: {
    flex: 1,
    minWidth: 0,
    fontFamily: FONTS.sans,
    fontSize: 16,
    lineHeight: 22,
    color: PRODUCT.fg,
    padding: 0,
  },
  panel: {
    backgroundColor: PRODUCT.card,
    borderRadius: RADIUS.row,
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: PRODUCT.border,
  },
  list: { flexGrow: 0 },
  loading: { paddingVertical: 36, alignItems: "center" },
  empty: {
    ...PTYPE.body,
    textAlign: "center",
    paddingVertical: 32,
    paddingHorizontal: 16,
    color: PRODUCT.fgMuted,
  },
  recentBlock: {
    paddingHorizontal: 16,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PRODUCT.border,
  },
  trendingBlock: { paddingBottom: 6 },
  trendingLabel: { paddingHorizontal: 16, paddingTop: 12 },
  sectionLabel: {
    ...PTYPE.microLabel,
    marginBottom: 10,
  },
  chips: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  chipRecent: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    maxWidth: "100%",
    backgroundColor: PRODUCT.fill,
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  chipRecentText: {
    fontFamily: FONTS.sans,
    fontSize: 12,
    color: PRODUCT.fg,
    maxWidth: 180,
  },
  chipRecentSymbol: { color: PRODUCT.fgMuted },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: PRODUCT.border,
  },
  rowPressed: { backgroundColor: PRODUCT.fill },
  rowBody: { flex: 1, minWidth: 0 },
  company: {
    fontFamily: FONTS.sansMedium,
    fontSize: 14,
    lineHeight: 18,
    color: PRODUCT.fg,
  },
  metaLine: { flexDirection: "row", alignItems: "center", gap: 6, marginTop: 3 },
  meta: { ...PTYPE.small, flexShrink: 1 },
  logoFallback: { backgroundColor: PRODUCT.fill },
});
