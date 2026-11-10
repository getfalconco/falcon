// Expo's Metro config detects the pnpm workspace on its own (SDK 52+): it
// watches the repo root and resolves packages through pnpm's isolated
// node_modules, so no watchFolders / nodeModulesPaths overrides are needed.
const { getDefaultConfig } = require("expo/metro-config");

module.exports = getDefaultConfig(__dirname);
