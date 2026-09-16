/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@meridian/ui"],
  async redirects() {
    return [
      { source: "/jobs", destination: "/careers", permanent: true },
      { source: "/jobs/:path*", destination: "/careers/:path*", permanent: true },
    ];
  },
};

export default nextConfig;
