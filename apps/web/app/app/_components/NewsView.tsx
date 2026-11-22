"use client";

import { useCallback, useEffect, useState } from "react";
import { RotateCw } from "lucide-react";
import type { NewsItem } from "@/app/api/news/route";
import { MONO, timeAgo } from "./parts";
import { CardBody, CardHeader, TextButton } from "./shell/ui";

/**
 * Temporary News view: market news for all companies from Finnhub
 * (/api/news), to test pulling news into Falcon. Opens from the rail.
 */

const REFRESH_MS = 2 * 60_000;

type State = { status: "loading" } | { status: "ready"; items: NewsItem[] } | { status: "error"; message: string };

export function NewsView({ headerExtra }: { headerExtra?: React.ReactNode }) {
  const [state, setState] = useState<State>({ status: "loading" });
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/news", { cache: "no-store" });
      const body = (await res.json().catch(() => null)) as { items?: NewsItem[]; error?: string } | null;
      if (!res.ok || !body?.items) setState({ status: "error", message: body?.error ?? `Could not load news (HTTP ${res.status})` });
      else setState({ status: "ready", items: body.items });
    } catch {
      setState({ status: "error", message: "Could not load news" });
    } finally {
      setBusy(false);
    }
  }, []);

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
          <p className="px-5 py-6 text-fs-13 text-quiet">No news right now</p>
        ) : (
          <ul className="flex flex-col px-2 py-2">
            {state.items.map((n) => (
              <li key={n.url}>
                <a
                  href={n.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex gap-3 rounded-lg px-3 py-2.5 outline-none transition-colors hover:bg-line/[0.04] focus-visible:bg-line/[0.05]"
                >
                  <span className="min-w-0 flex-1">
                    <span className="flex min-h-[20px] items-center gap-1.5 text-fs-11.5 text-quiet" style={{ fontFamily: MONO }}>
                      <span className="min-w-0 truncate">{n.source}</span>
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
