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
 *
 * The Calendar tab's event card never starts a read: it shows what this
 * cache holds, else what main already keeps on disk (`useGuidancePeek`),
 * and a disk answer it finds is kept here for the two views above.
 */

const KEEP_MS = 10 * 60_000;

export type GuidanceState =
  | { status: "loading" }
  | { status: "ready"; track: GuidanceTrack }
  /** A failure, a main process without the channel, or a company that gives no figures. */
  | { status: "none" };

/**
 * `peeked`: the entry came from main's disk peek (`peekStoredGuidance`), not
 * a full read. It is shown at once, but a view that may read still asks main
 * for the full answer, since a release filed after the last visit is not on
 * disk yet.
 */
type Entry = { at: number; track: GuidanceTrack | null; peeked?: boolean };

const cache = new Map<string, Entry>();
const pending = new Map<string, Promise<GuidanceTrack | null>>();
const peeking = new Map<string, Promise<GuidanceTrack | null>>();

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

/**
 * Where a view that may read starts: `state` to show now, `read` whether to
 * ask main for the full answer. A recent full read is used as is; a disk
 * peek is shown while the full answer is asked; otherwise it loads.
 */
export function guidanceStart(ticker: string | null): { state: GuidanceState; read: boolean } {
  const hit = ticker ? cache.get(ticker) : undefined;
  if (hit && !hit.peeked && Date.now() - hit.at < KEEP_MS) return { state: stateOf(hit.track), read: false };
  if (hit?.peeked && hit.track && hit.track.rows.length > 0) return { state: stateOf(hit.track), read: true };
  return { state: { status: "loading" }, read: true };
}

export function useGuidanceTrack(ticker: string | null): GuidanceState {
  const [state, setState] = useState<GuidanceState>(() => guidanceStart(ticker).state);
  useEffect(() => {
    if (!ticker) return;
    const start = guidanceStart(ticker);
    setState(start.state);
    if (!start.read) return;
    let live = true;
    void load(ticker).then((track) => {
      // A failed read keeps the peeked track on screen when there is one.
      if (live) setState(track ? stateOf(track) : start.state.status === "ready" ? start.state : { status: "none" });
    });
    return () => {
      live = false;
    };
  }, [ticker]);
  return state;
}

/**
 * The track this run already holds (read, or peeked from main's disk),
 * whatever its age, without asking main: for a view that must never start a
 * first read (the Calendar tab's event card). Null when it is not held or
 * gives no figures.
 */
export function peekGuidanceTrack(ticker: string): GuidanceTrack | null {
  const track = cache.get(ticker.toUpperCase())?.track ?? null;
  return track && track.rows.length > 0 ? track : null;
}

/**
 * The track record from what main already keeps on disk
 * (`stocktab:guidancePeek`: no EDGAR read, no model call), kept in this
 * run's cache as a peek so the Stock tab section and the Earnings drawer
 * show it at once. Asks main only when memory holds nothing for the ticker;
 * a miss or a failure is not kept.
 */
export function peekStoredGuidance(ticker: string): Promise<GuidanceTrack | null> {
  const key = ticker.trim().toUpperCase();
  if (!key) return Promise.resolve(null);
  if (cache.has(key)) return Promise.resolve(peekGuidanceTrack(key));
  const running = peeking.get(key);
  if (running) return running;
  const ask = window.meridian?.getStockTabGuidancePeek;
  const task = (ask ? ask(key) : Promise.resolve(null))
    .then((r) => (r && r.ok ? r.track : null))
    .catch(() => null)
    .then((track) => {
      // A full read that landed meanwhile wins over the peek.
      if (track && !cache.has(key)) cache.set(key, { at: Date.now(), track, peeked: true });
      return peekGuidanceTrack(key);
    })
    .finally(() => peeking.delete(key));
  peeking.set(key, task);
  return task;
}

/**
 * The Calendar tab's guidance: what memory holds, else what main keeps on
 * disk. Never a full read. Nothing is asked while `ticker` is null (the tab
 * is hidden).
 */
export function useGuidancePeek(ticker: string | null): GuidanceTrack | null {
  const key = ticker ? ticker.trim().toUpperCase() : null;
  const [peeked, setPeeked] = useState<{ key: string; track: GuidanceTrack | null } | null>(null);
  useEffect(() => {
    if (!key || cache.has(key)) return;
    let live = true;
    void peekStoredGuidance(key).then((track) => {
      if (live) setPeeked({ key, track });
    });
    return () => {
      live = false;
    };
  }, [key]);
  if (!key) return null;
  return peekGuidanceTrack(key) ?? (peeked?.key === key ? peeked.track : null);
}

/** Tests only: forget every answer. */
export function resetGuidanceCache(): void {
  cache.clear();
  pending.clear();
  peeking.clear();
}
