const os = require("os");

/** Loopback / link-local — never advertise these as the worker host. */
const SKIP_IFACE = /^(lo|docker|br-|veth|utun|awdl|llw|bridge|vmnet|vbox|cinder|tun|ap\d)/i;

function isPrivateIpv4(address) {
  if (address.startsWith("10.")) return 3;
  if (address.startsWith("192.168.")) return 4;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(address)) return 1;
  return 0;
}

/**
 * LAN IPv4 of this machine (Metro host). Baked into extra.computeLanHost so a
 * physical phone can reach the research-worker even when Expo's hostUri is
 * empty or still 127.0.0.1 (USB / some Expo Go builds).
 * Skip during EAS/production builds — that IP would be the builder, not the laptop.
 */
function lanIPv4() {
  if (process.env.EAS_BUILD === "true") return null;
  const preferred = [];
  const rest = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (SKIP_IFACE.test(name)) continue;
    for (const addr of addrs ?? []) {
      const family = addr.family === "IPv4" || addr.family === 4;
      if (!family || addr.internal) continue;
      if (addr.address.startsWith("169.254.")) continue;
      const rank = isPrivateIpv4(addr.address);
      if (!rank) continue;
      const row = { name, address: addr.address, rank, wifi: /^(en0|en1|wlan|eth0|wifi)/i.test(name) };
      (row.wifi ? preferred : rest).push(row);
    }
  }
  const pool = [...preferred, ...rest].sort((a, b) => b.rank - a.rank);
  return pool[0]?.address ?? null;
}

/** @param {{ config: import('expo/config').ExpoConfig }} ctx */
module.exports = ({ config }) => {
  const fromEnv = String(process.env.EXPO_PUBLIC_COMPUTE_LAN_HOST ?? "")
    .trim()
    .replace(/^https?:\/\//, "")
    .split(":")[0];
  const computeLanHost = fromEnv || lanIPv4();
  if (computeLanHost) {
    console.log(`[falcon] compute LAN host ${computeLanHost}:8787`);
  }

  // Cleartext HTTP is only needed for local dev, where a physical phone reaches
  // the research-worker at http://<mac-lan-ip>:8787. Production (any EAS build)
  // talks to the HTTPS Railway worker + getfalcon.co, so shipping a global
  // cleartext/arbitrary-loads exception would only add a MITM risk. Gate it.
  const isLocalDevBuild = process.env.EAS_BUILD !== "true";

  return {
    ...config,
    extra: {
      ...(config.extra ?? {}),
      computeLanHost,
    },
    ios: {
      ...(config.ios ?? {}),
      infoPlist: {
        ...(config.ios?.infoPlist ?? {}),
        NSAppTransportSecurity: {
          // Safe in every build: permits cleartext to LAN/link-local hosts only,
          // while still enforcing TLS for public internet domains.
          NSAllowsLocalNetworking: true,
          // Arbitrary (public) cleartext — dev only.
          ...(isLocalDevBuild ? { NSAllowsArbitraryLoads: true } : {}),
        },
      },
    },
    android: {
      ...(config.android ?? {}),
      usesCleartextTraffic: isLocalDevBuild,
    },
  };
};
