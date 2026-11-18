"use client";

import { useEffect, useState } from "react";
import type { User } from "@supabase/supabase-js";
import { isSupabaseConfigured, requireSupabase } from "@/lib/supabase";
import { AVATAR_BUCKET } from "./avatar";

/**
 * Browser-side profile reads shared by Settings > Account, the top bar's
 * account circle and the Dashboard greeting: the signed-in user (kept current
 * through auth events, so a saved name or photo shows everywhere at once) and
 * a signed URL for their photo.
 */

/** The signed-in user; undefined while loading, null when signed out or `enabled` is false. */
export function useAuthUser(enabled = true): User | null | undefined {
  const [user, setUser] = useState<User | null | undefined>(enabled && isSupabaseConfigured ? undefined : null);
  useEffect(() => {
    if (!enabled || !isSupabaseConfigured) {
      setUser(null);
      return;
    }
    let live = true;
    const client = requireSupabase();
    client.auth
      .getSession()
      .then(({ data }) => live && setUser(data.session?.user ?? null))
      .catch(() => live && setUser(null));
    const { data } = client.auth.onAuthStateChange((_event, session) => {
      if (live) setUser(session?.user ?? null);
    });
    return () => {
      live = false;
      data.subscription.unsubscribe();
    };
  }, [enabled]);
  return user;
}

const URL_TTL_S = 3600;
const cache = new Map<string, { url: string; until: number }>();
const listeners = new Set<() => void>();

/** Forget cached photo URLs (after an upload replaces the file at the same path). */
export function invalidateAvatar(): void {
  cache.clear();
  listeners.forEach((l) => l());
}

/** A short-lived signed URL for the member's own photo, or null (none, loading, or the bucket is not there yet). */
export function useAvatarUrl(path: string | null | undefined): string | null {
  const [url, setUrl] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    const bump = () => setVersion((v) => v + 1);
    listeners.add(bump);
    return () => {
      listeners.delete(bump);
    };
  }, []);
  useEffect(() => {
    if (!path || !isSupabaseConfigured) {
      setUrl(null);
      return;
    }
    const hit = cache.get(path);
    if (hit && hit.until > Date.now()) {
      setUrl(hit.url);
      return;
    }
    let live = true;
    requireSupabase()
      .storage.from(AVATAR_BUCKET)
      .createSignedUrl(path, URL_TTL_S)
      .then(({ data, error }) => {
        if (!live) return;
        if (error || !data?.signedUrl) return setUrl(null);
        cache.set(path, { url: data.signedUrl, until: Date.now() + (URL_TTL_S - 300) * 1000 });
        setUrl(data.signedUrl);
      })
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
    };
  }, [path, version]);
  return url;
}
