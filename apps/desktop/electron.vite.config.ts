import { resolve } from "path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

const projectRoot = resolve(__dirname);

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ["@meridian/research", "@meridian/research/step1", "@meridian/research/propagation", "@meridian/research/gloss", "@meridian/research/screen", "@meridian/research/quantlab"] })],
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
  },
});
