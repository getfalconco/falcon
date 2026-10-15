import { registerIpcHandler } from "../ipc-register";
import { resolveDataRoot } from "../data-root";
import type { ProfilePhotoResult } from "../../shared/profile-photo";
import { readProfilePhoto, removeProfilePhoto, writeProfilePhoto } from "./profile-photo-store";

function failure(err: unknown): { ok: false; error: string } {
  return { ok: false, error: err instanceof Error ? err.message : String(err) };
}

/** The reader's profile photo, kept on this machine (see profile-photo-store). */
export function registerProfileHandlers(): void {
  registerIpcHandler("profile:get-photo", async (_event, userId: string): Promise<ProfilePhotoResult> => {
    try {
      return { ok: true, dataUrl: await readProfilePhoto(resolveDataRoot(), userId) };
    } catch (err) {
      return failure(err);
    }
  });

  registerIpcHandler(
    "profile:set-photo",
    async (_event, payload: { userId: string; dataUrl: string }): Promise<ProfilePhotoResult> => {
      try {
        return { ok: true, dataUrl: await writeProfilePhoto(resolveDataRoot(), payload?.userId, payload?.dataUrl) };
      } catch (err) {
        return failure(err);
      }
    },
  );

  registerIpcHandler("profile:remove-photo", async (_event, userId: string): Promise<ProfilePhotoResult> => {
    try {
      await removeProfilePhoto(resolveDataRoot(), userId);
      return { ok: true, dataUrl: null };
    } catch (err) {
      return failure(err);
    }
  });
}
