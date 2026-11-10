"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent } from "react";
import { FileSpreadsheet, ImageUp, Landmark, Loader2, X } from "lucide-react";
import { TICKER_PATTERN, type PickedStock } from "@/lib/onboarding";
import { cleanTicker, parseHoldingsCsv } from "@/lib/portfolio";
import { GEIST, MONO, MonoLabel } from "./Steps";

/**
 * The welcome flow's "Connect your portfolio" step: a screenshot (read on the
 * server), a broker CSV (read here in the browser) or a SnapTrade broker link.
 * Whatever comes back is listed for the member to check, edit or trim before
 * it feeds the rest of the flow.
 */

type Sources = { screenshot: boolean; broker: boolean };
type Busy = "screenshot" | "csv" | "broker" | null;

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
/** Long edge of the image we send: plenty for reading a holdings list. */
const MAX_IMAGE_EDGE = 2400;
const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/heic,image/heif,.heic,.heif";
const CSV_ACCEPT = ".csv,text/csv,text/plain,application/vnd.ms-excel";

const ROW =
  "flex w-full items-center gap-4 rounded-xl border px-5 py-3.5 text-left outline-none transition-colors focus-visible:border-black/50";
const ROW_ON = "border-black/[0.12] hover:border-black/30";
const ROW_OFF = "cursor-not-allowed border-black/[0.07] opacity-60";
const QUIET =
  "text-xs uppercase tracking-[0.18em] text-[#9a9a9a] outline-none transition-colors hover:text-[#1d1b1b] focus-visible:text-[#1d1b1b]";

function isHeic(file: File) {
  return /heic|heif/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/**
 * A JPEG no larger than MAX_IMAGE_EDGE on its long side, decoded by the
 * browser (which also turns HEIC into JPEG where the browser can read it).
 */
async function prepareImage(file: File): Promise<Blob> {
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_IMAGE_EDGE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no canvas");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.92));
    if (!blob) throw new Error("no blob");
    return blob;
  } catch {
    if (isHeic(file)) {
      throw new Error("This browser can't open HEIC files. Take a PNG screenshot or save the image as JPG.");
    }
    if (["image/png", "image/jpeg", "image/webp"].includes(file.type)) return file;
    throw new Error("Use a PNG, JPG, WEBP or HEIC image.");
  }
}

async function readJson(res: Response): Promise<{ holdings?: PickedStock[]; error?: string; url?: string }> {
  try {
    return (await res.json()) as { holdings?: PickedStock[]; error?: string; url?: string };
  } catch {
    return {};
  }
}

function formatShares(n: number | undefined) {
  return n === undefined ? "" : String(Math.round(n * 10000) / 10000);
}

