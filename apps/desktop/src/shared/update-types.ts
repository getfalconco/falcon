/**
 * What the main process knows about a newer Falcon, as shown to the renderer.
 *
 * - `ready`    Windows: the update is downloaded; restarting installs it.
 * - `unsigned` macOS: a newer version exists but this build is not code-signed,
 *              and unsigned builds cannot self-update. The user has to fetch it.
 * - `idle`     nothing to show (no update, still checking, or check failed).
 */
export type UpdateStatus =
  | { kind: "idle" }
  | { kind: "ready"; version: string }
  | { kind: "unsigned"; version: string };
