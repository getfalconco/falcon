import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { readGitCommit } from "./git-commit";

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function repo(files: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-git-"));
  for (const [rel, body] of Object.entries(files)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
  }
  return root;
}

describe("readGitCommit", () => {
  it("follows a loose branch ref from a nested directory", () => {
    const root = repo({ ".git/HEAD": "ref: refs/heads/main\n", ".git/refs/heads/main": `${SHA_A}\n` });
    const nested = path.join(root, "apps", "desktop", "out", "main");
    fs.mkdirSync(nested, { recursive: true });
    assert.deepEqual(readGitCommit(nested), { sha: SHA_A, branch: "main" });
  });

  it("falls back to packed-refs", () => {
    const root = repo({
      ".git/HEAD": "ref: refs/heads/feature/x\n",
      ".git/packed-refs": `# pack-refs with: peeled\n${SHA_B} refs/heads/feature/x\n`,
    });
    assert.deepEqual(readGitCommit(root), { sha: SHA_B, branch: "feature/x" });
  });

  it("reads a detached HEAD", () => {
    const root = repo({ ".git/HEAD": `${SHA_A}\n` });
    assert.deepEqual(readGitCommit(root), { sha: SHA_A, branch: null });
  });

  it("resolves a worktree's refs through commondir", () => {
    const main = repo({ ".git/refs/heads/wt": `${SHA_B}\n` });
    const wtGit = path.join(main, ".git", "worktrees", "wt");
    fs.mkdirSync(wtGit, { recursive: true });
    fs.writeFileSync(path.join(wtGit, "HEAD"), "ref: refs/heads/wt\n");
    fs.writeFileSync(path.join(wtGit, "commondir"), "../..\n");
    const checkout = fs.mkdtempSync(path.join(os.tmpdir(), "falcon-wt-"));
    fs.writeFileSync(path.join(checkout, ".git"), `gitdir: ${wtGit}\n`);
    assert.deepEqual(readGitCommit(checkout), { sha: SHA_B, branch: "wt" });
  });

  it("returns null when HEAD points at nothing readable", () => {
    const root = repo({ ".git/HEAD": "ref: refs/heads/gone\n" });
    assert.equal(readGitCommit(root), null);
  });
});
