import path from "node:path";
import { app } from "electron";

/** Same research dir step1 reads/writes — must match register-step1-handlers. */
export function resolveStep1DataDir(): string {
  const fromEnv = process.env.FALCON_RESEARCH_DATA_DIR;
  if (fromEnv) return fromEnv;
  try {
    return path.resolve(process.cwd(), "data", "research");
  } catch {
    return path.join(app.getPath("userData"), "research");
  }
}
