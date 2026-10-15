/**
 * Which document of an 8-K is its press release.
 *
 * Exhibit file names follow no rule ("ex99-1.htm", "q2fy27pr.htm",
 * "a2026q4ex991-pressrelease.htm"), so the type column of the filing's index
 * page (`<accession>-index.htm`) decides: the document typed EX-99.1, else
 * the first typed EX-99.x. Pure: the caller fetches the page.
 */

/**
 * The press release's file name from a filing's index page (`<accession>-index.htm`):
 * the document typed EX-99.1, else the first typed EX-99.x. Null when there is none.
 */
export function exhibitFromIndex(html: string): string | null {
  const rows = [...html.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((m) => m[0]);
  const typed = rows
    .map((row) => {
      const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => c[1]!.replace(/<[^>]+>/g, " ").replace(/&nbsp;/gi, " ").replace(/\s+/g, " ").trim());
      const href = /href="([^"]+)"/i.exec(row)?.[1] ?? null;
      const name = href ? href.replace(/[?#].*$/, "").replace(/^.*\//, "") : null;
      return { cells, name };
    })
    .filter((r): r is { cells: string[]; name: string } => !!r.name && /\.(htm|html|txt)$/i.test(r.name));
  const exact = typed.find((r) => r.cells.some((c) => /^EX-99\.1$/i.test(c)));
  if (exact) return exact.name;
  return typed.find((r) => r.cells.some((c) => /^EX-99(\.\d+)?$/i.test(c)))?.name ?? null;
}

