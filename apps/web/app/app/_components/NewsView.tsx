"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCw, Search } from "lucide-react";
import type { NewsItem } from "@/app/api/news/route";
import { MONO, timeAgo } from "./parts";
import { CardBody, CardHeader, TextButton } from "./shell/ui";

/**
 * Temporary News view: company news and SEC filings for every US-listed
 * company (/api/news: publishers' articles collected through Finnhub, and
 * EDGAR filings from the filings sweeper), to test pulling news into Falcon.
 * Each row shows the same source label Falcon AI uses; filings carry their
 * form. Opens from the rail. The ticker box filters to one symbol.
 */

const REFRESH_MS = 2 * 60_000;

type State = { status: "loading" } | { status: "ready"; items: NewsItem[] } | { status: "error"; message: string };

export function NewsView({ headerExtra }: { headerExtra?: React.ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [symbol, setSymbol] = useState("");

  useEffect(() => {
    const next = query.trim().toUpperCase();
    const id = setTimeout(() => setSymbol(next), 350);
    return () => clearTimeout(id);
  }, [query]);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch(symbol ? `/api/news?symbol=${encodeURIComponent(symbol)}` : "/api/news", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { items?: NewsItem[]; error?: string } | null;
      if (!res.ok || !body?.items) setState({ status: "error", message: body?.error ?? `Could not load news (HTTP ${res.status})` });
      else setState({ status: "ready", items: body.items });
    } catch {
      setState({ status: "error", message: "Could not load news" });
    } finally {
      setBusy(false);
    }
  }, [symbol]);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(id);
  }, [load]);

  return (
    <>
      <CardHeader
        title="News"
        actions={
          <>
            <label className="relative flex h-8 w-[112px] items-center">
              <Search width={13} height={13} strokeWidth={1.75} aria-hidden className="pointer-events-none absolute left-2.5 text-faint" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value.replace(/[^A-Za-z0-9.\-]/g, "").slice(0, 12))}
                onKeyDown={(e) => {
                  if (e.key === "Escape" && query) {
                    e.preventDefault();
                    setQuery("");
                  }
                }}
                placeholder="Ticker"
                aria-label="Filter by ticker"
                spellCheck={false}
                autoCapitalize="characters"
                className="h-8 w-full min-w-0 rounded-lg border border-line/[0.1] bg-surface pl-8 pr-2 text-fs-13 uppercase text-fore outline-none transition-colors placeholder:normal-case placeholder:text-faint-2 hover:border-line/[0.16] focus-visible:border-line/[0.22] focus-visible:ring-2 focus-visible:ring-line/15 [&::-webkit-search-cancel-button]:hidden"
                style={{ fontFamily: MONO }}
              />
            </label>
            <TextButton icon={RotateCw} onClick={() => void load()} disabled={busy}>
              Refresh
            </TextButton>
            {headerExtra}
          </>
        }
      />
      <CardBody>
        {state.status === "loading" ? (
          <p className="px-5 py-6 text-fs-13 text-quiet">Loading news</p>
        ) : state.status === "error" ? (
          <p className="px-5 py-6 text-fs-13 text-quiet">{state.message}</p>
        ) : state.items.length === 0 ? (
          <p className="px-5 py-6 text-fs-13 text-quiet">{symbol ? `No news for ${symbol} yet` : "No news right now"}</p>
        ) : (
          <ul className="flex flex-col px-2 py-2">
            {state.items.map((n) => (
              <li key={`${n.kind}:${n.id}`}>
                <a
                  href={n.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors hover:bg-line/[0.04] focus-visible:bg-line/[0.05]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-h-[20px] items-center gap-1.5 text-fs-11.5 text-quiet" style={{ fontFamily: MONO }}>
                      {n.kind === "filing" && n.form ? (
                        <span className="shrink-0 rounded border border-line/[0.16] px-1 text-fs-11 leading-[16px] text-fore">{n.form}</span>
                      ) : null}
                      <span className="min-w-0 truncate">{n.label}</span>
                      {n.related.length ? (
                        <>
                          <span aria-hidden>·</span>
                          <span className="min-w-0 truncate text-fore">{n.related.join(" ")}</span>
                        </>
                      ) : null}
                      <span className="ml-auto shrink-0 text-faint">{timeAgo(n.datetime)}</span>
                    </span>
                    <span className="mt-0.5 block text-fs-13.5 font-medium leading-fs-19 text-fore">{n.headline}</span>
                    {n.summary ? <span className="mt-0.5 line-clamp-2 text-fs-13 text-quiet">{n.summary}</span> : null}
                  </span>
                  {n.image ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={n.image} alt="" loading="lazy" className="mt-1 h-14 w-20 shrink-0 rounded-md bg-line/[0.04] object-cover" />
                  ) : null}
                </a>
              </li>
            ))}
          </ul>
        )}
      </CardBody>
    </>
  );
}
