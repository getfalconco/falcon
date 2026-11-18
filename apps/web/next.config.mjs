/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@meridian/ui", "@falcon/ripple", "@falcon/backtest"],
  experimental: {
    // GET /api/graph and Falcon AI's falcon_graph tool (/api/desk/chat) read the per-ticker graph files at request time (scripts/graph-shards.mjs).
    outputFileTracingIncludes: { "/api/graph": ["./data/graph/**/*"], "/api/desk/chat": ["./data/graph/**/*"] },
  },
  async redirects() {
    return [
      { source: "/jobs", destination: "/careers", permanent: true },
      { source: "/jobs/:path*", destination: "/careers/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
