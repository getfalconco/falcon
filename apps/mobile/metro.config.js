// Expo's Metro config detects the pnpm workspace on its own (SDK 52+): it
// watches the repo root and resolves packages through pnpm's isolated
// node_modules, so no watchFolders / nodeModulesPaths overrides are needed.
const https = require("https");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Browser preview only: the website's API routes send no CORS headers, so the
// web build calls them on this dev server (`/api/...`) and they are forwarded
// to the site here. The phone calls the site directly (src/lib/env.ts).
const API_ORIGIN = new URL(process.env.EXPO_PUBLIC_API_URL || "https://getfalcon.co");

config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => (req, res, next) => {
    if (!req.url || !req.url.startsWith("/api/")) return middleware(req, res, next);
    const headers = { ...req.headers, host: API_ORIGIN.host };
    delete headers.origin;
    delete headers.referer;
    const upstream = https.request(
      { protocol: API_ORIGIN.protocol, hostname: API_ORIGIN.hostname, port: API_ORIGIN.port || 443, path: req.url, method: req.method, headers },
      (response) => {
        res.writeHead(response.statusCode || 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "The API proxy could not reach the site." }));
    });
    req.pipe(upstream);
  },
};

module.exports = config;
