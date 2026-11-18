import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@meridian/ui", "@falcon/ripple", "@falcon/backtest"],
  experimental: {
    // GET /api/graph and Falcon AI's falcon_graph tool (/api/desk/chat) read the per-ticker graph files at request time (scripts/graph-shards.mjs).
    outputFileTracingIncludes: { "/api/graph": ["./data/graph/**/*"], "/api/desk/chat": ["./data/graph/**/*"] },
  },
  // Engine sources the site bundles (packages/engine/src/options, lib/desk/tools) import @falcon/ripple, which
  // the deploy's install (--filter web...) links only into apps/web: resolve it there, as tsconfig's paths do.
  webpack(config) {
    config.resolve.alias = { ...config.resolve.alias, "@falcon/ripple$": path.resolve(here, "../../packages/ripple/src/index.ts") };
    return config;
  },
  async redirects() {
    return [
      { source: "/jobs", destination: "/careers", permanent: true },
      { source: "/jobs/:path*", destination: "/careers/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
