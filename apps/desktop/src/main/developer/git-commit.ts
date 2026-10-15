import fs from "node:fs";
import path from "node:path";

/**
 * The commit a dev checkout is running, read straight from `.git` — no `git`
 * binary, no child process. Nothing records a commit at build time, so a
 * packaged build has no answer and says so rather than guessing.
 *
 * Handles a plain repo (`.git/` directory), a worktree (`.git` file pointing
 * at the real git dir), a branch ref stored loose or in `packed-refs`, and a
 * detached HEAD. Anything it cannot read comes back null.
 */

export type GitCommit = { sha: string; branch: string | null };

function findGitDir(startDir: string): string | null {
  let dir = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(dir, ".git");
    try {
      const stat = fs.statSync(candidate);
      if (stat.isDirectory()) return candidate;
      if (stat.isFile()) {
        const match = fs.readFileSync(candidate, "utf8").match(/^gitdir:\s*(.+)\s*$/m);
        if (match) return path.resolve(dir, match[1].trim());
      }
    } catch {
      /* not here; keep climbing */
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** A worktree keeps its own HEAD but shares refs with the main git dir. */
function commonDir(gitDir: string): string {
  try {
    const rel = fs.readFileSync(path.join(gitDir, "commondir"), "utf8").trim();
    return rel ? path.resolve(gitDir, rel) : gitDir;
  } catch {
    return gitDir;
  }
}

function resolveRef(gitDir: string, ref: string): string | null {
  for (const dir of [gitDir, commonDir(gitDir)]) {
    try {
      const sha = fs.readFileSync(path.join(dir, ref), "utf8").trim();
      if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
    } catch {
      /* try packed-refs */
    }
    try {
      for (const line of fs.readFileSync(path.join(dir, "packed-refs"), "utf8").split("\n")) {
        const [sha, name] = line.trim().split(" ");
        if (name === ref && /^[0-9a-f]{40}$/i.test(sha ?? "")) return sha;
      }
    } catch {
      /* none */
    }
  }
  return null;
}

export function readGitCommit(startDir: string): GitCommit | null {
  const gitDir = findGitDir(startDir);
  if (!gitDir) return null;
  let head: string;
  try {
    head = fs.readFileSync(path.join(gitDir, "HEAD"), "utf8").trim();
  } catch {
    return null;
  }
  if (/^[0-9a-f]{40}$/i.test(head)) return { sha: head, branch: null };
  const match = head.match(/^ref:\s*(refs\/\S+)$/);
  if (!match) return null;
  const sha = resolveRef(gitDir, match[1]);
  if (!sha) return null;
  return { sha, branch: match[1].replace(/^refs\/heads\//, "") };
}
