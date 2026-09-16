import { cpSync, existsSync, mkdirSync, rmSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const standaloneDir = join(root, ".next", "standalone");
const staticSrc = join(root, ".next", "static");
const staticDest = join(standaloneDir, ".next", "static");
const publicSrc = join(root, "public");
const publicDest = join(standaloneDir, "public");

if (!existsSync(join(standaloneDir, "server.js"))) {
  console.error(
    "Missing .next/standalone/server.js — run `npm run build` first."
  );
  process.exit(1);
}

mkdirSync(join(standaloneDir, ".next"), { recursive: true });

if (existsSync(staticSrc)) {
  rmSync(staticDest, { recursive: true, force: true });
  cpSync(staticSrc, staticDest, { recursive: true });
  console.log("Copied .next/static → standalone");
} else {
  console.warn("Warning: .next/static not found");
}

if (existsSync(publicSrc)) {
  rmSync(publicDest, { recursive: true, force: true });
  cpSync(publicSrc, publicDest, { recursive: true });
  console.log("Copied public → standalone");
}

const envLocal = join(root, ".env.local");
const envDesktop = join(root, ".env.desktop");
const envDest = join(standaloneDir, ".env.local");
const envSource = existsSync(envDesktop)
  ? envDesktop
  : existsSync(envLocal)
    ? envLocal
    : null;

if (envSource) {
  cpSync(envSource, envDest);
  console.log(`Copied ${envSource === envDesktop ? ".env.desktop" : ".env.local"} → standalone/.env.local`);
} else if (existsSync(envDest)) {
  rmSync(envDest, { force: true });
}

console.log("Standalone bundle ready:", standaloneDir);
