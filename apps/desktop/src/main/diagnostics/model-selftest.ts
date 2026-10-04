import { app } from "electron";
import fs from "node:fs";
import path from "node:path";
import { anthropicGlossCaller, glossSelection } from "@meridian/research/gloss";
import { resolveDataRoot } from "../data-root";
import { isProviderProxyActive } from "../provider-routing";
import { getRendererSession, onRendererSession } from "../session-bridge";

/**
 * A development check of the model route, for when the reader-facing message
 * ("Couldn't reach the model") is all the app shows and the main process's
 * console is out of reach. With FALCON_MODEL_SELFTEST=1 in a dev build, once
 * the route has what it needs (a signed-in session when calls go through the
 * worker), it makes the gloss's own call once, plus two bare requests that
 * tell the layers apart, and writes what came back to
 * `<data>/logs/model-selftest.json`.
 *
 * Nothing secret is written: the key is described by its kind only, and the
 * provider's replies are cut short. A packaged build never runs it.
 */

type Probe = { status: number | null; ms: number; detail: string };

function keyKind(key: string | undefined): string {
  const k = key?.trim() ?? "";
  if (!k) return "missing";
  if (k.startsWith("sk-ant-")) return "sk-ant";
  if (k.split(".").length === 3) return "session-jwt";
  return "other";
}

function hostOf(url: string | undefined): string {
  if (!url) return "api.anthropic.com (default)";
  try {
    return new URL(url).host + new URL(url).pathname.replace(/\/+$/, "");
  } catch {
    return "unreadable";
  }
}

/** Long tokens of any kind are masked before anything reaches the file. */
function clean(text: string): string {
  return text.replace(/[A-Za-z0-9_\-]{32,}(\.[A-Za-z0-9_\-]+){0,2}/g, "****").slice(0, 600);
}

async function bare(withOutputConfig: boolean): Promise<Probe> {
  const base = (process.env.ANTHROPIC_BASE_URL?.trim() || "https://api.anthropic.com").replace(/\/+$/, "");
  const started = Date.now();
  try {
    const res = await fetch(`${base}/v1/messages`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY?.trim() ?? "",
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-opus-5",
        max_tokens: 400,
        messages: [{ role: "user", content: 'Reply with {"ok":true}.' }],
        ...(withOutputConfig
          ? {
              output_config: {
                effort: "low",
                format: {
                  type: "json_schema",
                  schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false },
                },
              },
            }
          : {}),
      }),
      signal: AbortSignal.timeout(30_000),
    });
    return { status: res.status, ms: Date.now() - started, detail: clean(await res.text()) };
  } catch (err) {
    return { status: null, ms: Date.now() - started, detail: clean(err instanceof Error ? `${err.name}: ${err.message}` : String(err)) };
  }
}

async function run(): Promise<void> {
  const out: Record<string, unknown> = {
    at: new Date().toISOString(),
    proxy: isProviderProxyActive(),
    base: hostOf(process.env.ANTHROPIC_BASE_URL),
    key: keyKind(process.env.ANTHROPIC_API_KEY),
  };
  out.bare = await bare(false);
  out.bareWithOutputConfig = await bare(true);
  const started = Date.now();
  try {
    const gloss = await glossSelection({ selection: "EBITDA" }, anthropicGlossCaller);
    out.gloss = { ok: true, ms: Date.now() - started, kind: gloss.kind, headline: clean(JSON.stringify(gloss).slice(0, 200)) };
  } catch (err) {
    const e = err as { name?: string; status?: number; message?: string; error?: unknown };
    out.gloss = {
      ok: false,
      ms: Date.now() - started,
      name: e?.name ?? null,
      status: e?.status ?? null,
      message: clean(String(e?.message ?? err)),
      body: e?.error ? clean(JSON.stringify(e.error)) : null,
    };
  }
  const dir = path.join(resolveDataRoot(), "logs");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "model-selftest.json"), JSON.stringify(out, null, 2), "utf8");
  console.info("[selftest] model route check written to", path.join(dir, "model-selftest.json"));
}

export function scheduleModelSelfTest(): void {
  if (app.isPackaged || process.env.FALCON_MODEL_SELFTEST?.trim() !== "1") return;
  let started = false;
  const maybe = (token: string | null) => {
    if (started) return;
    // Through the worker the call needs the reader's session; wait for it.
    if (isProviderProxyActive() && !token) return;
    started = true;
    setTimeout(() => void run().catch((err) => console.error("[selftest] failed:", err)), 1500);
  };
  maybe(getRendererSession().accessToken);
  onRendererSession((session) => maybe(session.accessToken));
}
