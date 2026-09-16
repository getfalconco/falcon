import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { isEngineChannel } from "@meridian/research/engine-channels";
import { callEngine, engineRemote } from "./engine/engine-client";

/**
 * Channels the always-on engine service owns when one is configured.
 *
 * The list itself lives in @meridian/research/engine-channels so the desktop
 * and the service cannot disagree about it — see the note there. With
 * `FALCON_ENGINE_URL` set these are answered by the server, because that is
 * the only copy of the chain still running: this process no longer polls
 * providers, no longer spends the Anthropic budget, and has no state to answer
 * from. Everything else stays local.
 */
export { isEngineChannel } from "@meridian/research/engine-channels";

export function registerIpcHandler<Args extends unknown[], Result>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result,
): void {
  ipcMain.removeHandler(channel);
  // The renderer's contract is the channel name and the payload shape, both of
  // which are identical either way — so the switch lives here, once, rather
  // than in every handler module.
  ipcMain.handle(channel, async (event, ...args) => {
    if (isEngineChannel(channel) && engineRemote()) {
      return callEngine(channel, args as unknown[]);
    }
    return handler(event, ...(args as Args));
  });
}
