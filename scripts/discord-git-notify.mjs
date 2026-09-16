#!/usr/bin/env node
/**
 * Discord'a tek satır Türkçe git notu:
 *   "<sha> · <kişi> <aksiyon> (<branch>) · <özet TR>"
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const ACTION_TR = {
  push: "gönderdi",
  pull: "çekti",
  fetch: "fetch etti",
  merge: "birleştirdi",
  rebase: "rebase etti",
};

function loadEnvValue(filePath, key) {
  if (!existsSync(filePath)) return null;
  const text = readFileSync(filePath, "utf8");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const m = trimmed.match(new RegExp(`^${key}\\s*=\\s*(.+)$`));
    if (!m) continue;
    return m[1].trim().replace(/^["']|["']$/g, "");
  }
  return null;
}

function loadEnvWebhook(key) {
  if (process.env[key]?.trim()) {
    return process.env[key].trim();
  }
  // Prefer root .env, then .env.discord (committed helper for private clones).
  return (
    loadEnvValue(join(root, ".env"), key) ||
    loadEnvValue(join(root, ".env.discord"), key)
  );
}

/** GitHub-logs channel — push / pull only. */
function loadGitWebhookUrl() {
  return loadEnvWebhook("DISCORD_WEBHOOK_URL");
}

/** falcon-error-logs channel — FAL-… trails and custom --message posts. */
function loadErrorLogWebhookUrl() {
  return loadEnvWebhook("DISCORD_ERROR_LOG_WEBHOOK_URL");
}

function parseArgs(argv) {
  const out = { message: "", action: "push", fromHook: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from-hook") out.fromHook = true;
    else if (a === "--action") out.action = argv[++i] ?? out.action;
    else if (a === "--message") out.message = argv[++i] ?? "";
    else if (a === "--title") out.message = argv[++i] ?? out.message;
    else if (a === "--body") {
      const body = argv[++i] ?? "";
      if (!out.message) out.message = body;
    } else if (a === "--event") i++;
  }
  return out;
}

function gitFmt(pretty) {
  try {
    return execSync(`git log -1 --pretty=format:${pretty}`, {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return "";
  }
}

function branchName() {
  try {
    return execSync("git rev-parse --abbrev-ref HEAD", {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return "main";
  }
}

function authorShort() {
  const full = gitFmt("%an") || process.env.USER || "biri";
  return full.split(/\s+/)[0] || full;
}

function looksTurkish(text) {
  return /[ğüşıöçĞÜŞİÖÇ]/.test(text) || /\b(ve|ile|için|eklendi|düzeltildi|güncellendi|kaldırıldı)\b/i.test(text);
}

/** Translate English commit subject → Turkish for Discord özet */
async function toTurkishSummary(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return "";
  if (looksTurkish(trimmed)) return trimmed;

  try {
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", trimmed.slice(0, 400));
    url.searchParams.set("langpair", "en|tr");
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return trimmed;
    const data = await res.json();
    const out = String(data?.responseData?.translatedText || "").trim();
    // MyMemory sometimes echoes the English or returns MYMEMORY warnings
    if (!out || /MYMEMORY WARNING/i.test(out) || out === trimmed) return trimmed;
    return out;
  } catch {
    return trimmed;
  }
}

async function buildLine(action) {
  const sha = gitFmt("%h");
  const subject = gitFmt("%s");
  if (!sha || !subject) return "";

  const who = authorShort();
  const verb = ACTION_TR[action] || "güncelledi";
  const branch = branchName();
  const ozet = await toTurkishSummary(subject);

  return `${sha} · ${who} ${verb} (${branch}) · ${ozet}`.slice(0, 280);
}

function detectGitAction(command) {
  const c = command.replace(/\s+/g, " ").trim();
  if (/\bgit\s+push\b/i.test(c)) return "push";
  if (/\bgit\s+pull\b/i.test(c)) return "pull";
  if (/\bgit\s+fetch\b/i.test(c)) return "fetch";
  if (/\bgit\s+merge\b/i.test(c)) return "merge";
  if (/\bgit\s+rebase\b/i.test(c)) return "rebase";
  return null;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function postDiscord(webhookUrl, message) {
  const content = String(message || "").trim().slice(0, 280);
  if (!content) return;

  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Discord webhook failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return res.status;
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.fromHook) {
    const webhookUrl = loadGitWebhookUrl();
    if (!webhookUrl) {
      process.stdout.write("{}\n");
      process.exit(0);
    }
    let input = {};
    try {
      const raw = await readStdin();
      input = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      process.stdout.write("{}\n");
      process.exit(0);
    }

    const command = String(input.command ?? input.shell_command ?? "");
    const exitCode = input.exit_code ?? input.exitCode ?? null;
    const action = detectGitAction(command);

    if (!action || (exitCode !== null && Number(exitCode) !== 0)) {
      process.stdout.write("{}\n");
      process.exit(0);
    }

    if (action !== "push" && action !== "pull") {
      process.stdout.write("{}\n");
      process.exit(0);
    }

    try {
      await postDiscord(webhookUrl, await buildLine(action));
    } catch (err) {
      console.error(String(err));
    }

    process.stdout.write("{}\n");
    process.exit(0);
  }

  if (args.message) {
    const errorWebhook = loadErrorLogWebhookUrl();
    if (!errorWebhook) {
      throw new Error("DISCORD_ERROR_LOG_WEBHOOK_URL is not set");
    }
    const status = await postDiscord(errorWebhook, args.message);
    console.log(`discord error-log ${status ?? "ok"}`);
    return;
  }

  const gitWebhook = loadGitWebhookUrl();
  if (!gitWebhook) process.exit(0);
  await postDiscord(gitWebhook, await buildLine(args.action));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
