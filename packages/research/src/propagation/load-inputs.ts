import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import type { DailyEventsFile } from "./event-types.js";
import type { GraphFile, MaterialNewsEvent, PropagationEvent } from "./types.js";

export async function loadGraphFile(graphPath: string): Promise<GraphFile> {
  const raw = await readFile(graphPath, "utf8");
  const parsed = JSON.parse(raw) as GraphFile & { edges: GraphFile["edges"] };
  return { nodes: parsed.nodes ?? [], edges: parsed.edges ?? [] };
}

export async function loadAllEvents(eventsDir: string): Promise<MaterialNewsEvent[]> {
  let files: string[] = [];
  try {
    await access(eventsDir);
    files = (await readdir(eventsDir)).filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f));
  } catch {
    return [];
  }

  const all: MaterialNewsEvent[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(path.join(eventsDir, file), "utf8");
      const parsed = JSON.parse(raw) as DailyEventsFile;
      if (Array.isArray(parsed.events)) all.push(...parsed.events);
    } catch {
      continue;
    }
  }

  return all.sort((a, b) => b.article_datetime - a.article_datetime);
}

export function toPropagationEvent(e: MaterialNewsEvent): PropagationEvent {
  return { ...e, source_urls: [e.source_url] };
}
