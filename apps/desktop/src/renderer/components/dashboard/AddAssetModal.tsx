import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, Feather, Star, X, type LucideIcon } from "lucide-react";
import { getAccessToken } from "@/lib/broker-links";
import { cn } from "@/lib/utils";
import falconLogo from "@/assets/brand/logo-black.png";
import type { SnaptradeBrokerage } from "../../../shared/snaptrade";

type Broker = {
  name: string;
  rating?: number;
  subtitle?: string;
  Icon?: LucideIcon;
  img?: string;
  /** Color for the icon / monogram fallback (logo images have no tile). */
  accent?: string;
  /** Render the logo as a rounded-corner square (all brokers except Falcon). */
  rounded?: boolean;
  /** SnapTrade brokerage slug used to open the connection portal. */
  slug?: string;
};

// Always available — the app's own paper-trading option, not from SnapTrade.
const FALCON: Broker = {
  name: "Falcon",
  img: falconLogo,
};

// Shown only when SnapTrade isn't configured, so the picker isn't empty.
const ROBINHOOD_FALLBACK: Broker = {
  name: "Robinhood",
  rating: 4.5,
  Icon: Feather,
  accent: "#c9f31d",
};

function toBroker(b: SnaptradeBrokerage): Broker {
  return {
    name: b.name,
    img: b.logoUrl ?? undefined,
    accent: "#e5e5e5",
    rounded: true,
    slug: b.slug || undefined,
  };
}

function BrokerCard({
  broker,
  selected,
  onToggle,
}: {
  broker: Broker;
  selected: boolean;
  onToggle: () => void;
}) {
  const [imgOk, setImgOk] = useState(true);

  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={selected}
      className={cn(
        "app-no-drag relative flex h-[120px] w-[116px] flex-col items-center justify-center gap-2 rounded-xl border px-2 text-center transition-colors",
        selected
          ? "border-emerald-500 bg-emerald-500/10"
          : "border-white/[0.08] bg-white/[0.02] hover:bg-white/[0.05]",
      )}
    >
      {selected ? (
        <span className="absolute right-2 top-2 flex h-4 w-4 items-center justify-center rounded-full bg-emerald-500 text-black">
          <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
        </span>
      ) : null}

      {broker.img && imgOk ? (
        <img
          src={broker.img}
          alt=""
          className={cn(
            "h-11 w-11 object-contain",
            broker.rounded && "rounded-xl object-cover",
          )}
          onError={() => setImgOk(false)}
        />
      ) : (
        <span
          className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/[0.06] text-lg font-bold"
          style={{ color: broker.accent }}
        >
          {broker.Icon ? (
            <broker.Icon className="h-6 w-6" strokeWidth={2} aria-hidden />
          ) : (
            broker.name.charAt(0).toUpperCase()
          )}
        </span>
      )}

      <span className="line-clamp-1 w-full text-xs font-medium text-foreground">
        {broker.name}
      </span>

      {broker.subtitle ? (
        <span className="line-clamp-1 text-[10px] leading-tight text-fg-faint">
          {broker.subtitle}
        </span>
      ) : broker.rating !== undefined ? (
        <span className="flex items-center gap-1 text-[11px] text-fg-muted">
          <Star className="h-3 w-3 fill-current" strokeWidth={0} aria-hidden />
          {broker.rating.toFixed(1)}
        </span>
      ) : null}
    </button>
  );
}

type LoadState =
  | { status: "loading" }
  | { status: "ready"; brokers: Broker[] }
  | { status: "unconfigured" }
  | { status: "error"; message: string };

// Cache the brokerage list for the session so reopening the modal is instant.
// Only stable outcomes are cached; errors stay retryable on the next open.
let cachedLoad: LoadState | null = null;

