import { copyFileSync, existsSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = [".env.desktop", ".env.local", ".env.production"];
const dest = join(root, "build", "env.production");

let copied = false;
for (const name of sources) {
  const src = join(root, name);
  if (existsSync(src)) {
    mkdirSync(join(root, "build"), { recursive: true });
    copyFileSync(src, dest);
    console.log(`Desktop env: copied ${name} → build/env.production`);
    copied = true;
    break;
  }
}

if (!copied) {
  mkdirSync(join(root, "build"), { recursive: true });
  copyFileSync(
    join(root, ".env.desktop.example"),
    join(root, "build", "env.production")
  );
  console.warn(
    "No .env.desktop / .env.local found — using .env.desktop.example placeholder (add real keys)."
  );
}
