import Constants from "expo-constants";
import * as Linking from "expo-linking";
import { NativeModules, Platform, TurboModuleRegistry } from "react-native";

/** Loopback hosts that mean "this device" — wrong on a physical phone. */
const LOOPBACK = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/** Expo tunnel / ngrok hosts — Metro is proxied; the worker on :8787 is not. */
const TUNNEL =
  /(\.exp\.direct|\.exp\.host|\.expo\.dev|\.ngrok(?:-free)?\.(?:app|io|dev)|\.loca\.lt|\.trycloudflare\.com)$/i;

function isLoopbackHost(hostname: string): boolean {
  return LOOPBACK.has(hostname.toLowerCase().replace(/^\[|\]$/g, ""));
}

function isPrivateIpv4(hostname: string): boolean {
  return (
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)
  );
}

function isUsableLanHost(hostname: string): boolean {
  if (!hostname || isLoopbackHost(hostname)) return false;
  if (TUNNEL.test(hostname)) return false;
  return true;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

function hostFromHint(raw: string | null | undefined): string | null {
  if (!raw?.trim()) return null;
  try {
    const value = raw.trim();
    const withScheme = value.includes("://") ? value : `http://${value}`;
    const hostname = new URL(withScheme).hostname;
    return hostname && isUsableLanHost(hostname) ? hostname : null;
  } catch {
    return null;
  }
}

function packagerScriptURL(): string | undefined {
  if (Platform.OS === "web") return undefined;
  try {
    const turbo = TurboModuleRegistry.get<{
      scriptURL?: string;
      getConstants?: () => { scriptURL?: string };
    }>("SourceCode");
    const fromTurbo = turbo?.scriptURL ?? turbo?.getConstants?.()?.scriptURL;
    if (fromTurbo) return fromTurbo;
  } catch {
    // Bridgeless Expo Go still exposes NativeModules.SourceCode on some builds.
  }
  const source = NativeModules.SourceCode as { scriptURL?: string } | undefined;
  return source?.scriptURL;
}

function bakedLanHost(extra: unknown): string | null {
  const row = asRecord(extra);
  const baked = typeof row?.computeLanHost === "string" ? row.computeLanHost.trim() : "";
  return baked && isUsableLanHost(baked) ? baked : null;
}

/**
 * Mac LAN IP: env override, then app.config.js extra (Expo Go nests it under
 * manifest2.extra.expoClient.extra — expoConfig.extra is often empty there).
 */
function extraLanHost(): string | null {
  const env = hostFromHint(process.env.EXPO_PUBLIC_COMPUTE_LAN_HOST);
  if (env) return env;

  const manifest2 = asRecord(Constants.manifest2);
  const manifest2Extra = asRecord(manifest2?.extra);
  const expoClient = asRecord(manifest2Extra?.expoClient);
  const manifest = asRecord(Constants.manifest);

  return (
    bakedLanHost(Constants.expoConfig?.extra) ??
    bakedLanHost(expoClient?.extra) ??
    bakedLanHost(manifest?.extra)
  );
}

function linkingHost(): string | null {
  try {
    return hostFromHint(Linking.createURL("/"));
  } catch {
    return null;
  }
}

/**
 * Metro / Expo Go debugger host on the LAN.
 * hostUri is empty in some Expo Go builds; scriptURL + extra.computeLanHost cover those.
 */
export function lanHostFromExpo(): string | null {
  const go = Constants.expoGoConfig as { debuggerHost?: string } | null;
  const manifest2 = asRecord(Constants.manifest2);
  const manifest2Extra = asRecord(manifest2?.extra);
  const expoGo = asRecord(manifest2Extra?.expoGo);
  const expoClient = asRecord(manifest2Extra?.expoClient);
  const manifest = asRecord(Constants.manifest);
  const platform = asRecord(Constants.platform);

  const hints = [
    Constants.expoConfig?.hostUri,
    go?.debuggerHost,
    typeof expoGo?.debuggerHost === "string" ? expoGo.debuggerHost : null,
    typeof expoClient?.hostUri === "string" ? expoClient.hostUri : null,
    typeof manifest?.debuggerHost === "string" ? manifest.debuggerHost : null,
    typeof manifest?.hostUri === "string" ? manifest.hostUri : null,
    typeof platform?.hostUri === "string" ? platform.hostUri : null,
    packagerScriptURL(),
    Constants.linkingUri,
    Constants.experienceUrl,
    linkingHost(),
    extraLanHost(),
  ];
  const hosts: string[] = [];
  for (const hint of hints) {
    const host = hostFromHint(typeof hint === "string" ? hint : null);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts.find(isPrivateIpv4) ?? hosts[0] ?? extraLanHost();
}

function withLanHost(url: URL, lan: string): string {
  const port = url.port || "8787";
  const protocol = url.protocol || "http:";
  const wrapped = lan.includes(":") && !lan.startsWith("[") ? `[${lan}]` : lan;
  return `${protocol}//${wrapped}:${port}`;
}

export function isLoopbackApiUrl(url: string): boolean {
  try {
    return isLoopbackHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Physical devices cannot reach a worker at 127.0.0.1 (that's the phone).
 * When the configured URL is loopback, swap in the Expo debugger LAN IP
 * (or the Mac LAN IP baked into extra.computeLanHost) and keep the worker port.
 * Explicit non-localhost URLs (production) stay as-is.
 */
export type ComputeUrlResolution = {
  url: string;
  configured: string;
  lanHost: string | null;
  rewritten: boolean;
};

export function describeComputeApiUrl(configured: string): ComputeUrlResolution {
  const trimmed = configured.replace(/\/$/, "");
  const lanHost = lanHostFromExpo();
  if (!trimmed || Platform.OS === "web") {
    return { url: trimmed, configured: trimmed, lanHost, rewritten: false };
  }
  try {
    const url = new URL(trimmed);
    if (!isLoopbackHost(url.hostname) || !lanHost) {
      return { url: trimmed, configured: trimmed, lanHost, rewritten: false };
    }
    return {
      url: withLanHost(url, lanHost),
      configured: trimmed,
      lanHost,
      rewritten: true,
    };
  } catch {
    return { url: trimmed, configured: trimmed, lanHost, rewritten: false };
  }
}

export function resolveComputeApiUrl(configured: string): string {
  return describeComputeApiUrl(configured).url;
}
