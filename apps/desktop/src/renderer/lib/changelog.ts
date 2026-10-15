import { useEffect, useState } from "react";
import type { MessageKey } from "@/lib/i18n";

/**
 * What changed in Falcon, release by release, for the "What's new" panel
 * behind the account menu's View Changelog.
 *
 * Written from the repository's history: one release per day that shipped
 * something a reader would notice, newest first, each commit retold as what
 * it does for the reader. Server upkeep is kept only where the reader felt
 * it (data that would not load); tests, scripts and the website are left out.
 *
 * Only the newest release carries a version. The app's version has stood at
 * 0.2.0 since the repository began, so no older day has a number of its own,
 * and giving it a made-up one would claim a release that never existed.
 *
 * Each line is an i18n key: the English wording lives in
 * lib/i18n/messages/areas/changelog.ts with its translations beside it, so a
 * new release is written there first and listed here by key.
 */

export type ChangelogRelease = {
  /** The day it shipped, as YYYY-MM-DD. Also the release's identity. */
  date: string;
  /** The app version, where the release has a real one. */
  version?: string;
  sections: {
    new?: readonly MessageKey[];
    improved?: readonly MessageKey[];
    fixed?: readonly MessageKey[];
  };
};

/** The headings, in the order a release lists them. */
export const CHANGELOG_SECTIONS = [
  { key: "new", labelKey: "changelog.section.new" },
  { key: "improved", labelKey: "changelog.section.improved" },
  { key: "fixed", labelKey: "changelog.section.fixed" },
] as const satisfies ReadonlyArray<{ key: keyof ChangelogRelease["sections"]; labelKey: MessageKey }>;

export const CHANGELOG: readonly ChangelogRelease[] = [
  {
    date: "2026-10-04",
    version: "0.2.0",
    sections: {
      new: ["changelog.r20261004.new1", "changelog.r20261004.new2", "changelog.r20261004.new3"],
      improved: ["changelog.r20261004.improved1"],
      fixed: ["changelog.r20261004.fixed1"],
    },
  },
  {
    date: "2026-10-03",
    sections: {
      improved: ["changelog.r20261003.improved1"],
      fixed: ["changelog.r20261003.fixed1"],
    },
  },
  {
    date: "2026-09-26",
    sections: {
      new: ["changelog.r20260926.new1", "changelog.r20260926.new2", "changelog.r20260926.new3"],
      improved: [
        "changelog.r20260926.improved1",
        "changelog.r20260926.improved2",
        "changelog.r20260926.improved3",
        "changelog.r20260926.improved4",
      ],
    },
  },
  {
    date: "2026-09-24",
    sections: {
      new: ["changelog.r20260924.new1", "changelog.r20260924.new2", "changelog.r20260924.new3", "changelog.r20260924.new4"],
      improved: [
        "changelog.r20260924.improved1",
        "changelog.r20260924.improved2",
        "changelog.r20260924.improved3",
        "changelog.r20260924.improved4",
      ],
    },
  },
  {
    date: "2026-09-21",
    sections: {
      new: ["changelog.r20260921.new1", "changelog.r20260921.new2", "changelog.r20260921.new3"],
      improved: ["changelog.r20260921.improved1", "changelog.r20260921.improved2", "changelog.r20260921.improved3"],
      fixed: ["changelog.r20260921.fixed1", "changelog.r20260921.fixed2", "changelog.r20260921.fixed3"],
    },
  },
  {
    date: "2026-09-16",
    sections: {
      new: ["changelog.r20260916.new1"],
    },
  },
];

/**
 * "2026-10-04" as "October 4, 2026" (or "4 Ekim 2026", "2026年10月4日"),
 * the same day on every machine whatever its time zone.
 */
export function formatReleaseDate(ymd: string, locale = "en-US"): string {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(locale, {
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  });
}

/*
 * Whether the reader has opened the panel since the newest release. The
 * release's date is what is kept, since the version does not move with
 * every release. Storage can be missing; then nothing is ever marked unseen,
 * because a dot that can never be cleared is worse than no dot.
 */

const SEEN_KEY = "falcon.changelog.seen";
const SEEN_EVENT = "falcon:changelog-seen";
const LATEST = CHANGELOG[0]?.date ?? "";

function readSeen(): string | null {
  try {
    return localStorage.getItem(SEEN_KEY) ?? "";
  } catch {
    return null;
  }
}

/** True when the newest release has not been looked at on this machine. */
export function hasUnseenChangelog(): boolean {
  const seen = readSeen();
  return seen !== null && seen < LATEST;
}

/** The panel was opened: the newest release counts as seen from now on. */
export function markChangelogSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, LATEST);
  } catch {
    /* nothing to keep it in; the dot just stays as it was */
  }
  window.dispatchEvent(new Event(SEEN_EVENT));
}

/** `hasUnseenChangelog`, kept current when the panel marks it seen. */
export function useChangelogUnseen(): boolean {
  const [unseen, setUnseen] = useState(hasUnseenChangelog);
  useEffect(() => {
    const sync = () => setUnseen(hasUnseenChangelog());
    window.addEventListener(SEEN_EVENT, sync);
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(SEEN_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);
  return unseen;
}
