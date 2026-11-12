// Expo's Metro config detects the pnpm workspace on its own (SDK 52+): it
// watches the repo root and resolves packages through pnpm's isolated
// node_modules, so no watchFolders / nodeModulesPaths overrides are needed.
const http = require("http");
const https = require("https");
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Browser preview only: the website's API routes send no CORS headers, so the
// web build calls them on this dev server (`/api/...`) and they are forwarded
// to the site here. The phone calls the site directly (src/lib/env.ts).
const API_ORIGIN = new URL(process.env.EXPO_PUBLIC_API_URL || "https://getfalcon.co");
// The Ripple Engine's routes live on the app host; in the preview that is the
// local site (src/lib/env.ts appApiUrl). "app.localhost" is reached as
// localhost, which the site serves the same API routes on.
const APP_ORIGIN = new URL(process.env.EXPO_PUBLIC_API_BASE || "http://localhost:3000");
const APP_PATHS = /^\/api\/graph(\/|\?|$)/;

config.server = {
  ...config.server,
  enhanceMiddleware: (middleware) => (req, res, next) => {
    if (!req.url || !req.url.startsWith("/api/")) return middleware(req, res, next);
    const origin = APP_PATHS.test(req.url) ? APP_ORIGIN : API_ORIGIN;
    const secure = origin.protocol === "https:";
    const headers = { ...req.headers, host: origin.host };
    delete headers.origin;
    delete headers.referer;
    const upstream = (secure ? https : http).request(
      {
        protocol: origin.protocol,
        hostname: origin.hostname === "app.localhost" ? "localhost" : origin.hostname,
        port: origin.port || (secure ? 443 : 80),
        path: req.url,
        method: req.method,
        headers,
      },
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
