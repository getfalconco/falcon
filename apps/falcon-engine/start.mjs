/**
 * Start the engine with a V8 heap ceiling that fits the container.
 *
 * Node sizes its old-space heap from the memory it believes the machine has,
 * not from the cgroup cap the container actually runs under. In the Railway
 * container that default came out well below what the chain holds at a
 * cycle — the whole ticker universe's state, every stored run, the classifier
 * verdicts — and the process died with "JavaScript heap out of memory" about
 * ninety seconds after every boot: after the healthcheck had passed, before
 * any JavaScript-level guard could see it, with the container's stdout the
 * only place the reason was ever written.
 *
 * So the ceiling is chosen here, from the cgroup's own limit: 70% of it,
 * which leaves the rest for buffers, code and the native heap. With no cgroup
 * limit readable (a dev checkout), Node's default stands. The choice is
 * printed, and /health reports the resulting `heap_limit_mb`, so the next
 * person can check the arithmetic against the plan instead of guessing.
 */

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const MB = 1024 * 1024;

/** The container's memory cap in bytes, or null when there is none readable. */
function cgroupLimitBytes() {
  for (const file of ["/sys/fs/cgroup/memory.max", "/sys/fs/cgroup/memory/memory.limit_in_bytes"]) {
    try {
      const raw = readFileSync(file, "utf8").trim();
      if (raw === "max") return null;
      const n = Number.parseInt(raw, 10);
      // cgroup v1 reports "unlimited" as a very large number.
      if (Number.isFinite(n) && n > 0 && n < 2 ** 50) return n;
    } catch {
      // Not this cgroup flavour, or not a container.
    }
  }
  return null;
}

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeOptions = [process.env.NODE_OPTIONS ?? ""];
const limit = cgroupLimitBytes();
if (limit != null && !/max-old-space-size/.test(nodeOptions[0])) {
  const heapMb = Math.max(256, Math.min(6144, Math.floor((limit * 0.7) / MB)));
  nodeOptions.push(`--max-old-space-size=${heapMb}`);
  console.info(`[start] container memory cap ${Math.round(limit / MB)} MB → V8 heap ceiling ${heapMb} MB`);
} else {
  console.info(`[start] no container memory cap readable — Node's default heap ceiling stands`);
}

const child = spawn(
  process.execPath,
  [path.join(here, "node_modules", "tsx", "dist", "cli.mjs"), path.join(here, "src", "index.ts")],
  {
    stdio: "inherit",
    env: { ...process.env, NODE_OPTIONS: nodeOptions.filter(Boolean).join(" ") },
  },
);

for (const signal of ["SIGTERM", "SIGINT"]) {
  process.on(signal, () => child.kill(signal));
}
child.on("exit", (code, signal) => {
  if (signal) {
    console.error(`[start] engine ended by ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
