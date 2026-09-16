// Metro in a pnpm monorepo: watch the repo root so workspace packages resolve,
// and allow symlinked node_modules (pnpm's default layout).
const { getDefaultConfig } = require("expo/metro-config");
const path = require("node:path");

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];
// pnpm stores real packages under .pnpm and symlinks them in; without this
// Metro refuses to follow those links.
config.resolver.unstable_enableSymlinks = true;
// Hierarchical lookup must stay ON for pnpm: a package's own dependencies live
// in a nested node_modules beside it under .pnpm, and Metro only finds them by
// walking up from the importing file.

module.exports = config;
