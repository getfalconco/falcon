import { stripJsonFences } from "../step1/index.js";

/** Extract first JSON object from LLM text (fences, preamble, multiline). */
export function extractJsonObject(raw: string): string {
  const cleaned = stripJsonFences(raw);
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) return cleaned.slice(start, end + 1);
  return cleaned.trim();
}
