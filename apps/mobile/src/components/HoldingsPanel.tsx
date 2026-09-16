import { useEffect, useMemo, useState } from "react";
import { Image, Pressable, StyleSheet, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { Feather } from "@expo/vector-icons";
import GlassPanel from "@/components/GlassPanel";
import PressableScale from "@/components/PressableScale";
import StockIcon from "@/components/StockIcon";
import {
  fetchLiveBrokerSnapshot,
  fetchPaperAccount,
  type LiveBrokerageAccount,
  type PaperAccount,
} from "@/lib/brokers";
import { toggleDemoMode, useDemoMode } from "@/lib/demo-mode";
import { getStockQuote } from "@/lib/stock-quote";
import { FONTS, PRODUCT, PTYPE } from "@/theme";

const MASK = "$*****";

function fmtUsd(v: number, sign = false): string {
  const s = Math.abs(v).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return `${v < 0 ? "-" : sign && v > 0 ? "+" : ""}$${s}`;
}

function pnlTone(v: number): string {
  if (v > 0) return PRODUCT.gain;
  if (v < 0) return PRODUCT.loss;
  return PRODUCT.fgMuted;
}

/** Desktop PortfolioCard coaching line — tiered by move size. */
function pnlMessageParts(
  pnl: number,
  pct: number,
): { before: string; amount: string | null; after: string } {
  const amt = fmtUsd(Math.abs(pnl));
  const day = Math.floor(Date.now() / 86_400_000);
  if (Math.abs(pnl) < 0.005) {
    const flat = ["No meaningful move yet.", "Flat for now, watching the tape."];
    return { before: flat[day % flat.length], amount: null, after: "" };
  }
  const mag = Math.abs(pct);
  let variants: Array<[string, string]>;
  if (pnl > 0) {
    if (mag < 1) {
      variants = [
        ["Up ", ", ordinary drift, nothing more."],
        ["", " ahead today. A quiet green day."],
      ];
    } else if (mag < 5) {
      variants = [
        ["Up ", ", the book is moving your way."],
        ["", " in the green today. Good tape."],
      ];
    } else {
      variants = [
        ["Sitting on ", " of gains, a real run. Protect it."],
        ["Up ", ", the thesis is paying off in size."],
      ];
    }
  } else if (mag < 1) {
    variants = [
      ["Down ", ", within normal daily noise."],
      ["", " off today. Nothing that needs a decision."],
    ];
  } else if (mag < 5) {
    variants = [
      ["Down ", " today, softer, still inside the plan."],
      ["", " off, worth watching, not reacting."],
    ];
  } else {
    variants = [
      ["Down ", ", big enough to matter. Re-check the thesis."],
      ["", " drawdown, review sizing and the original case."],
    ];
  }
  const [before, after] = variants[day % variants.length];
  return { before, amount: amt, after };
}

function LetterAvatar({ label }: { label: string }) {
  return (
    <View style={styles.avatar}>
      <Text style={styles.avatarText}>{label.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}

/**
 * Assets card — desktop PortfolioCard layout on phone (glass shell).
 * Header "+" toggles demo mode (desktop Ctrl/⌘+P): fake holdings + fake graph.
 */
export default function HoldingsPanel({
  masked = false,
  onToggleMasked,
  refreshKey = 0,
  onPaperCreated,
}: {
  masked?: boolean;
  onToggleMasked?: () => void;
  refreshKey?: number;
  /** Fired when demo toggles so the dashboard chart/networth re-render. */
  onPaperCreated?: () => void;
}) {
  const router = useRouter();
  const demo = useDemoMode();
  const [realPaper, setRealPaper] = useState<PaperAccount | null>(null);
  const [brokerAccounts, setBrokerAccounts] = useState<LiveBrokerageAccount[]>([]);
  const [prices, setPrices] = useState<Record<string, number>>({});
  const [brokeragesOpen, setBrokeragesOpen] = useState(true);
  const [falconOpen, setFalconOpen] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [p, live] = await Promise.all([
          fetchPaperAccount(),
          fetchLiveBrokerSnapshot().catch(() => ({
            connected: false,
            total: 0,
            accounts: [] as LiveBrokerageAccount[],
          })),
        ]);
        if (cancelled) return;
        setRealPaper(p);
        setBrokerAccounts(live.accounts ?? []);
      } catch {
        if (!cancelled) {
          setRealPaper({ cash: 0, positions: {} });
          setBrokerAccounts([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);

  // Demo overlay replaces the Falcon paper book (desktop Ctrl+P).
  const paper = demo?.account ?? realPaper;
  // Live brokers stay visible under the tree unless demo is on — presentation
  // mode is a clean fake Falcon book, same as desktop.
  const shownBrokers = demo ? [] : brokerAccounts;

  const symbols = useMemo(
    () => Object.keys(paper?.positions ?? {}).sort(),
    [paper],
  );

  useEffect(() => {
    if (symbols.length === 0) {
      setPrices({});
      return;
    }
    let cancelled = false;
    void Promise.all(
      symbols.map(async (s) => {
        try {
          const q = await getStockQuote(s);
          return [s, q.price] as const;
        } catch {
          return null;
        }
      }),
    ).then((entries) => {
      if (cancelled) return;
      const next: Record<string, number> = {};
      for (const e of entries) {
        if (e && e[1] > 0) next[e[0]] = e[1];
      }
      setPrices(next);
    });
    return () => {
      cancelled = true;
    };
  }, [symbols.join(",")]);

  const rows = useMemo(() => {
    if (!paper) return [];
    return Object.values(paper.positions).map((p) => {
      const price = prices[p.symbol];
      const value = price != null ? p.shares * price : p.costUsd;
      const pnl = value - p.costUsd;
      return {
        symbol: p.symbol,
        value,
        pnlPct: Math.abs(p.costUsd) > 1e-9 ? (pnl / Math.abs(p.costUsd)) * 100 : 0,
      };
    });
  }, [paper, prices]);

  const totalPnl = useMemo(() => {
    if (!paper) return 0;
    return Object.values(paper.positions).reduce((s, p) => {
      const price = prices[p.symbol];
      const value = price != null ? p.shares * price : p.costUsd;
      return s + (value - p.costUsd);
    }, 0);
  }, [paper, prices]);

  const totalBasis = Object.values(paper?.positions ?? {}).reduce(
    (s, p) => s + Math.abs(p.costUsd),
    0,
  );
  const pnlPct = totalBasis > 1e-9 ? (totalPnl / totalBasis) * 100 : 0;
  const paperValue =
    (paper?.cash ?? 0) +
    Object.values(paper?.positions ?? {}).reduce((s, p) => {
      const price = prices[p.symbol];
      return s + (price != null ? p.shares * price : p.costUsd);
    }, 0);

  const money = (s: string) => (masked ? MASK : s);
  const msg = pnlMessageParts(totalPnl, pnlPct);
  const goBrokers = () => router.push("/brokers");

  function handleToggleDemo() {
    const on = toggleDemoMode();
    onPaperCreated?.();
    if (on) setFalconOpen(true);
  }

  return (
    <GlassPanel style={styles.panel}>
      <View style={styles.head}>
        <Text style={styles.headLabel}>ASSETS</Text>
        <View style={styles.headActions}>
          {onToggleMasked ? (
            <Pressable
              onPress={onToggleMasked}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel={masked ? "Show values" : "Hide values"}
            >
              <Feather
                name={masked ? "eye-off" : "eye"}
                size={16}
                color={PRODUCT.fgMuted}
              />
            </Pressable>
          ) : null}
          {/* Desktop Ctrl/⌘+P — fake portfolio + fake graph (not persisted). */}
          <Pressable
            onPress={handleToggleDemo}
            hitSlop={8}
            accessibilityRole="button"
            accessibilityLabel={
              demo ? "Exit demo portfolio" : "Toggle demo portfolio (Ctrl+P)"
            }
            style={[styles.paperBtn, demo && styles.paperBtnOn]}
          >
            <Feather name="plus" size={14} color="#ffffff" />
          </Pressable>
          <Pressable onPress={goBrokers} hitSlop={10} accessibilityLabel="Portfolio settings">
            <Feather name="sliders" size={16} color={PRODUCT.fgMuted} />
          </Pressable>
        </View>
      </View>

      <View style={styles.pnlRow}>
        <Text style={styles.pnlUsd} numberOfLines={1}>
          {money(fmtUsd(totalPnl, true))}
        </Text>
        <View style={styles.pnlPctRow}>
          <Feather
            name={pnlPct >= 0 ? "arrow-up-right" : "arrow-down-right"}
            size={14}
            color={pnlTone(pnlPct)}
          />
          <Text style={[styles.pnlPct, { color: pnlTone(pnlPct) }]}>
            {pnlPct >= 0 ? "+" : ""}
            {pnlPct.toFixed(2)}%
          </Text>
        </View>
      </View>

      <Text style={styles.coach}>
        {msg.before}
        {msg.amount ? (
          <Text style={{ color: pnlTone(totalPnl), fontFamily: FONTS.sansMedium }}>
            {money(msg.amount)}
          </Text>
        ) : null}
        {msg.after}
      </Text>

      <Pressable
        onPress={() => setBrokeragesOpen((v) => !v)}
        style={styles.sectionToggle}
        accessibilityRole="button"
      >
        <Feather
          name="chevron-right"
          size={12}
          color={PRODUCT.fgMuted}
          style={{ transform: [{ rotate: brokeragesOpen ? "90deg" : "0deg" }] }}
        />
        <Text style={styles.sectionLabel}>Brokerages</Text>
      </Pressable>

      {brokeragesOpen ? (
        <View>
          <Pressable
            onPress={() => setFalconOpen((v) => !v)}
            style={styles.falconRow}
            accessibilityRole="button"
          >
            <Feather
              name="chevron-right"
              size={12}
              color={PRODUCT.fgSubtle}
              style={{ transform: [{ rotate: falconOpen ? "90deg" : "0deg" }] }}
            />
            <View style={styles.falconLogo}>
              <Image
                source={require("../../assets/falcon-mark.png")}
                style={styles.falconLogoImg}
              />
            </View>
            <Text style={styles.falconName}>Falcon</Text>
            <Text style={styles.falconValue}>{money(fmtUsd(paperValue))}</Text>
          </Pressable>

          {falconOpen ? (
            <View style={styles.tree}>
              {rows.length === 0 ? (
                <Text style={styles.emptyPos}>No open positions.</Text>
              ) : (
                <>
                  {rows.map((row) => (
                    <View key={row.symbol} style={styles.holdingRow}>
                      <StockIcon symbol={row.symbol} size={20} />
                      <Text style={styles.holdingSym}>{row.symbol}</Text>
                      <View style={styles.holdingRight}>
                        <Text style={styles.holdingVal}>{money(fmtUsd(row.value))}</Text>
                        <Text style={[styles.holdingPct, { color: pnlTone(row.pnlPct) }]}>
                          {row.pnlPct >= 0 ? "↑" : "↓"} {Math.abs(row.pnlPct).toFixed(2)}%
                        </Text>
                      </View>
                    </View>
                  ))}
                  <Pressable onPress={goBrokers} style={styles.seeAll}>
                    <Text style={styles.seeAllText}>See all</Text>
                    <Feather name="chevron-right" size={12} color={PRODUCT.fgSubtle} />
                  </Pressable>
                </>
              )}
            </View>
          ) : null}

          {shownBrokers.map((acct) => (
            <View key={acct.id} style={styles.brokerRow}>
              <LetterAvatar label={acct.institution || acct.name || "B"} />
              <View style={styles.brokerMeta}>
                <Text style={styles.holdingSym}>{acct.institution || "Broker"}</Text>
                {acct.name ? <Text style={styles.brokerSub}>{acct.name}</Text> : null}
              </View>
              <Text style={styles.falconValue}>
                {acct.totalValue != null ? money(fmtUsd(acct.totalValue)) : "—"}
              </Text>
            </View>
          ))}
        </View>
      ) : null}

      <PressableScale
        onPress={goBrokers}
        style={styles.connect}
        pressedStyle={styles.connectHeld}
      >
        <Feather name="plus" size={14} color="#ffffff" />
        <Text style={styles.connectText}>Connect an asset</Text>
      </PressableScale>
    </GlassPanel>
  );
}

const styles = StyleSheet.create({
  // No outer margin: the module stack sets the gap between cards, and a
  // margin inside the context menu's host is measured away by SwiftUI.
  panel: {},
  head: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    marginBottom: 16,
  },
  headLabel: {
    fontFamily: FONTS.sansMedium,
    fontSize: 11,
    letterSpacing: 0.9,
    color: PRODUCT.fgSubtle,
  },
  headActions: { flexDirection: "row", alignItems: "center", gap: 14 },
  paperBtn: {
    width: 22,
    height: 22,
    borderRadius: 11,
    backgroundColor: "#1d1b1b",
    alignItems: "center",
    justifyContent: "center",
  },
  paperBtnOn: {
    backgroundColor: PRODUCT.gain,
  },
  pnlRow: {
    flexDirection: "row",
    alignItems: "flex-end",
    gap: 8,
    flexWrap: "wrap",
  },
  pnlUsd: {
    fontFamily: FONTS.sansMedium,
    fontSize: 30,
    lineHeight: 34,
    color: PRODUCT.fg,
  },
  pnlPctRow: { flexDirection: "row", alignItems: "center", gap: 2, marginBottom: 2 },
  pnlPct: { fontFamily: FONTS.sansMedium, fontSize: 13 },
  coach: {
    ...PTYPE.small,
    color: PRODUCT.fgSubtle,
    marginTop: 8,
    marginBottom: 14,
  },
  sectionToggle: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    marginBottom: 4,
  },
  sectionLabel: {
    fontFamily: FONTS.sansMedium,
    fontSize: 12,
    color: PRODUCT.fgMuted,
  },
  falconRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
  },
  falconLogo: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#ffffff",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
  },
  falconLogoImg: { width: 12, height: 12 },
  falconName: {
    fontFamily: FONTS.sansMedium,
    fontSize: 13,
    color: PRODUCT.fg,
    flex: 1,
  },
  falconValue: {
    fontFamily: FONTS.sans,
    fontSize: 12,
    color: PRODUCT.fgMuted,
  },
  tree: {
    marginLeft: 20,
    borderLeftWidth: StyleSheet.hairlineWidth,
    borderLeftColor: "rgba(0,0,0,0.1)",
    paddingLeft: 14,
  },
  emptyPos: { ...PTYPE.small, color: PRODUCT.fgSubtle, paddingVertical: 6 },
  holdingRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingVertical: 8,
  },
  avatar: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: "#E3E3E0",
    alignItems: "center",
    justifyContent: "center",
  },
  avatarText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 9,
    color: PRODUCT.fgMuted,
  },
  holdingSym: {
    fontFamily: FONTS.sansMedium,
    fontSize: 13,
    color: PRODUCT.fg,
  },
  holdingRight: {
    marginLeft: "auto",
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  holdingVal: {
    fontFamily: FONTS.sans,
    fontSize: 13,
    color: PRODUCT.fgBody,
  },
  holdingPct: {
    fontFamily: FONTS.sansMedium,
    fontSize: 12,
    minWidth: 64,
    textAlign: "right",
  },
  seeAll: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 2,
    paddingTop: 8,
  },
  seeAllText: {
    fontFamily: FONTS.sans,
    fontSize: 12,
    color: PRODUCT.fgSubtle,
  },
  brokerRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingVertical: 6,
    paddingLeft: 20,
  },
  brokerMeta: { flex: 1, minWidth: 0 },
  brokerSub: { ...PTYPE.small, color: PRODUCT.fgSubtle },
  connect: {
    marginTop: 20,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    borderRadius: 12,
    backgroundColor: "#1d1b1b",
    paddingVertical: 10,
  },
  connectHeld: { backgroundColor: "#0f0d0b" },
  connectText: {
    fontFamily: FONTS.sansMedium,
    fontSize: 13,
    color: "#ffffff",
  },
});