export default function AddAssetModal({
  onClose,
  onCreatePaperAccount,
}: {
  onClose: () => void;
  onCreatePaperAccount: (balance: number) => void;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const [load, setLoad] = useState<LoadState>(
    () => cachedLoad ?? { status: "loading" },
  );
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);
  const [step, setStep] = useState<"select" | "balance">("select");
  const [amount, setAmount] = useState("");

  // Animate in on mount (next frame so the transition actually runs).
  useEffect(() => {
    const id = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(id);
  }, []);

  // Animate out, then unmount once the transition has played.
  const requestClose = useCallback(() => {
    setVisible(false);
    window.setTimeout(onClose, 200);
  }, [onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") requestClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  useEffect(() => {
    // Already have a stable (cached) result — skip the refetch entirely.
    if (cachedLoad) return;
    let cancelled = false;

    async function run() {
      let next: LoadState;
      try {
        if (!window.meridian?.listBrokerages) {
          next = { status: "unconfigured" };
        } else {
          const token = await getAccessToken();
          const res = await window.meridian.listBrokerages(token);
          if (res.ok) {
            next = { status: "ready", brokers: res.brokerages.map(toBroker) };
          } else if (!res.configured) {
            next = { status: "unconfigured" };
          } else {
            next = { status: "error", message: res.error };
          }
        }
      } catch (err) {
        next = {
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }

      if (cancelled) return;
      // Cache stable outcomes; leave errors uncached so reopening retries.
      if (next.status === "ready" || next.status === "unconfigured") {
        cachedLoad = next;
      }
      setLoad(next);
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  function toggle(name: string) {
    setSelected((prev) => (prev === name ? null : name));
  }

  // Falcon is always first; SnapTrade brokerages follow (or a fallback offline).
  const remote: Broker[] =
    load.status === "ready"
      ? load.brokers
      : load.status === "loading"
        ? []
        : [ROBINHOOD_FALLBACK];
  const brokers: Broker[] = [FALCON, ...remote];

  async function handleContinue() {
    if (!selected || connecting) return;
    const broker = brokers.find((b) => b.name === selected);
    if (!broker) return;
    // Falcon is the app's own paper trading — pick a starting balance first.
    if (broker.name === FALCON.name) {
      setStep("balance");
      return;
    }
    const connect = window.meridian?.connectBrokerage;
    if (!connect) {
      setConnectError("Connection API unavailable — restart the app to load the latest build.");
      return;
    }
    setConnecting(true);
    setConnectError(null);
    try {
      const token = await getAccessToken();
      const res = await connect({ broker: broker.slug, accessToken: token });
      if (res.ok) {
        requestClose();
      } else {
        setConnectError(res.error || "Couldn't start the connection.");
      }
    } catch (err) {
      setConnectError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  }

  const amountValue = Number(amount);
  const amountValid = Number.isFinite(amountValue) && amountValue > 0;

  function handleCreate() {
    if (!amountValid) return;
    onCreatePaperAccount(Math.round(amountValue));
    requestClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      {/* Backdrop */}
      <div
        className={cn(
          "app-no-drag absolute inset-0 bg-black/70 backdrop-blur-sm transition-opacity duration-200 ease-out",
          visible ? "opacity-100" : "opacity-0",
        )}
        onClick={requestClose}
        aria-hidden
      />

      {/* Panel */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Connect your brokerage"
        className={cn(
          "app-no-drag relative z-10 flex max-h-[86vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-white/[0.10] bg-background shadow-2xl transition-all duration-200 ease-out",
          visible
            ? "translate-y-0 scale-100 opacity-100"
            : "translate-y-3 scale-95 opacity-0",
        )}
      >
        <button
          type="button"
          onClick={requestClose}
          aria-label="Close"
          className="absolute right-5 top-5 z-20 text-fg-faint transition-colors hover:text-foreground"
        >
          <X className="h-5 w-5" strokeWidth={1.75} aria-hidden />
        </button>

        {step === "select" ? (
          <>
        {/* Scrollable content */}
        <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-24 pt-8">
          <h2 className="pr-10 text-xl font-semibold text-foreground">
            Connect your brokerage
          </h2>
          <p className="mt-1 text-sm text-fg-muted">
            Link an account to sync your portfolio live.
          </p>

          <div className="mt-6 flex flex-wrap justify-center gap-3">
            {brokers.map((broker) => (
              <BrokerCard
                key={broker.name}
                broker={broker}
                selected={selected === broker.name}
                onToggle={() => toggle(broker.name)}
              />
            ))}
          </div>

          {load.status === "loading" ? (
            <p className="mt-4 text-center text-xs text-fg-faint">
              Loading brokerages…
            </p>
          ) : load.status === "unconfigured" ? (
            <p className="mt-4 text-center text-xs text-fg-faint">
              Set SNAPTRADE_CLIENT_ID and SNAPTRADE_CONSUMER_KEY to load every
              supported brokerage.
            </p>
          ) : load.status === "error" ? (
            <p className="mt-4 text-center text-xs text-red-400/80">
              Couldn&apos;t load brokerages: {load.message}
            </p>
          ) : null}
        </div>

        {/* Sticky Continue bar — slides up from the bottom on selection */}
        <div
          style={{
            maskImage: "linear-gradient(to top, #000 55%, transparent)",
            WebkitMaskImage: "linear-gradient(to top, #000 55%, transparent)",
          }}
          className={cn(
            "absolute inset-x-0 bottom-0 z-10 flex justify-center bg-gradient-to-t from-background via-background to-transparent px-8 pb-6 pt-16 backdrop-blur-sm transition-all duration-300 ease-out",
            selected
              ? "pointer-events-auto translate-y-0 opacity-100"
              : "pointer-events-none translate-y-6 opacity-0",
          )}
        >
          <div className="flex w-full flex-col items-center gap-2">
            {connectError ? (
              <p className="text-xs text-red-400/90">{connectError}</p>
            ) : null}
            <button
              type="button"
              onClick={handleContinue}
              disabled={connecting}
              className="app-no-drag w-full rounded-lg bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              {connecting ? "Connecting…" : "Continue"}
            </button>
          </div>
        </div>
          </>
        ) : (
          <div className="flex flex-col px-8 pb-8 pt-8">
            <button
              type="button"
              onClick={() => setStep("select")}
              className="app-no-drag flex items-center gap-1 self-start text-xs text-fg-faint transition-colors hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" strokeWidth={1.75} aria-hidden />
              Back
            </button>

            <div className="mt-6 flex flex-col items-center text-center">
              <img src={falconLogo} alt="" className="h-12 w-12 object-contain" />
              <h2 className="mt-4 text-xl font-semibold text-foreground">
                Set your starting balance
              </h2>
              <p className="mt-1 text-sm text-fg-muted">
                Your Falcon paper-trading account starts with this cash.
              </p>

              <div className="mt-7 flex items-center justify-center gap-1 text-4xl font-semibold tabular-nums text-foreground">
                <span className="text-fg-faint">$</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) =>
                    setAmount(e.target.value.replace(/[^0-9]/g, ""))
                  }
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleCreate();
                  }}
                  placeholder="0"
                  autoFocus
                  className="w-44 bg-transparent text-center outline-none placeholder:text-fg-faint"
                />
              </div>

              <div className="mt-6 flex gap-2">
                {[1000, 10000, 100000].map((preset) => (
                  <button
                    key={preset}
                    type="button"
                    onClick={() => setAmount(String(preset))}
                    className="app-no-drag rounded-full border border-white/[0.12] px-3 py-1 text-xs text-fg-muted transition-colors hover:text-foreground"
                  >
                    ${preset.toLocaleString("en-US")}
                  </button>
                ))}
              </div>
            </div>

            <button
              type="button"
              onClick={handleCreate}
              disabled={!amountValid}
              className="app-no-drag mt-8 w-full rounded-lg bg-white py-2.5 text-sm font-medium text-black transition-opacity hover:opacity-90 disabled:opacity-40"
            >
              Create account
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
