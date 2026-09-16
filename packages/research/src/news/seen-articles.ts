import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { seenArticlesPath } from "./event-paths.js";

type SeenStore = {
  ids: number[];
  updatedAt: string;
};

const MAX_SEEN = 20_000;

export class SeenArticleStore {
  private ids = new Set<number>();
  private loaded = false;
  private dirty = false;

  constructor(private readonly dataDir: string) {}

  async load(): Promise<void> {
    if (this.loaded) return;
    const path = seenArticlesPath(this.dataDir);
    try {
      await access(path);
      const raw = await readFile(path, "utf8");
      const parsed = JSON.parse(raw) as SeenStore;
      for (const id of parsed.ids ?? []) this.ids.add(id);
    } catch {
      // fresh store
    }
    this.loaded = true;
  }

  has(id: number): boolean {
    return this.ids.has(id);
  }

  add(id: number): void {
    this.ids.add(id);
    this.dirty = true;
  }

  async persist(): Promise<void> {
    if (!this.dirty) return;
    await mkdir(this.dataDir, { recursive: true });
    const all = [...this.ids];
    const trimmed = all.length > MAX_SEEN ? all.slice(all.length - MAX_SEEN) : all;
    const payload: SeenStore = {
      ids: trimmed,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(seenArticlesPath(this.dataDir), JSON.stringify(payload, null, 2), "utf8");
    this.dirty = false;
  }
}
