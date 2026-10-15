/**
 * Calendar tab: where events go on the grid.
 *
 * Two packers. The time grid lays the timed events of one day side by side
 * where they overlap, the way every calendar does: events that overlap one
 * another, directly or through a chain, form a cluster; each takes the first
 * column free at its start; and the cluster's width is shared by its column
 * count. The all-day lane (and each week of the month grid) stacks multi-day
 * bars in rows, each in the first row free across its whole run.
 *
 * Pure, and independent of how an event looks: everything is ids and numbers.
 */

export type TimedSlot = { id: string; start: number; end: number };
export type TimedPlacement = { id: string; column: number; columns: number };

/**
 * Overlap packing for one day column. `minSpan` is the shortest an event
 * counts as for overlap, in the same unit as start/end: a five-minute event
 * is still drawn tall enough for its title, and must push its neighbour
 * aside for that height, not for five minutes.
 */
export function packTimed(slots: readonly TimedSlot[], minSpan = 0): TimedPlacement[] {
  const sorted = slots
    .map((s) => ({ ...s, end: Math.max(s.end, s.start + minSpan) }))
    .sort((a, b) => a.start - b.start || b.end - a.end || a.id.localeCompare(b.id));

  const out: TimedPlacement[] = [];
  let cluster: Array<{ id: string; column: number }> = [];
  let columnEnds: number[] = [];
  let clusterEnd = -Infinity;

  const close = () => {
    const columns = columnEnds.length;
    for (const c of cluster) out.push({ id: c.id, column: c.column, columns });
    cluster = [];
    columnEnds = [];
  };

  for (const s of sorted) {
    if (s.start >= clusterEnd && cluster.length > 0) close();
    let column = columnEnds.findIndex((end) => end <= s.start);
    if (column === -1) {
      column = columnEnds.length;
      columnEnds.push(s.end);
    } else {
      columnEnds[column] = s.end;
    }
    cluster.push({ id: s.id, column });
    clusterEnd = cluster.length === 1 ? s.end : Math.max(clusterEnd, s.end);
  }
  if (cluster.length > 0) close();
  return out;
}

export type SpanItem = { id: string; start: string; end: string };
export type SpanPlacement = { id: string; row: number; startIndex: number; span: number };

/**
 * Row packing for bars across a run of days (`days` in order, consecutive or
 * not: a week without its weekend still packs). A bar that starts before the
 * run or ends after it is clipped to it; one entirely outside is left out.
 * Longer bars are placed first within a start day, so a three-day event is
 * not pushed down under a one-day one that happened to sort ahead of it.
 */
export function packSpans(items: readonly SpanItem[], days: readonly string[]): SpanPlacement[] {
  if (days.length === 0) return [];
  const first = days[0];
  const last = days[days.length - 1];
  const indexOf = (ymd: string, edge: "start" | "end"): number => {
    if (edge === "start") {
      const i = days.findIndex((d) => d >= ymd);
      return i === -1 ? days.length : i;
    }
    for (let i = days.length - 1; i >= 0; i--) if (days[i] <= ymd) return i;
    return -1;
  };

  const visible = items
    .filter((it) => it.end >= first && it.start <= last)
    .map((it) => ({ id: it.id, s: indexOf(it.start, "start"), e: indexOf(it.end, "end") }))
    .filter((it) => it.e >= it.s)
    .sort((a, b) => a.s - b.s || b.e - b.s - (a.e - a.s) || a.id.localeCompare(b.id));

  const rows: number[] = []; // per row: the last day index taken
  const out: SpanPlacement[] = [];
  for (const it of visible) {
    let row = rows.findIndex((lastTaken) => lastTaken < it.s);
    if (row === -1) {
      row = rows.length;
      rows.push(it.e);
    } else {
      rows[row] = it.e;
    }
    out.push({ id: it.id, row, startIndex: it.s, span: it.e - it.s + 1 });
  }
  return out;
}

/**
 * Which bars are drawn when a cell has room for `maxRows` rows, and how many
 * are hidden on each day. When anything is hidden on a day, its last row
 * gives way to the "+N more" line, so a cell never shows a bar and a count on
 * top of each other. A bar across several days is drawn only where it fits
 * on every one of them; otherwise it is counted on each.
 */
export function fitRows(placements: readonly SpanPlacement[], dayCount: number, maxRows: number): { drawn: Set<string>; hidden: number[] } {
  const crowded = Array.from({ length: dayCount }, () => false);
  for (const p of placements) {
    if (p.row < maxRows) continue;
    for (let i = p.startIndex; i < p.startIndex + p.span; i++) if (i < dayCount) crowded[i] = true;
  }
  // A bar hidden for want of room on one day is hidden on all of its days, and
  // each of those now needs its "+N more" line too: settle until nothing changes.
  let drawn = new Set<string>();
  let hidden = Array.from({ length: dayCount }, () => 0);
  for (let pass = 0; pass <= dayCount; pass++) {
    const limit = crowded.map((c) => (c ? Math.max(0, maxRows - 1) : maxRows));
    drawn = new Set<string>();
    hidden = Array.from({ length: dayCount }, () => 0);
    for (const p of placements) {
      let fits = true;
      for (let i = p.startIndex; i < p.startIndex + p.span; i++) if (i < dayCount && p.row >= limit[i]) fits = false;
      if (fits) drawn.add(p.id);
      else for (let i = p.startIndex; i < p.startIndex + p.span; i++) if (i < dayCount) hidden[i]++;
    }
    let changed = false;
    hidden.forEach((h, i) => {
      if (h > 0 && !crowded[i]) {
        crowded[i] = true;
        changed = true;
      }
    });
    if (!changed) break;
  }
  return { drawn, hidden };
}