export function PortfolioConnect({
  value,
  onChange,
  getToken,
}: {
  value: PickedStock[];
  onChange: (stocks: PickedStock[]) => void;
  /** The member's Supabase access token for the server routes, or null. */
  getToken: () => Promise<string | null>;
}) {
  const [sources, setSources] = useState<Sources | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const csvInput = useRef<HTMLInputElement>(null);
  const valueRef = useRef(value);
  valueRef.current = value;

  useEffect(() => {
    let live = true;
    fetch("/api/portfolio/status", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<Sources>) : { screenshot: false, broker: false }))
      .catch(() => ({ screenshot: false, broker: false }))
      .then((s) => live && setSources(s));
    return () => {
      live = false;
    };
  }, []);

  const authHeaders = useCallback(async (): Promise<HeadersInit | null> => {
    const token = await getToken();
    return token ? { Authorization: `Bearer ${token}` } : null;
  }, [getToken]);

  const found = useCallback(
    (holdings: PickedStock[] | undefined, empty: string) => {
      if (!holdings || holdings.length === 0) {
        setError(empty);
        return;
      }
      setError(null);
      onChange(holdings);
    },
    [onChange],
  );

  const uploadScreenshot = useCallback(
    async (file: File) => {
      if (!sources?.screenshot) {
        setError("Screenshot upload isn't available yet. Try a CSV for now.");
        return;
      }
      if (file.size > MAX_UPLOAD_BYTES) {
        setError("That image is over 10 MB.");
        return;
      }
      setBusy("screenshot");
      setError(null);
      try {
        const headers = await authHeaders();
        if (!headers) throw new Error("Sign in again to upload a screenshot.");
        const form = new FormData();
        form.append("image", await prepareImage(file), "portfolio.jpg");
        const res = await fetch("/api/portfolio/screenshot", { method: "POST", headers, body: form });
        const body = await readJson(res);
        if (!res.ok) throw new Error(body.error ?? "We couldn't read that screenshot. Try a CSV instead.");
        found(body.holdings, "We couldn't find any tickers in that screenshot.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "We couldn't read that screenshot.");
      } finally {
        setBusy(null);
      }
    },
    [authHeaders, found, sources?.screenshot],
  );

  const uploadCsv = useCallback(
    async (file: File) => {
      if (file.size > MAX_UPLOAD_BYTES) {
        setError("That file is over 10 MB.");
        return;
      }
      setBusy("csv");
      setError(null);
      try {
        const parsed = parseHoldingsCsv(await file.text());
        if (!parsed.ok) throw new Error(parsed.error);
        // Fill in company names from the SEC list where it knows the ticker.
        let holdings = parsed.holdings;
        try {
          const res = await fetch(`/api/tickers?symbols=${encodeURIComponent(holdings.map((h) => h.ticker).join(","))}`);
          const body = (await res.json()) as { names?: Record<string, string> };
          if (body.names) holdings = holdings.map((h) => ({ ...h, name: body.names?.[h.ticker] ?? h.name }));
        } catch {
          // Names are a nicety; the tickers are what matter.
        }
        found(holdings, "We couldn't find any stock holdings in that file.");
      } catch (err) {
        setError(err instanceof Error ? err.message : "We couldn't read that file.");
      } finally {
        setBusy(null);
      }
    },
    [found],
  );

  const connectBroker = useCallback(async () => {
    if (!sources?.broker) return;
    // Opened inside the click so pop-up blockers allow it; pointed at the portal once we have the link.
    const popup = window.open("", "falcon-broker", "width=520,height=760");
    if (!popup) {
      setError("Allow pop-ups for this site to connect your broker.");
      return;
    }
    setBusy("broker");
    setError(null);
    try {
      const headers = await authHeaders();
      if (!headers) throw new Error("Sign in again to connect a broker.");
      const res = await fetch("/api/portfolio/broker/start", { method: "POST", headers });
      const body = await readJson(res);
      if (!res.ok || !body.url) throw new Error(body.error ?? "We couldn't reach the broker service.");
      popup.location.href = body.url;

      // Done when the portal sends the member back (a message) or the window closes.
      await new Promise<void>((resolve) => {
        const finish = () => {
          window.removeEventListener("message", onMessage);
          clearInterval(watch);
          resolve();
        };
        const onMessage = (event: MessageEvent) => {
          if (event.origin === window.location.origin && (event.data as { type?: string })?.type === "falcon:broker") {
            finish();
          }
        };
        const watch = setInterval(() => {
          if (popup.closed) finish();
        }, 500);
        window.addEventListener("message", onMessage);
      });

      // Always called: it also removes the temporary SnapTrade link.
      const holdingsRes = await fetch("/api/portfolio/broker/holdings", { method: "POST", headers });
      const holdingsBody = await readJson(holdingsRes);
      if (!holdingsRes.ok) throw new Error(holdingsBody.error ?? "We couldn't read your broker holdings.");
      found(holdingsBody.holdings, "No holdings came back from your broker. Try again or use a CSV.");
    } catch (err) {
      if (!popup.closed) popup.close();
      setError(err instanceof Error ? err.message : "We couldn't connect your broker.");
    } finally {
      setBusy(null);
    }
  }, [authHeaders, found, sources?.broker]);

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (!file || busy) return;
    if (/\.csv$/i.test(file.name) || file.type === "text/csv") void uploadCsv(file);
    else if (file.type.startsWith("image/") || isHeic(file)) void uploadScreenshot(file);
    else setError("Drop a screenshot or a CSV file.");
  }

  /* ---------------- Review: the holdings found ---------------- */

  const update = (index: number, patch: Partial<PickedStock>) => {
    onChange(valueRef.current.map((h, i) => (i === index ? { ...h, ...patch } : h)));
  };

  async function commitTicker(index: number, raw: string) {
    const current = valueRef.current[index];
    const ticker = cleanTicker(raw) ?? raw.trim().toUpperCase();
    if (!current || ticker === current.ticker) return;
    update(index, { ticker, name: "" });
    if (!TICKER_PATTERN.test(ticker)) return;
    try {
      const res = await fetch(`/api/tickers?symbols=${encodeURIComponent(ticker)}`);
      const body = (await res.json()) as { names?: Record<string, string> };
      const name = body.names?.[ticker];
      if (name && valueRef.current[index]?.ticker === ticker) update(index, { name });
    } catch {
      // Leave the name empty.
    }
  }

  if (value.length > 0) {
    return (
      <div>
        <div className="flex items-baseline justify-between gap-4">
          <MonoLabel>
            {value.length} {value.length === 1 ? "holding" : "holdings"}
          </MonoLabel>
          <button type="button" onClick={() => onChange([])} className={QUIET} style={{ fontFamily: MONO }}>
            Start over
          </button>
        </div>
        <ul className="mt-3 max-h-[min(360px,45dvh)] divide-y divide-black/[0.06] overflow-y-auto border-y border-black/[0.06]">
          {value.map((h, i) => {
            const valid = TICKER_PATTERN.test(h.ticker);
            return (
              <li key={`${i}-${h.ticker}`} className="flex items-center gap-3 py-2.5" style={{ fontFamily: GEIST }}>
                <input
                  defaultValue={h.ticker}
                  onBlur={(e) => void commitTicker(i, e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  aria-label="Ticker"
                  aria-invalid={!valid}
                  spellCheck={false}
                  autoCapitalize="characters"
                  className={`-ml-2 w-[72px] shrink-0 rounded-md border bg-transparent px-2 py-1.5 text-[12px] uppercase text-[#1d1b1b] outline-none transition-colors focus:border-black/40 ${
                    valid ? "border-transparent hover:border-black/10" : "border-red-400"
                  }`}
                  style={{ fontFamily: MONO }}
                />
                <span className="min-w-0 flex-1 truncate text-[13px] text-[#767676]">{h.name}</span>
                <input
                  defaultValue={formatShares(h.shares)}
                  onBlur={(e) => {
                    const n = Number.parseFloat(e.target.value.replace(/,/g, ""));
                    update(i, { shares: Number.isFinite(n) && n > 0 ? n : undefined });
                  }}
                  inputMode="decimal"
                  placeholder="Shares"
                  aria-label={`Shares of ${h.ticker}`}
                  className="w-[84px] shrink-0 rounded-md border border-transparent bg-transparent px-2 py-1.5 text-right text-[13px] text-[#1d1b1b] outline-none transition-colors placeholder:text-[#b4b4b0] hover:border-black/10 focus:border-black/40"
                />
                <button
                  type="button"
                  onClick={() => onChange(valueRef.current.filter((_, j) => j !== i))}
                  aria-label={`Remove ${h.ticker}`}
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[#8a8a8a] outline-none transition-colors hover:bg-black/[0.05] hover:text-[#1d1b1b] focus-visible:bg-black/[0.05]"
                >
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    );
  }

  /* ---------------- Choose: three ways in ---------------- */

  const options = [
    {
      id: "screenshot" as const,
      icon: ImageUp,
      title: "Upload a screenshot",
      enabled: sources?.screenshot === true,
      onClick: () => imageInput.current?.click(),
    },
    {
      id: "csv" as const,
      icon: FileSpreadsheet,
      title: "Upload a CSV",
      enabled: true,
      onClick: () => csvInput.current?.click(),
    },
    {
      id: "broker" as const,
      icon: Landmark,
      title: "Connect your broker",
      enabled: sources?.broker === true,
      onClick: () => void connectBroker(),
    },
  ];

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!busy) setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
      className={`rounded-2xl transition-colors ${dragging ? "bg-black/[0.03]" : ""}`}
    >
      <div className="space-y-2.5">
        {options.map((option) => {
          const Icon = option.icon;
          const isBusy = busy === option.id;
          const disabled = !option.enabled || (busy !== null && !isBusy);
          return (
            <button
              key={option.id}
              type="button"
              onClick={option.onClick}
              disabled={disabled || isBusy}
              aria-busy={isBusy}
              className={`${ROW} ${option.enabled ? ROW_ON : ROW_OFF} disabled:cursor-default`}
              style={{ fontFamily: GEIST }}
            >
              <Icon className="h-5 w-5 shrink-0 text-[#1d1b1b]" strokeWidth={1.5} aria-hidden />
              <span className="min-w-0 flex-1 text-[15px] text-[#1d1b1b]">{option.title}</span>
              {isBusy ? (
                <Loader2 className="h-4 w-4 shrink-0 animate-spin text-[#8a8a8a]" aria-hidden />
              ) : sources && !option.enabled ? (
                <span
                  className="shrink-0 text-[10px] uppercase tracking-[0.18em] text-[#9a9a9a]"
                  style={{ fontFamily: MONO }}
                >
                  Coming soon
                </span>
              ) : null}
            </button>
          );
        })}
      </div>

      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-red-600" style={{ fontFamily: GEIST }}>
          {error}
        </p>
      ) : null}

      <input
        ref={imageInput}
        type="file"
        accept={IMAGE_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void uploadScreenshot(file);
        }}
      />
      <input
        ref={csvInput}
        type="file"
        accept={CSV_ACCEPT}
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void uploadCsv(file);
        }}
      />
    </div>
  );
}
