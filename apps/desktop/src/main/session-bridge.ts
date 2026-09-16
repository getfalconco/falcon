/**
 * Renderer → main session bridge.
 *
 * The renderer owns the Supabase session (anon key inlined at build time, the
 * user's JWT from auth). The main process must never hold privileged keys, so
 * anything it needs to read or write on the user's behalf uses exactly these
 * two things, forwarded here: the public anon key and the user's own token.
 * Nothing here is a secret the user does not already possess.
 */

export type RendererSession = {
  supabaseUrl: string | null;
  anonKey: string | null;
  accessToken: string | null;
  updatedAt: string;
};

type Listener = (session: RendererSession) => void;

let current: RendererSession = {
  supabaseUrl: null,
  anonKey: null,
  accessToken: null,
  updatedAt: new Date(0).toISOString(),
};
const listeners = new Set<Listener>();

export function setRendererSession(input: {
  supabaseUrl?: string | null;
  anonKey?: string | null;
  accessToken?: string | null;
}): RendererSession {
  current = {
    supabaseUrl: input.supabaseUrl?.trim() || current.supabaseUrl,
    anonKey: input.anonKey?.trim() || current.anonKey,
    // null clears the token on sign-out
    accessToken: input.accessToken === undefined ? current.accessToken : input.accessToken?.trim() || null,
    updatedAt: new Date().toISOString(),
  };
  for (const l of listeners) {
    try {
      l(current);
    } catch (err) {
      console.warn("[session] listener failed:", err);
    }
  }
  return current;
}

export function getRendererSession(): RendererSession {
  return current;
}

/** Notified on every change; used to flush work that waited for a token. */
export function onRendererSession(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
