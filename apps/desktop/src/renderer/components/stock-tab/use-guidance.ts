import { useEffect, useState } from "react";
import type { GuidanceTrack } from "../../../shared/guidance-types";

/**
 * The guidance track record of one company (main/guidance), for the Stock
 * tab's section and the Earnings drawer. One answer per ticker is kept for
 * the run's next few minutes so a switch back does not ask again; main keeps
 * each release's reading on disk, so a later ask is quick either way.
 *
 * A first read of a company takes a while (each release is fetched from
 * EDGAR and read once), so the state says when it is still loading. Nothing
 * is asked while `ticker` is null: the callers pass null while their tab is
 * hidden.
 */

const KEEP_MS = 10 * 60_000;

export type GuidanceState =
  | { status: "loading" }
  | { status: "ready"; track: GuidanceTrack }
  /** A failure, a main process without the channel, or a company that gives no figures. */
  | { status: "none" };

const cache = new Map<string, { at: number; track: GuidanceTrack | null }>();
const pending = new Map<string, Promise<GuidanceTrack | null>>();

function load(ticker: string): Promise<GuidanceTrack | null> {
  const running = pending.get(ticker);
  if (running) return running;
  const ask = window.meridian?.getStockTabGuidance;
  const task = (ask ? ask(ticker) : Promise.resolve(null))
    .then((r) => (r && r.ok ? r.track : null))
    .catch(() => null)
    .then((track) => {
      // A failure is not kept: the next open asks again.
      if (track) cache.set(ticker, { at: Date.now(), track });
      return track;
    })
    .finally(() => pending.delete(ticker));
  pending.set(ticker, task);
  return task;
}

function stateOf(track: GuidanceTrack | null): GuidanceState {
  return track && track.rows.length > 0 ? { status: "ready", track } : { status: "none" };
}

function fresh(ticker: string | null): GuidanceState | null {
  if (!ticker) return null;
  const hit = cache.get(ticker);
  return hit && Date.now() - hit.at < KEEP_MS ? stateOf(hit.track) : null;
}

export function useGuidanceTrack(ticker: string | null): GuidanceState {
  const [state, setState] = useState<GuidanceState>(() => fresh(ticker) ?? { status: "loading" });
  useEffect(() => {
    if (!ticker) return;
    const hit = fresh(ticker);
    if (hit) {
      setState(hit);
      return;
    }
    setState({ status: "loading" });
    let live = true;
    void load(ticker).then((track) => {
      if (live) setState(stateOf(track));
    });
    return () => {
      live = false;
    };
  }, [ticker]);
  return state;
}

/**
 * The track this run has already read, whatever its age, without asking
 * main: for a view that must never start a first read (the Calendar tab's
 * event card). Null when it has not been read or gives no figures.
 */
export function peekGuidanceTrack(ticker: string): GuidanceTrack | null {
  const track = cache.get(ticker.toUpperCase())?.track ?? null;
  return track && track.rows.length > 0 ? track : null;
}
