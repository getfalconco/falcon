import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const projectRoot = resolve(__dirname);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@meridian/research", "@meridian/research/step1", "@meridian/research/propagation", "@meridian/research/gloss", "@meridian/research/screen", "@meridian/research/quantlab", "@meridian/research/edgar-time", "@meridian/research/sec-fetch"] })],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
  },
  renderer: {
    resolve: {
      alias: {
        "@": resolve(projectRoot, "src/renderer"),
        "@fontsource": resolve(projectRoot, "node_modules/@fontsource"),
      },
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        // The app, and the dark theme editor's window (Settings, Developer, Testing).
        input: {
          index: resolve(projectRoot, "src/renderer/index.html"),
          "theme-editor": resolve(projectRoot, "src/renderer/theme-editor.html"),
        },
      },
    },
  },
});
