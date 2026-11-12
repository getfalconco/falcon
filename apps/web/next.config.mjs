/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@meridian/ui", "@falcon/ripple", "@falcon/backtest"],
  async redirects() {
    return [
      { source: "/jobs", destination: "/careers", permanent: true },
      { source: "/jobs/:path*", destination: "/careers/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
