import { app, BrowserWindow, dialog, shell } from "electron";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { registerIpcHandler } from "../ipc-register";
import { mt } from "../i18n";
import { resolveDataRoot } from "../data-root";
import { getRendererSession } from "../session-bridge";
import { userKeyFromAccessToken } from "../briefing/user-key";
import { engineRemote, engineUrl } from "../engine/engine-client";
import { isProviderProxyActive } from "../provider-routing";
import { readProfilePhoto } from "../profile/profile-photo-store";
import type {
  ClearHistoryResult,
  PrivacyExportRendererPart,
  PrivacyExportResult,
  PrivacySummaryResult,
  ProviderRoutes,
  UsageSummaryResult,
} from "../../shared/privacy-types";
import {
  accountBriefingFiles,
  clearAccountHistory,
  collectLocalExport,
  inventoryLocalData,
  summarizeLocalUsage,
  tallyPath,
} from "./local-data";

/**
 * Settings → Privacy and Usage. Every answer is read from this machine at the
 * moment it is asked; the account a request acts for is the one in the
 * session bridge, never a user id the renderer names.
 */

function failure(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

function currentUserKey(): string {
  return userKeyFromAccessToken(getRendererSession().accessToken);
}

function hostOf(url: string | null | undefined): string | null {
  if (!url?.trim()) return null;
  try {
    return new URL(url).host || null;
  } catch {
    return null;
  }
}

/** Read from the env the engines themselves read, so the pane says where requests really go. */
function providerRoutes(): ProviderRoutes {
  return {
    modelHost: hostOf(process.env.ANTHROPIC_BASE_URL) ?? "api.anthropic.com",
    newsHost: hostOf(process.env.FINNHUB_BASE_URL) ?? "finnhub.io",
    engineHost: engineRemote() ? hostOf(engineUrl()) : null,
    viaWorker: isProviderProxyActive(),
  };
}

/** A packaged build's bundled seed data, so extractions that shipped with the app are not counted as usage. */
function seedDir(): string | null {
  return app.isPackaged ? path.join(process.resourcesPath, "seed-data") : null;
}

function exportFileName(now: Date): string {
  const ymd = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  return `falcon-export-${ymd}.json`;
}

/** Keeps only plain JSON-shaped fields of what the renderer sent; anything else is dropped. */
function rendererPart(raw: unknown): PrivacyExportRendererPart {
  const r = (raw && typeof raw === "object" ? raw : {}) as Partial<PrivacyExportRendererPart>;
  const storage: Record<string, string> = {};
  if (r.browserStorage && typeof r.browserStorage === "object") {
    for (const [k, v] of Object.entries(r.browserStorage)) if (typeof v === "string") storage[k] = v;
  }
  return {
    account: r.account && typeof r.account === "object" ? r.account : null,
    browserStorage: storage,
    cloud: r.cloud && typeof r.cloud === "object" ? r.cloud : {},
  };
}

export function registerPrivacyHandlers(): void {
  registerIpcHandler("privacy:summary", async (): Promise<PrivacySummaryResult> => {
    try {
      const root = resolveDataRoot();
      const clearable = { files: 0, bytes: 0 };
      for (const file of accountBriefingFiles(root, currentUserKey())) {
        const t = tallyPath(file);
        clearable.files += t.files;
        clearable.bytes += t.bytes;
      }
      // The pre-migration plaintext identity sits outside the data root until
      // main/snaptrade moves it; counted with the encrypted files while it exists.
      const categories = inventoryLocalData(root, {
        legacySnaptradeFile: path.join(app.getPath("userData"), "snaptrade-user.json"),
      });
      return { ok: true, summary: { root, categories, clearable, routes: providerRoutes() } };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler("privacy:usage", async (): Promise<UsageSummaryResult> => {
    try {
      return {
        ok: true,
        usage: summarizeLocalUsage(resolveDataRoot(), {
          userKey: currentUserKey(),
          nowMs: Date.now(),
          seedDir: seedDir(),
          enginesRemote: engineRemote(),
        }),
      };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler("privacy:clear-history", async (): Promise<ClearHistoryResult> => {
    try {
      return { ok: true, ...clearAccountHistory(resolveDataRoot(), currentUserKey()) };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler("privacy:reveal-data", async (): Promise<{ ok: true } | { ok: false; error: string }> => {
    const error = await shell.openPath(resolveDataRoot());
    return error ? { ok: false, error } : { ok: true };
  });

  registerIpcHandler("privacy:export", async (event, raw: unknown): Promise<PrivacyExportResult> => {
    try {
      const root = resolveDataRoot();
      const userKey = currentUserKey();
      const now = new Date();
      const owner = event ? BrowserWindow.fromWebContents(event.sender) : null;
      const options = {
        title: mt("dialog.export.title"),
        defaultPath: path.join(app.getPath("downloads"), exportFileName(now)),
        filters: [{ name: "JSON", extensions: ["json"] }],
      };
      const choice = owner ? await dialog.showSaveDialog(owner, options) : await dialog.showSaveDialog(options);
      if (choice.canceled || !choice.filePath) return { ok: false, canceled: true };

      const part = rendererPart(raw);
      const photo = userKey === "anon" ? null : await readProfilePhoto(root, userKey).catch(() => null);
      const document = {
        format: "falcon-data-export",
        // 2: this_device gained agents and calendar_events; Supabase tables are read in full, page by page.
        version: 2,
        exported_at: now.toISOString(),
        app_version: app.getVersion(),
        account: part.account,
        this_device: { ...collectLocalExport(root, userKey), profile_photo: photo },
        browser_storage: part.browserStorage,
        falcon_account_data: part.cloud,
      };
      const text = `${JSON.stringify(document, null, 2)}\n`;
      await writeFile(choice.filePath, text, "utf8");
      return { ok: true, path: choice.filePath, bytes: Buffer.byteLength(text) };
    } catch (err) {
      return failure(err);
    }
  });
}
