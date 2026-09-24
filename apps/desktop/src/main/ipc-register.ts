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

type AnyHandler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown;

/** Every registered handler, by channel — what `invokeChannel` answers from. */
const handlers = new Map<string, AnyHandler>();

export function registerIpcHandler<Args extends unknown[], Result>(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: Args) => Promise<Result> | Result,
): void {
  handlers.set(channel, handler as unknown as AnyHandler);
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

/**
 * Ask a channel a question from inside the main process, with the same answer
 * the renderer would get.
 *
 * A main-process feature that needs the chain's view of the world (what the
 * Tracker saw, what Base made of it, the latest risk snapshot) would otherwise
 * have to know where the chain lives and branch on it at every call site, the
 * way the portfolio coverage handler does. This makes the one decision
 * `registerIpcHandler` already makes — remote engine or local handler — so the
 * payload shape is identical either way and the switch stays in this file.
 *
 * The local handlers take the IPC event only to ignore it, so none is passed.
 */
export async function invokeChannel<Result>(channel: string, ...args: unknown[]): Promise<Result> {
  if (isEngineChannel(channel) && engineRemote()) {
    return (await callEngine(channel, args)) as Result;
  }
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return (await (handler as unknown as (event: null, ...rest: unknown[]) => unknown)(null, ...args)) as Result;
}
